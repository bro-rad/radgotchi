'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = path.join(__dirname, '../src/web/companion-arcade.js');
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = new Map(); this.value = ''; this.text = ''; }
  set textContent(v) { this.text = String(v); this.children = []; }
  get textContent() { return this.text + this.children.map(x => x.textContent).join(''); }
  set innerHTML(_) { throw Error('Unsafe HTML'); }
  append(...nodes) { for (const n of nodes) { n.parent = this; this.children.push(n); } }
  remove() { this.parent.children = this.parent.children.filter(x => x !== this); }
  setAttribute(k,v) { this.attributes[k] = String(v); }
  addEventListener(k,f) { this.listeners.set(k,f); }
  removeEventListener(k,f) { if (this.listeners.get(k) === f) this.listeners.delete(k); }
  click() { if (!this.disabled) this.listeners.get('click')?.(); }
}
function harness(transport, missing = false) {
  const mount = new Element('div'), sentinel = new Element('span'); sentinel.textContent = 'MONITOR'; mount.append(sentinel);
  const document = {getElementById: id => !missing && id === 'companion-arcade' ? mount : null, createElement: t => new Element(t)};
  const timers = new Map(); let next = 0;
  const context = {crypto: require('node:crypto').webcrypto, setTimeout: f => {timers.set(++next,f); return next;}, clearTimeout: id => timers.delete(id)};
  if (fs.existsSync(source)) vm.runInNewContext(fs.readFileSync(source,'utf8'),context);
  assert.equal(typeof context.RadgotchiArcade?.init, 'function', 'explicit arcade adapter exists');
  assert.equal(mount.children.length,1,'no auto startup');
  const destroy = context.RadgotchiArcade.init(document,transport);
  const all = (n = mount) => [n,...n.children.flatMap(x => all(x))];
  return {mount,sentinel,document,context,destroy,timers,all,button: text => all().find(x => x.tagName === 'button' && x.textContent === text), input: name => all().find(x => x.attributes['aria-label'] === name)};
}
const flush = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };
// SYNTHETIC ONLY: no real account, game results, credentials or network.
const fixture = (overrides = {}) => ({xp: 120, gameStats: {wins: 2, losses: 1, profit: 20}, blackjack: null, coinflip: null, ...overrides});
test('authoritative coinflip payload, strict bets, single-flight and server-only XP', async () => {
  const calls = []; let settle;
  const h = harness({request(action,payload) { calls.push({action,payload}); return action === 'state' ? Promise.resolve({success:true,state:fixture()}) : new Promise(r => {settle=r;}); }});
  await flush(); assert.equal(calls[0].action,'state');
  assert.match(h.mount.textContent,/TOTAL: 120/);
  const input = h.input('Coinflip bet XP'); input.value='5.5'; h.button('HEADS').click();
  assert.equal(calls.length,1); assert.match(h.mount.textContent,/INVALID BET/);
  input.value='10'; h.button('HEADS').click(); h.button('HEADS').click(); await flush();
  assert.equal(calls.length,2); assert.equal(calls[1].action,'coinflip');
  assert.equal(calls[1].payload.bet,10); assert.equal(calls[1].payload.choice,'heads');
  assert.match(calls[1].payload.idempotencyKey,/^[0-9a-f-]{36}$/);
  assert.match(h.mount.textContent,/TOTAL: 120/); assert.equal(h.button('DEAL').disabled,true);
  settle({success:true,state:fixture({xp:128,coinflip:{result:'heads',won:true,profit:8}})}); await flush();
  assert.match(h.mount.textContent,/HEADS — YOU WIN \+8 XP/); assert.match(h.mount.textContent,/TOTAL: 128/);
  assert.equal(h.button('HEADS').disabled,false); h.destroy();
});
test('blackjack restores authoritative hidden cards and first-action double permission', async () => {
  const hand = {handId:'synthetic-hand',state:'playing',dealer:['A♠','??'],player:['10♥','7♣'],dealerShowing:11,playerValue:17,canDouble:false};
  const calls=[];
  const h=harness({request(action,payload) {calls.push({action,payload}); return Promise.resolve({success:true,state:fixture({blackjack: action === 'blackjack-stand' ? {...hand,state:'complete',dealer:['A♠','9♦'],dealerValue:20,outcome:'lose',profit:-10} : hand})});}});
  await flush(); assert.match(h.mount.textContent,/🂠/); assert.equal(h.button('2X').disabled,true); assert.equal(h.button('DEAL').disabled,true);
  h.button('STAND').click(); await flush(); assert.equal(calls[1].payload.handId,'synthetic-hand');
  assert.match(h.mount.textContent,/❌ DEALER WINS -10 XP/); assert.equal(h.button('HIT').disabled,true); assert.equal(h.button('DEAL').disabled,false); h.destroy();
});
test('deadlines clear stale authority, ignore late settlement and permit explicit recovery', async () => {
  let resolve; let n=0;
  const h=harness({request() { if (++n===1) return Promise.resolve({success:true,state:fixture({level:3,rank:'ANALYST',inventory:{'ration-pack':2}})}); return new Promise(r => {resolve=r;}); }});
  await flush(); h.input('Coinflip bet XP').value='5'; h.button('TAILS').click(); await flush();
  for (const timer of [...h.timers.values()]) timer(); await flush();
  assert.equal(h.button('TAILS').disabled,true); assert.equal(h.button('REFRESH').disabled,false);
  assert.match(h.mount.textContent,/TOTAL: —/);
  assert.doesNotMatch(h.mount.textContent,/ANALYST|ration-pack ×2/);
  resolve({success:true,state:fixture({xp:999})}); await flush(); assert.doesNotMatch(h.mount.textContent,/999/); h.destroy();
});
test('teardown ignores pending response; errors redact hostile text and malformed state', async () => {
  let resolve;
  const h=harness({request:() => new Promise(r => {resolve=r;})}); await flush(); h.destroy();
  resolve({success:true,state:fixture()}); await flush(); assert.deepEqual(h.mount.children,[h.sentinel]); assert.equal(h.timers.size,0);
  for (const response of [{success:false,reason:'SECRET<script>'},{success:true,state:fixture({blackjack:{}})}]) {
    const failed=harness({request:() => Promise.resolve(response)}); await flush();
    assert.match(failed.mount.textContent,/UNAVAILABLE/); assert.doesNotMatch(failed.mount.textContent,/SECRET|script|TOTAL: 120/); failed.destroy();
  }
  const thrown=harness({request() {throw Error('SECRET');}}); await flush(); assert.doesNotMatch(thrown.mount.textContent,/SECRET/); thrown.destroy();
});
test('native scoped stylesheet supplies focus, mobile wrapping and reduced motion without art changes', () => {
  const file=path.join(__dirname,'../src/styles/companion-arcade.css');
  assert.ok(fs.existsSync(file)); const css=fs.readFileSync(file,'utf8');
  assert.match(css,/:focus-visible/); assert.match(css,/prefers-reduced-motion/); assert.match(css,/\.rg-arcade/); assert.doesNotMatch(css,/@import|url\(/);
});
test('destroy before dispatch prevents transport invocation and game results announce accessibly', async () => {
  let calls=0; const h=harness({request() {calls++; return Promise.resolve({success:true,state:fixture()});}});
  assert.ok(h.all().filter(x => ['cf-result','bj-result'].includes(x.className)).every(x => x.attributes['aria-live']==='polite'));
  h.destroy(); await flush(); assert.equal(calls,0);
});
test('optional explicit mount defaults unavailable without fictional progression; isolated teardown', () => {
  const h = harness();
  assert.match(h.mount.textContent,/ARCADE UNAVAILABLE/);
  assert.doesNotMatch(h.mount.textContent,/TOTAL: 0|YOU WIN|EMPTY INV/);
  assert.ok(h.all().filter(x => x.tagName === 'button').every(x => x.disabled));
  assert.ok(h.all().some(x => x.attributes.role === 'status'));
  assert.equal(h.context.RadgotchiArcade.init(h.document),h.destroy);
  h.destroy(); h.destroy(); assert.deepEqual(h.mount.children,[h.sentinel]);
  harness(null,true).destroy();
});
