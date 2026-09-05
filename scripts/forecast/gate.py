#!/usr/bin/env python3
"""Reads a backtest directory and prints one word: SHIP, NO-SHIP, VOID or PROVISIONAL.

    uv run python gate.py --results ../../tmp-forecast/results/seasonal-mid

The report (report.md + report.json) lands in the repo's top-level `gate/`
directory — deployed with the site, where gate/index.html renders the JSON
as an interactive plate at https://bmmmm.github.io/pegel-visual/gate/.

Every threshold below was fixed before the first model run. There is no
"promising": the seasonal verdict is SHIP only when A1..A7 all pass; the
short-horizon verdict is PROVISIONAL until every station has at least 60
independent origins and 3 rise events, and can never be SHIP before that.
A run whose ForecastConfig fingerprint, coverage or repeat check is off is
VOID — no verdict at all.

Exit code: 0 SHIP, 1 NO-SHIP, 2 VOID, 3 PROVISIONAL.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import warnings
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import metrics  # noqa: E402
import stations as st  # noqa: E402
import tfm  # noqa: E402

REPO = Path(__file__).resolve().parents[2]

# ---------- pre-registered thresholds (plan §1d) ----------
THRESHOLDS = {
    "A1_pooled_ss_min": 0.10,
    "A2_regimes_positive_min": 4,
    "A2_regime_ss_floor": -0.05,
    "A3_ci_lower_min": 0.03,
    "A4_dm_p_max": 0.10,
    "A4_regimes_significant_min": 4,
    "A4_stouffer_z_min": 2.5,
    "A5_picp80_range": [0.72, 0.88],
    "A5_picp80_slack_vs_baseline": 0.03,
    "A6_ss_crps_min": 0.05,
    "A7_recent_vs_old_ratio_min": 0.5,
    "tie_cm": 2.0,
    "coverage_min": 0.95,
    "bootstrap_B": 2000,
    "bootstrap_block": 26,
    "newey_west_lag": 13,
    "short_origins_min": 60,
    "short_rise_events_min": 3,
    "short_ss_min": 0.15,
}
CONTAMINATION_OLD = (2003, 2015)
CONTAMINATION_NEW = (2024, 2025)


def block_slice(block: list[int]) -> slice:
    return slice(block[0] - 1, block[1])


def year_of(dates: np.ndarray) -> np.ndarray:
    return dates.astype("datetime64[Y]").astype(int) + 1970


def one_sided_p(z: float) -> float:
    return float("nan") if math.isnan(z) else 0.5 * math.erfc(z / math.sqrt(2.0))


def fmt(v, digits=3):
    if v is None or (isinstance(v, float) and math.isnan(v)):
        return "—"
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, (int, np.integer)):
        return str(int(v))
    return f"{v:.{digits}f}"


# ---------- per-station scoring ----------

METHODS = ("persist", "clim", "snaive", "blend", "tfm_point", "upstream")


def per_h_abs_err(d: dict, split: str = "is_test") -> tuple[dict, dict]:
    """(sum of |err|, count) per lead day h = 1..H and method, on the given split —
    the raw material for a curve over the lead day, poolable across stations."""
    sel = d[split].astype(bool)
    y, m = d["y"][sel], d["tmask"][sel]
    sums, counts = {}, {}
    for k in METHODS:
        err = np.abs(d[k][sel] - y)
        ok = m & ~np.isnan(err)
        sums[k] = np.where(ok, err, 0.0).sum(axis=0)
        counts[k] = ok.sum(axis=0)
    return sums, counts


def _ratio(num: np.ndarray, den: np.ndarray) -> np.ndarray:
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.where(den > 0, num / np.where(den > 0, den, 1.0), np.nan)


def per_h_mae(d: dict, split: str = "is_test") -> dict:
    """MAE per lead day for every method — {method: [H]}, NaN where a column is
    empty (upstream at every gauge but KÖLN). Rounded to 2 decimals; _clean turns
    the NaN into null. This is the curve the gate page draws, not a clause input."""
    sums, counts = per_h_abs_err(d, split)
    return {k: np.round(_ratio(sums[k], counts[k]), 2) for k in METHODS}


def score_station(d: dict, blocks: dict, thresholds: dict, split: str = "is_test") -> dict:
    sel = d[split].astype(bool)
    y, m = d["y"][sel], d["tmask"][sel]
    out = {"n": int(sel.sum()), "tau": int(d["tau"]), "blocks": {}}
    forecasts = {k: d[k][sel] for k in ("persist", "clim", "snaive", "blend", "tfm_point", "upstream")}
    tfm_q, blend_q = d["tfm_q"][sel], d["blend_q"][sel]
    for name, block in blocks.items():
        s = block_slice(block)
        yb, mb = y[:, s], m[:, s]
        b = {"mae": {k: metrics.mae(v[:, s], yb, mb) for k, v in forecasts.items()}}
        b["delta_mae_cm"] = b["mae"]["tfm_point"] - b["mae"]["blend"]
        b["ss"] = metrics.skill(b["mae"]["tfm_point"], b["mae"]["blend"])
        b["ss_clim_vs_blend"] = metrics.skill(b["mae"]["clim"], b["mae"]["blend"])
        b["ss_upstream_vs_blend"] = metrics.skill(b["mae"]["upstream"], b["mae"]["blend"])
        b["tie"] = bool(abs(b["delta_mae_cm"]) < thresholds["tie_cm"]) if not math.isnan(b["delta_mae_cm"]) else False
        b["ss_adj"] = 0.0 if b["tie"] else b["ss"]
        dh = d["d_h"][s]
        per_h = np.array([metrics.mae(forecasts["tfm_point"][:, s][:, [i]], yb[:, [i]], mb[:, [i]]) for i in range(yb.shape[1])])
        b["mase"] = float(np.nanmean(per_h / dh))
        crps_t = metrics.crps_deciles(yb, tfm_q[:, s])
        crps_b = metrics.crps_deciles(yb, blend_q[:, s])
        b["crps"] = {"tfm": float(np.nanmean(crps_t[mb])), "blend": float(np.nanmean(crps_b[mb]))}
        b["ss_crps"] = metrics.skill(b["crps"]["tfm"], b["crps"]["blend"])
        b["picp80"] = {"tfm": metrics.picp(yb, tfm_q[:, s], 0, 8, mb), "blend": metrics.picp(yb, blend_q[:, s], 0, 8, mb)}
        b["picp60"] = {"tfm": metrics.picp(yb, tfm_q[:, s], 1, 7, mb), "blend": metrics.picp(yb, blend_q[:, s], 1, 7, mb)}
        b["pit"] = metrics.pit_histogram(yb, tfm_q[:, s], mb).tolist()
        # per-origin block loss for the DM test (same mask for both sides)
        err_t = np.where(mb, np.abs(forecasts["tfm_point"][:, s] - yb), np.nan)
        err_b = np.where(mb, np.abs(forecasts["blend"][:, s] - yb), np.nan)
        with np.errstate(invalid="ignore"):
            lt, lb = np.nanmean(err_t, axis=1), np.nanmean(err_b, axis=1)
        b["dm"] = metrics.dm_test(lt, lb, thresholds["newey_west_lag"])
        out["blocks"][name] = b
    out["per_h"] = per_h_mae(d, split)
    return out


# ---------- pooled scoring over the regime representatives ----------

def pooled(data: dict, blocks: dict, thresholds: dict) -> dict:
    """Pooled SS, bootstrap CI, PICP, CRPS and the contamination probe over st.POOLED."""
    uuids = [u for u in st.POOLED if u in data]
    # common TEST origin axis (all series share the daily grid)
    all_o = sorted(set(int(o) for u in uuids for o in data[u]["origins"][data[u]["is_test"].astype(bool)]))
    pos = {o: i for i, o in enumerate(all_o)}
    K = len(all_o)
    out = {"stations": [st.name_of(u) for u in uuids], "n_origins": K, "blocks": {}}
    for name, block in blocks.items():
        s = block_slice(block)
        E_t = np.zeros((len(uuids), K))
        E_b = np.zeros((len(uuids), K))
        crps_t = crps_b = 0.0
        inside = total = 0
        inside_b = 0
        old_t = old_b = new_t = new_b = 0.0
        for si, u in enumerate(uuids):
            d = data[u]
            sel = d["is_test"].astype(bool)
            y, m = d["y"][sel][:, s], d["tmask"][sel][:, s]
            et = np.where(m, np.abs(d["tfm_point"][sel][:, s] - y), 0.0)
            eb = np.where(m, np.abs(d["blend"][sel][:, s] - y), 0.0)
            idx = [pos[int(o)] for o in d["origins"][sel]]
            E_t[si, idx] = et.sum(axis=1)
            E_b[si, idx] = eb.sum(axis=1)
            ct = metrics.crps_deciles(y, d["tfm_q"][sel][:, s])
            cb = metrics.crps_deciles(y, d["blend_q"][sel][:, s])
            crps_t += float(ct[m].sum())
            crps_b += float(cb[m].sum())
            q = d["tfm_q"][sel][:, s]
            qb = d["blend_q"][sel][:, s]
            inside += int(((q[:, :, 0] <= y) & (y <= q[:, :, 8]))[m].sum())
            inside_b += int(((qb[:, :, 0] <= y) & (y <= qb[:, :, 8]))[m].sum())
            total += int(m.sum())
            # contamination probe uses h1-30 only; computed here for every block, read for h1-30
            yrs = year_of(d["o_dates"][sel])
            old = (yrs >= CONTAMINATION_OLD[0]) & (yrs <= CONTAMINATION_OLD[1])
            new = (yrs >= CONTAMINATION_NEW[0]) & (yrs <= CONTAMINATION_NEW[1])
            old_t += et[old].sum(); old_b += eb[old].sum()
            new_t += et[new].sum(); new_b += eb[new].sum()
        ss = 1 - E_t.sum() / E_b.sum() if E_b.sum() > 0 else float("nan")

        def stat(idx):
            bt, bb = E_t[:, idx].sum(), E_b[:, idx].sum()
            return 1 - bt / bb if bb > 0 else float("nan")
        lo, hi = metrics.bootstrap_ci(stat, K, thresholds["bootstrap_block"], thresholds["bootstrap_B"])
        out["blocks"][name] = {
            "ss": float(ss), "ci95": [lo, hi], "n_pairs": total,
            "picp80": {"tfm": inside / total if total else float("nan"), "blend": inside_b / total if total else float("nan")},
            "crps": {"tfm": crps_t / total if total else float("nan"), "blend": crps_b / total if total else float("nan")},
            "ss_crps": 1 - crps_t / crps_b if crps_b > 0 else float("nan"),
            "ss_new": 1 - new_t / new_b if new_b > 0 else float("nan"),
        }
    # per lead day, for the page's curve: the cm-pooled MAE (sum |err| / count over
    # the five, Rhine and Elbe weigh most) and the median of the five stations'
    # ratios method/blend ("five regimes, one vote each"; blend is 1.0 by construction)
    # a pooled column exists only where EVERY pooled station has it: upstream lives at
    # KÖLN alone, and one gauge's number must not come out labelled as five gauges'
    H = data[uuids[0]]["y"].shape[1] if uuids else 0
    sums = {k: np.zeros(H) for k in METHODS}
    counts = {k: np.zeros(H) for k in METHODS}
    complete = {k: np.ones(H, bool) for k in METHODS}
    ratios = {k: [] for k in METHODS}
    for u in uuids:
        s_u, c_u = per_h_abs_err(data[u])
        mae_u = {k: _ratio(s_u[k], c_u[k]) for k in METHODS}
        for k in METHODS:
            sums[k] += s_u[k]
            counts[k] += c_u[k]
            complete[k] &= c_u[k] > 0
            ratios[k].append(_ratio(mae_u[k], mae_u["blend"]))
    out["per_h"] = {k: np.round(np.where(complete[k], _ratio(sums[k], counts[k]), np.nan), 2) for k in METHODS}
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)  # all-NaN columns are null, not noise
        out["per_h_ratio_median"] = {k: np.round(np.where(complete[k], np.nanmedian(np.array(ratios[k]), axis=0), np.nan), 3) if ratios[k] else np.full(H, np.nan) for k in METHODS}
    return out


def contamination(data: dict, blocks_h1_30: list[int]) -> dict:
    """SS on TRAIN-period origins 2003-2015 vs TEST origins 2024-25, h1-30, pooled."""
    s = block_slice(blocks_h1_30)
    acc = {"old": [0.0, 0.0], "new": [0.0, 0.0]}
    for u in st.POOLED:
        if u not in data:
            continue
        d = data[u]
        yrs = year_of(d["o_dates"])
        for key, (a, b) in (("old", CONTAMINATION_OLD), ("new", CONTAMINATION_NEW)):
            sel = (yrs >= a) & (yrs <= b)
            y, m = d["y"][sel][:, s], d["tmask"][sel][:, s]
            acc[key][0] += float(np.where(m, np.abs(d["tfm_point"][sel][:, s] - y), 0).sum())
            acc[key][1] += float(np.where(m, np.abs(d["blend"][sel][:, s] - y), 0).sum())
    ss_old = 1 - acc["old"][0] / acc["old"][1] if acc["old"][1] > 0 else float("nan")
    ss_new = 1 - acc["new"][0] / acc["new"][1] if acc["new"][1] > 0 else float("nan")
    return {"ss_old_2003_2015": ss_old, "ss_new_2024_2025": ss_new}


# ---------- regimes ----------

def regimes(per_station: dict, blocks: dict) -> dict:
    out = {}
    for regime in st.REGIMES:
        members = [u for u in per_station if st.regime_of(u) == regime]
        if not members:
            continue
        out[regime] = {"members": [st.name_of(u) for u in members], "blocks": {}}
        for name in blocks:
            ss = [per_station[u]["blocks"][name]["ss_adj"] for u in members]
            zs = [per_station[u]["blocks"][name]["dm"]["z"] for u in members]
            z = float(np.nanmedian(zs)) if zs else float("nan")
            out[regime]["blocks"][name] = {"ss": float(np.nanmedian(ss)), "z": z, "p": one_sided_p(z)}
    return out


# ---------- clauses ----------

def clauses(pool: dict, reg: dict, contam: dict, blocks: dict, th: dict) -> dict:
    res = {}
    names = list(blocks)
    res["A1"] = {"pass": all(pool["blocks"][b]["ss"] >= th["A1_pooled_ss_min"] for b in names),
                 "detail": {b: pool["blocks"][b]["ss"] for b in names}}
    a2 = {}
    for b in names:
        ss = [reg[r]["blocks"][b]["ss"] for r in reg]
        a2[b] = {"positive": sum(1 for v in ss if v > 0), "min": min(ss) if ss else float("nan")}
    res["A2"] = {"pass": all(v["positive"] >= th["A2_regimes_positive_min"] and v["min"] >= th["A2_regime_ss_floor"] for v in a2.values()),
                 "detail": a2}
    res["A3"] = {"pass": all(pool["blocks"][b]["ci95"][0] > th["A3_ci_lower_min"] for b in names),
                 "detail": {b: pool["blocks"][b]["ci95"][0] for b in names}}
    a4 = {}
    for b in names:
        ps = [reg[r]["blocks"][b]["p"] for r in reg]
        zs = [reg[r]["blocks"][b]["z"] for r in reg]
        a4[b] = {"significant": sum(1 for p in ps if p < th["A4_dm_p_max"]), "stouffer_z": metrics.stouffer(zs)}
    res["A4"] = {"pass": all(v["significant"] >= th["A4_regimes_significant_min"] and v["stouffer_z"] > th["A4_stouffer_z_min"] for v in a4.values()),
                 "detail": a4}
    lo, hi = th["A5_picp80_range"]
    a5 = {}
    for b in names:
        pt, pb = pool["blocks"][b]["picp80"]["tfm"], pool["blocks"][b]["picp80"]["blend"]
        a5[b] = {"tfm": pt, "blend": pb, "ok": (lo <= pt <= hi) and (abs(pt - 0.8) <= abs(pb - 0.8) + th["A5_picp80_slack_vs_baseline"])}
    res["A5"] = {"pass": all(v["ok"] for v in a5.values()), "detail": a5}
    res["A6"] = {"pass": all(pool["blocks"][b]["ss_crps"] >= th["A6_ss_crps_min"] for b in names),
                 "detail": {b: pool["blocks"][b]["ss_crps"] for b in names}}
    old, new = contam["ss_old_2003_2015"], contam["ss_new_2024_2025"]
    a7_ok = (not math.isnan(old)) and (not math.isnan(new)) and new >= th["A7_recent_vs_old_ratio_min"] * old
    res["A7"] = {"pass": bool(a7_ok), "detail": contam}
    return res


# ---------- void conditions ----------

def void_reasons(header: dict, data: dict, expected_config: dict, th: dict) -> list[str]:
    reasons = []
    key = header.get("model_key")
    if key is not None and key not in tfm.MODELS:
        reasons.append(f"header names an unregistered model ({key})")
    if header.get("config_fingerprint") != tfm.config_fingerprint(expected_config):
        reasons.append("ForecastConfig fingerprint differs from the pre-registered one")
    if not header.get("model_ran"):
        reasons.append("model did not run (baselines only)")
    if header.get("limit"):
        reasons.append(f"origin grid truncated (--limit {header['limit']})")
    if header.get("repeat_identical") is not True:
        reasons.append("repeat check did not reproduce bit for bit")
    for u, info in header.get("stations", {}).items():
        exp, got = info.get("pairs_expected", 0), info.get("pairs_scored", 0)
        if exp and got / exp < th["coverage_min"]:
            reasons.append(f"{info.get('name', u)}: only {got / exp:.1%} of pairs scored")
    for u in st.POOLED:
        if u not in data:
            reasons.append(f"{st.name_of(u)} missing from the results")
    for u, d in data.items():
        if "is_train" in d and d["is_train"].any() and d["is_test"].any():  # the short protocol has no TRAIN split
            H = d["y"].shape[1]
            if d["origins"][d["is_train"]].max() + H >= d["origins"][d["is_test"]].min():
                reasons.append(f"{st.name_of(u)}: TRAIN/TEST not disjoint")
    return reasons


# ---------- report ----------

def load_results(results: Path):
    header = json.loads((results / "header.json").read_text(encoding="utf-8"))
    data = {}
    for uuid in header.get("stations", {}):
        p = results / f"{uuid}.npz"
        if p.exists():
            data[uuid] = dict(np.load(p, allow_pickle=False))
    return header, data


def seasonal_report(header: dict, data: dict, th: dict) -> dict:
    blocks = header["protocol"]["blocks"]
    per_station = {u: score_station(data[u], blocks, th) for u in data if u in st.STATIONS}
    pool = pooled(data, blocks, th)
    reg = regimes(per_station, blocks)
    contam = contamination(data, [1, 30])
    cl = clauses(pool, reg, contam, blocks, th)
    void = void_reasons(header, data, tfm.expected_config(header), th)
    if void:
        verdict = "VOID"
    else:
        verdict = "SHIP" if all(c["pass"] for c in cl.values()) else "NO-SHIP"
    # Befund 2: does climatology alone carry the long horizon?
    clim_carries = {b: {st.name_of(u): per_station[u]["blocks"][b]["ss_clim_vs_blend"] for u in per_station} for b in blocks}
    return {"verdict": verdict, "void": void, "clauses": cl, "pooled": pool, "regimes": reg,
            "stations": {st.name_of(u): v for u, v in per_station.items()},
            "climatology_vs_blend": clim_carries, "thresholds": th,
            "header": {k: header[k] for k in header if k != "stations"}, "station_info": header["stations"]}


def short_report(header: dict, data: dict, th: dict) -> dict:
    blocks = header["protocol"]["blocks"]
    stations_out, reasons = {}, []
    for u, info in header["stations"].items():
        name = info.get("name", u)
        n, rises = info.get("kept", 0), info.get("rise_events", 0)
        if n < th["short_origins_min"]:
            reasons.append(f"{name}: {n}/{th['short_origins_min']} origins")
        if rises < th["short_rise_events_min"]:
            reasons.append(f"{name}: {rises}/{th['short_rise_events_min']} rise events")
        if u not in data:
            continue
        d = data[u]
        y, m = d["y"], d["tmask"]
        # no per_h here on purpose: the page's curve over the lead day reads the
        # chosen SEASONAL report; the short protocol has a different grid and no blend
        entry = {"origins": int(n), "rise_events": int(rises), "blocks": {}}
        for bname, block in blocks.items():
            s = block_slice(block)
            maes = {k: metrics.mae(d[k][:, s], y[:, s], m[:, s]) for k in ("persist", "snaive", "drift", "tidal", "tfm_point")}
            base = {k: v for k, v in maes.items() if k != "tfm_point" and not math.isnan(v)}
            best = min(base, key=base.get) if base else None
            entry["blocks"][bname] = {"mae": maes, "best_baseline": best,
                                      "ss_vs_best": metrics.skill(maes["tfm_point"], base[best]) if best else float("nan")}
        stations_out[name] = entry
    void = void_reasons(header, data, {**tfm.expected_config(header), "max_horizon": header["protocol"]["horizon"]}, th) if data else []
    if reasons:
        verdict = "PROVISIONAL"
    elif void:
        verdict = "VOID"
    else:
        ok = all(b["ss_vs_best"] >= th["short_ss_min"] for e in stations_out.values() for b in e["blocks"].values())
        verdict = "SHIP" if ok else "NO-SHIP"
    return {"verdict": verdict, "provisional_reasons": reasons, "void": void, "stations": stations_out,
            "thresholds": th, "header": {k: header[k] for k in header if k != "stations"}, "station_info": header["stations"]}


def shipping_note(h: dict) -> list[str]:
    """A run with weights this repo may not ship says so where the numbers are,
    not in a footnote. Its measurements are facts and stand; what cannot follow
    from them is a deployment."""
    if h.get("model_shippable", True):
        return []
    return [f"> Measured, not shipped. These weights are licensed {h['model_license']} "
            f"({h.get('model_license_url', 'no link')}), which forbids redistribution and any commercial or "
            f"production use — so this line can be measured here but can never become the model this "
            f"GPL-3.0 repo ships, however it scores.", ""]


def candidates_in(out_dir: Path, key: str) -> list[str]:
    """Registry keys with a report in this directory, plus the one being written.

    Registry keys only, in registry order: a stray `report_backup_….json` must
    never be counted as a candidate, and the directory is the one actually being
    written, so --report cannot make the count describe some other run."""
    found = {key} | {k for k in tfm.MODELS
                     if (out_dir / f"{'report' if k == tfm.SHIPPED else f'report-{k}'}.json").exists()}
    return [k for k in tfm.MODELS if k in found]


def candidate_note(rep: dict) -> list[str]:
    """Every candidate measured on this TEST set, named. The thresholds were
    pre-registered for one; a second look at the same origins is a second
    hypothesis test, and a reader must be able to see how many were taken.
    Reads rep["candidates"] — the same list the JSON carries, so the page can
    say it too instead of the markdown saying it alone."""
    found = rep.get("candidates") or []
    if len(found) < 2:
        return []
    names = ", ".join(tfm.MODELS[k]["id"] for k in found)
    return [f"- {len(found)} candidates have now been measured on the SAME TEST origins ({names}). "
            f"The clause thresholds were pre-registered for a single candidate; read the significances "
            f"as {len(found)} looks at one test set, not one."]


def write_models_manifest(repo: Path) -> dict:
    """gate/models.json — what the page may offer. Rebuilt from the registry and
    from what is actually on disk, so it cannot drift from either."""
    models = []
    for key, entry in tfm.MODELS.items():
        files = {}
        stem = "report" if key == tfm.SHIPPED else f"report-{key}"
        for d in sorted(x for x in (repo / "gate").glob("*-*") if x.is_dir()):
            if not (d / f"{stem}.json").exists():
                continue
            entry_files = {"json": f"{d.name}/{stem}.json"}
            if (d / f"{stem}.md").exists():  # a listed twin that 404s is worse than none
                entry_files["md"] = f"{d.name}/{stem}.md"
            files[d.name] = entry_files
        if not files:
            continue
        models.append({"key": key, "label": entry["label"], "id": entry["id"], "params": entry["params"],
                       "checkpoint": entry["checkpoint"], "license": entry["license"],
                       "license_url": entry["license_url"], "shippable": entry["shippable"],
                       "files": files})
    # the primary must be a LISTED model — a registered line with no report on
    # disk is skipped above, and a manifest naming it would send the page to a
    # model it cannot draw; the shipped line is always listed once it has a report
    listed = [m["key"] for m in models]
    primary = tfm.PRIMARY if tfm.PRIMARY in listed else tfm.SHIPPED
    out = {"shipped": tfm.SHIPPED, "primary": primary, "models": models}
    (repo / "gate" / "models.json").write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    return out


def render_seasonal(rep: dict) -> str:
    h = rep["header"]
    blocks = list(h["protocol"]["blocks"])
    lines = [f"# Forecast gate — {h['horizon_kind']} / target {h['target']}", "",
             f"Verdict: **{rep['verdict']}**", "",
             f"model {h['model']} ({h['model_license']}) · checkpoint {h['checkpoint']} · config {h['config_fingerprint']} · "
             f"timesfm {h['versions'].get('timesfm')} · torch {h['versions'].get('torch')} · git {h['git']} · {h['generated']} · "
             f"{h['elapsed_s']} s · repeat identical: {fmt(h['repeat_identical'])} · tfm sha256 {str(h['tfm_sha256'])[:16]}"
             + (f" · reproduced bit for bit by a second full run at {h['reproduced_by_run']}" if h.get("reproduced_by_run") else
                " · second full run: not compared"), ""]
    lines += shipping_note(h)
    if rep["void"]:
        lines += ["VOID because:"] + [f"- {r}" for r in rep["void"]] + [""]
    lines += ["## Clauses", "", "| clause | pass | detail |", "|---|---|---|"]
    for k, c in rep["clauses"].items():
        det = json.dumps(c["detail"], ensure_ascii=False, default=lambda v: round(v, 4) if isinstance(v, float) else v)
        lines.append(f"| {k} | {'PASS' if c['pass'] else 'FAIL'} | {det} |")
    lines += ["", "## Pooled (" + ", ".join(rep["pooled"]["stations"]) + f", {rep['pooled']['n_origins']} TEST origins)", "",
              "| block | SS vs blend | 95 % CI | PICP80 tfm / blend | CRPS tfm / blend | SS CRPS | pairs |", "|---|---|---|---|---|---|---|"]
    for b in blocks:
        p = rep["pooled"]["blocks"][b]
        lines.append(f"| {b} | {fmt(p['ss'])} | [{fmt(p['ci95'][0])}, {fmt(p['ci95'][1])}] | {fmt(p['picp80']['tfm'])} / {fmt(p['picp80']['blend'])} | "
                     f"{fmt(p['crps']['tfm'], 1)} / {fmt(p['crps']['blend'], 1)} | {fmt(p['ss_crps'])} | {p['n_pairs']} |")
    lines += ["", "## Regimes (median of members; ties count as 0)", "", "| regime | members | " + " | ".join(f"{b} SS / z / p" for b in blocks) + " |",
              "|---|---|" + "---|" * len(blocks)]
    for r, v in rep["regimes"].items():
        cells = [f"{fmt(v['blocks'][b]['ss'])} / {fmt(v['blocks'][b]['z'], 2)} / {fmt(v['blocks'][b]['p'])}" for b in blocks]
        lines.append(f"| {r} | {', '.join(v['members'])} | " + " | ".join(cells) + " |")
    lines += ["", "## Stations (TEST origins, MAE in the gauge's cm)", ""]
    for name, s in rep["stations"].items():
        lines += [f"### {name} — {s['n']} TEST origins, τ = {s['tau']}", "",
                  "| block | persist | clim | snaive365 | blend | upstream OLS | **TimesFM** | ΔMAE | SS | tie | MASE | SS CRPS | PICP80 | DM z (p, n_eff) |",
                  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
        for b in blocks:
            v = s["blocks"][b]
            mae = v["mae"]
            lines.append(f"| {b} | {fmt(mae['persist'], 1)} | {fmt(mae['clim'], 1)} | {fmt(mae['snaive'], 1)} | {fmt(mae['blend'], 1)} | "
                         f"{fmt(mae['upstream'], 1)} | **{fmt(mae['tfm_point'], 1)}** | {fmt(v['delta_mae_cm'], 1)} | {fmt(v['ss'])} | {fmt(v['tie'])} | "
                         f"{fmt(v['mase'], 2)} | {fmt(v['ss_crps'])} | {fmt(v['picp80']['tfm'], 2)} | "
                         f"{fmt(v['dm']['z'], 2)} ({fmt(v['dm']['p'])}, {fmt(v['dm']['n_eff'], 0)}) |")
        pit = s["blocks"][blocks[-1]]["pit"]
        lines += ["", f"PIT histogram {blocks[-1]}: {pit}", ""]
    lines += ["## Befund 2 — climatology vs blend (SS of plain climatology against the blend)", "",
              "| block | " + " | ".join(rep["stations"]) + " |", "|---|" + "---|" * len(rep["stations"])]
    for b in blocks:
        lines.append(f"| {b} | " + " | ".join(fmt(rep["climatology_vs_blend"][b][n]) for n in rep["stations"]) + " |")
    lines += ["", "## Caveats", "",
              f"- {h['model']} has no published corpus manifest; PEGELONLINE is open and CAMELS-DE (2024) covers German basins. "
              "Assume the archive MAY be in the training data. A7 is a probe, not a proof — and it gets weaker the "
              "later the checkpoint, because A7's own recent side (2024-2025) can sit inside the training window too.",
              "- The blend's τ and residual deciles are fitted on TRAIN; A7's 2003-2015 side therefore favours the blend slightly.",
              "- Persistence is reported for the MASE denominators only. The bar is the blend."]
    lines += candidate_note(rep) + [""]
    return "\n".join(lines)


def render_short(rep: dict) -> str:
    h = rep["header"]
    lines = [f"# Forecast gate — short horizon (15-minute grid)", "", f"Verdict: **{rep['verdict']}**", ""]
    lines += shipping_note(h)
    if rep["provisional_reasons"]:
        lines += ["PROVISIONAL — cannot be SHIP before:"] + [f"- {r}" for r in rep["provisional_reasons"]] + [""]
    if rep["void"]:
        lines += ["VOID because:"] + [f"- {r}" for r in rep["void"]] + [""]
    lines += ["| station | origins | rises | block | persist | snaive24h | drift | tidal | TimesFM | best baseline | SS vs best |",
              "|---|---|---|---|---|---|---|---|---|---|---|"]
    for name, s in rep["stations"].items():
        for b, v in s["blocks"].items():
            m = v["mae"]
            lines.append(f"| {name} | {s['origins']} | {s['rise_events']} | {b} | {fmt(m['persist'], 1)} | {fmt(m['snaive'], 1)} | "
                         f"{fmt(m['drift'], 1)} | {fmt(m['tidal'], 1)} | {fmt(m['tfm_point'], 1)} | {v['best_baseline']} | {fmt(v['ss_vs_best'])} |")
    lines += ["", f"collected: " + "; ".join(f"{i.get('name')}: {i.get('collected_steps', 0)} steps" for i in rep["station_info"].values()), ""]
    # a short-horizon challenger would otherwise publish without the warning the
    # seasonal reports carry
    note = candidate_note(rep)
    if note:
        lines += ["## Caveats", ""] + note + [""]
    return "\n".join(lines)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--results", required=True)
    ap.add_argument("--report", default=None, help="directory for report.md + report.json (default: <repo>/gate/<horizon>-<target>)")
    ap.add_argument("--compare", default=None, help="a second results directory that must reproduce the first")
    args = ap.parse_args(argv)
    warnings.filterwarnings("ignore", category=RuntimeWarning)  # empty slices in a baselines-only run are reported as VOID, not as noise
    header, data = load_results(Path(args.results))
    th = dict(THRESHOLDS)
    if args.compare:
        other, _ = load_results(Path(args.compare))
        if other.get("tfm_sha256") != header.get("tfm_sha256"):
            print(f"VOID: second run does not reproduce (sha256 {header.get('tfm_sha256')} vs {other.get('tfm_sha256')})")
            return 2
        header["reproduced_by_run"] = other.get("generated")  # carried into the report: the void condition was measured, not assumed
        print("second run reproduces bit for bit")
    # the destination is decided BEFORE rendering: the candidate count is part of
    # the report, and it must describe the directory this run actually writes to
    default_out = REPO / "gate" / f"{header['horizon_kind']}-{header['target']}"
    out = Path(args.report) if args.report else default_out
    out.mkdir(parents=True, exist_ok=True)
    # report.json is THE report — the shipped model's. A challenger writes
    # report-<key>.json beside it and leaves every existing link standing.
    key = header.get("model_key") or tfm.SHIPPED
    stem = "report" if key == tfm.SHIPPED else f"report-{key}"
    if header["horizon_kind"] == "seasonal":
        rep = seasonal_report(header, data, th)
        rep["candidates"] = candidates_in(out, key)
        text = render_seasonal(rep)
    else:
        rep = short_report(header, data, th)
        rep["candidates"] = candidates_in(out, key)
        text = render_short(rep)
    print(text)
    (out / f"{stem}.md").write_text(text + "\n", encoding="utf-8")
    (out / f"{stem}.json").write_text(json.dumps(_clean(rep), indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    # the manifest describes the deployed gate/ directory, so only a run that
    # actually wrote there may rewrite it — `--report elsewhere` must not.
    if out == default_out:
        write_models_manifest(REPO)
    print(f"report: {out / stem}.json")
    return {"SHIP": 0, "NO-SHIP": 1, "VOID": 2, "PROVISIONAL": 3}[rep["verdict"]]


def _clean(v):
    """JSON-safe copy: numpy scalars to Python, NaN to null (json.dumps would emit a bare NaN)."""
    if isinstance(v, dict):
        return {str(k): _clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_clean(x) for x in v]
    if isinstance(v, np.ndarray):
        return _clean(v.tolist())
    if isinstance(v, (np.bool_, bool)):
        return bool(v)
    if isinstance(v, (np.integer, int)):
        return int(v)
    if isinstance(v, (np.floating, float)):
        f = float(v)
        return None if math.isnan(f) or math.isinf(f) else f
    return v


if __name__ == "__main__":
    sys.exit(main())
