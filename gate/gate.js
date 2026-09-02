// The forecast gate report as a survey plate — see gate/index.html.
//
// Pure functions build a view model from the committed report.json files and
// render it to markup; main() wires the page. The module has no DOM at import
// time so tests/gate-page.test.mjs can run buildModel/renderPage in Node
// against the real reports. Every chart shares the one filter row (target and
// horizon block, both in the URL), every mark class is also a legend swatch,
// and every chart has a table twin. Nothing repaints on a timer.

export const BLOCKS = ['h1-14', 'h15-30', 'h31-90'];
export const BLOCK_LABEL = { 'h1-14': 'days 1–14', 'h15-30': 'days 15–30', 'h31-90': 'days 31–90' };
export const TARGETS = { mid: 'daily mid', max: 'daily max' };
export const SKILL_DOMAIN = [-0.2, 0.2];   // fixed across blocks and targets, so bars stay comparable
export const RATIO_DOMAIN = [0.5, 2.0];    // error relative to the blend; 1.0 is the bar
export const PICP_DOMAIN = [0.6, 1.0];

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const attr = (name, v) => v == null || v === '' ? '' : ` ${name}="${esc(v)}"`;

const num = (v, d = 3) => (v == null || Number.isNaN(v)) ? '—' : (typeof v === 'number' ? v.toFixed(d) : String(v));
const signed = (v, d = 3) => (v == null || Number.isNaN(v)) ? '—' : (v > 0 ? '+' : '') + v.toFixed(d);
const pct = (frac, [lo, hi]) => Math.max(0, Math.min(100, ((frac - lo) / (hi - lo)) * 100));
const clampInfo = (v, [lo, hi]) => ({ x: pct(Math.max(lo, Math.min(hi, v)), [lo, hi]), clipped: v < lo ? 'lo' : v > hi ? 'hi' : null });
const pval = p => p == null || Number.isNaN(p) ? '—' : p < 0.001 ? '< 0.001' : p.toFixed(3);
const thousands = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); // 3 563, the thin space the app uses

export function parseState(search) {
  const q = new URLSearchParams(search || '');
  const target = q.get('target') in TARGETS ? q.get('target') : 'mid';
  const block = BLOCKS.includes(q.get('block')) ? q.get('block') : 'h1-14';
  return { target, block };
}

export function stateHref(state, patch = {}) {
  const s = { ...state, ...patch };
  const q = new URLSearchParams();
  if (s.target !== 'mid') q.set('target', s.target);
  if (s.block !== 'h1-14') q.set('block', s.block);
  const str = q.toString();
  return str ? '?' + str : './';
}

// the clauses, spelled out for people — the report carries them as codes
const CLAUSE_TEXT = {
  A1: d => `pooled skill ≥ 0.10 against the blend in every block — measured ${BLOCKS.map(b => `${signed(d[b])} (${BLOCK_LABEL[b]})`).join(', ')}`,
  A2: d => `≥ 4 of 5 regimes better than the blend in every block, none below −0.05 — ${BLOCKS.map(b => `${d[b].positive}/5 positive, floor ${signed(d[b].min)} (${BLOCK_LABEL[b]})`).join('; ')}`,
  A3: d => `bootstrap 95 % CI of the pooled skill entirely above 0.03 — lower bounds ${BLOCKS.map(b => `${signed(d[b])} (${BLOCK_LABEL[b]})`).join(', ')}`,
  A4: d => `Diebold-Mariano p < 0.10 in ≥ 4 of 5 regimes and Stouffer z > 2.5 — ${BLOCKS.map(b => `${d[b].significant}/5 regimes, z ${num(d[b].stouffer_z, 2)} (${BLOCK_LABEL[b]})`).join('; ')}`,
  A5: d => `80 % interval covers 72–88 % and is no worse than the blend's own band by more than 0.03 — ${BLOCKS.map(b => `${num(d[b].tfm, 2)} vs ${num(d[b].blend, 2)} (${BLOCK_LABEL[b]})`).join(', ')}`,
  A6: d => `CRPS skill ≥ 0.05 against the blend's residual band — ${BLOCKS.map(b => `${signed(d[b])} (${BLOCK_LABEL[b]})`).join(', ')}`,
  A7: d => `contamination probe: skill on 2024–25 origins ≥ half the skill on 2003–15 origins (days 1–30) — ${signed(d.ss_new_2024_2025)} vs ${signed(d.ss_old_2003_2015)}`,
};
const CLAUSE_NAME = { A1: 'pooled skill', A2: 'regime vote', A3: 'bootstrap CI', A4: 'significance', A5: 'calibration', A6: 'CRPS skill', A7: 'contamination probe' };

function stationOrder(report) {
  // regimes in the order the report votes them; members inside a regime as reported
  const out = [];
  for (const [regime, r] of Object.entries(report.regimes || {})) for (const m of r.members) out.push({ station: m, regime });
  return out;
}

const SIG_P = 0.10;

export function skillRows(report, block, key = 'ss') {
  const th = report.thresholds || {};
  return stationOrder(report).map(({ station, regime }) => {
    const b = report.stations[station].blocks[block];
    const mae = b.mae;
    const ss = key === 'ss' ? b.ss : b.ss_clim_vs_blend;
    const tie = key === 'ss' ? b.tie : Math.abs(mae.clim - mae.blend) < (th.tie_cm ?? 2);
    const sig = key === 'ss' && b.dm && b.dm.p != null && b.dm.p < SIG_P && b.dm.z > 0;
    const model = key === 'ss' ? mae.tfm_point : mae.clim;
    const label = key === 'ss' ? 'TimesFM' : 'climatology';
    const say = `${station}, ${BLOCK_LABEL[block]}: ${label} ${num(model, 1)} cm vs blend ${num(mae.blend, 1)} cm — skill ${signed(ss)}` +
      (tie ? ' (a tie: under 2 cm apart)' : '') +
      (key === 'ss' && b.dm ? `; DM z ${num(b.dm.z, 2)}, p ${pval(b.dm.p)}, n_eff ${num(b.dm.n_eff, 0)} of ${b.dm.n}` : '') +
      `; MASE ${num(b.mase, 2)}.`;
    return { station, regime, ss, tie, sig, say, model, blend: mae.blend, z: b.dm && b.dm.z, p: b.dm && b.dm.p };
  });
}

export function buildModel({ seasonal, short }, state) {
  const report = seasonal[state.target] || seasonal.mid;
  const h = report.header;
  const block = state.block;
  const pooled = report.pooled.blocks[block];
  const clauses = Object.entries(report.clauses).map(([id, c]) => ({
    id, pass: !!c.pass, name: CLAUSE_NAME[id] || id,
    text: (CLAUSE_TEXT[id] || (d => JSON.stringify(d)))(c.detail),
  }));
  const regimes = Object.entries(report.regimes).map(([name, r]) => ({ name, members: r.members, ...r.blocks[block] }));
  const skill = {
    rows: skillRows(report, block, 'ss'),
    pooled: { ss: pooled.ss, lo: pooled.ci95[0], hi: pooled.ci95[1], n: report.pooled.n_origins, stations: report.pooled.stations },
    threshold: report.thresholds.A1_pooled_ss_min,
    regimes,
  };
  const clim = { rows: skillRows(report, block, 'clim') };
  const error = stationOrder(report).map(({ station, regime }) => {
    const b = report.stations[station].blocks[block];
    const m = b.mae;
    const marks = [
      ['tfm', 'TimesFM', m.tfm_point], ['persist', 'persistence', m.persist], ['clim', 'climatology', m.clim],
      ['snaive', 'seasonal naive 365', m.snaive], ['up', 'upstream OLS', m.upstream],
    ].filter(([, , v]) => v != null && !Number.isNaN(v)).map(([kind, name, v]) => ({ kind, name, mae: v, ratio: v / m.blend }));
    const say = `${station}, ${BLOCK_LABEL[block]}, MAE in cm: blend ${num(m.blend, 1)} · ` +
      marks.map(k => `${k.name} ${num(k.mae, 1)} (×${num(k.ratio, 2)})`).join(' · ') + '.';
    return { station, regime, blend: m.blend, marks, say };
  });
  const calib = stationOrder(report).map(({ station, regime }) => {
    const b = report.stations[station].blocks[block];
    const pit = b.pit || [];
    const total = pit.reduce((a, c) => a + c, 0) || 1;
    return {
      station, regime, tfm: b.picp80.tfm, blend: b.picp80.blend, pit: pit.map(c => c / total),
      say: `${station}, ${BLOCK_LABEL[block]}: the 80 % interval covered ${num(b.picp80.tfm * 100, 0)} % of days (blend band ${num(b.picp80.blend * 100, 0)} %), the 60 % interval ${num(b.picp60.tfm * 100, 0)} %; CRPS ${num(b.crps.tfm, 1)} vs ${num(b.crps.blend, 1)} cm, CRPS skill ${signed(b.ss_crps)}.`,
    };
  });
  const shortModel = short ? {
    verdict: short.verdict, reasons: short.provisional_reasons || [],
    need: short.thresholds.short_origins_min, needRises: short.thresholds.short_rise_events_min,
    stations: Object.entries(short.stations).map(([name, s]) => ({ name, origins: s.origins, rises: s.rise_events, blocks: s.blocks })),
    generated: short.header.generated,
  } : null;
  // the write-up quotes the primary (mid) run whatever the chips say
  const mid = seasonal.mid;
  const koeln = mid.stations['KÖLN'] && mid.stations['KÖLN'].blocks['h31-90'];
  const climLong = Object.entries(mid.stations).map(([n, s]) => ({ n, v: Math.abs(s.blocks['h31-90'].ss_clim_vs_blend) })).sort((a, b) => b.v - a.v);
  const picps = BLOCKS.map(b => mid.pooled.blocks[b].picp80.tfm * 100);
  const pctStr = v => `${Math.round(Math.abs(v) * 100)} %`;
  const story = {
    verdict: mid.verdict,
    h1: pctStr(mid.pooled.blocks['h1-14'].ss),
    h90: pctStr(mid.pooled.blocks['h31-90'].ss),
    h90sign: mid.pooled.blocks['h31-90'].ss < 0 ? 'behind' : 'ahead',
    rhine90: pctStr((mid.regimes['Mittelrhein'] || { blocks: { 'h31-90': { ss: 0 } } }).blocks['h31-90'].ss),
    persistGain: koeln ? pctStr(1 - koeln.mae.blend / koeln.mae.persist) : '—',
    picp: `${Math.round(Math.min(...picps))}–${Math.round(Math.max(...picps))} %`,
    climWorst: climLong[0] ? climLong[0].n : '—',
    climRest: climLong[1] ? pctStr(climLong[1].v) : '—',
    perGauge: Math.round(Object.values(mid.station_info).reduce((a, s) => a + (s.test || 0), 0) / Object.keys(mid.stations).length),
    windows: Object.values(mid.station_info).reduce((a, s) => a + (s.test || 0), 0),
    minutes: Math.max(1, Math.round((mid.header.elapsed_s || 0) / 60)),
  };
  return {
    state, verdict: report.verdict, clauses, block, target: state.target, story,
    head: {
      generated: h.generated, model: h.model, license: h.model_license, checkpoint: h.checkpoint, git: h.git,
      fingerprint: h.config_fingerprint, versions: h.versions, elapsed: h.elapsed_s, reproduced: h.reproduced_by_run,
      windows: Object.values(report.station_info).reduce((a, s) => a + (s.test || 0), 0),
      stations: Object.keys(report.stations).length, regimes: Object.keys(report.regimes).length,
    },
    skill, error, calib, clim, short: shortModel,
    void: report.void || [],
  };
}

// ---------- marks and swatches (drawing and key share these) ----------

const SHAPES = {
  tfm: '<circle cx="6" cy="6" r="4.5"/>',
  blend: '<rect x="5.2" y="0" width="1.6" height="12"/>',
  persist: '<circle cx="6" cy="6" r="4.2"/>',
  clim: '<path d="M6 1.5 L11 10.5 L1 10.5 Z"/>',
  snaive: '<path d="M1 1.5 L11 1.5 L6 10.5 Z"/>',
  up: '<path d="M6 1 L11 6 L6 11 L1 6 Z"/>',
  'picp-t': '<circle cx="6" cy="6" r="4.5"/>',
  'picp-b': '<circle cx="6" cy="6" r="4.2"/>',
};
const mark = (kind, x, extra = '') => `<span class="mk mk-${kind}"${attr('style', `left:${x.toFixed(2)}%`)}${extra}><svg viewBox="0 0 12 12" aria-hidden="true">${SHAPES[kind]}</svg></span>`;
const sw = kind => `<span class="sw mk-${kind}"><svg viewBox="0 0 12 12" aria-hidden="true">${SHAPES[kind]}</svg></span>`;
const swBar = cls => `<span class="sw bar ${cls}"></span>`;

function plateKey(items) {
  return '<dl class="p-key"><dt>key</dt>' + items.filter(Boolean).map(it =>
    it.note != null ? `<dd class="note${it.warn ? ' warn' : ''}">${esc(it.note)}</dd>` :
    `<dd><span class="lg">${it.sw}<span class="lgn">${esc(it.label)}</span></span></dd>`).join('') + '</dl>';
}

function ctlRow(label, items, aria) {
  return `<nav class="p-tabs"${attr('aria-label', aria || label)}>` +
    (label ? `<span class="p-tabs-lbl">${esc(label)}</span>` : '') +
    items.map(it => it.lbl ? `<span class="p-tabs-lbl">${esc(it.lbl)}</span>` :
      `<a${attr('href', it.href)}${attr('class', it.on ? 'on' : '')}${it.on ? ' aria-current="true"' : ''}${attr('title', it.title)}>${esc(it.label)}</a>`).join('') +
    '</nav>';
}

function axis(ticks, domain, fmt) {
  return `<div class="axis"><span></span><div class="ticks">` +
    ticks.map(t => `<span${attr('style', `left:${pct(t, domain).toFixed(2)}%`)}>${esc(fmt(t))}</span>`).join('') +
    `</div><span></span></div>`;
}

const rowOpen = (cls, say) => `<div class="row ${cls}" tabindex="0" role="button"${attr('data-say', say)}>`;
const lbl = (station, regime) => `<span class="lbl">${esc(station)}${regime ? `<span class="rg">${esc(regime)}</span>` : ''}</span>`;

function skillBar(ss, tie) {
  const { x, clipped } = clampInfo(ss, SKILL_DOMAIN);
  const zero = pct(0, SKILL_DOMAIN);
  const left = Math.min(x, zero), width = Math.abs(x - zero);
  const cls = tie ? 'tie' : ss >= 0 ? 'pos' : 'neg';
  return `<span class="bar ${cls}"${attr('style', `left:${left.toFixed(2)}%;width:${width.toFixed(2)}%`)}></span>` +
    (clipped ? `<span class="clip ${clipped}"${attr('style', `left:${x.toFixed(2)}%`)}></span>` : '');
}

// ---------- sections ----------

function renderVerdict(m) {
  const why = m.verdict === 'SHIP'
    ? 'Every pre-registered clause held. The model may ship.'
    : m.verdict === 'VOID'
      ? 'The run is invalid; no verdict was formed.'
      : 'At least one pre-registered clause failed. The model is honest — calibrated, and no better on the recent years than on the old ones — but not better than the blend past two weeks.';
  return `<div class="verdict"><span class="word">${esc(m.verdict)}</span><span class="why">${esc(why)}</span></div>` +
    (m.void.length ? `<ul class="p-empty">${m.void.map(v => `<li>${esc(v)}</li>`).join('')}</ul>` : '') +
    `<ul class="clauses" aria-label="clauses">` + m.clauses.map(c =>
      `<li class="${c.pass ? 'pass' : 'fail'}"><button type="button" aria-pressed="false"${attr('data-say', `${c.id} ${c.pass ? 'passed' : 'failed'} — ${c.text}`)}>` +
      `<span class="g" aria-hidden="true">${c.pass ? '✓' : '✗'}</span><span class="vh">${c.pass ? 'passed' : 'failed'}</span>${esc(c.id)} ${esc(c.name)}</button></li>`).join('') +
    `</ul><p class="p-readout" id="clause-readout"><span class="hint">Pick a clause for what it demanded and what was measured.</span></p>`;
}

function renderControls(m) {
  const s = m.state;
  return ctlRow('target', [
    ...Object.entries(TARGETS).map(([k, label]) => ({ href: stateHref(s, { target: k }), label, on: s.target === k, title: k === 'mid' ? 'the day’s (min+max)/2 — what the archive stores' : 'the day’s maximum — the crest is what matters in a flood' })),
    { lbl: 'horizon' },
    ...BLOCKS.map(b => ({ href: stateHref(s, { block: b }), label: BLOCK_LABEL[b], on: s.block === b })),
  ], 'target and horizon block');
}

function renderSkill(m) {
  const k = m.skill;
  const zero = pct(0, SKILL_DOMAIN), thr = pct(k.threshold, SKILL_DOMAIN);
  const refs = `<span class="zero"${attr('style', `left:${zero.toFixed(2)}%`)}></span><span class="thr"${attr('style', `left:${thr.toFixed(2)}%`)}></span>`;
  const ci = `<span class="ci"${attr('style', `left:${pct(Math.max(SKILL_DOMAIN[0], k.pooled.lo), SKILL_DOMAIN).toFixed(2)}%;width:${(pct(Math.min(SKILL_DOMAIN[1], k.pooled.hi), SKILL_DOMAIN) - pct(Math.max(SKILL_DOMAIN[0], k.pooled.lo), SKILL_DOMAIN)).toFixed(2)}%`)}></span>`;
  const pooledSay = `Pooled over ${k.pooled.stations.join(', ')} (${k.pooled.n} test origins each, ${BLOCK_LABEL[m.block]}): skill ${signed(k.pooled.ss)}, moving-block bootstrap 95 % CI ${signed(k.pooled.lo)} to ${signed(k.pooled.hi)}. Clause A1 asks for ${signed(k.threshold, 2)}.`;
  const rows = rowOpen('pooled', pooledSay) + `<span class="lbl">pooled · 5 regimes</span><span class="track">${refs}${skillBar(k.pooled.ss, false)}${ci}</span><span class="val">${esc(signed(k.pooled.ss))}</span></div>` +
    k.rows.map(r => rowOpen('', r.say) + lbl(r.station, r.regime) + `<span class="track">${refs}${skillBar(r.ss, r.tie)}</span>` +
      `<span class="val">${esc(signed(r.ss))}${r.sig ? ' <span class="sig" title="DM p below 0.10">●</span>' : ''}</span></div>`).join('');
  const regimeLine = k.regimes.map(r => `${r.name} ${signed(r.ss)}`).join(' · ');
  const table = `<details class="tbl"><summary>table</summary><div class="tblwrap"><table><thead><tr><th>station</th><th>regime</th><th>TimesFM MAE</th><th>blend MAE</th><th>skill</th><th>tie</th><th>DM z</th><th>p</th></tr></thead><tbody>` +
    k.rows.map(r => `<tr><td>${esc(r.station)}</td><td>${esc(r.regime)}</td><td>${num(r.model, 1)}</td><td>${num(r.blend, 1)}</td><td>${signed(r.ss)}</td><td>${r.tie ? 'yes' : 'no'}</td><td>${num(r.z, 2)}</td><td>${pval(r.p)}</td></tr>`).join('') +
    `</tbody></table></div></details>`;
  return `<section class="p-block"><h2 class="p-h2">Skill against the blend · ${esc(TARGETS[m.target])} · ${esc(BLOCK_LABEL[m.block])}</h2>` +
    `<p class="p-dim">1 − MAE<sub>TimesFM</sub> / MAE<sub>blend</sub>. Positive means the model beat the persistence-to-climatology blend; the bar had to reach ${esc(signed(k.threshold, 2))} pooled. Regime medians: ${esc(regimeLine)}.</p>` +
    `<div class="rows">${rows}</div>` + axis([-0.2, -0.1, 0, 0.1, 0.2], SKILL_DOMAIN, v => signed(v, 1)) +
    `<p class="p-readout" data-readout><span class="hint">Hover or pick a row for the numbers behind it.</span></p>` +
    plateKey([
      { sw: swBar('pos'), label: 'better than the blend' },
      { sw: swBar('neg'), label: 'worse than the blend' },
      { sw: swBar('tie'), label: 'a tie — under 2 cm apart, neither win nor loss' },
      { sw: '<span class="sw"><span class="ci" style="position:relative;display:block;top:5px;width:12px"></span></span>', label: 'bootstrap 95 % CI (pooled row)' },
      { sw: '<span class="sw"><span class="thr" style="position:relative;display:block;height:12px;left:6px"></span></span>', label: 'the A1 bar, +0.10' },
      { sw: '<span class="sw" style="text-align:center;color:var(--water-line)">●</span>', label: 'Diebold-Mariano p below 0.10 (Newey-West, lag 13)' },
      { note: 'The three Rhine gauges lie on 97 river-km of one chain and vote as one regime, by their median.' },
    ]) + table + '</section>';
}

function renderError(m) {
  const one = pct(1, RATIO_DOMAIN);
  const rows = m.error.map(r => rowOpen('', r.say) + lbl(r.station, r.regime) +
    `<span class="track"><span class="one"${attr('style', `left:${one.toFixed(2)}%`)}></span>` +
    r.marks.map(k => { const { x, clipped } = clampInfo(k.ratio, RATIO_DOMAIN); return mark(k.kind, x) + (clipped ? `<span class="clip ${clipped}"${attr('style', `left:${x.toFixed(2)}%`)}></span>` : ''); }).join('') +
    `</span><span class="val">${esc(num(r.blend, 1))} cm</span></div>`).join('');
  const table = `<details class="tbl"><summary>table</summary><div class="tblwrap"><table><thead><tr><th>station</th><th>blend</th><th>TimesFM</th><th>persistence</th><th>climatology</th><th>seasonal naive</th><th>upstream OLS</th></tr></thead><tbody>` +
    m.error.map(r => { const g = kind => { const k = r.marks.find(x => x.kind === kind); return k ? num(k.mae, 1) : '—'; };
      return `<tr><td>${esc(r.station)}</td><td>${num(r.blend, 1)}</td><td>${g('tfm')}</td><td>${g('persist')}</td><td>${g('clim')}</td><td>${g('snaive')}</td><td>${g('up')}</td></tr>`; }).join('') +
    `</tbody></table></div></details>`;
  return `<section class="p-block"><h2 class="p-h2">Mean absolute error, relative to the blend · ${esc(BLOCK_LABEL[m.block])}</h2>` +
    `<p class="p-dim">Each method's MAE divided by the blend's, so a 15 cm gauge and a 100 cm gauge share one axis. Left of the line is better than the blend. The value column is the blend's own MAE in cm.</p>` +
    `<div class="rows">${rows}</div>` + axis([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2], RATIO_DOMAIN, v => '×' + v.toFixed(2)) +
    `<p class="p-readout" data-readout><span class="hint">Hover or pick a row for the MAE of every method in cm.</span></p>` +
    plateKey([
      { sw: sw('tfm'), label: 'TimesFM 2.5' },
      { sw: sw('blend'), label: 'the blend (×1.00)' },
      { sw: sw('persist'), label: 'persistence — the MASE denominator, not the bar' },
      { sw: sw('clim'), label: 'climatology (day-of-year mean of earlier years)' },
      { sw: sw('snaive'), label: 'seasonal naive — the value 365 days before' },
      { sw: sw('up'), label: 'upstream OLS (KÖLN from MAXAU; reference only)' },
      { note: 'Beyond a month climatology sits within 2 % of the blend at every gauge but Dresden — a seasonal outlook is a lookup table.' },
    ]) + table + '</section>';
}

function renderCalib(m) {
  const band = `<span class="band"${attr('style', `left:${pct(0.72, PICP_DOMAIN).toFixed(2)}%;width:${(pct(0.88, PICP_DOMAIN) - pct(0.72, PICP_DOMAIN)).toFixed(2)}%`)}></span><span class="thr"${attr('style', `left:${pct(0.8, PICP_DOMAIN).toFixed(2)}%`)}></span>`;
  const rows = m.calib.map(r => {
    const xt = pct(r.tfm, PICP_DOMAIN), xb = pct(r.blend, PICP_DOMAIN);
    return rowOpen('', r.say) + lbl(r.station, r.regime) + `<span class="track">${band}` +
      `<span class="link"${attr('style', `left:${Math.min(xt, xb).toFixed(2)}%;width:${Math.abs(xt - xb).toFixed(2)}%`)}></span>` +
      mark('picp-b', xb) + mark('picp-t', xt) + `</span><span class="val">${esc(num(r.tfm * 100, 0))} %</span></div>`;
  }).join('');
  const pits = m.calib.map(r => {
    const bars = r.pit.map((f, i) => `<rect class="pb" x="${(i * 10 + 0.8).toFixed(1)}" y="${(30 - f * 100).toFixed(2)}" width="8.4" height="${(f * 100).toFixed(2)}"/>`).join('');
    return `<div class="pit"><span class="nm">${esc(r.station)}</span><svg viewBox="0 0 100 30" preserveAspectRatio="none" role="img"${attr('aria-label', `${r.station}: PIT histogram, ten bins, ` + r.pit.map(f => num(f * 100, 0) + '%').join(' '))}>${bars}<line class="pu" x1="0" y1="20" x2="100" y2="20"/></svg></div>`;
  }).join('');
  const table = `<details class="tbl"><summary>table</summary><div class="tblwrap"><table><thead><tr><th>station</th><th>PICP80 TimesFM</th><th>PICP80 blend</th>${Array.from({ length: 10 }, (_, i) => `<th>PIT ${i}</th>`).join('')}</tr></thead><tbody>` +
    m.calib.map(r => `<tr><td>${esc(r.station)}</td><td>${num(r.tfm, 3)}</td><td>${num(r.blend, 3)}</td>${r.pit.map(f => `<td>${num(f * 100, 1)}</td>`).join('')}</tr>`).join('') +
    `</tbody></table></div></details>`;
  return `<section class="p-block"><h2 class="p-h2">Calibration · ${esc(BLOCK_LABEL[m.block])}</h2>` +
    `<p class="p-dim">How often the model's 80 % interval actually contained the reading. Inside the shaded band is clause A5; the dashed line is the ideal 80 %. Below, the PIT histograms: a flat profile means the deciles are honest, a U means the band is too narrow, a hump too wide.</p>` +
    `<div class="rows">${rows}</div>` + axis([0.6, 0.7, 0.8, 0.9, 1.0], PICP_DOMAIN, v => num(v * 100, 0) + ' %') +
    `<p class="p-readout" data-readout><span class="hint">Hover or pick a row for coverage and CRPS.</span></p>` +
    `<div class="pits">${pits}</div>` +
    plateKey([
      { sw: sw('picp-t'), label: 'TimesFM, 80 % interval coverage' },
      { sw: sw('picp-b'), label: 'the blend with its own residual deciles' },
      { sw: '<span class="sw"><span class="band" style="position:relative;display:block;height:12px;width:12px"></span></span>', label: 'accepted range 72–88 %' },
      { sw: '<span class="sw"><span class="thr" style="position:relative;display:block;height:12px;left:6px"></span></span>', label: 'ideal 80 %' },
      { sw: '<span class="sw"><svg viewBox="0 0 12 12" aria-hidden="true"><rect class="pb" x="1" y="4" width="4" height="8"/><rect class="pb" x="7" y="2" width="4" height="10"/></svg></span>', label: 'PIT histogram: share of readings that fell at or below each decile' },
      { sw: '<span class="sw"><svg viewBox="0 0 12 12" aria-hidden="true"><line class="pu" x1="0" y1="6" x2="12" y2="6"/></svg></span>', label: 'the flat 10 % a calibrated model would show' },
    ]) + table + '</section>';
}

function renderClim(m) {
  const zero = pct(0, SKILL_DOMAIN);
  const rows = m.clim.rows.map(r => rowOpen('', r.say) + lbl(r.station, r.regime) +
    `<span class="track"><span class="zero"${attr('style', `left:${zero.toFixed(2)}%`)}></span>${skillBar(r.ss, r.tie)}</span><span class="val">${esc(signed(r.ss))}</span></div>`).join('');
  return `<section class="p-block"><h2 class="p-h2">Finding 2 · climatology alone against the blend · ${esc(BLOCK_LABEL[m.block])}</h2>` +
    `<p class="p-dim">The same skill score, but for plain day-of-year climatology with no knowledge of today's level. Switch the horizon: at days 1–14 it is far behind, at days 31–90 it is a tie almost everywhere — the long horizon needs no model, only a calendar.</p>` +
    `<div class="rows">${rows}</div>` + axis([-0.2, -0.1, 0, 0.1, 0.2], SKILL_DOMAIN, v => signed(v, 1)) +
    `<p class="p-readout" data-readout><span class="hint">Hover or pick a row.</span></p>` +
    plateKey([
      { sw: swBar('pos'), label: 'climatology better than the blend' },
      { sw: swBar('neg'), label: 'climatology worse (values below −0.20 are clipped, marked ◂)' },
      { sw: swBar('tie'), label: 'a tie' },
    ]) + '</section>';
}

function renderShort(m) {
  const s = m.short;
  if (!s) return '';
  const rows = s.stations.map(st => {
    const o = Math.min(100, (st.origins / s.need) * 100);
    const say = `${st.name}: ${st.origins} of ${s.need} independent 48-hour origins collected, ${st.rises} rise events (${s.needRises} needed). ` +
      Object.entries(st.blocks).map(([b, v]) => `${b}: TimesFM ${num(v.mae.tfm_point, 1)} cm vs best simple baseline (${v.best_baseline}) ${num(v.mae[v.best_baseline], 1)} cm, skill ${signed(v.ss_vs_best)}`).join('; ') + '.';
    return rowOpen('', say) + `<span class="lbl">${esc(st.name)}</span><span class="track"><span class="meter" style="position:relative;display:block;height:100%"><span${attr('style', `width:${o.toFixed(1)}%`)}></span></span></span><span class="val">${esc(st.origins)} / ${esc(s.need)}</span></div>`;
  }).join('');
  const blocks = s.stations.length ? Object.keys(s.stations[0].blocks) : [];
  const table = `<details class="tbl"><summary>first-week numbers (no verdict)</summary><div class="tblwrap"><table><thead><tr><th>station</th><th>origins</th><th>rises</th>${blocks.map(b => `<th>${esc(b)} TimesFM</th><th>best baseline</th><th>skill</th>`).join('')}</tr></thead><tbody>` +
    s.stations.map(st => `<tr><td>${esc(st.name)}</td><td>${st.origins}</td><td>${st.rises}</td>${blocks.map(b => { const v = st.blocks[b]; return `<td>${num(v.mae.tfm_point, 1)}</td><td>${esc(v.best_baseline)} ${num(v.mae[v.best_baseline], 1)}</td><td>${signed(v.ss_vs_best)}</td>`; }).join('')}</tr>`).join('') +
    `</tbody></table></div></details>`;
  return `<section class="p-block"><h2 class="p-h2">Short horizon (hours to two days) · ${esc(s.verdict)}</h2>` +
    `<p class="p-dim">The daily archive keeps day extremes only, so 15-minute readings are being collected weekly since 2026-09-02. The verdict stays PROVISIONAL until every gauge has ${esc(s.need)} independent origins (about sixteen weeks) and ${esc(s.needRises)} rise events; it can never be SHIP before that.</p>` +
    `<div class="rows">${rows}</div>` +
    `<p class="p-readout" data-readout><span class="hint">Hover or pick a gauge for its first-week numbers.</span></p>` +
    plateKey([
      { sw: '<span class="meter sw" style="display:inline-block;width:12px;height:12px"><span style="width:60%"></span></span>', label: `independent 48-hour origins collected, of the ${s.need} the gate needs` },
      { note: `Collected ${esc(s.generated)}. Ten origins is a month of data; nothing here is a result yet.` },
    ]) + table + '</section>';
}

// the write-up: what was tried, why the bar sits where it sits, and what the
// one word above cost — prose for the reader who came from the main page
function renderStory(m) {
  const k = m.story;
  return `<section class="p-block prose" id="writeup"><h2 class="p-h2">Write-up · a brand-new model meets 26 years of river data</h2>` +
    `<p><b>The question.</b> PEGEL:// draws what a river did and what it does right now, never what it will do. In 2026 that stopped being a given: Google's <b>TimesFM 2.5</b> is a 200-million-parameter foundation model for time series that forecasts <em>zero-shot</em> — no training on the data at hand, a <code>pip install</code> and a checkpoint. It is the first thing of its kind a one-file website could plausibly run against 737 gauges without keeping 737 models alive. So before drawing a single forecast line we asked the only question that matters: can it beat something trivial?</p>` +
    `<p><b>What we did.</b> We took the daily archive this site already hosts — every gauge since 2000, condensed to day min/max — and built a backtest: 1 024 days of history in, 90 days out, one origin every week, ${esc(k.perGauge)} test origins per gauge from 2016 to 2025 on seven gauges chosen for their regimes: the sluggish Rhine, the continental Elbe, the alpine Danube, the flashy Saar, the tidal North Sea coast. The whole thing ran on a laptop CPU — ${esc(k.minutes)} minutes for ${esc(thousands(k.windows))} windows — and then once more, to prove it reproduces bit for bit. Every threshold, the model configuration and even the tie rule were written down before the first run, because a test set you re-run after peeking is no longer a test.</p>` +
    `<p><b>The bar.</b> Not persistence. Persistence — "tomorrow is today" — is the opponent that makes every model look brilliant at three months; we measured that a two-line blend, today's level decaying into the day-of-year norm with one time constant per gauge, already beats it by ${esc(k.persistGain)} there at KÖLN. That blend is the bar, and the model had to beat <em>it</em> by ten percent, pooled, in every horizon block, with confidence intervals that respect overlapping windows and with the three Rhine gauges counted as one vote.</p>` +
    `<p><b>The answer.</b> ${esc(k.verdict)}. TimesFM is a genuinely good forecaster: at two weeks it beats the blend by ${esc(k.h1)} — real, significant, and short of the bar. At a month it is a draw. At three months it is ${esc(k.h90)} ${esc(k.h90sign)}, ${esc(k.rhine90)} behind on the Rhine. Its uncertainty bands are honest (coverage ${esc(k.picp)} where 80 was asked), it forecasts recent years no worse than old ones, and the daily maximum tells the same story as the daily mean. The quiet finding underneath is worth more than the loud one: beyond a month, plain climatology — a calendar lookup — sits within ${esc(k.climRest)} of the bar at every gauge but ${esc(k.climWorst)}. The long horizon needs no model at all.</p>` +
    `<p><b>What it cost and what it bought.</b> One evening, a 2.5 GB download and about 700 lines of Python that now live in the repository as a permanent instrument. It bought a clean no: no forecast view, no Python in the deploy, no model weights to licence-check every release (the 3.0 line went non-commercial on 2026-08-28, which is why the gate pins 2.5). What may follow is a seasonal outlook drawn from the archive alone, and a second verdict on the <em>short</em> horizon — hours to two days — for which 15-minute readings are now collected weekly and mirrored into a data branch, because the archive never kept them. That verdict is due around the turn of the year and can be no better than the data it waits for.</p>` +
    `<p class="p-dim">Every number in this write-up is read from the committed report below; the code is under <a href="https://github.com/bmmmm/pegel-visual/tree/main/scripts/forecast">scripts/forecast</a>, the markdown reports sit beside this page.</p></section>`;
}

function renderMethod(m) {
  const h = m.head;
  return `<section class="p-block prose"><h2 class="p-h2">How it was measured</h2>` +
    `<p>Rolling-origin backtest on the daily archive, closed years 2000–2025: 1 024 days of context, 90 days of horizon, one origin every 7 days. Origins before 2016 (676 per gauge) fit the blend's τ and its residual deciles; origins from 2016 (${esc(h.windows / h.stations)} per gauge, ${esc(h.windows)} in all) are scored. A 90-day embargo separates the two.</p>` +
    `<p>The bar is the <b>blend</b> — e<sup>−h/τ</sup>·today + (1 − e<sup>−h/τ</sup>)·climatology(day) — not persistence: at days 31–90 the blend already beats persistence by a quarter, so a win over persistence would be a win over nothing. Overlapping windows are not independent samples: significance comes from Diebold-Mariano tests with a Newey-West variance (lag 13) and a moving-block bootstrap over origins (block 26), and the Rhine trio votes once, by its median.</p>` +
    `<ul><li>Every threshold and the ForecastConfig were fixed before the first model run; a run with a different config, a truncated grid, or one that does not reproduce bit for bit is VOID, not a verdict.</li>` +
    `<li>TimesFM 2.5 has no published corpus manifest. PEGELONLINE is open and CAMELS-DE covers German basins, so 2000–2024 may be in its training data. Clause A7 compares recent against old origins; it is a probe, not a proof.</li>` +
    `<li>The blend's τ and residual deciles are fitted on the pre-2016 origins, which favours the blend slightly on A7's old side.</li>` +
    `<li>The daily-max target run (switch the target chip above) tells the same story: the crest is no easier to forecast than the mid.</li></ul></section>`;
}

function renderFoot(m) {
  const h = m.head;
  const v = h.versions || {};
  return `<footer id="plate-foot">` +
    `<p><span class="lbl">model</span>${esc(h.model)} · ${esc(h.checkpoint)} · ${esc(h.license)} · timesfm ${esc(v.timesfm)} · torch ${esc(v.torch)} · numpy ${esc(v.numpy)} · config ${esc(h.fingerprint)}</p>` +
    `<p><span class="lbl">run</span>${esc(h.generated)} · git ${esc(h.git)} · ${esc(num(h.elapsed, 0))} s on CPU, float32` +
    (h.reproduced ? ` · reproduced bit for bit by a second full run at ${esc(h.reproduced)}` : ' · second full run: not compared') + `</p>` +
    `<p><span class="lbl">source</span>PEGELONLINE (WSV) daily archive on the <a href="https://github.com/bmmmm/pegel-visual/tree/archive">archive branch</a> · ` +
    `<a href="seasonal-mid/report.md">report (mid)</a> · <a href="seasonal-max/report.md">report (max)</a> · <a href="short-mid/report.md">report (short)</a> · ` +
    `<a href="https://github.com/bmmmm/pegel-visual/tree/main/scripts/forecast">the gate's code</a></p>` +
    `<p><span class="lbl">not</span>a forecast product. Nothing on this sheet predicts a river; it measures whether a model could, and the answer was no.</p>` +
    `</footer>`;
}

export function screenSummary(m) {
  const k = m.skill;
  return `Forecast gate, ${m.verdict}. TimesFM 2.5 against the persistence-to-climatology blend, ${TARGETS[m.target]} target, ${BLOCK_LABEL[m.block]}: pooled skill ${signed(k.pooled.ss)} with a 95 % interval from ${signed(k.pooled.lo)} to ${signed(k.pooled.hi)}. ` +
    `${m.clauses.filter(c => c.pass).length} of ${m.clauses.length} clauses passed.`;
}

export function renderPage(m) {
  return `<p class="vh">${esc(screenSummary(m))}</p>` +
    `<header class="p-head"><h1><a href="../">PEGEL://</a> · FORECAST GATE</h1>` +
    `<p class="p-sub">Can a zero-shot model beat a persistence-to-climatology blend on the daily archive? ${esc(m.head.stations)} gauges in ${esc(m.head.regimes)} regimes, ${esc(thousands(m.head.windows))} test windows, measured ${esc(String(m.head.generated).slice(0, 10))}.</p></header>` +
    renderVerdict(m) +
    renderStory(m) +
    renderControls(m) +
    renderSkill(m) + renderError(m) + renderCalib(m) + renderClim(m) + renderShort(m) + renderMethod(m) + renderFoot(m);
}

// ---------- the page ----------

async function getJson(url) {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

function wire(root) {
  // the fixed readout under each chart: hover, focus or pick a row, and the
  // numbers behind it appear in prose — no floating tooltip to chase on touch
  const show = el => {
    const say = el.getAttribute('data-say');
    if (!say) return;
    const box = el.closest('section') ? el.closest('section').querySelector('[data-readout]') : root.querySelector('#clause-readout');
    if (box) box.innerHTML = `<b>${esc(say)}</b>`;
    if (el.tagName === 'BUTTON') {
      for (const b of root.querySelectorAll('.clauses button')) b.setAttribute('aria-pressed', String(b === el));
    }
  };
  root.addEventListener('click', e => { const el = e.target.closest('[data-say]'); if (el) show(el); });
  root.addEventListener('mouseover', e => { const el = e.target.closest('.row[data-say]'); if (el) show(el); });
  root.addEventListener('focusin', e => { const el = e.target.closest('[data-say]'); if (el) show(el); });
  root.addEventListener('keydown', e => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('.row[data-say]')) { e.preventDefault(); show(e.target); }
  });
  // the chips are real links; intercept so the filter row re-renders in place
  root.addEventListener('click', e => {
    const a = e.target.closest('.p-tabs a');
    if (!a || e.metaKey || e.ctrlKey || e.button !== 0) return;
    e.preventDefault();
    history.pushState(null, '', a.getAttribute('href'));
    draw();
  });
}

let reports = null;
let root = null;

function draw() {
  if (!reports) return;
  const state = parseState(location.search);
  const m = buildModel(reports, state);
  root.innerHTML = renderPage(m);
  document.title = `PEGEL:// gate · ${m.verdict}`;
}

export async function main() {
  root = document.getElementById('plate');
  const [mid, max, short] = await Promise.all([getJson('seasonal-mid/report.json'), getJson('seasonal-max/report.json'), getJson('short-mid/report.json')]);
  if (!mid) {
    root.innerHTML = '<div class="p-empty"><p>The gate report could not be loaded.</p><p class="p-dim">seasonal-mid/report.json did not answer — the deploy may still be running.</p></div>';
    return;
  }
  reports = { seasonal: { mid, max: max || undefined }, short: short || undefined };
  wire(root);
  window.addEventListener('popstate', draw);
  draw();
}

if (typeof document !== 'undefined' && document.getElementById('plate')) main();
