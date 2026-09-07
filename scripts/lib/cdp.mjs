// The apparatus every browser check in this repo needs: a local server, a
// headless Chrome, a CDP client over the global WebSocket, and a PASS/FAIL
// counter. The recipe itself — and why `--headless=new --screenshot` proves
// nothing here — is .claude/domains/browser-verify.md; this file is only its
// mechanics, factored out of the three scripts that each carried a copy
// (gate-check, verify-precip, gate-rain-check).
//
// Callers need the sandbox bypass: serve() binds a loopback port and chrome()
// connects to one.
//
// Headless Chrome does not exit by itself when the caller is killed. End the
// script normally, or kill Chrome by the pid printed on start — never pkill.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export const freePort = () => new Promise((res, rej) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  s.on('error', rej);
});

// every child this module spawns, so a caller can take them all down in one
// `finally` — a leaked python3 holds the port, a leaked Chrome holds a profile.
// The profiles are removed here as well as on the child's `exit`: a script that
// calls process.exit() right after this never reaches that event handler.
export const children = [];
const profiles = [];
export const killChildren = () => {
  for (const c of children) c.kill();
  // Best effort, and never fatal: a Chrome that was killed a millisecond ago is
  // still writing into its profile, so this races and ENOTEMPTYs. Letting that
  // throw out of a caller's `finally` would replace the run's real exit code
  // with a crash — a green check reported as a failure, over a temp directory
  // the OS sweeps anyway.
  for (const p of profiles) { try { rmSync(p, { recursive: true, force: true }); } catch { /* the OS gets it */ } }
};

// `url` short-circuits the whole thing: pointing a check at the deployed page
// (GATE_BASE_URL, LANUK_BASE_URL, --url) is the same run against another origin.
//
// The server is polled, not slept at: a blind wait fails on a loaded runner as
// "the page never painted", which is the reading that costs the most to chase.
export async function serve({ root, path = '/', url = null, settle = 700 } = {}) {
  if (url) return url;
  const port = await freePort();
  children.push(spawn('python3', ['-m', 'http.server', String(port), '--directory', root, '--bind', '127.0.0.1'], { stdio: 'ignore' }));
  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + Math.max(settle, 5000);
  for (;;) {
    try { await fetch(base + '/', { method: 'HEAD' }); break; } catch {
      if (Date.now() > deadline) throw new Error(`the local server never answered on ${base}`);
      await sleep(100);
    }
  }
  return base + path;
}

// CHROME=<binary> overrides the macOS path (CI passes google-chrome). A fresh
// --user-data-dir per run matters beyond hygiene: it is what keeps a service
// worker registered by one run from serving the next one its cached index.html.
export async function chrome({ bin = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  tag = 'browser-check', cdp = null } = {}) {
  if (cdp) return cdp;
  const port = await freePort();
  const profile = mkdtempSync(join(tmpdir(), `${tag}-`));
  profiles.push(profile);
  // CI runners: no user namespace for Chrome's own sandbox, and /dev/shm is tiny
  const p = spawn(bin, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${profile}`, `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    ...(process.env.CI ? ['--no-sandbox', '--disable-dev-shm-usage'] : []), 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  children.push(p);
  let stderr = '';
  p.stderr.on('data', d => { stderr += d; if (stderr.length > 20000) stderr = stderr.slice(-20000); });  // drained, or a chatty Chrome blocks on a full pipe
  let exited = null;
  p.on('exit', (code, signal) => { exited = `${code ?? signal}`; rmSync(profile, { recursive: true, force: true }); });
  console.log(`chrome ${bin} pid ${p.pid} on port ${port}`);
  for (let i = 0; i < 120 && exited == null; i++) {
    await sleep(250);
    try { await fetch(`http://127.0.0.1:${port}/json/version`); return `http://127.0.0.1:${port}`; } catch { /* not up yet */ }
  }
  throw new Error(`Chrome did not open its debugging port (exit ${exited ?? 'still running'}); stderr:\n${stderr.trim().split('\n').slice(-25).join('\n')}`);
}

// The forty-line CDP client. Two things beyond request/response:
//
//   events — the console, every response code and every uncaught exception,
//     collected from the moment the domains are enabled. Enable Runtime, Log
//     and Network BEFORE navigating, or a request the app swallows in a
//     `.catch` stays invisible.
//   on(method, fn) — CDP events carry no `id`, so without a dispatcher they
//     land on the floor. Fetch.requestPaused is the one that needs this: an
//     interception that is never answered hangs the page rather than failing it.
//     ONE handler per method: a second on() for the same event replaces the
//     first, which for Fetch.requestPaused means the page stops being answered.
export async function session(cdp) {
  const t = await (await fetch(`${cdp}/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const pending = new Map();
  const handlers = new Map();
  const events = { console: [], responses: [], exceptions: [] };
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) {
      const { res, rej } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
      return;
    }
    if (m.method === 'Runtime.consoleAPICalled') events.console.push(`${m.params.type}: ${m.params.args.map(a => a.value ?? a.description ?? '').join(' ')}`);
    if (m.method === 'Log.entryAdded') events.console.push(`${m.params.entry.level}: ${m.params.entry.text} ${m.params.entry.url || ''}`);
    if (m.method === 'Runtime.exceptionThrown') events.exceptions.push(m.params.exceptionDetails.text + ' ' + ((m.params.exceptionDetails.exception || {}).description || ''));
    if (m.method === 'Network.responseReceived') events.responses.push({ url: m.params.response.url, status: m.params.response.status });
    const fn = handlers.get(m.method);
    if (fn) fn(m.params);
  };
  const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
  const evaluate = async expr => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.text} ${(r.exceptionDetails.exception || {}).description || ''} — in: ${expr.slice(0, 140)}`);
    return r.result.value;
  };
  const on = (method, fn) => handlers.set(method, fn);
  const close = async () => { ws.close(); await fetch(`${cdp}/json/close/${t.id}`).catch(() => {}); };
  return { send, evaluate, on, close, events };
}

// One counter per script: `check.failures` is the exit code's source.
export function checker() {
  const check = (ok, what, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}${detail ? ' — ' + detail : ''}`);
    if (!ok) check.failures++;
  };
  check.failures = 0;
  return check;
}

// Measuring and pressing, for a page that moves under the pointer.
export function helpers(s) {
  const rect = sel => s.evaluate(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`);

  // A page that scrolls `behavior: 'smooth'` moves under a rect measured while
  // the scroll is still running: the press falls in the gap between two chips,
  // nothing happens, and every check after it fails for a reason that is not
  // there. This waits for the page to stop moving before believing a
  // measurement — a latent race until 24 px of new page height exposed it.
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

  // A press is dispatched at a POINT, so this checks that the point still
  // belongs to the element before spending it, and says so loudly if it never
  // does rather than letting the run fail somewhere downstream.
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
    await sleep(700);
    await settle();
  };

  return { rect, settle, click };
}
