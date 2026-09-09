#!/usr/bin/env node
// Usage: node scripts/gate-rain-check.mjs  (sandbox bypass: it binds and
// connects on loopback). The sibling of scripts/gate-check.mjs, for the one
// panel that one does not know about.
//
// One look at the gate page's `rain` panel in a real browser, at both
// widths: opened, measured, screenshot. The suite asserts its markup; this says
// whether a reader can read it. Needs the sandbox bypass (loopback).
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sleep, serve, chrome, session, checker, killChildren } from './lib/cdp.mjs';
import { NRW_BLOCKS } from '../gate/gate.js';

// the checkout this file lives in — a worktree runs its own copy, and a
// hardcoded path would send every worktree's run at the main checkout
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SHOTS = join(ROOT, 'tmp-shots');  // gitignored: pictures are evidence, not source
mkdirSync(SHOTS, { recursive: true });
const check = checker();

// The bars are the arm-vs-arm skill per block, and their SIGN is data: until
// 2026-09-09 this check demanded every bar negative because every bar WAS,
// and the next gate run with a positive block would have turned CI red for
// a data reason. The expectation is read off the report the page draws —
// pooled.blocks in the page's own NRW_BLOCKS order; the control arm's numbers
// live in report-3p0-rain-shuffled.json and are not drawn as bars. Against a
// deployed page (GATE_BASE_URL) the report is read from that origin too —
// a local report ahead of a deploy would otherwise expect bars the page
// does not draw yet.
const RAIN_REPORT = 'gate/nrw-mid/report-3p0-rain.json';
const rainReport = process.env.GATE_BASE_URL
  ? await (await fetch(new URL(RAIN_REPORT, process.env.GATE_BASE_URL))).json()
  : JSON.parse(readFileSync(join(ROOT, RAIN_REPORT), 'utf8'));
const expectFills = NRW_BLOCKS.filter(b => rainReport.pooled.blocks[b])
  .map(b => (rainReport.pooled.blocks[b].ss_vs_other < 0 ? '-45deg' : '45deg'));
if (!expectFills.length) throw new Error(`${RAIN_REPORT}: no pooled blocks to expect bars for`);

// GATE_BASE_URL=https://bmmmm.github.io/pegel-visual/ checks the deployed page
const base = await serve({ root: ROOT, url: process.env.GATE_BASE_URL || null });
const cdp = await chrome({ tag: 'rain-panel' });

for (const vp of [{ n: 'desktop', w: 1280, h: 900 }, { n: 'phone', w: 390, h: 844, mobile: true }]) {
  const s = await session(cdp);
  const { send, evaluate: ev } = s;
  const errs = s.events.exceptions;
  await send('Page.enable'); await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: vp.w, height: vp.h, deviceScaleFactor: 2, mobile: !!vp.mobile });
  await send('Page.navigate', { url: base + 'gate/#rain' });
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
  if (!m) { check(false, `${vp.n}: the rain panel exists`); await s.close(); continue; }
  console.log(`  title: ${m.title}`);
  for (const r of m.rows) console.log(`  row: ${r}`);
  check(errs.length === 0, `${vp.n}: no uncaught exception`, errs.join(' | '));
  check(m.rows.length === expectFills.length, `${vp.n}: one row per block`, String(m.rows.length));
  check(m.tables === 2, `${vp.n}: the clause table and the per-gauge twin`, String(m.tables));
  check(m.swatchesEmpty === 0, `${vp.n}: no empty swatch`, String(m.swatchesEmpty));
  check(m.wide.length === 0, `${vp.n}: nothing sticks out`, m.wide.join(', '));
  check(/negative control/.test(m.controlNote), `${vp.n}: the control arm is named as one`, m.controlNote);
  check(!m.chipRow.some(c => /shuffled/i.test(c)), `${vp.n}: and it has no chip`, m.chipRow.join(' | '));
  check(/NO EFFECT|RAIN HELPS|RAIN HARMS/.test(m.title), `${vp.n}: the title carries the rain verdict`, m.title);
  // every bar is painted with the sign the report gives it — and the key's
  // two swatches must not be the same picture twice
  check(m.barFills.length === expectFills.length && m.barFills.every((f, i) => f.includes(`(${expectFills[i]}`)),
    `${vp.n}: each bar is painted with its own sign (${expectFills.join(' ')})`, m.barFills.map(f => (f.match(/-?45deg/) || ['?'])[0]).join(' '));
  check(m.keyFills.length === 2 && m.keyFills[0] !== m.keyFills[1],
    `${vp.n}: the key's two marks are two pictures`, m.keyFills.join(' | '));
  await ev(`document.querySelector('details.panel#rain').open = true`);
  await sleep(200);
  const full = await ev(`({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })`);
  const shot = await send('Page.captureScreenshot', { captureBeyondViewport: true, clip: { x: 0, y: 0, width: full.w, height: Math.min(full.h, 6000), scale: 1 } });
  writeFileSync(join(SHOTS, `gate-${vp.n}-rain.png`), Buffer.from(shot.data, 'base64'));
  await s.close();
}
killChildren();
console.log(`\n${check.failures ? `${check.failures} FAILURES` : 'all checks green'} — ${SHOTS}`);
process.exit(check.failures ? 1 : 0);
