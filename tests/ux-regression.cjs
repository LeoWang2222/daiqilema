#!/usr/bin/env node
'use strict';

// Synthetic-data regression runner. No browser, npm packages, network or real storage.
// Usage from the project root: node tests/ux-regression.cjs [path-to-index.html]
// Runs the production inline script unchanged and invokes its actual DOM listeners.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const path = require('node:path');

const inputPath = process.argv[2] || path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(path.resolve(inputPath), 'utf8');
const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)]
  .filter(match => !/\bsrc\s*=/.test(match[1])).map(match => match[2]);
assert.ok(scripts.length, 'The supplied HTML must contain an inline application script.');
const STORE_KEY = 'daiqilema_v1';
const START = new Date(2026, 9, 5, 12, 0, 0).getTime();

function decode(value) {
  return String(value).replace(/&(amp|lt|gt|quot|apos|#39|#\d+|#x[\da-f]+);/gi, (_, code) => {
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
    if (Object.hasOwn(named, code.toLowerCase())) return named[code.toLowerCase()];
    return String.fromCodePoint(code.toLowerCase().startsWith('#x') ? parseInt(code.slice(2), 16) : +code.slice(1));
  });
}

class Target {
  constructor() { this.listeners = new Map(); this.parentNode = null; }
  addEventListener(type, callback, options = {}) {
    const list = this.listeners.get(type) || [];
    list.push({ callback, once: !!options.once });
    this.listeners.set(type, list);
  }
  removeEventListener(type, callback) {
    this.listeners.set(type, (this.listeners.get(type) || []).filter(entry => entry.callback !== callback));
  }
  dispatchEvent(event) {
    if (!event.target) event.target = this;
    event.currentTarget = this;
    for (const entry of [...(this.listeners.get(event.type) || [])]) {
      if (entry.once) this.removeEventListener(event.type, entry.callback);
      entry.callback.call(this, event);
      if (event.immediateStopped) break;
    }
    if (!event.immediateStopped && typeof this['on' + event.type] === 'function') this['on' + event.type].call(this, event);
    if (event.bubbles && !event.stopped && this.parentNode) this.parentNode.dispatchEvent(event);
    return !event.defaultPrevented;
  }
}

class SyntheticEvent {
  constructor(type, options = {}) {
    Object.assign(this, { type, bubbles: false, defaultPrevented: false, stopped: false }, options);
  }
  preventDefault() { this.defaultPrevented = true; }
  stopPropagation() { this.stopped = true; }
  stopImmediatePropagation() { this.stopped = true; this.immediateStopped = true; }
}

class TextNode extends Target {
  constructor(value) { super(); this.nodeType = 3; this.nodeValue = value; }
  get textContent() { return this.nodeValue; }
  set textContent(value) { this.nodeValue = String(value); }
}

const VOID_TAGS = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
function parseFragment(markup, owner, parent) {
  const stack = [parent];
  for (const token of markup.match(/<!--[\s\S]*?-->|<![^>]*>|<[^>]+>|[^<]+/g) || []) {
    if (/^<!/.test(token)) continue;
    if (/^<\//.test(token)) {
      const tag = token.match(/^<\/\s*([^\s>]+)/)?.[1]?.toUpperCase();
      const index = stack.findLastIndex(node => node.tagName === tag);
      if (index > 0) stack.splice(index);
      continue;
    }
    if (token.startsWith('<')) {
      const tagMatch = token.match(/^<\s*([^\s/>]+)([\s\S]*?)\/?>$/);
      if (!tagMatch) continue;
      const element = new Element(tagMatch[1], owner);
      for (const match of tagMatch[2].matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
        element.setAttribute(match[1], decode(match[2] ?? match[3] ?? match[4] ?? ''));
      }
      stack.at(-1).appendChild(element);
      if (!VOID_TAGS.has(tagMatch[1].toLowerCase()) && !token.endsWith('/>')) stack.push(element);
    } else stack.at(-1).appendChild(new TextNode(decode(token)));
  }
}

function matchesSimple(element, selector) {
  if (!(element instanceof Element)) return false;
  selector = selector.trim();
  const not = [...selector.matchAll(/:not\(([^)]+)\)/g)];
  selector = selector.replace(/:not\([^)]+\)/g, '');
  if (not.some(match => matchesSimple(element, match[1]))) return false;
  if (/:disabled/.test(selector) && !element.disabled) return false;
  if (/:enabled/.test(selector) && element.disabled) return false;
  selector = selector.replace(/:(?:disabled|enabled)/g, '');
  const tag = selector.match(/^[a-z][\w-]*/i)?.[0];
  if (tag && tag.toUpperCase() !== element.tagName) return false;
  for (const match of selector.matchAll(/#([\w-]+)/g)) if (element.id !== match[1]) return false;
  for (const match of selector.matchAll(/\.([\w-]+)/g)) if (!element.classList.contains(match[1])) return false;
  for (const match of selector.matchAll(/\[([^\]\s=^$*~|]+)\s*(?:(\^=|\$=|\*=|=)\s*["']?([^\]"']*)["']?)?\]/g)) {
    const value = element.getAttribute(match[1]);
    if (value === null) return false;
    if (!match[2]) continue;
    if (match[2] === '=' && value !== match[3]) return false;
    if (match[2] === '^=' && !value.startsWith(match[3])) return false;
    if (match[2] === '$=' && !value.endsWith(match[3])) return false;
    if (match[2] === '*=' && !value.includes(match[3])) return false;
  }
  return true;
}

function matches(element, selector) {
  return selector.split(',').some(part => {
    const pieces = part.trim().split(/\s+(?![^\[]*\])/);
    let node = element;
    if (!matchesSimple(node, pieces.pop())) return false;
    while (pieces.length) {
      const preceding = pieces.pop();
      node = node.parentNode;
      while (node && !matchesSimple(node, preceding)) node = node.parentNode;
      if (!node) return false;
    }
    return true;
  });
}

class Element extends Target {
  constructor(tag, owner) {
    super(); this.nodeType = 1; this.tagName = tag.toUpperCase(); this.ownerDocument = owner;
    this.attributes = new Map(); this.childNodes = []; this.style = {
      setProperty(name, value) { this[name] = String(value); },
      getPropertyValue(name) { return this[name] || ''; },
      removeProperty(name) { const prior = this[name]; delete this[name]; return prior || ''; }
    }; this.value = ''; this.files = [];
    this.disabled = false; this.hidden = false; this.inert = false;
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/).filter(Boolean), ...names])].join(' '); },
      remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
      toggle: (name, force) => {
        const next = force === undefined ? !this.classList.contains(name) : !!force;
        this.classList[next ? 'add' : 'remove'](name); return next;
      }
    };
  }
  get children() { return this.childNodes.filter(node => node.nodeType === 1); }
  get firstChild() { return this.childNodes[0] || null; }
  get firstElementChild() { return this.children[0] || null; }
  get className() { return this.attributes.get('class') || ''; }
  set className(value) { this.attributes.set('class', String(value)); }
  get id() { return this.attributes.get('id') || ''; }
  set id(value) { this.attributes.set('id', String(value)); }
  get textContent() { return this.childNodes.map(node => node.textContent).join(''); }
  set textContent(value) { this.replaceChildren(new TextNode(String(value))); }
  get innerText() { return this.textContent; }
  set innerText(value) { this.textContent = value; }
  set innerHTML(markup) { this.replaceChildren(); parseFragment(String(markup), this.ownerDocument, this); }
  get innerHTML() { return this.textContent; }
  get dataset() {
    return new Proxy({}, {
      get: (_, key) => this.getAttribute('data-' + String(key).replace(/[A-Z]/g, letter => '-' + letter.toLowerCase())),
      set: (_, key, value) => { this.setAttribute('data-' + String(key).replace(/[A-Z]/g, letter => '-' + letter.toLowerCase()), value); return true; }
    });
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'hidden') this.hidden = true;
    if (name === 'disabled') this.disabled = true;
    if (name === 'value') this.value = String(value);
    if (name === 'style') {
      for (const declaration of String(value).split(';')) {
        const [property, ...rest] = declaration.split(':');
        if (rest.length) this.style[property.trim().replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = rest.join(':').trim();
      }
    }
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  hasAttribute(name) { return this.attributes.has(name); }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'hidden') this.hidden = false; if (name === 'disabled') this.disabled = false; }
  appendChild(node) { if (node.parentNode) node.remove(); node.parentNode = this; this.childNodes.push(node); return node; }
  append(...nodes) { nodes.forEach(node => this.appendChild(typeof node === 'string' ? new TextNode(node) : node)); }
  replaceChildren(...nodes) { this.childNodes.forEach(node => { node.parentNode = null; }); this.childNodes = []; this.append(...nodes); }
  removeChild(node) { const index = this.childNodes.indexOf(node); if (index < 0) throw new Error('Not a child'); this.childNodes.splice(index, 1); node.parentNode = null; return node; }
  remove() { if (this.parentNode?.removeChild) this.parentNode.removeChild(this); }
  contains(node) { return node === this || this.childNodes.some(child => child === node || child.contains?.(node)); }
  matches(selector) { return matches(this, selector); }
  closest(selector) { for (let node = this; node instanceof Element; node = node.parentNode) if (node.matches(selector)) return node; return null; }
  querySelectorAll(selector) {
    const result = [];
    const visit = node => { for (const child of node.children || []) { if (child.matches(selector)) result.push(child); visit(child); } };
    visit(this); return result;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { this.ownerDocument.activeElement = this; }
  blur() { if (this.ownerDocument.activeElement === this) this.ownerDocument.activeElement = this.ownerDocument.body; }
  select() { this.focus(); }
  setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
  scrollIntoView() {}
  scrollTo() {}
  get offsetWidth() { return this.hidden ? 0 : 100; }
  get offsetHeight() { return this.hidden ? 0 : 40; }
  click() { if (!this.disabled) this.dispatchEvent(new SyntheticEvent('click', { bubbles: true })); }
}

class Document extends Element {
  constructor(markup) {
    super('document', null); this.ownerDocument = this; this.nodeType = 9;
    this.visibilityState = 'visible'; this.readyState = 'complete';
    parseFragment(markup.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ''), this, this);
    this.body = this.querySelector('body'); this.documentElement = this.querySelector('html'); this.activeElement = this.body;
  }
  get hidden() { return this.visibilityState === 'hidden'; }
  set hidden(_) {}
  getElementById(id) { return this.querySelector('#' + id); }
  createElement(tag) { return new Element(tag, this); }
  createTextNode(text) { return new TextNode(String(text)); }
}

function fixture(options = {}) {
  return { cats: [
    { id: 'synthetic-cat-1', name: '合成出门清单', icon: '🎒', autoReset: !!options.daily, lastResetOn: options.daily ? '2026-10-5' : null,
      items: [
        { id: 'synthetic-item-a', name: '合成甲', checked: true },
        { id: 'synthetic-item-b', name: '合成乙', checked: false },
        { id: 'synthetic-item-c', name: '合成丙', checked: true }
      ] },
    { id: 'synthetic-cat-2', name: '合成其他分类', icon: '📋', autoReset: false, lastResetOn: null,
      items: [{ id: 'synthetic-other', name: '合成其他物品', checked: true }] }
  ] };
}

function boot(initial = fixture(), options = {}) {
  const document = new Document(html);
  const window = new Target();
  document.parentNode = window;
  let wallTime = START, elapsed = 0, timerId = 0, random = 0, failWrites = !!options.failWrites;
  const timers = new Map(), storage = new Map([[STORE_KEY, JSON.stringify(initial)]]);
  const storageCalls = [], confirmations = [];
  const schedule = (callback, delay, interval) => {
    const id = ++timerId; timers.set(id, { callback, due: elapsed + (+delay || 0), interval }); return id;
  };
  function tick(ms = 0) {
    const end = elapsed + ms;
    let count = 0;
    while (true) {
      const next = [...timers.entries()].filter(([, entry]) => entry.due <= end).sort((a, b) => a[1].due - b[1].due)[0];
      if (!next) break;
      assert.ok(++count < 10000, 'Timers failed to settle.');
      const [id, entry] = next;
      wallTime += entry.due - elapsed; elapsed = entry.due; timers.delete(id);
      if (entry.interval) timers.set(id, { ...entry, due: elapsed + entry.interval });
      entry.callback();
    }
    wallTime += end - elapsed; elapsed = end;
  }
  class ClockDate extends Date {
    constructor(...args) { super(...(args.length ? args : [wallTime])); }
    static now() { return wallTime; }
  }
  const location = new URL('https://synthetic.invalid/index.html');
  location.reload = () => {};
  const entries = [{ state: null, url: location.href }];
  let historyIndex = 0;
  const clone = state => state == null ? state : JSON.parse(JSON.stringify(state));
  const history = {
    get state() { return clone(entries[historyIndex].state); },
    get length() { return entries.length; },
    pushState(state, _, url) {
      entries.splice(historyIndex + 1); entries.push({ state: clone(state), url: url ? new URL(url, location.href).href : location.href });
      historyIndex++; location.href = entries[historyIndex].url;
    },
    replaceState(state, _, url) {
      entries[historyIndex] = { state: clone(state), url: url ? new URL(url, location.href).href : location.href };
      location.href = entries[historyIndex].url;
    },
    go(offset) {
      schedule(() => {
        const next = historyIndex + offset;
        if (next < 0 || next >= entries.length) return;
        historyIndex = next; location.href = entries[next].url;
        window.dispatchEvent(new SyntheticEvent('popstate', { state: history.state }));
      }, 0);
    },
    back() { this.go(-1); },
    forward() { this.go(1); }
  };
  class FileReader {
    readAsText(file) {
      schedule(() => {
        if (file.error) { this.error = new Error('Synthetic read error'); this.onerror?.({ target: this }); return; }
        this.result = file.content; this.onload?.({ target: this });
      }, 0);
    }
  }
  const math = Object.create(Math);
  math.random = () => ((++random * 7919) % 1000003) / 1000003;
  Object.assign(window, {
    document, window, self: window, history, location, Date: ClockDate, Math: math, console, innerHeight: 800,
    navigator: { vibrate() {} },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem(key, value) {
        storageCalls.push({ key, value, failed: failWrites });
        if (failWrites) { const error = new Error('Synthetic storage quota exceeded'); error.name = 'QuotaExceededError'; throw error; }
        storage.set(key, String(value));
      },
      removeItem: key => storage.delete(key), clear: () => storage.clear()
    },
    FileReader, Blob, URL: class extends URL {
      static createObjectURL() { return 'blob:synthetic'; }
      static revokeObjectURL() {}
    },
    Event: SyntheticEvent, KeyboardEvent: SyntheticEvent, PopStateEvent: SyntheticEvent,
    HTMLElement: Element, Element,
    setTimeout: (callback, delay) => schedule(callback, delay), clearTimeout: id => timers.delete(id),
    setInterval: (callback, delay) => schedule(callback, delay, +delay || 1), clearInterval: id => timers.delete(id),
    requestAnimationFrame: callback => schedule(() => callback(elapsed), 16), cancelAnimationFrame: id => timers.delete(id),
    getComputedStyle: element => ({ display: element.hidden ? 'none' : element.style.display || 'block' }),
    confirm: message => { confirmations.push(String(message)); return !!options.confirm; },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} })
  });
  const context = vm.createContext(window);
  scripts.forEach((script, index) => vm.runInContext(script, context, { filename: path.basename(inputPath) + ':inline-' + index, timeout: 2000 }));
  tick(0);
  const $ = id => { const element = document.getElementById(id); assert.ok(element, 'Missing DOM element #' + id); return element; };
  const fire = (node, type, values = {}) => { node.dispatchEvent(new SyntheticEvent(type, { bubbles: true, ...values })); tick(0); };
  const click = target => { (typeof target === 'string' ? $(target) : target).click(); tick(0); };
  return {
    $, document, window, history, tick, click, fire, confirmations, storageCalls,
    state: () => JSON.parse(storage.get(STORE_KEY)),
    failWrites: value => { failWrites = value; },
    setDay: day => { wallTime = new Date(2026, 9, day, 12, 0, 0).getTime(); },
    openCat: (index = 0) => click($('cat-list').children[index]),
    itemNames: () => $('item-list').querySelectorAll('.item-name').map(node => node.textContent),
    checkedRows: () => $('item-list').querySelectorAll('.item-row').map(node => node.classList.contains('checked')),
    visibility(value) { document.visibilityState = value; fire(document, 'visibilitychange', { bubbles: false }); },
    pageshow(persisted = true) { fire(window, 'pageshow', { persisted, bubbles: false }); },
    back() { history.back(); tick(0); },
    importFile(data) {
      click('btn-settings'); click('btn-import');
      $('import-file').files = [{ name: 'synthetic-backup.json', type: 'application/json', size: 128, content: typeof data === 'string' ? data : JSON.stringify(data) }];
      fire($('import-file'), 'change');
    }
  };
}

function isOpen(app, id) { return app.$(id).classList.contains('open'); }
function warningVisible(app) {
  const warning = app.$('storage-warning');
  return !warning.hidden && warning.style.display !== 'none' && warning.getAttribute('aria-hidden') !== 'true';
}
function states(app, cat = 0) { return app.state().cats[cat].items.map(item => item.checked); }
function names(app, cat = 0) { return app.state().cats[cat].items.map(item => item.name); }
const imported = { app: 'daiqilema', version: 1, cats: [
  { id: 'external-synthetic-id', name: '合成导入清单', icon: '🧪', autoReset: false, items: [
    { id: 'external-synthetic-item', name: '合成导入物品', checked: true }
  ] }
] };

const tests = [];
function test(name, callback) { tests.push({ name, callback }); }

test('Initialization renders supplied synthetic categories', () => {
  const app = boot();
  assert.equal(app.$('cat-list').querySelectorAll('.cat-card').length, 2);
  assert.equal(app.$('page-detail').getAttribute('aria-hidden'), 'true');
  assert.match(app.$('cat-list').textContent, /合成出门清单/);
});

test('Opening, toggling and reopening preserves the fixed item order', () => {
  const app = boot(); const expected = names(app);
  app.openCat(); assert.deepEqual(app.itemNames(), expected);
  assert.deepEqual(names(app), expected, 'Opening must not mutate persisted order.');
  app.click(app.$('item-list').children[1].querySelector('.check-btn'));
  assert.deepEqual(app.itemNames(), expected);
  app.click('btn-back'); app.openCat();
  assert.deepEqual(app.itemNames(), expected);
  assert.deepEqual(names(app), expected);
});

test('Enabling daily reset preserves today\'s confirmations', () => {
  const app = boot(); app.openCat(); app.click('btn-daily');
  assert.equal(app.state().cats[0].autoReset, true);
  assert.equal(app.state().cats[0].lastResetOn, '2026-10-5');
  assert.deepEqual(states(app), [true, false, true]);
  assert.deepEqual(app.checkedRows(), [true, false, true]);
});

test('A hidden page does not reset until it becomes visible on a new day', () => {
  const app = boot(fixture({ daily: true })); app.openCat(); app.setDay(6);
  app.visibility('hidden'); assert.deepEqual(states(app), [true, false, true]);
  app.visibility('visible'); assert.deepEqual(states(app), [false, false, false]);
  assert.deepEqual(app.checkedRows(), [false, false, false]);
  assert.equal(app.state().cats[0].lastResetOn, '2026-10-6');
  assert.deepEqual(states(app, 1), [true], 'Non-daily categories must retain confirmations.');
});

test('A restored page resets daily categories without reopening their detail', () => {
  const app = boot(fixture({ daily: true })); app.setDay(6); app.pageshow(true);
  assert.deepEqual(states(app), [false, false, false]);
  assert.equal(app.state().cats[0].lastResetOn, '2026-10-6');
  assert.match(app.$('cat-list').children[0].textContent, /0\s*\/\s*3/);
});

test('An ordinary pageshow also notices a new day', () => {
  const app = boot(fixture({ daily: true })); app.setDay(6); app.pageshow(false);
  assert.deepEqual(states(app), [false, false, false]);
});

test('Adding several items keeps the sheet open and clears/refocuses the input', () => {
  const app = boot(); app.openCat(); app.click('fab-add-item');
  app.$('modal-input').value = '合成新增一'; app.click('modal-ok');
  assert.equal(isOpen(app, 'modal-mask'), true);
  assert.equal(app.$('modal-input').value, '');
  assert.equal(app.document.activeElement, app.$('modal-input'));
  app.$('modal-input').value = '合成新增二'; app.fire(app.$('modal-input'), 'keydown', { key: 'Enter', isComposing: false });
  assert.equal(isOpen(app, 'modal-mask'), true);
  assert.deepEqual(names(app).slice(-2), ['合成新增一', '合成新增二']);
  app.click('modal-cancel'); assert.equal(isOpen(app, 'modal-mask'), false);
});

test('IME Enter cannot accidentally add an unfinished item', () => {
  const app = boot(); app.openCat(); app.click('fab-add-item');
  app.$('modal-input').value = '合成拼音待选';
  app.fire(app.$('modal-input'), 'keydown', { key: 'Enter', isComposing: true, keyCode: 13 });
  assert.equal(names(app).length, 3); assert.equal(isOpen(app, 'modal-mask'), true);
  app.fire(app.$('modal-input'), 'keydown', { key: 'Enter', isComposing: false, keyCode: 229 });
  assert.equal(names(app).length, 3);
  app.fire(app.$('modal-input'), 'keydown', { key: 'Enter', isComposing: false, keyCode: 13 });
  assert.equal(names(app).length, 4); assert.equal(names(app).at(-1), '合成拼音待选');
});

test('Bulk confirm/cancel updates persistence, rows and the detail summary', () => {
  const app = boot(); app.openCat(); app.click('btn-checkall');
  assert.deepEqual(states(app), [true, true, true]); assert.deepEqual(app.checkedRows(), [true, true, true]);
  assert.match(app.$('detail-sub').textContent, /全部带齐/);
  assert.match(app.$('btn-checkall').textContent, /取消/);
  app.click('btn-checkall');
  assert.deepEqual(states(app), [false, false, false]); assert.deepEqual(app.checkedRows(), [false, false, false]);
  assert.match(app.$('detail-sub').textContent, /0\s*\/\s*3/);
});

test('Reset undo restores exactly the prior confirmations and order', () => {
  const app = boot(); app.openCat(); const before = app.state().cats[0].items;
  app.click('btn-reset'); assert.deepEqual(states(app), [false, false, false]);
  assert.equal(app.$('toast').classList.contains('can-undo'), true);
  app.click('toast-undo');
  assert.deepEqual(app.state().cats[0].items, before);
  assert.deepEqual(app.checkedRows(), [true, false, true]);
});

test('Storage failure keeps edits in memory and leaves a persistent, actionable warning', () => {
  const app = boot(); app.openCat(); const original = app.state(); app.failWrites(true);
  app.click('btn-checkall');
  assert.deepEqual(app.state(), original, 'Failed writes must not change durable storage.');
  assert.deepEqual(app.checkedRows(), [true, true, true], 'User edits should stay in memory.');
  assert.equal(warningVisible(app), true);
  assert.match(app.$('storage-warning').textContent, /保存|存储/);
  assert.ok(app.$('storage-export'), 'The warning must include a backup export action.');
  app.tick(20000);
  assert.equal(warningVisible(app), true, 'A transient toast cannot substitute for the warning.');
  app.failWrites(false); app.click('btn-checkall');
  assert.deepEqual(states(app), [false, false, false]);
  assert.equal(warningVisible(app), false, 'The warning should clear after a successful save.');
});

test('Import preview requires confirmation and cancel retains the original list', () => {
  const app = boot(); const before = app.state(); app.importFile(imported);
  assert.deepEqual(app.state(), before, 'Reading a valid file must not replace categories.');
  assert.equal(isOpen(app, 'import-confirm-mask'), true);
  assert.match(app.$('import-confirm-tip').textContent, /1|合成导入清单/);
  app.click('import-confirm-cancel');
  assert.deepEqual(app.state(), before); assert.equal(isOpen(app, 'import-confirm-mask'), false);
});

test('Confirm import replaces the list and the offered undo restores the original', () => {
  const app = boot(); const before = app.state(); app.importFile(imported); app.click('import-confirm-ok');
  assert.equal(app.state().cats.length, 1);
  assert.equal(app.state().cats[0].name, '合成导入清单');
  assert.deepEqual(states(app), [true]);
  assert.equal(isOpen(app, 'import-confirm-mask'), false);
  assert.equal(app.$('toast').classList.contains('can-undo'), true);
  app.click('toast-undo'); assert.deepEqual(app.state(), before);
});

test('Failed import save rolls back categories and leaves confirmation available', () => {
  const app = boot(); const before = app.state(); app.importFile(imported); app.failWrites(true); app.click('import-confirm-ok');
  assert.deepEqual(app.state(), before);
  assert.match(app.$('cat-list').textContent, /合成出门清单/);
  assert.doesNotMatch(app.$('cat-list').textContent, /合成导入清单/);
  assert.equal(isOpen(app, 'import-confirm-mask'), true); assert.equal(warningVisible(app), true);
  app.failWrites(false); app.click('import-confirm-ok');
  assert.equal(app.state().cats[0].name, '合成导入清单');
});

test('Malformed import never changes existing categories', () => {
  const app = boot(); const before = app.state(); app.importFile('{invalid synthetic json');
  assert.deepEqual(app.state(), before);
  assert.equal(isOpen(app, 'import-confirm-mask'), false);
  assert.match(app.$('toast-msg').textContent, /导入失败|格式/);
});

test('History Back closes the active add sheet before its category detail', () => {
  const app = boot(); app.openCat(); app.click('fab-add-item');
  assert.equal(isOpen(app, 'modal-mask'), true);
  app.back(); assert.equal(isOpen(app, 'modal-mask'), false); assert.equal(isOpen(app, 'page-detail'), true);
  app.back(); assert.equal(isOpen(app, 'page-detail'), false);
  assert.equal(app.$('page-home').getAttribute('aria-hidden'), 'false');
});

test('History Back closes settings and import preview one layer at a time', () => {
  const app = boot(); const before = app.state(); app.importFile(imported);
  app.back(); assert.equal(isOpen(app, 'import-confirm-mask'), false); assert.equal(isOpen(app, 'settings-mask'), true);
  assert.deepEqual(app.state(), before);
  app.back(); assert.equal(isOpen(app, 'settings-mask'), false);
});

test('Management to edit replaces its history layer rather than leaving a stale menu', () => {
  const app = boot(); app.openCat(); app.click(app.$('item-list').children[0].querySelector('.item-menu'));
  assert.equal(isOpen(app, 'actions-mask'), true);
  app.click('action-edit'); assert.equal(isOpen(app, 'actions-mask'), false); assert.equal(isOpen(app, 'modal-mask'), true);
  app.back(); assert.equal(isOpen(app, 'modal-mask'), false); assert.equal(isOpen(app, 'actions-mask'), false);
  assert.equal(isOpen(app, 'page-detail'), true);
  app.back(); assert.equal(isOpen(app, 'page-detail'), false);
});

test('Undoing import from an imported detail returns safely to the original home', () => {
  const app = boot(); const before = app.state(); app.importFile(imported); app.click('import-confirm-ok');
  if (isOpen(app, 'settings-mask')) app.click('settings-close');
  app.openCat(); assert.match(app.$('detail-name').textContent, /合成导入清单/);
  app.click('toast-undo');
  assert.deepEqual(app.state(), before);
  assert.equal(isOpen(app, 'page-detail'), false);
  assert.equal(app.$('page-home').getAttribute('aria-hidden'), 'false');
  assert.match(app.$('cat-list').textContent, /合成出门清单/);
});

test('Undo is consumed once even if the button receives a second click', () => {
  const app = boot(); app.openCat(); const before = app.state().cats[0].items;
  app.click(app.$('item-list').children[0].querySelector('.item-menu')); app.click('action-delete');
  assert.equal(app.state().cats[0].items.length, 2);
  app.click('toast-undo'); app.click('toast-undo');
  assert.deepEqual(app.state().cats[0].items, before);
  assert.equal(app.$('toast-undo').disabled, true);
  assert.equal(app.$('toast-undo').onclick, null);
});

test('Reopening an edited item fills the current name rather than an empty saved draft', () => {
  const app = boot(); app.openCat();
  app.click(app.$('item-list').children[0].querySelector('.item-menu')); app.click('action-edit');
  app.$('modal-input').value = '合成已改名称'; app.click('modal-ok');
  app.click(app.$('item-list').children[0].querySelector('.item-menu')); app.click('action-edit');
  assert.equal(app.$('modal-input').value, '合成已改名称');
});

let failed = 0;
for (const { name, callback } of tests) {
  try { callback(); console.log('PASS ' + name); }
  catch (error) { failed++; console.error('FAIL ' + name + '\n     ' + error.message.split('\n').join('\n     ')); }
}
console.log(`\n${tests.length - failed}/${tests.length} passed; ${failed} failed. Input: ${path.resolve(inputPath)}`);
process.exitCode = failed ? 1 : 0;
