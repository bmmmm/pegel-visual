// Test loader for the single-file app: extracts the inline <script> out of
// index.html, evaluates it against a minimal hand-rolled browser stub (no jsdom,
// no network), and returns an evaluator with access to the script's scope.
//
// Usage:
//   const app = loadApp();                         // defaults: 1200px wide, real clock
//   app.run('parseCommand("--station BONN")');     // evaluate inside the app scope
//   const app2 = loadApp({ width: 390, now: Date.UTC(2026, 0, 15, 12) });
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) throw new Error('no inline <script> found in index.html');
const source = match[1];

function makeEl(tag = 'div') {
  const el = {
    tag,
    attrs: {},
    children: [],
    listeners: {},
    style: {},
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    hidden: false,
    value: '',
    textContent: '',
    innerHTML: '',
    className: '',
    title: '',
    href: '',
    label: '',
    type: '',
    files: [],
    childElementCount: 0,
    clientWidth: 0,
    scrollWidth: 0,
    open: false,
    addEventListener(type, fn) { (el.listeners[type] ||= []).push(fn); },
    removeEventListener() {},
    dispatchEvent() { return true; },
    setAttribute(k, v) { el.attrs[k] = String(v); },
    getAttribute(k) { return el.attrs[k] ?? null; },
    append() {},
    appendChild(c) { el.children.push(c); el.childElementCount = el.children.length; return c; },
    click() {},
    focus() {},
    select() {},
    blur() {},
    closest() { return null; },
    querySelector() { return makeEl(); },
    showModal() { el.open = true; },
    close() { el.open = false; },
  };
  return el;
}

export function loadApp({ width = 1200, search = '', now = null } = {}) {
  const els = new Map();
  const elById = id => {
    if (!els.has(id)) els.set(id, makeEl(id));
    return els.get(id);
  };
  const mainEl = makeEl('main');
  const documentStub = {
    title: '',
    documentElement: Object.assign(makeEl('html'), { clientWidth: width }),
    activeElement: makeEl('body'),
    getElementById: elById,
    querySelector: sel => (sel === 'main' ? mainEl : makeEl(sel)),
    createElement: tag => makeEl(tag),
    createDocumentFragment: () => makeEl('#fragment'),
    addEventListener() {},
    removeEventListener() {},
  };

  // plain data properties + non-enumerable methods, so the app's
  // Object.keys(localStorage) sees exactly the stored keys
  const localStorageStub = Object.create(null);
  for (const [name, fn] of Object.entries({
    getItem: k => (Object.prototype.hasOwnProperty.call(localStorageStub, k) ? localStorageStub[k] : null),
    setItem: (k, v) => { localStorageStub[k] = String(v); },
    removeItem: k => { delete localStorageStub[k]; },
  })) {
    Object.defineProperty(localStorageStub, name, { value: fn, writable: true, enumerable: false, configurable: true });
  }

  // an injectable clock: new Date() and Date.now() pin to `now`, everything
  // else (parse, UTC, explicit timestamps) stays real — makes isNight/moonPhase/
  // archive-thinning tests deterministic
  const DateStub = now == null ? Date : class extends Date {
    constructor(...args) { args.length ? super(...args) : super(now); }
    static now() { return now; }
  };

  const params = {
    window: { addEventListener() {}, removeEventListener() {} },
    document: documentStub,
    localStorage: localStorageStub,
    location: { search, origin: 'http://localhost', pathname: '/', href: 'http://localhost/' + search },
    history: { pushState() {}, replaceState() {} },
    navigator: {},
    fetch: () => Promise.reject(new Error('offline (test stub)')),
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    requestAnimationFrame: () => 0,
    performance: { now: () => 0 },
    getComputedStyle: () => ({ paddingLeft: '0', paddingRight: '0', borderLeftWidth: '0', borderRightWidth: '0' }),
    setInterval: () => 0,
    clearInterval() {},
    setTimeout: () => 0,
    clearTimeout() {},
    Blob: class { constructor() {} },
    URL: { createObjectURL: () => 'blob:test', revokeObjectURL() {} },
    Date: DateStub,
  };

  const factory = new Function(...Object.keys(params),
    source + '\n;return { __run: code => eval(code) };');
  const { __run } = factory(...Object.values(params));

  return {
    run: __run,
    el: elById,
    document: documentStub,
    localStorage: localStorageStub,
  };
}
