'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
// Small DOM boundary harness: production render/poll code executes unchanged.
class Element {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this.hidden = false; this.value = ''; }
  set textContent(value) { this.value = String(value); this.children = []; }
  get textContent() { return this.value + this.children.map(child => child.textContent).join(''); }
  set src(value) { this.setAttribute('src', value); }
  get src() { return this.attributes.src || ''; }
  set innerHTML(_) { throw new Error('Unsafe HTML sink'); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.value = ''; this.children = children; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
}
function harness(fetch = async () => ({ ok: true, json: async () => payload() })) {
  const elements = Object.fromEntries(['feed-selection', 'web-sprite', 'source-status', 'freshness', 'package-list', 'request-status', 'login-link', 'reported-rows', 'package-count'].map(id => [id, new Element()]));
  const timers = new Map(); let nextTimer = 0;
  const document = { getElementById: id => elements[id], createElement: tag => new Element(tag) };
  const context = { document, fetch, AbortController, Date: class extends Date {static now() {return Date.parse('2026-11-13T12:00:00Z');}}, setTimeout: (fn, delay) => { timers.set(++nextTimer, { fn, delay }); return nextTimer; }, clearTimeout: id => timers.delete(id) };
  context.globalThis = context;
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/web/monitoring-panel.js'), 'utf8'), context);
  return { elements, timers, panel: context.RadgotchiMonitoring };
}
function payload(extra = {}) {
  return { sourceStatus: 'connected', observedAt: '2026-11-13T12:00:00Z', lastSuccessAt: '2026-11-13T12:00:00Z', coverage: 'package-status-only', containerIdentityAvailable: false, reportedRows: 2, packages: [{ name: '<img src=x onerror=alert(1)>', versions: ['1.2.3'], reportedRows: 2, states: { running: 1, exited: 1 } }], ...extra };
}
function buttons(element) {
  return [element, ...element.children.flatMap(buttons)].filter(item => item.tagName === 'button');
}
test('native package selection persists across refresh, yields to stale, clears on disappearance and resets to feed', () => {
  const {panel, elements} = harness();
  const sample = states => payload({packages:[{name:'<hostile>', versions:[], reportedRows:2, states}]});
  panel.render(sample({running:2}));
  let select = buttons(elements['package-list'])[0];
  assert.ok(select, 'each observed package has a native selection button');
  assert.equal(select.textContent, '<hostile>');
  select.onclick();
  assert.equal(elements['web-sprite'].src, '/assets/gotchi/MOTIVATED.png');
  assert.match(elements['request-status'].textContent, /Package · running/);
  assert.equal(buttons(elements['package-list'])[0].ariaPressed, 'true');
  assert.match(buttons(elements['package-list'])[0].className, /\bactive\b/);
  panel.render(sample({exited:2}));
  assert.equal(elements['web-sprite'].src, '/assets/gotchi/BORED.png');
  panel.render({...sample({running:2}), sourceStatus:'stale'});
  assert.equal(elements['web-sprite'].src, '/assets/gotchi/LONELY.png');
  buttons(elements['package-list'])[0].onclick();
  assert.equal(elements['web-sprite'].src, '/assets/gotchi/LONELY.png');
  panel.render(sample({running:2}));
  assert.equal(elements['web-sprite'].src, '/assets/gotchi/MOTIVATED.png');
  elements['feed-selection'].onclick();
  assert.equal(elements['web-sprite'].src, '/assets/gotchi/AWAKE.png');
  assert.equal(buttons(elements['package-list'])[0].ariaPressed, 'false');
  buttons(elements['package-list'])[0].onclick();
  panel.render(payload({packages:[], reportedRows:0}));
  assert.equal(elements['web-sprite'].src, '/assets/gotchi/AWAKE.png');
  panel.render(sample({running:2}));
  assert.equal(buttons(elements['package-list'])[0].ariaPressed, 'false');
});

test('pure expression evidence distinguishes selected package aggregates from feed health', () => {
  const {panel} = harness();
  const cases = [
    [{running:2}, 'MOTIVATED', 'running'],
    [{exited:1, stopped:1}, 'BORED', 'stopped'],
    [{running:1, exited:1}, 'LONELY', 'mixed'],
    [{paused:2}, 'AWAKE', 'unknown'],
    [{unknown:2}, 'AWAKE', 'unknown'],
    [{running:1}, 'AWAKE', 'unknown'],
    [{running:0}, 'AWAKE', 'unknown']
  ];
  for (const [states, face, evidence] of cases) {
    const data = payload({packages:[{name:'sample', versions:[], reportedRows:2, states}]});
    const result = panel.observationExpression(data, 'sample');
    assert.equal(result.face, face);
    assert.equal(result.scope, 'package');
    assert.equal(result.evidence, evidence);
    assert.doesNotMatch(result.label, /healthy/i);
    assert.equal(panel.observationExpression(data).scope, 'feed');
    for (const sourceStatus of ['stale', 'error', 'unconfigured', 'unauthorized']) {
      const override = panel.observationExpression({...data, sourceStatus}, 'sample');
      assert.equal(override.scope, 'feed');
      assert.equal(override.evidence, sourceStatus);
    }
  }
});

test('original expressions follow source transitions, never package running states', () => {
  const { panel, elements } = harness();
  for (const [sourceStatus, face] of [['connected','AWAKE'], ['stale','LONELY'], ['connected','AWAKE'], ['unconfigured','BORED'], ['error','BROKEN'], ['connected','AWAKE']]) {
    panel.render(payload({sourceStatus}));
    assert.equal(elements['web-sprite'].src, `/assets/gotchi/${face}.png`);
    assert.match(elements['web-sprite'].alt, /feed/i);
  }
  panel.render(payload({packages: [{name:'stopped', versions:[], reportedRows:2, states:{exited:2}}]}));
  assert.equal(elements['web-sprite'].src, '/assets/gotchi/AWAKE.png');
});

test('start shows waiting while the first feed request is pending', async () => {
  let resolve;
  const {panel, elements} = harness(() => new Promise(r => { resolve = r; }));
  const pending = panel.start();
  assert.equal(elements['web-sprite'].src, '/assets/gotchi/BORED.png');
  assert.match(elements['web-sprite'].alt, /Waiting/);
  assert.match(elements['request-status'].textContent, /Waiting/);
  resolve({ok:true, json:async () => payload()});
  await pending;
  assert.equal(elements['web-sprite'].src, '/assets/gotchi/AWAKE.png');
  panel.stop();
});

test('stopped request cannot overwrite a restarted feed or schedule another poll', async () => {
  for (const late of ['success', '401', 'network', 'json']) {
    const requests = [];
    const {panel, elements, timers} = harness((_url, options) => new Promise((resolve, reject) => requests.push({resolve, reject, signal:options.signal})));
    const old = panel.start();
    await panel.start();
    assert.equal(requests.length, 1, 'duplicate starts do not overlap');
    let finishJson;
    if (late === 'json') {
      requests[0].resolve({ok:true, json:() => new Promise(r => {finishJson = r;})});
      await new Promise(setImmediate);
      assert.equal(typeof finishJson, 'function');
    }
    panel.stop();
    assert.equal(requests[0].signal.aborted, true);
    const fresh = panel.start();
    requests[1].resolve({ok:true, json:async () => payload({sourceStatus:'stale'})});
    await fresh;
    if (late === 'network') requests[0].reject(new Error('late failure'));
    else if (late === 'json') finishJson(payload());
    else requests[0].resolve(late === '401' ? {status:401} : {ok:true, json:async () => payload()});
    await old;
    assert.equal(elements['web-sprite'].src, '/assets/gotchi/LONELY.png', late);
    assert.equal(timers.size, 1, late);
    panel.stop();
    assert.equal(timers.size, 0);
  }
});

test('polls only authenticated same-origin GET at a bounded non-overlapping cadence', async () => {
  const calls = [];
  const { panel, timers, elements } = harness(async (...args) => { calls.push(args); return { ok: true, json: async () => payload() }; });
  assert.equal(typeof panel.start, 'function');
  await panel.start();
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], '/api/monitoring/package-status');
  assert.equal(calls[0][1].method, 'GET');
  assert.equal(calls[0][1].credentials, 'same-origin');
  assert.equal(calls[0][1].cache, 'no-store');
  assert.equal(timers.size, 2);
  assert.ok([...timers.values()].some(timer => timer.delay === 30000));
  assert.ok([...timers.values()].some(timer => timer.delay === 90000));
  assert.match(elements['request-status'].textContent, /30s/);
  panel.stop();
  assert.equal(timers.size, 0);
});

test('401 stops polling, clears inventory, and exposes the server login link', async () => {
  const { panel, elements, timers } = harness(async () => ({ status: 401, ok: false, json: async () => ({ error: 'login-required' }) }));
  panel.render(payload());
  await panel.start();
  assert.equal(elements['web-sprite'].src, '/assets/gotchi/ANGRY.png');
  assert.match(elements['web-sprite'].alt, /login required/);
  assert.equal(elements['package-list'].textContent, '');
  assert.equal(elements['login-link'].hidden, false);
  assert.match(elements['request-status'].textContent, /Login required/);
  assert.equal(timers.size, 0);
});

test('failed refresh preserves last-good data and labels it stale without exposing error bodies', async () => {
  for (const failure of ['network', 'http', 'schema']) {
    let calls = 0;
    const { panel, elements, timers } = harness(async () => {
      if (++calls === 1) return { ok: true, json: async () => payload() };
      if (failure === 'network') throw new Error('secret upstream detail');
      return { ok: failure !== 'http', json: async () => ({ packages: [], secret: 'secret upstream detail' }) };
    });
    await panel.start();
    const before = elements['package-list'].textContent;
    const scheduled = [...timers.entries()].find(([,timer]) => timer.delay === 30000); timers.delete(scheduled[0]);
    await scheduled[1].fn();
    assert.equal(elements['web-sprite'].src, '/assets/gotchi/BROKEN.png');
    assert.equal(elements['package-list'].textContent, before);
    assert.match(elements['request-status'].textContent, /stale/i);
    assert.doesNotMatch(elements['request-status'].textContent, /secret/);
    assert.equal(timers.size, 1);
    panel.stop();
  }
});

test('source freshness states explicitly explain empty and retained observations', () => {
  const { panel, elements } = harness();
  panel.render(payload({ sourceStatus: 'stale' }));
  assert.match(elements['request-status'].textContent, /last successful/i);
  assert.match(elements['package-list'].textContent, /running: 1/);
  panel.render(payload({ sourceStatus: 'unconfigured', observedAt: null, lastSuccessAt: null, packages: [], reportedRows: 0 }));
  assert.match(elements['request-status'].textContent, /not configured/i);
  assert.match(elements['package-list'].textContent, /No observations/);
  panel.render(payload({ sourceStatus: 'error', observedAt: null, lastSuccessAt: null, packages: [], reportedRows: 0 }));
  assert.match(elements['request-status'].textContent, /error/i);
});

test('static shell is accessible, local-only, attributed, and auto-starts its external script', () => {
  assert.ok(fs.existsSync(path.join(root, 'monitoring.html')), 'static monitoring page exists');
  const html = fs.readFileSync(path.join(root, 'monitoring.html'), 'utf8');
  assert.match(html, /lang="en"/);
  assert.match(html, /<main/);
  assert.match(html, /role="status"/);
  assert.match(html, /aria-live="polite"/);
  assert.match(html, /Service and container identities are unavailable/);
  assert.match(html, /href="\/login"/);
  assert.match(html, /assets\/gotchi\/AWAKE.png/);
  assert.match(html, /itsTylerIRL/);
  assert.match(html, /MIT/);
  assert.match(html, /<script src="\/src\/web\/monitoring-panel.js" defer><\/script>/);
  assert.match(html, /<button[^>]*id="feed-selection"[^>]*type="button"[^>]*>FEED<\/button>/);
  assert.doesNotMatch(html, /(?:src|href)="https?:|\son\w+=|<input/);
  assert.ok(fs.existsSync(path.join(root, 'assets/gotchi/AWAKE.png')));
  const css = fs.readFileSync(path.join(root, 'src/styles/monitoring.css'), 'utf8');
  assert.match(css, /:focus-visible/);
  assert.doesNotMatch(css, /@import|https?:/);
  const source = fs.readFileSync(path.join(root, 'src/web/monitoring-panel.js'), 'utf8');
  assert.match(source, /document\.currentScript/);
});

test('compact terminal reports real groups, rows and original node components', () => {
  const {panel,elements}=harness(); panel.render(payload());
  assert.equal(elements['package-count'].textContent,'1');
  assert.equal(elements['reported-rows'].textContent,'2');
  assert.equal(elements['package-list'].children[0].className,'network-node');
  assert.ok(elements['request-status'].textContent.length < 65);
});

test('renders grouped source data literally without inferring health or identities', () => {
  assert.ok(fs.existsSync(path.join(root, 'src/web/monitoring-panel.js')), 'monitoring renderer must exist');
  const { panel, elements } = harness();
  panel.render(payload());
  assert.match(elements['package-list'].textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(elements['package-list'].textContent, /1\.2\.3/);
  assert.match(elements['package-list'].textContent, /running: 1/);
  assert.match(elements['package-list'].textContent, /exited: 1/);
  assert.doesNotMatch(elements['package-list'].textContent, /healthy/i);
  assert.match(elements['source-status'].textContent, /connected/);
  assert.match(elements.freshness.textContent, /2026-11-13T12:00:00Z/);
});

const http = require('node:http');
const os = require('node:os');
const {spawn} = require('node:child_process');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i=0; i<100; i++) { const value=await fn(); if (value) return value; await delay(50); }
  throw new Error('Synthetic browser condition timed out');
}
async function chromium(t) {
  // Explicit opt-in; no dependency install, personal profile, or existing browser targets.
  const executable=process.env.RADGOTCHI_TEST_CHROMIUM;
  if (!executable) {t.skip('Set RADGOTCHI_TEST_CHROMIUM to run real Chromium regression'); return;}
  const profile=fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(),'radgotchi-browser-'));
  const child=spawn(executable,['--headless=new','--no-first-run','--no-default-browser-check','--disable-background-networking','--disable-sync','--remote-debugging-pipe',`--user-data-dir=${profile}`],{stdio:['ignore','ignore','ignore','pipe','pipe']});
  let next=0, buffer=Buffer.alloc(0); const pending=new Map();
  child.stdio[4].on('data',chunk=>{
    buffer=Buffer.concat([buffer,chunk]); let end;
    while ((end=buffer.indexOf(0))!==-1) {
      const message=JSON.parse(buffer.subarray(0,end).toString()); buffer=buffer.subarray(end+1);
      const entry=pending.get(message.id);
      if (entry) {pending.delete(message.id); clearTimeout(entry.timer); message.error ? entry.reject(new Error('CDP command failed')) : entry.resolve(message.result);}
    }
  });
  t.after(async()=>{
    for (const entry of pending.values()) {clearTimeout(entry.timer); entry.reject(new Error('Browser closed'));}
    if (child.exitCode===null) {const exited=new Promise(r=>child.once('exit',r)); child.kill('SIGKILL'); await exited;}
    fs.rmSync(profile,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  });
  function call(method,params={},sessionId) {
    return new Promise((resolve,reject)=>{
      const id=++next; const timer=setTimeout(()=>{pending.delete(id); reject(new Error(`CDP command timed out: ${method}`));},20000);
      pending.set(id,{resolve,reject,timer});
      child.stdio[3].write(JSON.stringify({id,method,params,...(sessionId ? {sessionId} : {})})+'\0');
    });
  }
  const {targetId}=await call('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
  const command=(method,params)=>call(method,params,sessionId);
  const evaluate=async expression=>{
    const result=await command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});
    if(result.exceptionDetails) throw new Error('Synthetic browser evaluation failed');
    return result.result.value;
  };
  return {command,evaluate};
}


test('real browser keeps monitoring grid coherent at 320px and 390px', {timeout:60000}, async t => {
  const browser = await chromium(t); if (!browser) return;
  const server = http.createServer((req,res) => {
    const file = path.join(root, req.url === '/' ? 'monitoring.html' : req.url);
    if (req.url.startsWith('/api/')) {res.writeHead(503); res.end(); return;}
    res.setHeader('Content-Type', req.url.endsWith('.css') ? 'text/css' : req.url.endsWith('.js') ? 'text/javascript' : req.url.endsWith('.png') ? 'image/png' : 'text/html');
    if (!fs.existsSync(file)) {res.writeHead(404); res.end(); return;}
    res.end(fs.readFileSync(file));
  });
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  t.after(() => {server.closeAllConnections(); server.close();});
  await browser.command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});
  await until(() => browser.evaluate('!!globalThis.RadgotchiMonitoring'));
  await browser.evaluate(`Date.now = () => ${Date.parse('2026-11-13T12:00:00Z')}; RadgotchiMonitoring.stop(); RadgotchiMonitoring.render(${JSON.stringify(payload())});`);
  for (const width of [320,390]) {
    await browser.command('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:false});
    const layout = await browser.evaluate(`(() => {
      const grid=getComputedStyle(document.querySelector('main'));
      const rect=id => {const r=document.getElementById(id).getBoundingClientRect(); return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};};
      return {columns:grid.gridTemplateColumns.split(' ').length,areas:grid.gridTemplateAreas,sprite:rect('web-sprite-container'),packages:rect('packages'),status:rect('request-status'),scroll:document.documentElement.scrollWidth};
    })()`);
    assert.equal(layout.columns, width <=340 ? 2 : 3, JSON.stringify(layout));
    assert.ok(layout.sprite.bottom <= layout.packages.top, JSON.stringify(layout));
    assert.ok(layout.packages.bottom <= layout.status.top, JSON.stringify(layout));
    assert.ok(layout.scroll <= width, JSON.stringify(layout));
  }
  await browser.evaluate(`globalThis.fetch = async () => ({ok:true,json:async () => (${JSON.stringify(payload())})});
    document.querySelector('#package-list button').focus(); RadgotchiMonitoring.start();`);
  assert.equal(await browser.evaluate("document.activeElement.textContent"), payload().packages[0].name, 'polling preserves package keyboard focus');
  await browser.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',windowsVirtualKeyCode:13});
  await browser.command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  assert.equal(await browser.evaluate("document.activeElement.ariaPressed"), 'true');
  await browser.evaluate(`document.getElementById('feed-selection').focus(); RadgotchiMonitoring.render(${JSON.stringify(payload())});`);
  assert.equal(await browser.evaluate('document.activeElement.id'), 'feed-selection', 'refresh does not steal outside focus');
  await browser.evaluate(`document.querySelector('#package-list button').focus(); RadgotchiMonitoring.render(${JSON.stringify(payload({packages:[],reportedRows:0}))});`);
  assert.equal(await browser.evaluate('document.activeElement.id'), 'feed-selection', 'removed package has a stable focus fallback');
});
