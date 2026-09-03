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
// it at the end. Both need to bind and connect on loopback — from an agent
// sandbox that means running this ONE command with the sandbox bypass.
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
  const p = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`, '--remote-allow-origins=*', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(p);
  p.on('exit', () => rmSync(profile, { recursive: true, force: true }));
  console.log(`chrome pid ${p.pid} on port ${port}`);
  for (let i = 0; i < 50; i++) {
    await sleep(200);
    try { await fetch(`http://127.0.0.1:${port}/json/version`); return `http://127.0.0.1:${port}`; } catch { /* not up yet */ }
  }
  throw new Error('Chrome did not open its debugging port');
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
  const evaluate = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.exceptionDetails.exception || {}).description); return r.result.value; };
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
  const click = async sel => { const r = await rect(sel); if (!r) throw new Error(`no element ${sel}`); await s.evaluate(`document.querySelector(${JSON.stringify(sel)}).scrollIntoView({block:'center'})`); await sleep(100); const r2 = await rect(sel); const x = r2.x + r2.w / 2, y = r2.y + r2.h / 2; await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }); await sleep(700); };
  const active = () => s.evaluate('(() => { const a = document.activeElement; return a ? a.tagName.toLowerCase() + (a.id ? "#" + a.id : "") + (a.closest("details") ? " in details#" + a.closest("details").id : "") + (a.closest("section") && a.closest("section").id ? " in section#" + a.closest("section").id : "") : null; })()');

  // 1. load: everything closed, nothing overflows, the readout speaks
  check(await s.evaluate('[...document.querySelectorAll("details.panel")].every(d => !d.open)'), 'every panel is closed on load');
  const sw = await s.evaluate('({ scroll: document.documentElement.scrollWidth, inner: window.innerWidth })');
  check(sw.scroll <= sw.inner, 'no horizontal overflow', `scrollWidth ${sw.scroll} ≤ ${sw.inner}`);
  // rendered elements only, and not the tables — those scroll inside .tblwrap by design
  const wide = await s.evaluate('[...document.querySelectorAll("#plate *")].filter(e => e.checkVisibility() && !e.closest(".tblwrap") && e.getBoundingClientRect().right > window.innerWidth + 1).map(e => e.tagName + "." + e.className).slice(0, 5)');
  check(wide.length === 0, 'no visible element sticks out on the right', wide.join(', '));
  check(await s.evaluate('document.querySelector("#lead [data-readout]").textContent.startsWith("day 14: TimesFM ×")'), 'the readout starts on day 14');
  const plot = await rect('#lead svg[data-lead]');
  check(plot && plot.h >= 90, 'the curve has height', `${Math.round(plot.w)}×${Math.round(plot.h)} px`);
  await s.send('Page.captureScreenshot', {}).then(r => writeFileSync(join(shots, `${name}-load.png`), Buffer.from(r.data, 'base64')));

  // 2. a block chip: re-render, then focus on the opened panel's summary, scrolled to it
  await click('.p-tabs a[href*="block=h31-90"]');
  check((await s.evaluate('location.search + location.hash')) === '?block=h31-90#skill', 'the URL carries block and panel', await s.evaluate('location.search + location.hash'));
  check(await s.evaluate('document.querySelector("details#skill").open'), 'the skill panel opened');
  check((await active()) === 'summary in details#skill', 'focus sits on the skill summary', await active());
  check((await s.evaluate('window.scrollY')) > 0, 'the page scrolled to it', `scrollY ${await s.evaluate('window.scrollY')}`);
  check(await s.evaluate('document.querySelector("details#skill summary").textContent.includes("days 31–90")'), 'the summary names the new block');
  check(await s.evaluate('document.querySelector("#lead .lead-bands span.on b").textContent.startsWith("-")'), 'the curve hatches the block with the negative skill');
  check(await s.evaluate('getComputedStyle(document.activeElement).outlineStyle === "solid"'), 'the focus ring is drawn', await s.evaluate('getComputedStyle(document.activeElement).outline'));
  await s.send('Page.captureScreenshot', {}).then(r => writeFileSync(join(shots, `${name}-block.png`), Buffer.from(r.data, 'base64')));

  // 3. a gauge chip on the curve: focus on the curve's heading, panel stays open
  await click('#lead .p-tabs a[href*="DRESDEN"]');
  check((await s.evaluate('location.search + location.hash')) === '?block=h31-90&lead=DRESDEN#lead', 'the URL carries the gauge', await s.evaluate('location.search + location.hash'));
  check((await active()) === 'h2 in section#lead', 'focus sits on the curve heading', await active());
  check(await s.evaluate('document.querySelector("details#skill").open'), 'the open panel survived the re-render');
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
  await s.send('Page.captureScreenshot', {}).then(r => writeFileSync(join(shots, `${name}-cursor.png`), Buffer.from(r.data, 'base64')));

  // 5. an index link opens its panel and focuses it; the others stay as they were
  await click('.index a[data-focus="calib"]');
  check(await s.evaluate('document.querySelector("details#calib").open && document.querySelector("details#skill").open'), 'calibration opened, skill stayed open');
  check((await active()) === 'summary in details#calib', 'focus sits on the calibration summary', await active());
  check((await s.evaluate('location.hash')) === '#calib', 'the hash names the panel');

  // 6. back: popstate re-derives query and hash, focus follows the hash
  await s.evaluate('history.back()'); await sleep(700);
  check((await s.evaluate('location.search + location.hash')) === '?block=h31-90&lead=DRESDEN#lead', 'back restores the previous URL', await s.evaluate('location.search + location.hash'));
  check((await active()) === 'h2 in section#lead', 'and focuses what the hash names', await active());
  await s.evaluate('history.back()'); await sleep(700);
  check((await s.evaluate('location.search + location.hash')) === '?block=h31-90#skill', 'back again: the gauge chip is undone', await s.evaluate('location.search + location.hash'));
  check(await s.evaluate('document.querySelector("#lead [data-readout]").textContent.endsWith("pooled")'), 'the curve is pooled again');

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
  const key = await s.evaluate('(() => { const r = document.querySelector("#lead .p-key").getBoundingClientRect(); return { x: r.x + scrollX, y: r.y + scrollY, w: r.width, h: r.height }; })()');
  await s.send('Page.captureScreenshot', { captureBeyondViewport: true, clip: { x: key.x, y: key.y, width: key.w, height: key.h, scale: 3 } })
    .then(r => writeFileSync(join(shots, `${name}-key.png`), Buffer.from(r.data, 'base64')));
  // and the other colour scheme, so both palettes get looked at
  const dark = await s.evaluate('matchMedia("(prefers-color-scheme: dark)").matches');
  await s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: dark ? 'light' : 'dark' }] });
  await sleep(200);
  await s.send('Page.captureScreenshot', {}).then(r => writeFileSync(join(shots, `${name}-${dark ? 'light' : 'dark'}.png`), Buffer.from(r.data, 'base64')));
  await s.close();
}

const url = await serve();
const cdp = await chrome();
console.log(`page ${url}\ncdp  ${cdp}\nshots ${shots}`);
try {
  await run(cdp, url, { name: 'desktop', width: 1240, height: 900, mobile: false });
  await run(cdp, url, { name: 'phone', width: 390, height: 844, mobile: true });
} finally {
  for (const c of children) c.kill();
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
