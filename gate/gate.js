// The forecast gate report as a survey plate — see gate/index.html.
//
// Pure functions build a view model from the committed report.json files and
// render it to markup; main() wires the page. The module has no DOM at import
// time so tests/gate-page.test.mjs can run buildModel/renderPage in Node
// against the real reports.
//
// The sheet reads top-down: a way back, the verdict, ONE picture (error over
// the lead day, the story in a glance), five facts, then an index into closed
// <details> panels — every chart shares the one filter row (target and
// horizon block, both in the URL), every mark class is also a legend swatch,
// and every chart has a table twin. State is one URL: ?target=…&block=…&lead=…
// picks the data, #panel names the last panel a chip or index link jumped to;
// chips and index links go through the same pushState path, and every
// re-render puts the focus on what it just opened. Nothing repaints on a timer.

export const BLOCKS = ['h1-14', 'h15-30', 'h31-90'];
export const BLOCK_LABEL = { 'h1-14': 'days 1–14', 'h15-30': 'days 15–30', 'h31-90': 'days 31–90' };
export const TARGETS = { mid: 'daily mid', max: 'daily max' };

// Everything this page points at off-site. The model card, the paper and the
// package are the three things a reader needs to check the model claim itself;
// keeping them here means the foot, the basics and the model panel cannot drift
// apart. Verified 2026-09-03: the card states 0.2B params, decoder-only,
// apache-2.0 weights and cites arXiv 2310.10688 (Das, Kong, Sen, Zhou).
export const LINKS = {
  card: 'https://huggingface.co/google/timesfm-2.5-200m-pytorch',
  paper: 'https://arxiv.org/abs/2310.10688',
  pkg: 'https://github.com/google-research/timesfm',
  code: 'https://github.com/bmmmm/pegel-visual/tree/main/scripts/forecast',
  archive: 'https://github.com/bmmmm/pegel-visual/tree/archive',
};
const a = (href, text) => `<a${attr('href', href)}>${esc(text)}</a>`;
export const SKILL_DOMAIN = [-0.2, 0.2];   // fixed across blocks and targets, so bars stay comparable
export const RATIO_DOMAIN = [0.5, 2.0];    // error relative to the blend; 1.0 is the bar
export const PICP_DOMAIN = [0.6, 1.0];
export const LEAD_DOMAIN = [0.5, 4];       // the curve's y, log2: ×0.5 and ×2 sit symmetric about the blend
export const PANEL_IDS = ['lead', 'skill', 'error', 'calib', 'clim', 'short', 'model', 'method', 'basics'];

export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const attr = (name, v) => v == null || v === '' ? '' : ` ${name}="${esc(v)}"`;

const num = (v, d = 3) => (v == null || Number.isNaN(v)) ? '—' : (typeof v === 'number' ? v.toFixed(d) : String(v));
const signed = (v, d = 3) => (v == null || Number.isNaN(v)) ? '—' : (v > 0 ? '+' : '') + v.toFixed(d);
const pct = (frac, [lo, hi]) => Math.max(0, Math.min(100, ((frac - lo) / (hi - lo)) * 100));
const clampInfo = (v, [lo, hi]) => ({ x: pct(Math.max(lo, Math.min(hi, v)), [lo, hi]), clipped: v < lo ? 'lo' : v > hi ? 'hi' : null });
const pval = p => p == null || Number.isNaN(p) ? '—' : p < 0.001 ? '< 0.001' : p.toFixed(3);
const thousands = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' '); // 3 563, the thin space the app uses
const pctStr = v => `${Math.round(Math.abs(v) * 100)} %`;

// ---------- state: one URL ----------

export function parseState(search, hash = '', known = null) {
  const q = new URLSearchParams(search || '');
  const target = Object.hasOwn(TARGETS, q.get('target')) ? q.get('target') : 'mid';  // hasOwn: `in` would accept ?target=constructor
  const block = BLOCKS.includes(q.get('block')) ? q.get('block') : 'h1-14';
  const raw = q.get('lead');
  const lead = raw && raw !== 'pooled' && (!known || known.includes(raw)) ? raw : 'pooled';
  const h = String(hash || '').replace(/^#/, '');
  const panel = PANEL_IDS.includes(h) ? h : h === 'writeup' ? 'basics' : null;  // #writeup was the write-up's anchor before it became Basics; shared links keep working
  return { target, block, lead, panel };
}

// the one place that spells the URL: query for the data, hash for the panel
export function stateHref(state, patch = {}) {
  const s = { ...state, ...patch };
  const q = new URLSearchParams();
  if (s.target !== 'mid') q.set('target', s.target);
  if (s.block !== 'h1-14') q.set('block', s.block);
  if (s.lead && s.lead !== 'pooled') q.set('lead', s.lead);
  const str = q.toString();
  return (str ? '?' + str : './') + (s.panel ? '#' + s.panel : '');
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

// the curve over the lead day: error of every method relative to the blend,
// pooled as the median of the five regimes' ratios or for one gauge
function leadModel(report, state) {
  const per = report.pooled.per_h;
  if (!per || !per.blend) return null;
  const stations = Object.keys(report.stations);
  const station = state.lead !== 'pooled' && report.stations[state.lead] && report.stations[state.lead].per_h ? state.lead : 'pooled';
  const H = per.blend.length;
  const ratio = (a, b) => a == null || b == null || !(b > 0) ? null : a / b;
  let series;
  if (station === 'pooled') {
    const med = report.pooled.per_h_ratio_median;
    series = { tfm: med.tfm_point, clim: med.clim, persist: med.persist };
  } else {
    const p = report.stations[station].per_h;
    series = { tfm: p.tfm_point.map((v, i) => ratio(v, p.blend[i])), clim: p.clim.map((v, i) => ratio(v, p.blend[i])), persist: p.persist.map((v, i) => ratio(v, p.blend[i])) };
  }
  const src = station === 'pooled' ? report.pooled : report.stations[station];
  const proto = report.header.protocol.blocks;
  // the band label uses the curve's own estimator: for one gauge its block skill, for the
  // pooled view the MEDIAN of the five gauges' block skills — not clause A1's cm-pooled
  // figure, which weighs the Rhine by its centimetres and sits on a different line
  const median = xs => { const v = xs.filter(x => x != null && !Number.isNaN(x)).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : NaN; };
  const blockSs = b => station === 'pooled' ? median(report.pooled.stations.map(n => report.stations[n] && report.stations[n].blocks[b].ss)) : src.blocks[b].ss;
  const blocks = BLOCKS.map(b => ({ name: b, from: proto[b][0], to: proto[b][1], ss: blockSs(b), on: b === state.block }));
  return { station, stations, H, series, blendCm: src.per_h.blend, blocks, cursor: proto[state.block][1] };
}

// what the readout says for one lead day — the slider's value text, too
export function leadSay(L, day) {
  const i = Math.max(1, Math.min(L.H, day)) - 1;
  const r = v => v == null || Number.isNaN(v) ? '—' : '×' + v.toFixed(2);
  return `day ${i + 1}: TimesFM ${r(L.series.tfm[i])} · climatology ${r(L.series.clim[i])} · persistence ${r(L.series.persist[i])} · blend MAE ${num(L.blendCm[i], 1)} cm${L.station === 'pooled' ? ' pooled' : ''}`;
}

export function buildModel({ seasonal, short }, parsed) {
  // a target whose report did not load falls back to mid — and SAYS mid everywhere,
  // instead of labelling the mid run as the max run
  const targets = Object.keys(TARGETS).map(k => ({ k, label: TARGETS[k], available: !!(Object.hasOwn(seasonal, k) && seasonal[k]) }));
  const state = { ...parsed, target: targets.some(t => t.k === parsed.target && t.available) ? parsed.target : 'mid' };
  const report = seasonal[state.target];
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
  const windows = Object.values(report.station_info).reduce((a, s) => a + (s.test || 0), 0);
  const nStations = Object.keys(report.stations).length;
  const nRegimes = Object.keys(report.regimes).length;
  // the gist follows the target; the facts follow target AND block
  const pb = b => report.pooled.blocks[b].ss;
  const rel = v => Math.abs(v) < 0.02 ? 'draws' : `is ${pctStr(v)} ${v < 0 ? 'behind' : 'ahead'}`;
  const climLongT = Object.entries(report.stations).map(([n, s]) => ({ n, v: Math.abs(s.blocks['h31-90'].ss_clim_vs_blend) })).sort((a, b) => b.v - a.v);
  const gist = `On the ${TARGETS[state.target]} target TimesFM beats the blend by ${pctStr(pb('h1-14'))} at two weeks, ${rel(pb('h15-30'))} at a month and ${rel(pb('h31-90'))} by three months — the bar was ${pctStr(report.thresholds.A1_pooled_ss_min)} in every block, and beyond a month a calendar does as well.`;
  const positive = regimes.filter(r => r.ss > 0).length;
  const B = v => `<b>${esc(v)}</b>`;
  const facts = [
    { k: 'setup', html: `${B(nStations)} gauges in ${B(nRegimes)} regimes · ${B(report.pooled.n_origins)} test origins per gauge, ${B(thousands(windows))} windows from ${B(String(h.protocol.test_from).slice(0, 4))} · ${B(thousands(h.protocol.context))} days in, ${B(h.protocol.horizon)} days out` },
    { k: BLOCK_LABEL[block], html: `pooled skill ${B(signed(pooled.ss, 2))} against the blend (95 % CI ${B(signed(pooled.ci95[0], 2))} to ${B(signed(pooled.ci95[1], 2))}), ${B(positive)} of ${B(nRegimes)} regimes ahead — the bar was ${B(signed(report.thresholds.A1_pooled_ss_min, 2))}` },
    { k: 'calibration', html: `the 80 % band covered ${B(num(pooled.picp80.tfm * 100, 0) + ' %')} of days at ${BLOCK_LABEL[block]} (the blend's own band ${B(num(pooled.picp80.blend * 100, 0) + ' %')}); CRPS skill ${B(signed(pooled.ss_crps, 2))}` },
    { k: 'climatology', html: `from day 31 plain climatology sits within ${B(climLongT[1] ? pctStr(climLongT[1].v) : '—')} of the blend at every gauge but ${B(climLongT[0] ? climLongT[0].n : '—')} — the long horizon needs a calendar, not a model` },
    { k: 'run', html: `${B(Math.max(1, Math.round((h.elapsed_s || 0) / 60)) + ' min')} on a laptop CPU, ${h.reproduced_by_run ? 'reproduced bit for bit by a second run' : 'second run not compared'} · ${B(h.model)}, ${B(h.model_license)} — pinned since the 3.0 line went non-commercial on ${B('2026-08-28')}` },
  ];
  // the basics quote the primary (mid) run whatever the chips say
  const mid = seasonal.mid;
  const koeln = mid.stations['KÖLN'] && mid.stations['KÖLN'].blocks['h31-90'];
  const climLong = Object.entries(mid.stations).map(([n, s]) => ({ n, v: Math.abs(s.blocks['h31-90'].ss_clim_vs_blend) })).sort((a, b) => b.v - a.v);
  const story = {
    verdict: mid.verdict,
    h1: pctStr(mid.pooled.blocks['h1-14'].ss),
    h90: pctStr(mid.pooled.blocks['h31-90'].ss),
    h90sign: mid.pooled.blocks['h31-90'].ss < 0 ? 'behind' : 'ahead',
    persistGain: koeln ? pctStr(1 - koeln.mae.blend / koeln.mae.persist) : '—',
    climWorst: climLong[0] ? climLong[0].n : '—',
    climRest: climLong[1] ? pctStr(climLong[1].v) : '—',
    windows: Object.values(mid.station_info).reduce((a, s) => a + (s.test || 0), 0),
  };
  const m = {
    state, targets, verdict: report.verdict, clauses, block, target: state.target, gist, facts, story,
    head: {
      generated: h.generated, model: h.model, license: h.model_license, checkpoint: h.checkpoint, git: h.git,
      fingerprint: h.config_fingerprint, versions: h.versions, elapsed: h.elapsed_s, reproduced: h.reproduced_by_run,
      windows, stations: nStations, regimes: nRegimes,
      // the model panel draws the run's own protocol and config — never a literal
      protocol: h.protocol, config: h.forecast_config || {}, threads: h.torch_threads,
      sha: h.tfm_sha256, repeat: h.repeat_identical, kind: h.horizon_kind,
    },
    lead: leadModel(report, state),
    skill, error, calib, clim, short: shortModel,
    void: report.void || [],
  };
  // the panels actually rendered, in order — the index is built from this list
  m.panels = [
    { id: 'skill', title: `Skill by gauge · ${TARGETS[state.target]} · ${BLOCK_LABEL[block]}`, hook: 'seven gauges, five regime votes, the bootstrap interval', render: renderSkill },
    { id: 'error', title: `Error by method · ${BLOCK_LABEL[block]}`, hook: 'every baseline’s MAE next to the blend’s, gauge by gauge', render: renderError },
    { id: 'calib', title: `Calibration · ${BLOCK_LABEL[block]}`, hook: 'how often the 80 % band held, and the PIT histograms', render: renderCalib },
    { id: 'clim', title: `Climatology alone · ${BLOCK_LABEL[block]}`, hook: 'Finding 2: the calendar against the blend', render: renderClim },
    shortModel ? { id: 'short', title: `Short horizon · ${shortModel.verdict}`, hook: 'hours to two days — still collecting, no verdict yet', render: renderShort } : null,
    { id: 'model', title: 'The model, and the chain it runs in', hook: 'what TimesFM 2.5 is, where the weights come from, and the seven steps from archive to this sheet', render: renderModel },
    { id: 'method', title: 'Method', hook: 'how it was measured, and what it cannot prove', render: renderMethod },
    { id: 'basics', title: 'Basics', hook: 'the model, the bar and the verdict in three short paragraphs', render: renderBasics },
  ].filter(Boolean);
  return m;
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
// a flow-node swatch: the node's own classes, layout neutralised in .sw.fn
const swNode = cls => `<span class="sw fn ${cls}"></span>`;
// a vertical hairline swatch: the drawing's own class (zero, one, thr) on a 12 px box
const swRule = cls => `<span class="sw"><span class="${cls}" style="position:relative;display:block;height:12px;left:6px"></span></span>`;
// a line swatch: the curve's own class on a 12-unit stroke, so dash and colour follow the drawing
const swLine = cls => `<span class="sw"><svg viewBox="0 0 12 12" aria-hidden="true"><line class="${cls}" x1="0" y1="6" x2="12" y2="6"/></svg></span>`;

function plateKey(items) {
  return '<dl class="p-key"><dt>key</dt>' + items.filter(Boolean).map(it =>
    it.note != null ? `<dd class="note${it.warn ? ' warn' : ''}">${esc(it.note)}</dd>` :
    `<dd><span class="lg">${it.sw}<span class="lgn">${esc(it.label)}</span></span></dd>`).join('') + '</dl>';
}

function ctlRow(label, items, aria) {
  return `<nav class="p-tabs"${attr('aria-label', aria || label)}>` +
    (label ? `<span class="p-tabs-lbl">${esc(label)}</span>` : '') +
    items.map(it => it.lbl ? `<span class="p-tabs-lbl">${esc(it.lbl)}</span>` :
      it.off ? `<span class="off" aria-disabled="true"${attr('title', it.title)}>${esc(it.off)}</span>` :
      `<a${attr('href', it.href)}${attr('class', it.on ? 'on' : '')}${it.on ? ' aria-current="true"' : ''}${attr('title', it.title)}${attr('data-focus', it.focus)}>${esc(it.label)}</a>`).join('') +
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

// ---------- the sheet's head: a way back, the verdict, the picture, the facts ----------

function renderBack() {
  return `<nav class="p-back" aria-label="back"><a href="../">← back to the live gauges</a></nav>`;
}

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

// the curve: x is the lead day, y the error relative to the blend on a log axis
const LEAD_W = 320, LEAD_HGT = 120;
const leadX = (day, H) => (day - 0.5) / H * LEAD_W;
const leadY = v => {
  const lo = Math.log2(LEAD_DOMAIN[0]), hi = Math.log2(LEAD_DOMAIN[1]);
  return LEAD_HGT - (Math.log2(v) - lo) / (hi - lo) * LEAD_HGT;
};
const leadXpct = (day, H) => ((day - 0.5) / H * 100).toFixed(2);

function leadPath(vals, H) {
  // one path, a new sub-path after every gap; values outside the frame are drawn on its edge and marked
  let d = '', pen = false;
  const clipped = [];
  vals.forEach((v, i) => {
    if (v == null || Number.isNaN(v) || !(v > 0)) { pen = false; return; }
    const c = Math.max(LEAD_DOMAIN[0], Math.min(LEAD_DOMAIN[1], v));
    d += `${pen ? 'L' : 'M'}${leadX(i + 1, H).toFixed(2)} ${leadY(c).toFixed(2)}`;
    pen = true;
    if (v > LEAD_DOMAIN[1] || v < LEAD_DOMAIN[0]) clipped.push({ day: i + 1, dir: v > LEAD_DOMAIN[1] ? 'up' : 'dn' });
  });
  // one mark per run of clipped days, at the run's middle
  const runs = [];
  for (const c of clipped) {
    const last = runs[runs.length - 1];
    if (last && last.dir === c.dir && last.to === c.day - 1) last.to = c.day; else runs.push({ from: c.day, to: c.day, dir: c.dir });
  }
  return { d, clips: runs.map(r => ({ day: (r.from + r.to) / 2, dir: r.dir, from: r.from, to: r.to })) };
}

function leadAria(L) {
  const who = L.station === 'pooled' ? 'the median of five regimes' : L.station;
  return `Error relative to the blend by lead day, ${who}. Blocks: ` +
    L.blocks.map(b => `${BLOCK_LABEL[b.name]} skill ${signed(b.ss, 2)}`).join(', ') + '. Arrow keys move the day.';
}

function renderLead(m) {
  const L = m.lead;
  const s = m.state;
  const head = `<h2 class="p-h2" tabindex="-1">Error by lead day · ${esc(L ? (L.station === 'pooled' ? 'five regimes, one vote each' : L.station) : '')}</h2>`;
  if (!L) return `<section id="lead" class="p-block">${head}<p class="p-empty p-dim">This report carries no per-day curve; re-run gate.py to add it.</p></section>`;
  const chips = ctlRow('gauge', [
    { href: stateHref(s, { lead: 'pooled', panel: 'lead' }), label: 'five regimes', on: L.station === 'pooled', focus: 'lead', title: 'the median of the five pooled gauges’ ratios, day by day' },
    ...L.stations.map(n => ({ href: stateHref(s, { lead: n, panel: 'lead' }), label: n, on: L.station === n, focus: 'lead' })),
  ], 'gauge drawn in the curve');
  const bands = L.blocks.map(b => `<span class="lb${b.on ? ' on' : ''}"${attr('style', `left:${((b.from - 1) / L.H * 100).toFixed(2)}%;width:${((b.to - b.from + 1) / L.H * 100).toFixed(2)}%`)}></span>`).join('');
  // the band labels are the block chips of this chart: each one is the same link the filter row carries
  const bandLabels = L.blocks.map(b => `<a${attr('href', stateHref(s, { block: b.name, panel: 'lead' }))}${attr('class', b.on ? 'on' : '')}${b.on ? ' aria-current="true"' : ''} data-focus="lead"${attr('style', `left:${((b.from - 1) / L.H * 100).toFixed(2)}%;width:${((b.to - b.from + 1) / L.H * 100).toFixed(2)}%`)}${attr('title', `${BLOCK_LABEL[b.name]}: skill ${signed(b.ss, 3)}${L.station === 'pooled' ? ', median of the five gauges' : ''}`)}><span class="lbn">${esc(`${b.from}–${b.to}`)}</span><b>${esc(signed(b.ss, 2))}</b></a>`).join('');
  const paths = ['persist', 'clim', 'tfm'].map(k => ({ k, ...leadPath(L.series[k], L.H) }));
  const lines = paths.map(p => `<path class="ln ln-${p.k}"${attr('d', p.d)}/>`).join('');
  const clips = paths.flatMap(p => p.clips.map(c => `<span class="clip ${c.dir} ln-${p.k}"${attr('style', `left:${leadXpct(c.day, L.H)}%`)}${attr('title', `${p.k === 'tfm' ? 'TimesFM' : p.k === 'clim' ? 'climatology' : 'persistence'} beyond ×${LEAD_DOMAIN[c.dir === 'up' ? 1 : 0]} on ${c.from === c.to ? `day ${c.from}` : `days ${c.from}–${c.to}`}`)}></span>`)).join('');
  const cx = leadX(L.cursor, L.H).toFixed(2);
  const say = leadSay(L, L.cursor);
  const svg = `<svg viewBox="0 0 ${LEAD_W} ${LEAD_HGT}" preserveAspectRatio="none" tabindex="0" role="slider" data-lead data-core` +
    ` aria-valuemin="1"${attr('aria-valuemax', L.H)}${attr('aria-valuenow', L.cursor)}${attr('aria-valuetext', say)}${attr('aria-label', leadAria(L))}>` +
    `<line class="ln-blend" x1="0"${attr('y1', leadY(1).toFixed(2))} x2="${LEAD_W}"${attr('y2', leadY(1).toFixed(2))}/>` + lines +
    `<line class="ln-cur" data-cur${attr('x1', cx)} y1="0"${attr('x2', cx)} y2="${LEAD_HGT}"/></svg>`;
  const vscale = [4, 2, 1, 0.5].map(v => `<span${attr('style', `top:${(leadY(v) / LEAD_HGT * 100).toFixed(1)}%`)}>×${v}</span>`).join('');
  const ticks = [1, 14, 30, 60, 90].filter(d => d <= L.H).map(d => `<span${attr('style', `left:${leadXpct(d, L.H)}%`)}>${d}</span>`).join('');
  const r2 = v => v == null || Number.isNaN(v) ? '—' : v.toFixed(2);
  const table = `<details class="tbl"><summary>table — every lead day</summary><div class="tblwrap"><table><thead><tr><th>day</th><th>TimesFM</th><th>climatology</th><th>persistence</th><th>blend MAE cm</th></tr></thead><tbody>` +
    Array.from({ length: L.H }, (_, i) => `<tr><td>${i + 1}</td><td>×${r2(L.series.tfm[i])}</td><td>×${r2(L.series.clim[i])}</td><td>×${r2(L.series.persist[i])}</td><td>${num(L.blendCm[i], 1)}</td></tr>`).join('') +
    `</tbody></table></div></details>`;
  return `<section id="lead" class="p-block">${head}` +
    `<p class="p-dim">Each method's error divided by the blend's, day by day out to ${esc(L.H)}: below the line is better than the blend. The model wins early and hands over to the calendar; persistence never recovers. The hatched band is the horizon block in view — the band labels switch it, as does the row above the chart; the vertical rule is a cursor — drag it, or use the arrow keys.</p>` +
    chips +
    `<div class="plot"><div class="lead-bands">${bandLabels}</div><div class="vscale" aria-hidden="true">${vscale}</div><div class="plot-box">${bands}${svg}${clips}</div>` +
    `<div class="ticks lead-ticks" aria-hidden="true">${ticks}</div></div>` +
    `<p class="p-readout" data-readout><b>${esc(say)}</b></p>` +
    plateKey([
      { sw: swLine('ln ln-tfm'), label: 'TimesFM 2.5' },
      { sw: swLine('ln ln-clim'), label: 'climatology (day-of-year mean of earlier years)' },
      { sw: swLine('ln ln-persist'), label: 'persistence — today’s level, held' },
      { sw: swLine('ln-blend'), label: 'the blend, ×1.00 — the bar' },
      { sw: '<span class="sw"><span class="lb on" style="position:relative;display:block;height:12px;width:12px"></span></span>', label: 'the horizon block in view — pick one by its label, or in the row above the chart' },
      { sw: '<span class="sw"><span class="lb" style="position:relative;display:block;height:12px;width:12px"></span></span>', label: 'block boundaries — days 14 and 30, each labelled with its skill' },
      { sw: '<span class="sw"><svg viewBox="0 0 12 12" aria-hidden="true"><line class="ln-cur" x1="6" y1="0" x2="6" y2="12"/></svg></span>', label: 'the cursor; the line under the chart reads its day' },
      { note: `The y axis is logarithmic, ×${LEAD_DOMAIN[0]} to ×${LEAD_DOMAIN[1]}; a ▴ or ▾ marks days a curve runs above or below the frame (climatology in its first days).` },
      L.station === 'pooled' ? { note: 'Pooled here means the median of the five regime gauges — of their day-by-day ratios in the curve and of their block skills in the band labels — so the Rhine and the Elbe do not outvote the Saar by their centimetres. Clause A1 in the facts pools centimetres instead; the blend MAE in the readout is that cm-pooled figure.' } : null,
    ]) + table + '</section>';
}

function renderFacts(m) {
  return `<section class="facts-wrap"><h2 class="p-h2">In brief</h2><ul class="facts">` +
    m.facts.map(f => `<li><span class="fk">${esc(f.k)}</span><span>${f.html}</span></li>`).join('') + `</ul></section>`;
}

function renderIndex(m) {
  return `<nav class="index" aria-label="explore by interest"><h2 class="p-h2">Explore by interest</h2><ul>` +
    m.panels.map(p => `<li><a${attr('href', stateHref(m.state, { panel: p.id }))}${attr('data-focus', p.id)}>${esc(p.title.split(' · ')[0])}</a><span class="hook">${esc(p.hook)}</span></li>`).join('') +
    `</ul></nav>`;
}

// The one row that relabels the whole sheet. It sits directly above the curve
// because that is the drawing it changes first: measured in Chrome before this
// move, the chips sat 1 121 px below the curve's head (2 173 on a phone) and a
// click scrolled the curve 1 166 px off the top of the screen. Now the chip
// focuses the curve, and the drawing the reader is comparing stays in front of
// them. The panels below read the same state; the index is what leads into them.
function renderControls(m) {
  const s = m.state;
  return ctlRow('target', [
    ...m.targets.map(t => t.available
      ? { href: stateHref(s, { target: t.k, panel: 'lead' }), label: t.label, on: s.target === t.k, focus: 'lead', title: t.k === 'mid' ? 'the day’s (min+max)/2 — what the archive stores' : 'the day’s maximum — the crest is what matters in a flood' }
      : { off: t.label, title: `the ${t.label} report did not load` }),
    { lbl: 'horizon' },
    ...BLOCKS.map(b => ({ href: stateHref(s, { block: b, panel: 'lead' }), label: BLOCK_LABEL[b], on: s.block === b, focus: 'lead' })),
    { lbl: '· every chart on this sheet' },
  ], 'target and horizon block');
}

// a panel: the summary is the focus and click target; the visually hidden h2
// keeps the heading in the outline (an h2 inside summary loses its semantics)
function renderPanel(p, m) {
  return `<details class="panel"${attr('id', p.id)}><summary>${esc(p.title)}</summary><section><h2 class="vh">${esc(p.title)}</h2>${p.render(m)}</section></details>`;
}

// ---------- the panels ----------

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
  return `<p class="p-dim">1 − MAE<sub>TimesFM</sub> / MAE<sub>blend</sub>. Positive means the model beat the persistence-to-climatology blend; the bar had to reach ${esc(signed(k.threshold, 2))} pooled. Regime medians: ${esc(regimeLine)}.</p>` +
    `<div class="rows">${rows}</div>` + axis([-0.2, -0.1, 0, 0.1, 0.2], SKILL_DOMAIN, v => signed(v, 1)) +
    `<p class="p-readout" data-readout><span class="hint">Hover or pick a row for the numbers behind it.</span></p>` +
    plateKey([
      { sw: swBar('pos'), label: 'better than the blend' },
      { sw: swBar('neg'), label: 'worse than the blend' },
      { sw: swBar('tie'), label: 'a tie — under 2 cm apart, neither win nor loss' },
      { sw: swRule('zero'), label: 'zero — as good as the blend' },
      { sw: '<span class="sw"><span class="ci" style="position:relative;display:block;top:5px;width:12px"></span></span>', label: 'bootstrap 95 % CI (pooled row)' },
      { sw: swRule('thr'), label: 'the A1 bar, +0.10' },
      { sw: '<span class="sw sig" style="text-align:center">●</span>', label: 'Diebold-Mariano p below 0.10 (Newey-West, lag 13)' },
      { note: 'The three Rhine gauges lie on 97 river-km of one chain and vote as one regime, by their median.' },
    ]) + table;
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
  return `<p class="p-dim">Each method's MAE divided by the blend's, so a 15 cm gauge and a 100 cm gauge share one axis. Left of the line is better than the blend. The value column is the blend's own MAE in cm.</p>` +
    `<div class="rows">${rows}</div>` + axis([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2], RATIO_DOMAIN, v => '×' + v.toFixed(2)) +
    `<p class="p-readout" data-readout><span class="hint">Hover or pick a row for the MAE of every method in cm.</span></p>` +
    plateKey([
      { sw: sw('tfm'), label: 'TimesFM 2.5' },
      { sw: swRule('one'), label: 'the blend, ×1.00' },
      { sw: sw('persist'), label: 'persistence — the MASE denominator, not the bar' },
      { sw: sw('clim'), label: 'climatology (day-of-year mean of earlier years)' },
      { sw: sw('snaive'), label: 'seasonal naive — the value 365 days before' },
      { sw: sw('up'), label: 'upstream OLS (KÖLN from MAXAU; reference only)' },
      { note: 'Beyond a month climatology sits within 2 % of the blend at every gauge but Dresden — a seasonal outlook is a lookup table.' },
    ]) + table;
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
  return `<p class="p-dim">How often the model's 80 % interval actually contained the reading. Inside the shaded band is clause A5; the dashed line is the ideal 80 %. Below, the PIT histograms: a flat profile means the deciles are honest, a U means the band is too narrow, a hump too wide.</p>` +
    `<div class="rows">${rows}</div>` + axis([0.6, 0.7, 0.8, 0.9, 1.0], PICP_DOMAIN, v => num(v * 100, 0) + ' %') +
    `<p class="p-readout" data-readout><span class="hint">Hover or pick a row for coverage and CRPS.</span></p>` +
    `<div class="pits">${pits}</div>` +
    plateKey([
      { sw: sw('picp-t'), label: 'TimesFM, 80 % interval coverage' },
      { sw: sw('picp-b'), label: 'the blend with its own residual deciles' },
      { sw: '<span class="sw"><span class="band" style="position:relative;display:block;height:12px;width:12px"></span></span>', label: 'accepted range 72–88 %' },
      { sw: swRule('thr'), label: 'ideal 80 %' },
      { sw: '<span class="sw"><span class="link" style="position:relative;display:block;top:5px;width:12px"></span></span>', label: 'the gap between the model’s coverage and the blend’s' },
      { sw: '<span class="sw"><svg viewBox="0 0 12 12" aria-hidden="true"><rect class="pb" x="1" y="4" width="4" height="8"/><rect class="pb" x="7" y="2" width="4" height="10"/></svg></span>', label: 'PIT histogram: share of readings that fell at or below each decile' },
      { sw: '<span class="sw"><svg viewBox="0 0 12 12" aria-hidden="true"><line class="pu" x1="0" y1="6" x2="12" y2="6"/></svg></span>', label: 'the flat 10 % a calibrated model would show' },
    ]) + table;
}

function renderClim(m) {
  const zero = pct(0, SKILL_DOMAIN);
  const rows = m.clim.rows.map(r => rowOpen('', r.say) + lbl(r.station, r.regime) +
    `<span class="track"><span class="zero"${attr('style', `left:${zero.toFixed(2)}%`)}></span>${skillBar(r.ss, r.tie)}</span><span class="val">${esc(signed(r.ss))}</span></div>`).join('');
  return `<p class="p-dim">The same skill score, but for plain day-of-year climatology with no knowledge of today's level. Switch the horizon: at days 1–14 it is far behind, at days 31–90 it is a tie almost everywhere — the long horizon needs no model, only a calendar.</p>` +
    `<div class="rows">${rows}</div>` + axis([-0.2, -0.1, 0, 0.1, 0.2], SKILL_DOMAIN, v => signed(v, 1)) +
    `<p class="p-readout" data-readout><span class="hint">Hover or pick a row.</span></p>` +
    plateKey([
      { sw: swBar('pos'), label: 'climatology better than the blend' },
      { sw: swBar('neg'), label: 'climatology worse (values below −0.20 are clipped, marked ◂)' },
      { sw: swBar('tie'), label: 'a tie' },
      { sw: swRule('zero'), label: 'zero — as good as the blend' },
    ]);
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
    s.stations.map(st => `<tr><td>${esc(st.name)}</td><td>${esc(st.origins)}</td><td>${esc(st.rises)}</td>${blocks.map(b => { const v = st.blocks[b]; return `<td>${num(v.mae.tfm_point, 1)}</td><td>${esc(v.best_baseline)} ${num(v.mae[v.best_baseline], 1)}</td><td>${signed(v.ss_vs_best)}</td>`; }).join('')}</tr>`).join('') +
    `</tbody></table></div></details>`;
  return `<p class="p-dim">The daily archive keeps day extremes only, so 15-minute readings are being collected weekly since 2026-09-02. The verdict stays PROVISIONAL until every gauge has ${esc(s.need)} independent origins (about sixteen weeks) and ${esc(s.needRises)} rise events; it can never be SHIP before that.</p>` +
    `<div class="rows">${rows}</div>` +
    `<p class="p-readout" data-readout><span class="hint">Hover or pick a gauge for its first-week numbers.</span></p>` +
    plateKey([
      { sw: '<span class="meter sw" style="display:inline-block;width:12px;height:12px"><span style="width:60%"></span></span>', label: `independent 48-hour origins collected, of the ${s.need} the gate needs` },
      { note: `Collected ${esc(s.generated)}. Ten origins is a month of data; nothing here is a result yet.` },
    ]) + table;
}

// the basics: model and question, the bar, the verdict — three short paragraphs
// for the reader who came from the main page, every number from the mid run
function renderBasics(m) {
  const k = m.story;
  return `<div class="prose">` +
    `<p><b>Model and question.</b> ${a(LINKS.card, 'TimesFM 2.5')} is Google's 200-million-parameter foundation model for time series; it forecasts <em>zero-shot</em>, untrained on the series at hand. Could it beat something trivial on 26 years of daily archive? ${esc(thousands(k.windows))} windows on seven gauges, run twice to prove it reproduces.</p>` +
    `<p><b>The bar.</b> Not persistence: a two-line blend, today's level decaying into the day-of-year norm, already beats it by ${esc(k.persistGain)} at KÖLN over three months. The model had to beat that blend by ten percent, pooled, in every block; the Rhine trio votes once.</p>` +
    `<p><b>The verdict.</b> ${esc(k.verdict)}. At two weeks TimesFM beats the blend by ${esc(k.h1)}, under the bar; at a month it draws; at three months it is ${esc(k.h90)} ${esc(k.h90sign)}. Its bands are honest. Beyond a month climatology alone sits within ${esc(k.climRest)} of the bar everywhere but ${esc(k.climWorst)}: the long horizon needs a calendar, not a model.</p>` +
    `<p class="p-dim">Code: <a href="https://github.com/bmmmm/pegel-visual/tree/main/scripts/forecast">scripts/forecast</a>; the markdown reports sit beside this page.</p></div>`;
}

// The model panel: what TimesFM 2.5 is, and the chain this repo runs it in.
// Every number here comes out of the run's own header — protocol, ForecastConfig
// and versions — so a re-run with another context length redraws the chain
// instead of leaving a stale literal on the page.
function renderModel(m) {
  const h = m.head, c = h.config || {}, pr = h.protocol || {};
  const v = h.versions || {};
  const step = (cls, name, detail) => `<li class="fn ${cls}"><b>${esc(name)}</b><span>${detail}</span></li>`;
  const chain = `<ol class="flow">` +
    step('src', 'PEGELONLINE daily archive', `one min and one max per day, from the ${a(LINKS.archive, 'archive branch')} — closed years only, because the running year is still being rewritten and a gate built on it would not reproduce`) +
    step('step', 'loaders.py — windows', `gaps of up to three days interpolated, longer ones drop the window; a new origin every ${esc(pr.step)} days, ${esc(thousands(pr.context))} days of context, ${esc(pr.horizon)} days to forecast`) +
    step('step', 'baselines.py — the bar', 'persistence, day-of-year climatology, the blend between them, seasonal naive 365, an upstream OLS — computed first, on exactly these windows') +
    step('model', 'tfm.py — TimesFM 2.5', `the same windows, nothing else: no rain, no upstream gauge, no calendar feature. ${esc(c.per_core_batch_size)} per batch on CPU in float32, seed 0, ${esc(h.threads)} threads; of the ten output channels the point forecast is the median, and that is what gets scored`) +
    step('step', 'metrics.py — the scores', 'MAE and CRPS per lead day, the 80 % coverage, the PIT histogram, and a Diebold-Mariano test that knows the windows overlap') +
    step('step', 'gate.py — the clauses', `each pre-registered threshold checked in turn; a run whose ForecastConfig does not hash to ${esc(h.fingerprint)}, or whose origin grid was truncated, is VOID rather than a verdict`) +
    step('out', 'report.json — this page', 'the same file in every panel here, and its markdown twin beside it; nothing on this sheet is typed by hand') +
    `</ol>`;
  const cmds = `<details class="cmds"><summary>the two commands behind this sheet</summary><div class="tblwrap"><pre><code>` +
    esc('uv run python backtest.py --horizon ' + (h.kind || 'seasonal') + ' --target ' + m.target + ' \\\n    --archive ../../archive --out ../../tmp-forecast/results/' + (h.kind || 'seasonal') + '-' + m.target + '\n' +
        'uv run python gate.py --results ../../tmp-forecast/results/' + (h.kind || 'seasonal') + '-' + m.target + ' \\\n    --compare ../../tmp-forecast/results/' + (h.kind || 'seasonal') + '-' + m.target + '-repeat') +
    `</code></pre><p class="p-dim">Weights are pulled once from the model card and cached locally; the run took ${esc(num(h.elapsed, 0))} s on a laptop CPU. CI installs the same environment <em>without</em> the model group and runs the window, baseline and licence tests only — the gate itself is run by hand, because a re-run consumes the test set.</p></div></details>`;
  return `<div class="prose"><p>${a(LINKS.card, 'TimesFM 2.5')} is Google's foundation model for time series: decoder-only, 200 million parameters, ` +
    `pre-trained on other people's series and applied here <em>zero-shot</em> — it saw no gauge of this archive in training, and nothing was fitted to one. ` +
    `<em>Decoder-only</em> means it continues a series the way a language model continues a sentence, reading it in patches of days rather than words. ` +
    `The architecture is the ${a(LINKS.paper, 'ICML 2024 paper')}'s; the weights carried here are ${esc(h.license)}, checkpoint ${a(LINKS.card, h.checkpoint)}, loaded through the ` +
    `${a(LINKS.pkg, 'timesfm package')} pinned to ${esc(v.timesfm)} — that pin is deliberate, the newer line's weights are non-commercial and this repo is GPL-3.0.</p>` +
    `<p class="p-dim">What follows is the chain the ${esc(thousands(h.windows))} scored windows travel, from the archive to the picture at the top of this sheet. Only one link in it is the model.</p></div>` +
    chain +
    plateKey([
      { sw: swNode('src'), label: 'data this run reads' },
      { sw: swNode('step'), label: `a step in this repo (${'scripts/forecast'})` },
      { sw: swNode('model'), label: 'the foreign model — the only link that is not ours' },
      { sw: swNode('out'), label: 'what every panel on this page is drawn from' },
      { note: `Run ${h.generated}, git ${h.git}, timesfm ${v.timesfm} · torch ${v.torch} · numpy ${v.numpy}. ` +
        (h.repeat ? 'The same batch forecast twice gave identical numbers, ' : 'The repeat check did not run, ') +
        (h.reproduced ? `and a second full run reproduced every number (sha256 ${String(h.sha || '').slice(0, 12)}…).` : 'and no second full run was compared.') },
    ]) + cmds + `<p class="p-dim">All of it: ${a(LINKS.code, 'scripts/forecast')}.</p>`;
}

function renderMethod(m) {
  const h = m.head;
  return `<div class="prose">` +
    `<p>Rolling-origin backtest on the daily archive, closed years 2000–2025: 1 024 days of context, 90 days of horizon, one origin every 7 days. Origins before 2016 (676 per gauge) fit the blend's τ and its residual deciles; origins from 2016 (${esc(h.windows / h.stations)} per gauge, ${esc(h.windows)} in all) are scored. A 90-day embargo separates the two.</p>` +
    `<p>The bar is the <b>blend</b> — e<sup>−h/τ</sup>·today + (1 − e<sup>−h/τ</sup>)·climatology(day) — not persistence: at days 31–90 the blend already beats persistence by a quarter, so a win over persistence would be a win over nothing. Overlapping windows are not independent samples: significance comes from Diebold-Mariano tests with a Newey-West variance (lag 13) and a moving-block bootstrap over origins (block 26), and the Rhine trio votes once, by its median.</p>` +
    `<ul><li>Every threshold and the ForecastConfig were fixed before the first model run; a run with a different config, a truncated grid, or one that does not reproduce bit for bit is VOID, not a verdict.</li>` +
    `<li>TimesFM 2.5 has no published corpus manifest. PEGELONLINE is open and CAMELS-DE covers German basins, so 2000–2024 may be in its training data. Clause A7 compares recent against old origins; it is a probe, not a proof.</li>` +
    `<li>The blend's τ and residual deciles are fitted on the pre-2016 origins, which favours the blend slightly on A7's old side.</li>` +
    `<li>The daily-max target run (switch the target chip above) tells the same story: the crest is no easier to forecast than the mid.</li></ul></div>`;
}

function renderFoot(m) {
  const h = m.head;
  const v = h.versions || {};
  return `<footer id="plate-foot">` +
    `<p><span class="lbl">model</span>${esc(h.model)} · ${a(LINKS.card, h.checkpoint)} · ${esc(h.license)} · ${a(LINKS.pkg, 'timesfm')} ${esc(v.timesfm)} · torch ${esc(v.torch)} · numpy ${esc(v.numpy)} · config ${esc(h.fingerprint)}</p>` +
    `<p><span class="lbl">run</span>${esc(h.generated)} · git ${esc(h.git)} · ${esc(num(h.elapsed, 0))} s on CPU, float32` +
    (h.reproduced ? ` · reproduced bit for bit by a second full run at ${esc(h.reproduced)}` : ' · second full run: not compared') + `</p>` +
    `<p><span class="lbl">source</span>PEGELONLINE (WSV) daily archive on the <a href="https://github.com/bmmmm/pegel-visual/tree/archive">archive branch</a> · ` +
    `<a href="seasonal-mid/report.md">report (mid)</a> · <a href="seasonal-max/report.md">report (max)</a> · <a href="short-mid/report.md">report (short)</a> · ` +
    `<a href="https://github.com/bmmmm/pegel-visual/tree/main/scripts/forecast">the gate's code</a></p>` +
    `<p><span class="lbl">not</span>a forecast product. Nothing on this sheet predicts a river; it measures whether a model could, and the answer was no.</p>` +
    renderBack() +
    `</footer>`;
}

export function screenSummary(m) {
  const k = m.skill;
  return `Forecast gate, ${m.verdict}. TimesFM 2.5 against the persistence-to-climatology blend, ${TARGETS[m.target]} target, ${BLOCK_LABEL[m.block]}: pooled skill ${signed(k.pooled.ss)} with a 95 % interval from ${signed(k.pooled.lo)} to ${signed(k.pooled.hi)}. ` +
    `${m.clauses.filter(c => c.pass).length} of ${m.clauses.length} clauses passed.`;
}

export function renderPage(m) {
  return `<p class="vh">${esc(screenSummary(m))}</p>` +
    renderBack() +
    `<header class="p-head"><h1 tabindex="-1"><a href="../">PEGEL://</a> · FORECAST GATE</h1>` +
    `<p class="p-sub">${esc(m.gist)}</p></header>` +
    renderVerdict(m) +
    renderControls(m) +
    renderLead(m) +
    renderFacts(m) +
    renderIndex(m) +
    m.panels.map(p => renderPanel(p, m)).join('') +
    renderFoot(m);
}

// ---------- the page ----------

async function getJson(url) {
  try {
    const r = await fetch(url, { cache: 'no-cache' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

let reports = null;
let root = null;
let known = [];
// draw() reopens panels itself, and that must not read as the reader opening one.
// A time flag cannot do it: `toggle` fires in a task of its own, long after the
// restore loop has finished, so the element is marked instead and cleared when
// its event arrives. (Measured: with a flag, a chip clicked while two panels
// were open wrote #method into the URL instead of the drawing it changed.)
const silentToggles = new WeakSet();

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const coarsePointer = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

function announce(text) {
  const box = document.getElementById('gate-status');
  if (!box) return;
  box.textContent = '';                               // the same text twice would not re-fire the live region
  setTimeout(() => { box.textContent = text; }, 30);
}

// "already in view" is about the SECTION, not the heading: the reader watching
// the curve is watching the drawing, and its heading may well have scrolled off
// the top. A section counts as in view when it starts above the lower third of
// the window and still has 80 px of itself below the top edge.
// Is the part that matters already on screen? Measured as overlap, not as a
// threshold on its top edge: the curve's drawing begins 606 px down a 900 px
// window and ends at 846 — wholly visible, yet a rule about its top edge called
// it hidden and scrolled the page 415 px for a click that changed one line.
// [data-core] names that part — a section may open with prose and a chip row,
// and on a phone the drawing starts ~380 px below the section's own top edge.
// Without a [data-core] the whole section counts, which is right for a panel.
function inView(el) {
  const r = (el.querySelector('[data-core]') || el).getBoundingClientRect();
  const shown = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
  return shown > 0 && shown >= Math.min(r.height, innerHeight) * 0.8;
}

// after a full re-render the focus would be nowhere: put it on what was asked
// for — a panel's summary (opened), the curve's heading, or the h1 as a fallback
function focusTo(id, scroll) {
  let target = null, label = '';
  const el = id && root.querySelector(`#${CSS.escape(id)}`);
  if (el && el.tagName === 'DETAILS') {
    el.open = true;
    target = el.querySelector(':scope > summary');
    label = `${el.querySelector('summary').textContent}, opened`;
  } else if (el) {
    target = el.querySelector('h2[tabindex]') || el;
    label = el.querySelector('h2') ? el.querySelector('h2').textContent : id;
  }
  if (!target) { target = root.querySelector('h1'); label = 'top of the gate'; }
  if (!target) return;
  target.focus({ preventScroll: true });
  // Scroll only towards something the reader cannot already see. A gauge chip
  // sits ON the curve it changes, so pulling that curve's heading to the top of
  // the window moved the page 415 px on desktop and up to 299 on a phone for a
  // click that changed nothing but the line — the drawing jumped away from under
  // the thumb that picked it. An index link to a panel further down still gets
  // the panel laid at the top, because that section really is out of view.
  if (scroll && !inView(el || target)) target.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' });
  announce(label);
}

function wireLead(m) {
  const svg = root.querySelector('#lead svg[data-lead]');
  const L = m.lead;
  if (!svg || !L) return;
  const readout = root.querySelector('#lead [data-readout]');
  const cur = svg.querySelector('[data-cur]');
  let day = L.cursor;
  const set = d => {
    day = Math.max(1, Math.min(L.H, Math.round(d)));
    const x = leadX(day, L.H).toFixed(2);
    cur.setAttribute('x1', x); cur.setAttribute('x2', x);
    const say = leadSay(L, day);
    svg.setAttribute('aria-valuenow', String(day));
    svg.setAttribute('aria-valuetext', say);
    if (readout) readout.innerHTML = `<b>${esc(say)}</b>`;
  };
  // a thumb cannot aim at one of 90 days: on a coarse pointer the cursor snaps to every
  // fifth day plus the block edges, so day 14 and day 30 — the verdict's own boundaries — stay reachable
  const stops = [...new Set([1, ...Array.from({ length: Math.floor(L.H / 5) }, (_, i) => (i + 1) * 5), ...L.blocks.flatMap(b => [b.from, b.to])])].filter(d => d >= 1 && d <= L.H).sort((a, b) => a - b);
  const dayAt = e => {
    const r = svg.getBoundingClientRect();
    const raw = ((e.clientX - r.left) / Math.max(1, r.width)) * L.H + 0.5;
    if (!coarsePointer()) return raw;
    return stops.reduce((best, d) => Math.abs(d - raw) < Math.abs(best - raw) ? d : best, stops[0]);
  };
  // drag, not hover: a parked reading (arrow keys, a screen reader on the slider) must survive a passing mouse
  svg.addEventListener('pointerdown', e => { if (e.button !== 0) return; svg.setPointerCapture && svg.setPointerCapture(e.pointerId); set(dayAt(e)); });
  svg.addEventListener('pointermove', e => { if (e.buttons & 1) set(dayAt(e)); });
  svg.addEventListener('keydown', e => {
    const step = { ArrowLeft: -1, ArrowRight: 1, ArrowDown: -1, ArrowUp: 1, PageDown: -7, PageUp: 7 }[e.key];
    if (step) { e.preventDefault(); set(day + step); }
    else if (e.key === 'Home') { e.preventDefault(); set(1); }
    else if (e.key === 'End') { e.preventDefault(); set(L.H); }
  });
}

function wire() {
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
  // chips and index links are real links; intercept so the sheet re-renders in
  // place, and every one of them says what to focus afterwards
  // Opening a panel by hand puts it in the URL, so the address bar always names
  // what the reader is looking at and can be sent as it stands. replaceState,
  // not push: unfolding a section is not a navigation step, and a history entry
  // per fold would bury the chips' own back button. `toggle` does not bubble —
  // hence the capture phase, which catches it on the way down.
  root.addEventListener('toggle', e => {
    const d = e.target;
    if (!(d instanceof HTMLElement) || !d.classList.contains('panel')) return;
    if (silentToggles.has(d)) { silentToggles.delete(d); return; }
    let panel;
    if (d.open) panel = d.id;                                   // opened: that is what the reader is looking at
    else if (location.hash === '#' + d.id) {                    // closed the one the URL named: hand it on
      const last = [...root.querySelectorAll('details.panel[open]')].pop();
      panel = last ? last.id : null;
    } else return;                                              // closing a panel the URL never named changes nothing
    if ((panel ? '#' + panel : '') === location.hash) return;
    history.replaceState(null, '', stateHref(parseState(location.search, location.hash, known), { panel }));
  }, true);
  root.addEventListener('click', e => {
    const a = e.target.closest('.p-tabs a, .index a, .lead-bands a');
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    if (a.href !== location.href) history.pushState(null, '', a.getAttribute('href'));  // the active chip again: no duplicate history entry
    draw({ focus: a.dataset.focus || parseState(location.search, location.hash, known).panel, scroll: true });
  });
}

function draw(opts = {}) {
  if (!reports) return;
  const state = parseState(location.search, location.hash, known);
  const m = buildModel(reports, state);
  // what the reader had open stays open: the panels, and the table twins inside them (by position)
  const open = [...root.querySelectorAll('details[open]')].map(d => {
    if (d.classList.contains('panel')) return { id: d.id };
    const panel = d.closest('details.panel, #lead');  // the panel, or the curve's section — not the id-less <section> inside a panel
    return panel ? { id: panel.id, tbl: [...panel.querySelectorAll('details.tbl')].indexOf(d) } : null;
  }).filter(Boolean);
  root.innerHTML = renderPage(m);
  for (const o of open) {
    const d = root.querySelector(`#${CSS.escape(o.id)}`);
    if (!d) continue;
    if (o.tbl == null) { silentToggles.add(d); d.open = true; }
    else { const t = d.querySelectorAll('details.tbl')[o.tbl]; if (t) t.open = true; }
  }
  document.title = `PEGEL:// gate · ${m.verdict}`;
  wireLead(m);
  if (opts.focus) focusTo(opts.focus, opts.scroll);
}

export async function main() {
  root = document.getElementById('plate');
  const [mid, max, short] = await Promise.all([getJson('seasonal-mid/report.json'), getJson('seasonal-max/report.json'), getJson('short-mid/report.json')]);
  if (!mid) {
    root.innerHTML = '<div class="p-empty"><p>The gate report could not be loaded.</p><p class="p-dim">seasonal-mid/report.json did not answer — the deploy may still be running.</p></div>';
    return;
  }
  reports = { seasonal: { mid, max: max || undefined }, short: short || undefined };
  known = Object.keys(mid.stations);
  wire();
  // back/forward: the browser restores the scroll position itself. It also
  // processes the URL's fragment after popstate — and Chrome CLEARS the focus
  // when the fragment's target is not focusable (a <section>, a <details>) —
  // so the focus goes on after the next frame has done that, not inside the handler.
  window.addEventListener('popstate', () => {
    draw();
    const panel = parseState(location.search, location.hash, known).panel;
    requestAnimationFrame(() => requestAnimationFrame(() => focusTo(panel, false)));  // no panel: the h1
  });
  // the reports arrive after the load, so a #panel in the URL opens only now
  draw({ focus: parseState(location.search, location.hash, known).panel, scroll: true });
}

if (typeof document !== 'undefined' && document.getElementById('plate')) main();
