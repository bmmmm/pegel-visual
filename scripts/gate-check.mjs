#!/usr/bin/env node
// Drives the gate page (gate/) in a real headless Chrome and checks what the
// Node tests cannot: focus after a full re-render, the open state of the
// panels, popstate, the curve's cursor, and overflow on a phone viewport.
//
// Run it before every deploy of the page:
//
//     node scripts/gate-check.mjs                 # desktop 1240 + phone 390, screenshots into tmp-forecast/gate-check/
//     node scripts/gate-check.mjs --shots DIR     # screenshots elsewhere
//     node scripts/gate-check.mjs --url http://127.0.0.1:8765/gate/ --cdp http://127.0.0.1:9333
//
// Without --url it serves the repo itself (python3 -m http.server on a free
// port); without --cdp it starts Chrome headless on a fresh profile and stops
// it at the end (CHROME=<binary> overrides the macOS path; CI adds --no-sandbox).
// Both need to bind and connect on loopback — from an agent sandbox that means
// running this ONE command with the sandbox bypass. The `gate-page` job in
// .github/workflows/test.yml runs it on every push, so the deploy waits for it.
// Headless Chrome does not exit by itself when the script is killed: end the
// script normally (or kill Chrome by its pid, printed on start), never pkill.
//
// What is a failure: any check printed as FAIL; exit code 1. The list of checks
// is the contract of the page's behaviour — extend it with the page.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const args = Object.fromEntries(process.argv.slice(2).map((a, i, all) => a.startsWith('--') ? [a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : true] : []).filter(x => x.length));
const shots = resolve(args.shots || join(ROOT, 'tmp-forecast', 'gate-check'));
mkdirSync(shots, { recursive: true });

const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });

const children = [];
async function serve() {
  if (args.url) return args.url;
  const port = await freePort();
  const p = spawn('python3', ['-m', 'http.server', String(port), '--directory', ROOT, '--bind', '127.0.0.1'], { stdio: 'ignore' });
  children.push(p);
  await sleep(600);
  return `http://127.0.0.1:${port}/gate/`;
}
async function chrome() {
  if (args.cdp) return args.cdp;
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), 'gate-check-'));
  // CI runners: no user namespace for Chrome's own sandbox, and /dev/shm is tiny
  const p = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`, '--remote-allow-origins=*', ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(p);
  let stderr = '';
  p.stderr.on('data', d => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });  // drained, or a chatty Chrome blocks on a full pipe
  let exited = null;
  p.on('exit', (code, signal) => { exited = `${code ?? signal}`; rmSync(profile, { recursive: true, force: true }); });
  console.log(`chrome ${CHROME} pid ${p.pid} on port ${port}`);
  for (let i = 0; i < 120 && exited == null; i++) {
    await sleep(250);
    try { await fetch(`http://127.0.0.1:${port}/json/version`); return `http://127.0.0.1:${port}`; } catch { /* not up yet */ }
  }
  throw new Error(`Chrome did not open its debugging port (exit ${exited ?? 'still running'}); stderr:\n${stderr.trim().split('\n').slice(-25).join('\n')}`);
}

// a forty-line CDP client over the global WebSocket
async function session(cdp) {
  const t = await (await fetch(`${cdp}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text} ${(r.exceptionDetails.exception || {}).description || ''} — in: ${expr.slice(0, 120)}`); return r.result.value; };
  const close = async () => { ws.close(); await fetch(`${cdp}/json/close/${t.id}`).catch(() => {}); };
  return { send, evaluate, close };
}

let failures = 0;
const check = (ok, what, detail = '') => { console.log(`${ok ? '  ok ' : 'FAIL '} ${what}${detail ? ' — ' + detail : ''}`); if (!ok) failures++; };

async function run(cdp, url, { name, width, height, mobile }) {
  console.log(`\n== ${name} (${width}×${height}${mobile ? ', mobile, coarse pointer' : ''})`);
  const s = await session(cdp);
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: !!mobile });
  // (pointer: coarse) is not a feature setEmulatedMedia can override — Chrome derives it from touch emulation
  if (mobile) await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  const open = async u => { await s.send('Page.navigate', { url: u }); for (let i = 0; i < 40 && !(await s.evaluate('!!document.querySelector("#lead svg[data-lead]")')); i++) await sleep(250); await sleep(200); };
  await open(url);
  check(await s.evaluate('!!document.querySelector("#lead svg[data-lead]")'), 'the page rendered its curve');
  if (mobile) check(await s.evaluate('matchMedia("(pointer: coarse)").matches'), 'the emulated pointer is coarse');

  const rect = sel => s.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);
  // The page scrolls `behavior: 'smooth'` (gate.js, focusFor), so a rect measured
  // while a scroll is still running is a rect that has already moved by the time
  // the click lands — the press falls in the gap between two chips, nothing
  // happens, and every check after it fails for a reason that is not there. This
  // waits for the page to stop moving before believing a measurement. It was a
  // latent race: 24 px of new page height was enough to start losing the click.
  const settle = async (tries = 40) => {
    let last = null;
    for (let i = 0; i < tries; i++) {
      const y = await s.evaluate('scrollY');
      if (y === last) return y;
      last = y;
      await sleep(50);
    }
    return last;
  };
  // A press is dispatched at a POINT, so the helper checks that the point still
  // belongs to the element before spending it: a rect measured a frame too early
  // sends the click into the gap between two chips, nothing happens, and every
  // check downstream fails for a reason that is not there. It re-measures rather
  // than guessing, and says so loudly if the point never becomes the element.
  const click = async sel => {
    if (!(await rect(sel))) throw new Error(`no element ${sel}`);
    await s.evaluate(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({block:'center'})`);
    let r2, hit = false;
    for (let i = 0; i < 20 && !hit; i++) {
      await settle();
      r2 = await rect(sel);
      hit = await s.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); const r = e.getBoundingClientRect(); const t = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2); return !!t && (t === e || e.contains(t)); })()`);
      if (!hit) await sleep(50);
    }
    if (!hit) throw new Error(`the centre of ${sel} is not the element itself — something covers it, or it never stopped moving`);
    const x = r2.x + r2.w / 2, y = r2.y + r2.h / 2;
    await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(700); await settle();
  };
  const active = () => s.evaluate('(() => { const a = document.activeElement; return a ? a.tagName.toLowerCase() + (a.id ? "#" + a.id : "") + (a.closest("details") ? " in details#" + a.closest("details").id : "") + (a.closest("section") && a.closest("section").id ? " in section#" + a.closest("section").id : "") : null; })()');

  // 1. load: everything closed, nothing overflows, the readout speaks
  check(await s.evaluate('[...document.querySelectorAll("details.panel")].every(d => !d.open)'), 'every panel is closed on load');
  const sw = await s.evaluate('({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth })');
  check(sw.scroll <= sw.inner, 'no horizontal overflow', `scrollWidth ${sw.scroll} ≤ ${sw.inner}`);
  // rendered elements only, and not the tables — those scroll inside .tblwrap by design
  const sweep = () => s.evaluate('[...document.querySelectorAll("#plate *")].filter(e => e.checkVisibility() && !e.closest(".tblwrap") && e.getBoundingClientRect().right > window.innerWidth + 1).map(e => e.tagName + "." + e.className).slice(0, 5)');
  const wide = await sweep();
  check(wide.length === 0, 'no visible element sticks out on the right', wide.join(', '));

  // 1b. THE FIRST LOOK — asserted HERE, on the page as delivered, before this
  //     script forces every <details> open and shut again. Downstream of that
  //     reset "every fold comes shut" would be testing a state the harness had
  //     just imposed: green even if the page shipped every fold open.
  //     The sheet's whole claim is a verdict and a drawing; if the drawing is
  //     not on the first screen, the claim is not made. Measured before the
  //     folds went in: the plot started 661 px down a 900 px desktop (cut off
  //     at the bottom) and 1 213 px down an 844 px phone — not there at all.
  const foldState = await s.evaluate(`JSON.stringify([...document.querySelectorAll('details.fold')].map(d => ({ id: d.id, open: d.open, lid: d.querySelector('summary').textContent.trim() })))`);
  const folds = JSON.parse(foldState);
  check(folds.length >= 3 && folds.every(f => !f.open), 'every fold arrives shut, as delivered', foldState);
  const lidOf = async id => (JSON.parse(await s.evaluate(`JSON.stringify((() => { const d = document.getElementById(${JSON.stringify(id)}); return d ? d.querySelector('summary').textContent.trim() : null; })())`)));
  const settingsLid = folds.find(f => f.id === 'settings');
  check(!!settingsLid && /daily mid/.test(settingsLid.lid) && /days 1–14/.test(settingsLid.lid),
    'and the shut settings lid still says which target and horizon the picture is drawn for', settingsLid && settingsLid.lid);
  const plot0 = await rect('#lead svg[data-lead]');
  const vh = await s.evaluate('innerHeight');
  check(plot0 && plot0.y + plot0.h <= vh, 'the drawing is whole on the first screen', `plot ${Math.round(plot0.y)}–${Math.round(plot0.y + plot0.h)} px of ${vh}`);

  await s.evaluate('for (const d of document.querySelectorAll("details")) d.open = true');
  const wideOpen = await sweep();
  // Measured against the EMULATED width, not window.innerWidth: on a phone
  // viewport Chrome widens the layout viewport to fit an overflow, so innerWidth
  // grows with the very thing this is looking for and `scroll <= inner` is
  // always true. A plot that spilled 44 px past a 390 px phone passed this check
  // reading "scrollWidth 434" next to an inner of 434.
  const sw2 = await s.evaluate('({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth })');
  check(wideOpen.length === 0 && sw2.scroll <= width + 1, 'nothing sticks out with every panel and table open either',
    wideOpen.join(', ') + ` scrollWidth ${sw2.scroll} vs ${width} emulated (innerWidth ${sw2.inner})`);
  await s.evaluate('for (const d of document.querySelectorAll("details")) d.open = false');
  await settle();   // every one of those toggles can have started a smooth scroll of its own
  check(await s.evaluate('/^day 14: TimesFM/.test(document.querySelector("#lead [data-readout]").textContent)'), 'the readout starts on day 14 and names its model',
    await s.evaluate('document.querySelector("#lead [data-readout]").textContent.slice(0, 60)'));
  const plot = await rect('#lead svg[data-lead]');
  check(plot && plot.h >= 90, 'the curve has height', `${Math.round(plot.w)}×${Math.round(plot.h)} px`);
  await s.send('Page.captureScreenshot', {}).then(r => writeFileSync(join(shots, `${name}-load.png`), Buffer.from(r.data, 'base64')));

  // 2. the filter row sits against the curve, and a chip keeps the reader on it.
  //    (Before this order: the chips were 1 121 px below the curve's head on desktop,
  //    2 173 on a phone, and a click scrolled the curve clean off the top.)
  const openFold = async id => { await s.evaluate(`(() => { const d = document.getElementById(${JSON.stringify(id)}); if (d && !d.open) d.open = true; })()`); await settle(); };
  await openFold('settings');
  const rowY = await rect('nav.p-tabs[aria-label$="target and horizon block"]');
  check(rowY.y < plot.y, 'the filter row is above the curve it relabels', `row ${Math.round(rowY.y)} px, curve ${Math.round(plot.y)} px`);
  await click('nav.p-tabs a[data-ctl="block"][href*="block=h31-90"]');
  check(await s.evaluate('document.getElementById("settings").open'), 'and the fold it lives in survives its own click');
  // the lid must FOLLOW the state, not merely happen to spell the defaults: a lid
  // frozen on "daily mid · days 1–14" passes every check that only ever loads the
  // default URL, and is then the one place the sheet lies about what it is drawing
  const movedLid = await lidOf('settings');
  check(/days 31–90/.test(movedLid) && !/days 1–14/.test(movedLid), 'and its lid now names the block that is drawn, not the default', movedLid);
  check((await s.evaluate('location.search + location.hash')) === '?block=h31-90#lead', 'the URL carries block and the drawing it shows', await s.evaluate('location.search + location.hash'));
  check(!(await s.evaluate('document.querySelector("details#skill").open')), 'no panel is thrown open behind the reader');
  check((await active()) === 'h2 in section#lead', 'focus stays on the curve heading', await active());
  const curveTop = await s.evaluate('document.querySelector("#lead").getBoundingClientRect().top');
  const curveSeen = await s.evaluate('(() => { const r = document.querySelector("#lead svg[data-lead]").getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0; })()');
  check(curveSeen, 'and the drawing being compared is still on screen', `#lead top ${Math.round(curveTop)} px`);
  check(await s.evaluate('document.querySelector("#lead .lead-bands a.on b").textContent.startsWith("-")'), 'the curve hatches the block with the negative skill');
  check(await s.evaluate('document.querySelector("details#skill summary").textContent.includes("days 31–90")'), 'and the panels below carry the new block in their titles');
  check(await s.evaluate('getComputedStyle(document.activeElement).outlineStyle === "solid"'), 'the focus ring is drawn', await s.evaluate('getComputedStyle(document.activeElement).outline'));
  await s.send('Page.captureScreenshot', {}).then(r => writeFileSync(join(shots, `${name}-block.png`), Buffer.from(r.data, 'base64')));

  // 2b. the model chips: one independent on/off each, the last one on disabled,
  //     and the WHOLE sheet — curve, panel titles, prose — follows what is left.
  const chipRow = 'nav.p-tabs';
  const modelChips = await s.evaluate(`document.querySelectorAll('${chipRow} [data-ctl="model"]').length`);
  if (modelChips >= 2) {
    // derived, not hardcoded to two: a third candidate must turn these red for a
    // real reason or not at all, never because the count moved
    const BASELINES = 2;  // persistence and climatology, drawn once for every model
    const paths = () => s.evaluate('document.querySelectorAll("#lead svg[data-lead] path.ln").length');
    check((await paths()) === modelChips + BASELINES, `all ${modelChips} models are drawn beside the two baselines`, `${await paths()} lines`);
    // no two model lines may be told apart by colour alone — nor by dash alone:
    // where two candidates lie on each other a dash pattern is unreadable, so
    // each carries BOTH. This resolves the real cascade, which is the only place
    // `--m2: var(--water-line)` — the state this sheet shipped in — shows up.
    const strokes = await s.evaluate('JSON.stringify([...document.querySelectorAll("#lead path.ln:not(.ln-persist):not(.ln-clim)")].map(p => [getComputedStyle(p).strokeDasharray, getComputedStyle(p).stroke]))');
    const drawn = JSON.parse(strokes);
    check(drawn.length === modelChips && new Set(drawn.map(d => d[0])).size === drawn.length, 'and each told apart by its own dash', strokes);
    check(new Set(drawn.map(d => d[1])).size === drawn.length, 'and by its own colour, so the two survive lying on each other', strokes);
    // Every swatch in the key must actually show INK, and paint is the point: a
    // closed <details> keeps its layout, so these rects are real even while the
    // key is folded away — and the check would pass on geometry alone while the
    // subtree is never painted. Open it first, or this measures nothing.
    await openFold('leadkey');
    // a dasharray that starts on
    // a gap, or a mark placed off its own viewBox, leaves an empty 12 px box that
    // no Node test can see
    const inked = await s.evaluate('JSON.stringify([...document.querySelectorAll("#lead .p-key .sw svg line")].map(l => { const r = l.getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; }))');
    check(JSON.parse(inked).every(([w, h]) => Math.max(w, h) >= 8), 'every line swatch in the key is drawn, not an empty box', inked);

    await click(`${chipRow} a[data-ctl="model"][href*="models="]`);
    const url = await s.evaluate('location.search + location.hash');
    check(/[?&]models=/.test(url), 'a model chip puts the selection in the URL', url);
    check((await paths()) === modelChips - 1 + BASELINES, 'one model fewer is one line fewer', `${await paths()} lines`);
    check((await active()) === 'h2 in section#lead', 'and the focus stays on the drawing it changed', await active());
    const left = await s.evaluate(`document.querySelector('${chipRow} span.off[data-ctl="model"]') && document.querySelector('${chipRow} span.off[data-ctl="model"]').textContent`);
    check(!!left, 'the last model on cannot be switched off — its chip is disabled, not gone', String(left));
    // and it must still LOOK like the model in view. Painted like an ordinary
    // unavailable chip it reads as greyed out while the model switched off beside
    // it reads as available — the state inverted, which no class assertion sees.
    // Its ground is the model's own hue, so this measures the chip against the
    // CURVE it names rather than against some other lit chip: the one assertion
    // that catches a name and a line drifting onto different colours.
    const paint = await s.evaluate(`JSON.stringify((() => {
      const chip = document.querySelector('${chipRow} span.off[data-ctl="model"]');
      const mark = [...chip.classList].find(c => c.startsWith('m-'));
      const line = mark && document.querySelector('#lead svg[data-lead] path.ln-' + mark.slice(2));
      return { mark, locked: getComputedStyle(chip).backgroundColor,
        curve: line ? getComputedStyle(line).stroke : null,
        off: getComputedStyle(document.querySelector('${chipRow} a[data-ctl="block"]:not(.on)')).backgroundColor };
    })())`);
    const paints = JSON.parse(paint);
    check(paints.locked === paints.curve && paints.locked !== paints.off, 'and it is painted in the colour of the curve it names, not like one that is unavailable', paint);
    const title = await s.evaluate('document.querySelector("details#skill summary").textContent');
    check(title.includes(String(left).replace(/[^\x20-\x7e].*$/, '').trim()), 'and the panels below name the model they now speak for', title);
    const cols = await s.evaluate('(() => { const d = document.querySelector("details#error details.tbl"); d.open = true; const th = [...d.querySelectorAll("thead th")].map(x => x.textContent); const td = [...d.querySelectorAll("tbody tr:first-child td")].map(x => x.textContent); d.open = false; return JSON.stringify({ th, dash: td.filter(x => x === "—").length }); })()');
    const tbl = JSON.parse(cols);
    check(tbl.th.includes(String(left).replace(/[^\x20-\x7e].*$/, '').trim()), 'the table twin has a column for the model in view', cols);
    check(tbl.dash === 0 || tbl.th.includes('upstream OLS'), 'and its first row is numbers, not dashes', cols);
    await s.send('Page.captureScreenshot', {}).then(r => writeFileSync(join(shots, `${name}-one-model.png`), Buffer.from(r.data, 'base64')));
    await s.evaluate('history.back()');
    await sleep(400);
    check((await paths()) === modelChips + BASELINES, 'back restores every curve', `${await paths()} lines`);
  }

  // 3. a gauge chip on the curve: focus on the curve's heading, panel stays open,
  //    and — the chip sits ON its drawing — the page does not move under the reader.
  //    (Before that rule it travelled 415 px on desktop and 239 on a phone, per click.)
  await s.evaluate('scrollTo({ top: Math.round(document.querySelector("#lead .p-tabs").getBoundingClientRect().top + scrollY) - 20, behavior: "instant" })');
  await sleep(300);
  const parked = await s.evaluate('Math.round(scrollY)');
  // NOT through click(): that helper scrollIntoViews its target first, which is
  // the very movement being measured here. Dispatch where the chip already sits.
  const chip = await rect('#lead .p-tabs a[href*="DRESDEN"]');
  for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
    await s.send('Input.dispatchMouseEvent', { type, x: chip.x + chip.w / 2, y: chip.y + chip.h / 2, button: 'left', clickCount: 1 });
  }
  await sleep(900);
  const moved = Math.abs((await s.evaluate('Math.round(scrollY)')) - parked);
  check(moved <= 2, 'a gauge chip does not move the page it is standing on', `${moved} px, parked at ${parked}`);
  check(await s.evaluate('!!document.querySelector("#lead svg[data-lead][data-core]")'), 'the drawing is the part marked as having to stay in view');
  check((await s.evaluate('location.search + location.hash')) === '?block=h31-90&lead=DRESDEN#lead', 'the URL carries the gauge', await s.evaluate('location.search + location.hash'));
  check((await active()) === 'h2 in section#lead', 'focus sits on the curve heading', await active());
  await s.evaluate('document.querySelector("#lead details.tbl").open = true');
  await click('#lead .p-tabs a[href*="KOBLENZ"]');
  check(await s.evaluate('document.querySelector("#lead details.tbl").open'), 'an open table twin survives the re-render');
  await s.evaluate('history.back()'); await sleep(700);  // one entry back: DRESDEN again, through popstate
  check((await s.evaluate('location.search + location.hash')) === '?block=h31-90&lead=DRESDEN#lead', 'back from the KOBLENZ chip lands on DRESDEN', await s.evaluate('location.search + location.hash'));
  check(await s.evaluate('document.querySelector("#lead details.tbl").open'), 'the table twin is still open after popstate');
  await s.evaluate('document.querySelector("#lead details.tbl").open = false');
  check(await s.evaluate('document.querySelector("#lead [data-readout]").textContent.endsWith("cm")'), 'the readout is for one gauge, not pooled');
  check(await s.evaluate('!!document.querySelector("#lead .clip.up.ln-clim")'), 'Dresden’s climatology is marked above the frame');

  // 4. the cursor: arrow keys and the pointer move the day, nothing re-renders
  await s.evaluate('document.querySelector("#lead svg[data-lead]").focus()');
  const before = await s.evaluate('document.querySelector("#lead [data-readout]").textContent');
  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight', windowsVirtualKeyCode: 39 });
  await sleep(100);
  const after = await s.evaluate('document.querySelector("#lead [data-readout]").textContent');
  check(before.startsWith('day 90') && after === before, 'ArrowRight at day 90 stays put', after.slice(0, 12));
  await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37 });
  await sleep(100);
  check((await s.evaluate('document.querySelector("#lead svg[data-lead]").getAttribute("aria-valuenow")')) === '89', 'ArrowLeft moves the cursor to day 89');
  const p = await rect('#lead svg[data-lead]');
  const px = p.x + p.w * 0.25, py = p.y + p.h / 2;
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: px, y: py, button: 'left', clickCount: 1 });
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: px, y: py, button: 'left', clickCount: 1 });
  await sleep(100);
  const day = Number(await s.evaluate('document.querySelector("#lead svg[data-lead]").getAttribute("aria-valuenow")'));
  check(mobile ? day === 25 : day === 23, `a press at a quarter of the width lands on day ${mobile ? 25 : 23}`, `day ${day}`);
  check(await s.evaluate('document.querySelector("#lead [data-readout]").textContent.startsWith("day " + document.querySelector("#lead svg[data-lead]").getAttribute("aria-valuenow"))'), 'the readout follows the cursor');
  check((await s.evaluate('location.search + location.hash')) === '?block=h31-90&lead=DRESDEN#lead', 'the cursor never touches the URL');
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x + p.w * 0.75, y: py });
  await sleep(100);
  check(Number(await s.evaluate('document.querySelector("#lead svg[data-lead]").getAttribute("aria-valuenow")')) === day, 'a passing mouse does not move the parked cursor');
  await click('#lead .lead-bands a[href*="block=h15-30"]');
  check((await s.evaluate('location.search + location.hash')) === '?block=h15-30&lead=DRESDEN#lead', 'a band label switches the block', await s.evaluate('location.search + location.hash'));
  check(await s.evaluate('document.querySelector("#lead .lead-bands a.on").textContent.startsWith("15–30")'), 'and the hatch moves with it');
  check((await active()) === 'h2 in section#lead', 'focus stays on the curve');
  await s.evaluate('history.back()'); await sleep(700);
  check((await s.evaluate('location.search + location.hash')) === '?block=h31-90&lead=DRESDEN#lead', 'back undoes the band click');
  await s.send('Page.captureScreenshot', {}).then(r => writeFileSync(join(shots, `${name}-cursor.png`), Buffer.from(r.data, 'base64')));

  // 5. an index link opens its panel and focuses it; the others stay as they were
  await click('.index a[data-focus="calib"]');
  check(await s.evaluate('document.querySelector("details#calib").open'), 'the index link opened calibration');
  // the other half of the rule: a section that really IS out of view still gets
  // pulled to the top, or "don't scroll when it's visible" would have become
  // "never scroll" — and the index would stop working
  const calibTop = await s.evaluate('document.querySelector("details#calib summary").getBoundingClientRect().top');
  check(calibTop >= -2 && calibTop <= 60, 'and scrolled it to the top of the window', `summary top ${Math.round(calibTop)} px`);
  check((await active()) === 'summary in details#calib', 'focus sits on the calibration summary', await active());
  check((await s.evaluate('location.hash')) === '#calib', 'the hash names the panel');

  // 6. back: popstate re-derives query and hash, focus follows the hash
  await s.evaluate('history.back()'); await sleep(700);
  check((await s.evaluate('location.search + location.hash')) === '?block=h31-90&lead=DRESDEN#lead', 'back restores the previous URL', await s.evaluate('location.search + location.hash'));
  check((await active()) === 'h2 in section#lead', 'and focuses what the hash names', await active());
  await s.evaluate('history.back()'); await sleep(700);
  check((await s.evaluate('location.search + location.hash')) === '?block=h31-90#lead', 'back again: the gauge chip is undone', await s.evaluate('location.search + location.hash'));
  check(await s.evaluate('document.querySelector("#lead [data-readout]").textContent.endsWith("pooled")'), 'the curve is pooled again');
  await s.evaluate('history.back()'); await sleep(700);
  check((await s.evaluate('location.search + location.hash')) === '', 'back to the start: a bare URL', await s.evaluate('location.search + location.hash'));
  check((await active()) === 'h1', 'with no panel to name, the focus lands on the h1', await active());
  await click('nav.p-tabs a[data-ctl="block"][href*="block=h31-90"]');
  const entries = await s.evaluate('history.length');
  await click('nav.p-tabs a[data-ctl="block"][href*="block=h31-90"]');
  check((await s.evaluate('history.length')) === entries, 'clicking the active chip again adds no history entry');

  // 7. a deep link opens its panel on load
  await open(url + '?target=max#clim');
  check(await s.evaluate('document.querySelector("details#clim").open'), 'a #clim deep link opens the panel');
  check((await active()) === 'summary in details#clim', 'and focuses it', await active());
  check(await s.evaluate('document.querySelector(".p-sub").textContent.startsWith("On the daily max target")'), 'the gist follows the target');

  // 8. a full-page shot of the plain page, and a close-up of the curve's key
  await open(url);
  const full = await s.evaluate('({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })');
  await s.send('Page.captureScreenshot', { captureBeyondViewport: true, clip: { x: 0, y: 0, width: full.w, height: Math.min(full.h, 6000), scale: 1 } })
    .then(r => writeFileSync(join(shots, `${name}-full.png`), Buffer.from(r.data, 'base64')));
  // clip coordinates are page coordinates: the viewport rect plus the scroll
  await openFold('leadkey');   // layout survives a shut fold, paint does not — an unopened key crops to blank
  const key = await s.evaluate('(() => { const r = document.querySelector("#lead .p-key").getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height }; })()');
  await s.send('Page.captureScreenshot', { captureBeyondViewport: true, clip: { x: key.x, y: key.y, width: key.w, height: key.h, scale: 3 } })
    .then(r => writeFileSync(join(shots, `${name}-key.png`), Buffer.from(r.data, 'base64')));
  // and the other colour scheme, so both palettes get looked at
  const dark = await s.evaluate('matchMedia("(prefers-color-scheme: dark)").matches');
  await s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'light' : 'dark' }] });
  await sleep(200);
  await s.send('Page.captureScreenshot', {}).then(r => writeFileSync(join(shots, `${name}-${dark ? 'light' : 'dark'}.png`), Buffer.from(r.data, 'base64')));
  // 7. the address bar follows what the reader unfolds, so any URL can be sent as
  //    it stands. Last on purpose: this uses replaceState, which EDITS the current
  //    history entry — doing it inside the back/forward chain above would rewrite
  //    the very entries that chain is checking.
  await s.send('Page.navigate', { url: url.replace(/[?#].*$/, '') + '?block=h31-90&lead=DRESDEN' });
  for (let i = 0; i < 40 && !(await s.evaluate('!!document.querySelector("#lead svg[data-lead]")')); i++) await sleep(250);
  await sleep(300);
  const foldsBefore = await s.evaluate('history.length');
  await click('details#method > summary');
  check((await s.evaluate('location.hash')) === '#method', 'opening Method by hand puts it in the URL', await s.evaluate('location.hash'));
  await click('details#short > summary');
  check((await s.evaluate('location.hash')) === '#short', 'opening a second panel names the newer one', await s.evaluate('location.hash'));
  check((await s.evaluate('location.search')) === '?block=h31-90&lead=DRESDEN', 'and the data in the query is untouched', await s.evaluate('location.search'));
  await click('details#short > summary');
  check((await s.evaluate('location.hash')) === '#method', 'closing it hands the hash back to the one still open', await s.evaluate('location.hash'));
  await click('details#method > summary');
  check((await s.evaluate('location.hash')) === '', 'closing the last one drops the hash', await s.evaluate('location.hash'));
  check((await s.evaluate('history.length')) === foldsBefore, 'four folds, no history entries', `${await s.evaluate('history.length')} vs ${foldsBefore}`);
  // a chip re-renders the whole sheet; what the reader unfolded has to survive it
  await click('details#method > summary');
  await click('details#short > summary');
  await openFold('settings');   // the chips live in a fold now, and a fresh render brings it back shut
  await click('nav.p-tabs[aria-label$="target and horizon block"] a[href*="block=h15-30"]');
  check(await s.evaluate('document.querySelector("details#short").open && document.querySelector("details#method").open'), 'both open panels survive a chip’s re-render');
  check((await s.evaluate('location.hash')) === '#lead', 'and the chip names the drawing it changed, not a panel it merely reopened', await s.evaluate('location.hash'));
  // a sent URL arrives on the right sheet: same data, that panel open and focused
  await s.send('Page.navigate', { url: url.replace(/[?#].*$/, '') + '?target=max&block=h15-30#short' });
  for (let i = 0; i < 40 && !(await s.evaluate('!!document.querySelector("#lead svg[data-lead]")')); i++) await sleep(250);
  await sleep(300);
  check(await s.evaluate('document.querySelector("details#short").open'), 'a sent link opens the panel it names');
  check((await active()) === 'summary in details#short', 'and focuses it', await active());
  check((await s.evaluate('document.querySelector(\'nav.p-tabs a[data-ctl="target"].on\').textContent')) === 'daily max', 'with the target the link carried');

  await s.close();
}

// The palette, resolved by the real cascade, in BOTH schemes. The Node test can
// only compare declaration text — `--m2: light-dark(#8c0f42, #9fd4ec)` puts two
// candidates in one blue for every dark-mode reader while every string in the
// stylesheet still differs. Only a browser sees that, and only if it is asked in
// the scheme where it happens: the runner's own scheme is whatever the machine
// reports (dark on this laptop, light on a CI runner), so neither is assumed.
async function palette(cdp, url) {
  for (const scheme of ['light', 'dark']) {
    console.log(`\n== palette (${scheme})`);
    const s = await session(cdp);
    await s.send('Page.enable');
    await s.send('Runtime.enable');
    await s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    await s.send('Emulation.setDeviceMetricsOverride', { width: 1240, height: 900, deviceScaleFactor: 1, mobile: false });
    await s.send('Page.navigate', { url });
    for (let i = 0; i < 40 && !(await s.evaluate('!!document.querySelector("#lead svg[data-lead]")')); i++) await sleep(250);
    check(await s.evaluate(`matchMedia("(prefers-color-scheme: ${scheme})").matches`), `the page really is in ${scheme}`);
    // one row per model: its chip, its curve, the name in the verdict list
    const seen = await s.evaluate(`JSON.stringify([...document.querySelectorAll('nav.p-tabs [data-ctl="model"]')].map(chip => {
      const mark = ([...chip.classList].find(c => c.startsWith('m-')) || '').slice(2);
      const line = document.querySelector('#lead svg[data-lead] path.ln-' + mark);
      const name = [...document.querySelectorAll('.vmodels li')].find(li => li.classList.contains('m-' + mark));
      const cs = getComputedStyle(chip), lit = chip.classList.contains('on');
      return { mark, label: chip.textContent.trim(),
        chip: lit ? cs.backgroundColor : cs.color,
        curve: line ? getComputedStyle(line).stroke : null,
        dash: line ? getComputedStyle(line).strokeDasharray : null,
        name: name ? getComputedStyle(name.querySelector('.nm')).color : null };
    }))`);
    const rows = JSON.parse(seen);
    check(rows.length >= 1 && rows.every(r => r.mark), `every model chip carries a mark class`, seen);
    for (const r of rows) {
      check(r.curve && r.chip === r.curve, `${r.label}: the chip and the curve are one colour`, `${r.chip} vs ${r.curve}`);
      check(r.name === r.curve, `${r.label}: and so is its name in the verdict list`, `${r.name} vs ${r.curve}`);
    }
    const curves = rows.map(r => r.curve).filter(Boolean);
    check(new Set(curves).size === curves.length, 'no two candidates resolve to one colour in this scheme', JSON.stringify(curves));
    const dashes = rows.map(r => r.dash).filter(Boolean);
    check(new Set(dashes).size === dashes.length, 'nor to one dash', JSON.stringify(dashes));
    // `--mc` inherits, and the locked-on chip falls back to the ink only when
    // nobody set it. No report reaches "a target chip that is locked on", so the
    // state is built here: a block chip must never come out in a model's hue.
    const spill = await s.evaluate(`JSON.stringify((() => {
      const c = document.querySelector('nav.p-tabs a[data-ctl="block"]:not(.on)');
      const was = c.className;
      c.className = 'off on';
      const bg = getComputedStyle(c).backgroundColor;
      c.className = was;
      const ink = getComputedStyle(document.body).color;
      const model = getComputedStyle(document.querySelector('#lead svg[data-lead] path.ln-tfm')).stroke;
      return { bg, ink, model };
    })())`);
    const sp = JSON.parse(spill);
    check(sp.bg === sp.ink && sp.bg !== sp.model, 'a locked-on chip that is not a model keeps the ink, not a candidate’s hue', spill);
    await s.close();
  }
}

const url = await serve();
const cdp = await chrome();
console.log(`page ${url}\ncdp  ${cdp}\nshots ${shots}`);
try {
  for (const vp of [{ name: 'desktop', width: 1240, height: 900, mobile: false }, { name: 'phone', width: 390, height: 844, mobile: true }]) {
    try { await run(cdp, url, vp); } catch (e) { check(false, `${vp.name}: the run threw`, String(e.stack || e).split('\n').slice(0, 3).join(' | ')); }
  }
  try { await palette(cdp, url); } catch (e) { check(false, 'the palette pass threw', String(e.stack || e).split('\n').slice(0, 3).join(' | ')); }
} finally {
  for (const c of children) c.kill();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
