'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = path.join(__dirname, '../src/web/companion-activities.js');
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = new Map(); this.value = ''; }
  set textContent(value) { this.value = String(value); this.children = []; }
  get textContent() { return this.value + this.children.map(x => x.textContent).join(''); }
  set innerHTML(_) { throw Error('Unsafe sink'); }
  append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  remove() { this.parent.children = this.parent.children.filter(x => x !== this); }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  addEventListener(k, fn) { this.listeners.set(k, fn); }
  removeEventListener(k, fn) { if (this.listeners.get(k) === fn) this.listeners.delete(k); }
  click() { if (!this.disabled) this.listeners.get('click')?.(); }
}
function harness(storage, missing = false) {
  let now = 0, next = 0;
  const timers = new Map();
  const mount = new Element('div');
  const sentinel = new Element('div'); sentinel.textContent = 'MONITORING'; mount.append(sentinel);
  const document = {getElementById: id => id === 'companion-activities' && !missing ? mount : null, createElement: tag => new Element(tag)};
  const context = {Date: {now: () => now}, setInterval: fn => {timers.set(++next, fn); return next;}, clearInterval: id => timers.delete(id)};
  if (fs.existsSync(source)) vm.runInNewContext(fs.readFileSync(source, 'utf8'), context);
  assert.equal(typeof context.RadgotchiActivities?.init, 'function', 'activities exposes explicit init');
  assert.equal(mount.children.length, 1, 'loading never mounts automatically');
  const api = context.RadgotchiActivities.init(document, storage);
  const all = (node = mount) => [node, ...node.children.flatMap(x => all(x))];
  return {api, mount, sentinel, timers, document, context, all, button: text => all().find(x => x.tagName === 'button' && x.textContent === text), advance(ms) {now += ms; for (const fn of [...timers.values()]) fn();}};
}
test('audio events follow actual start/completion, never pause/reset or stale ticks', () => {
  const h = harness(), events = [];
  h.context.CustomEvent = class { constructor(type) {this.type=type;} };
  h.document.dispatchEvent = event => events.push(event.type);
  const start=h.button('START WORK'); start.click(); start.click();
  assert.deepEqual(events, ['radgotchi:pomodoro-start']);
  h.advance(1000); h.button('PAUSE').click(); h.button('RESET').click();
  assert.equal(events.length,1);
  h.button('START WORK').click(); h.advance(25*60*1000);
  assert.deepEqual(events,['radgotchi:pomodoro-start','radgotchi:pomodoro-start','radgotchi:pomodoro-complete']);
  h.advance(25*60*1000); assert.equal(events.length,3);
  h.button('START BREAK').click(); h.advance(5*60*1000);
  assert.equal(events.at(-1),'radgotchi:pomodoro-complete');
  assert.equal(events.length,5); h.api.destroy(); start.click(); assert.equal(events.length,5);
});
test('explicit mount is idle, accessible, isolated and destroy removes only owned nodes', () => {
  const h = harness();
  assert.equal(h.timers.size, 0);
  assert.match(h.mount.textContent, /25:00/);
  assert.match(h.mount.textContent, /LOCAL FOCUS/);
  assert.ok(h.all().some(x => x.attributes['aria-label'] === 'Local focus timer'));
  assert.ok(h.button('START WORK'));
  h.api.destroy(); h.api.destroy();
  assert.deepEqual(h.mount.children, [h.sentinel]);
  harness(null, true).api.destroy();
});
test('completion counts work once, offers manual breaks, and uses original fourth-work long break', () => {
  const h = harness();
  const status = h.all().find(x => x.attributes.role === 'status');
  assert.ok(status, 'completion has a polite announcement');
  for (let n = 1; n <= 4; n++) {
    h.button('START WORK').click(); h.advance(25 * 60 * 1000 + 5000);
    assert.equal(h.timers.size, 0, 'no automatic break');
    assert.match(h.mount.textContent, new RegExp(`LOCAL COMPLETED: ${n}`));
    assert.match(status.textContent, /WORK COMPLETE/);
    assert.match(h.mount.textContent, n === 4 ? /15:00/ : /05:00/);
    h.advance(5000);
    h.button('START BREAK').click();
    h.advance((n === 4 ? 15 : 5) * 60 * 1000);
    assert.equal(h.timers.size, 0);
    assert.match(h.mount.textContent, /25:00/);
    assert.match(h.mount.textContent, new RegExp(`LOCAL COMPLETED: ${n}`));
  }
  h.api.destroy();
});
test('optional storage validates bounded local counts and tolerates disabled storage', () => {
  const key = 'radgotchi.local-focus.v1';
  let saved;
  const h = harness({getItem(k) {assert.equal(k, key); return '{"version":1,"completed":3}';}, setItem(k, value) {assert.equal(k, key); saved = JSON.parse(value);}});
  assert.match(h.mount.textContent, /LOCAL COMPLETED: 3/);
  h.button('START WORK').click(); h.advance(25 * 60 * 1000);
  assert.deepEqual(saved, {version: 1, completed: 4});
  assert.match(h.mount.textContent, /15:00/);
  h.api.destroy();
  for (const raw of ['null', 'bad', '{"version":2,"completed":2}', '{"version":1,"completed":-1}', '{"version":1,"completed":1.5}', '{"version":1,"completed":1000001}', '{"version":1,"completed":"<img>"}', 'x'.repeat(1025)]) {
    const invalid = harness({getItem: () => raw});
    assert.match(invalid.mount.textContent, /LOCAL COMPLETED: 0/); invalid.api.destroy();
  }
  const blocked = harness({getItem() {throw Error('denied');}, setItem() {throw Error('quota');}});
  blocked.button('START WORK').click(); blocked.advance(25 * 60 * 1000);
  assert.match(blocked.mount.textContent, /LOCAL COMPLETED: 1/); blocked.api.destroy();
});
test('styles retain native components, visible focus and scoped reduced motion', () => {
  const cssPath = path.join(__dirname, '../src/styles/companion-activities.css');
  assert.ok(fs.existsSync(cssPath), 'dedicated activity stylesheet exists');
  const css = fs.readFileSync(cssPath, 'utf8');
  assert.match(css, /\.rg-activities\s+\.pomodoro-bar/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /animation:\s*none\s*!important/);
  assert.match(css, /transition:\s*none\s*!important/);
  assert.doesNotMatch(css, /@import|url\(/);
});
test('duplicate init is idempotent; remount starts idle without restoring active timers', () => {
  const h = harness();
  assert.equal(h.context.RadgotchiActivities.init(h.document), h.api);
  assert.equal(h.mount.children.length, 2);
  h.button('START WORK').click(); h.api.destroy();
  const replacement = h.context.RadgotchiActivities.init(h.document);
  h.api.destroy();
  assert.equal(h.mount.children.length, 2);
  assert.equal(h.timers.size, 0);
  replacement.destroy();
});
test('work runs only on request, pauses, resumes, resets and teardown cancels stale ticks', () => {
  const h = harness();
  const start = h.button('START WORK'); start.click(); start.click();
  assert.equal(h.timers.size, 1);
  h.advance(61000); assert.match(h.mount.textContent, /23:59/);
  h.button('PAUSE').click(); assert.equal(h.timers.size, 0);
  h.advance(100000); assert.match(h.mount.textContent, /23:59/);
  h.button('RESUME').click(); h.advance(1000);
  assert.match(h.mount.textContent, /23:58/);
  h.button('RESET').click(); assert.equal(h.timers.size, 0);
  assert.match(h.mount.textContent, /25:00/);
  assert.match(h.mount.textContent, /LOCAL COMPLETED: 0/);
  h.button('START WORK').click();
  const stale = [...h.timers.values()][0];
  h.api.destroy(); stale(); start.click();
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.mount.children, [h.sentinel]);
});
