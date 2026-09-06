#!/usr/bin/env node
// Usage: node scripts/gate-rain-check.mjs  (sandbox bypass: it binds and
// connects on loopback). The sibling of scripts/gate-check.mjs, for the one
// panel that one does not know about.
//
// One look at the gate page's `rain` panel in a real browser, at both
// widths: opened, measured, screenshot. The suite asserts its markup; this says
// whether a reader can read it. Needs the sandbox bypass (loopback).
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';

// the checkout this file lives in — a worktree runs its own copy, and a
// hardcoded path would send every worktree's run at the main checkout
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = join(ROOT, 'tmp-shots');  // gitignored: pictures are evidence, not source
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
mkdirSync(SHOTS, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const kids = [];
let bad = 0;
const check = (ok, what, d = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${d ? ' — ' + d : ''}`); if (!ok) bad++; };

const port = await freePort();
kids.push(spawn('python3', ['-m', 'http.server', String(port), '--directory', ROOT, '--bind', '127.0.0.1'], { stdio: 'ignore' }));
await sleep(700);
const cport = await freePort();
const profile = mkdtempSync(join(tmpdir(), 'rain-panel-'));
kids.push(spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`,
  `--remote-debugging-port=${cport}`, '--remote-allow-origins=*', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] }));
for (let i = 0; i < 120; i++) { await sleep(250); try { await fetch(`http://127.0.0.1:${cport}/json/version`); break; } catch { /* not up */ } }

for (const vp of [{ n: 'desktop', w: 1280, h: 900 }, { n: 'phone', w: 390, h: 844, mobile: true }]) {
  const t = await (await fetch(`http://127.0.0.1:${cport}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0; const pend = new Map(); const errs = [];
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); return; }
    if (m.method === 'Runtime.exceptionThrown') errs.push(m.params.exceptionDetails.text);
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async x => { const r = await send('Runtime.evaluate', { expression: x, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text); return r.result.value; };
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 2, mobile: !!vp.mobile });
  await send('Page.navigate', { url: `http://127.0.0.1:${port}/gate/#rain` });
  for (let i = 0; i < 60; i++) { await sleep(250); if (await ev(`!!document.querySelector('#rain')`).catch(() => false)) break; }
  await sleep(500);
  const m = await ev(`(() => {
    const p = document.querySelector('details.panel#rain');
    if (!p) return null;
    p.open = true;
    const r = p.getBoundingClientRect();
    const rows = [...p.querySelectorAll('.row')];
    return {
      title: p.querySelector('summary').innerText.replace(/\\s+/g, ' ').trim(),
      rows: rows.map(x => x.innerText.replace(/\\s+/g, ' ').trim()),
      tables: p.querySelectorAll('details.tbl').length,
      keyEntries: p.querySelectorAll('.p-key dd').length,
      swatchesEmpty: [...p.querySelectorAll('.p-key .sw')].filter(sw => { const b = sw.getBoundingClientRect(); return b.width < 1 || b.height < 1; }).length,
      wide: [...p.querySelectorAll('*')].filter(e => e.checkVisibility() && !e.closest('.tblwrap') && e.getBoundingClientRect().right > window.innerWidth + 1).map(e => e.className).slice(0, 4),
      controlNote: (p.innerText.match(/negative control[^.]*\\./) || [''])[0],
      // a mark that means "worse" has to LOOK different, not just be classed
      // differently: measure the paint, because a missing CSS rule is invisible
      // to every assertion on the markup
      barFills: [...p.querySelectorAll('.rows .meter > span')].map(x => getComputedStyle(x).backgroundImage),
      keyFills: [...p.querySelectorAll('.p-key .meter > span')].map(x => getComputedStyle(x).backgroundImage),
      // textContent, not innerText: a headless layout gives innerText '' for
      // these, and a check that reads '' passes whatever the chips say
      chipRow: [...document.querySelectorAll('.mchip')].map(c => c.textContent.replace(/\\s+/g, ' ').trim()),
    };
  })()`);
  console.log(`\n== ${vp.n}`);
  if (!m) { check(false, `${vp.n}: the rain panel exists`); ws.close(); continue; }
  console.log(`  title: ${m.title}`);
  for (const r of m.rows) console.log(`  row: ${r}`);
  check(errs.length === 0, `${vp.n}: no uncaught exception`, errs.join(' | '));
  check(m.rows.length === 3, `${vp.n}: one row per block`, String(m.rows.length));
  check(m.tables === 2, `${vp.n}: the clause table and the per-gauge twin`, String(m.tables));
  check(m.swatchesEmpty === 0, `${vp.n}: no empty swatch`, String(m.swatchesEmpty));
  check(m.wide.length === 0, `${vp.n}: nothing sticks out`, m.wide.join(', '));
  check(/negative control/.test(m.controlNote), `${vp.n}: the control arm is named as one`, m.controlNote);
  check(!m.chipRow.some(c => /shuffled/i.test(c)), `${vp.n}: and it has no chip`, m.chipRow.join(' | '));
  check(/NO EFFECT|RAIN HELPS|RAIN HARMS/.test(m.title), `${vp.n}: the title carries the rain verdict`, m.title);
  // every bar in this run is negative, so every one must be painted as such —
  // and the key's two swatches must not be the same picture twice
  check(new Set(m.barFills).size === 1 && /-45deg/.test(m.barFills[0]),
    `${vp.n}: a negative bar is painted as one`, m.barFills[0]);
  check(m.keyFills.length === 2 && m.keyFills[0] !== m.keyFills[1],
    `${vp.n}: the key's two marks are two pictures`, m.keyFills.join(' | '));
  await ev(`document.querySelector('details.panel#rain').open = true`);
  await sleep(200);
  const full = await ev(`({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })`);
  const shot = await send('Page.captureScreenshot', { captureBeyondViewport: true, clip: { x: 0, y: 0, width: full.w, height: Math.min(full.h, 6000), scale: 1 } });
  writeFileSync(join(SHOTS, `gate-${vp.n}-rain.png`), Buffer.from(shot.data, 'base64'));
  ws.close();
}
for (const k of kids) k.kill();
rmSync(profile, { recursive: true, force: true });
console.log(`\n${bad ? `${bad} FAILURES` : 'all checks green'} — ${SHOTS}`);
process.exit(bad ? 1 : 0);
