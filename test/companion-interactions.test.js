'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sourcePath = path.join(__dirname, '../src/web/companion-interactions.js');
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
test('real browser: original filters, keyboard greeting, bounded layout and reduced motion', {timeout:60000}, async t => {
  const browser = await chromium(t); if (!browser) return;
  const root = path.join(__dirname, '..');
  const assets = ['src/styles/chat-window.css', 'src/styles/monitoring.css', 'src/styles/companion-interactions.css', 'src/web/companion-interactions.js', 'assets/gotchi/AWAKE.png'];
  let html = fs.readFileSync(path.join(root, 'monitoring.html'), 'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '');
  html = html.replace('</head>', '<link rel="stylesheet" href="/src/styles/companion-interactions.css"><script defer src="/src/web/companion-interactions.js"></script><script defer src="/fixture-bootstrap.js"></script></head>');
  const server = http.createServer((req,res) => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'");
    if (req.url === '/') { res.setHeader('Content-Type','text/html'); return res.end(html); }
    if (req.url === '/fixture-bootstrap.js') { res.setHeader('Content-Type','text/javascript'); return res.end('globalThis.fixture = RadgotchiInteractions.init(document, localStorage);'); }
    const asset = assets.find(p => req.url === '/' + p);
    if (!asset) {res.statusCode=404; return res.end();}
    res.setHeader('Content-Type', asset.endsWith('.css') ? 'text/css' : asset.endsWith('.js') ? 'text/javascript' : 'image/png');
    res.end(fs.readFileSync(path.join(root, asset)));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => {server.closeAllConnections(); server.close();});
  await browser.command('Page.navigate', {url:`http://127.0.0.1:${server.address().port}/`});
  await until(() => browser.evaluate('!!globalThis.fixture && document.getElementById("web-sprite").naturalWidth > 0'));
  await browser.evaluate('document.getElementById("rg-interactions-pet").focus()');
  await browser.command('Input.dispatchKeyEvent', {type:'keyDown', key:'Enter', code:'Enter', text:'\r', windowsVirtualKeyCode:13});
  await browser.command('Input.dispatchKeyEvent', {type:'keyUp', key:'Enter', code:'Enter', windowsVirtualKeyCode:13});
  assert.equal(await browser.evaluate('document.getElementById("rg-interactions-motion").getAttribute("data-greeting")'), 'true');
  await until(() => browser.evaluate('!document.getElementById("rg-interactions-motion").hasAttribute("data-greeting")'));
  for (const width of [1280,390,320]) {
    await browser.command('Emulation.setDeviceMetricsOverride', {width,height:800,deviceScaleFactor:1,mobile:false});
    for (const zoom of ['75','100','125']) {
      await browser.evaluate(`(() => { const c=document.getElementById('rg-interactions-color'); c.value='cyan'; c.dispatchEvent(new Event('change')); })()`);
      await delay(350); // Allow upstream's original filter transition to settle.
      const actual = await browser.evaluate(`(() => {
        const z=document.getElementById('rg-interactions-zoom'); z.value='${zoom}'; z.dispatchEvent(new Event('change'));
        const c=document.getElementById('rg-interactions-color'); c.value='cyan'; c.dispatchEvent(new Event('change'));
        const s=document.getElementById('web-sprite'), h=document.getElementById('web-sprite-container').getBoundingClientRect();
        const b=s.getBoundingClientRect(), controls=document.getElementById('rg-interactions-controls').getBoundingClientRect();
        return {bounds:{sprite:b.toJSON(),host:h.toJSON(),controls:controls.toJSON()},src:s.getAttribute('src'), filter:getComputedStyle(s).filter, inside:b.left>=h.left && b.right<=h.right && b.top>=h.top && b.bottom<=controls.top, controlsInside:controls.left>=0 && controls.right<=innerWidth};
      })()`);
      assert.equal(actual.src, '/assets/gotchi/AWAKE.png');
      assert.match(actual.filter, /invert\(1\).*hue-rotate\(140deg\).*drop-shadow/);
      assert.ok(actual.inside, JSON.stringify({width,zoom,actual}));
      assert.ok(actual.controlsInside);
    }
  }
  await browser.command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  assert.equal(await browser.evaluate('getComputedStyle(document.getElementById("rg-interactions-motion")).animationName'), 'none');
  await browser.evaluate('fixture.destroy()');
  assert.equal(await browser.evaluate('document.getElementById("web-sprite").parentNode.id'), 'web-sprite-container');
});

// Minimal DOM boundary; no browser or dependency required for the unit suite.
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.attributes = {}; this.listeners = new Map(); this.className = ''; this.value = ''; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  removeAttribute(k) { delete this.attributes[k]; }
  set innerHTML(_) { throw Error('Unsafe HTML'); }
  get nextSibling() { const a = this.parentNode?.children || []; return a[a.indexOf(this) + 1] || null; }
  append(...nodes) { for (const n of nodes) { n.remove(); this.children.push(n); n.parentNode = this; } }
  insertBefore(n, ref) { if (!ref) return this.append(n); n.remove(); this.children.splice(this.children.indexOf(ref), 0, n); n.parentNode = this; }
  remove() { if (this.parentNode) { const a = this.parentNode.children; a.splice(a.indexOf(this), 1); this.parentNode = null; } }
  addEventListener(k, fn) { if (!this.listeners.has(k)) this.listeners.set(k, new Set()); this.listeners.get(k).add(fn); }
  removeEventListener(k, fn) { this.listeners.get(k)?.delete(fn); }
  dispatch(k, extra = {}) { for (const fn of this.listeners.get(k) || []) fn({target:this, ...extra}); }
  get classList() { return {add:(c) => { this.className = [...new Set([...this.className.split(' ').filter(Boolean), c])].join(' '); }, remove:(c) => { this.className = this.className.split(' ').filter(x => x !== c).join(' '); }}; }
}
function harness(raw) {
  const root = new Element('main'), host = new Element('div'), sprite = new Element('img'), sibling = new Element('span');
  host.id = 'web-sprite-container'; sprite.id = 'web-sprite';
  sprite.setAttribute('src', '/assets/gotchi/BROKEN.png'); sprite.setAttribute('alt', 'Feed unavailable');
  host.append(sprite, sibling); root.append(host);
  const all = n => [n, ...n.children.flatMap(all)];
  const document = {getElementById:id => all(root).find(n => n.id === id), createElement:tag => new Element(tag)};
  const writes = [];
  const storage = {getItem:() => raw ?? null, setItem:(k,v) => writes.push([k,v])};
  const context = {};
  assert.ok(fs.existsSync(sourcePath), 'interaction module exists');
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), context);
  return {root, host, sprite, sibling, document, storage, writes, api:context.RadgotchiInteractions, get:id => document.getElementById('rg-interactions-' + id)};
}

test('local palette and bounded zoom validate storage and reject hostile preferences', () => {
  for (const raw of [null, '{broken', 'null', '[]', '"green"', '{"color":"url(https://bad)","zoom":999}', '{"color":{},"zoom":"125"}', 'x'.repeat(2000)]) {
    const h = harness(raw); h.api.init(h.document, h.storage);
    assert.equal(h.get('color').value, 'original');
    assert.equal(h.get('zoom').value, '100');
    assert.equal(h.writes.length, 0, 'initialization never writes');
  }
  const h = harness('{"color":"cyan","zoom":125}'); h.api.init(h.document, h.storage);
  assert.equal(h.get('pet').getAttribute('data-color'), 'cyan');
  assert.equal(h.get('pet').getAttribute('data-zoom'), '125');
  assert.equal(h.get('color').getAttribute('aria-label'), 'Companion color');
  h.get('color').value = 'red'; h.get('color').dispatch('change');
  h.get('zoom').value = '75'; h.get('zoom').dispatch('change');
  assert.deepEqual(JSON.parse(h.writes.at(-1)[1]), {color:'red', zoom:75});
  assert.equal(h.writes.at(-1)[0], 'radgotchi-companion-appearance-v1');
  h.get('color').value = 'url(evil)'; h.get('color').dispatch('change');
  h.get('zoom').value = 'Infinity'; h.get('zoom').dispatch('change');
  assert.equal(h.get('color').value, 'red');
  assert.equal(h.get('zoom').value, '75');
  assert.equal(h.writes.length, 2);
  assert.equal(h.sprite.getAttribute('src'), '/assets/gotchi/BROKEN.png');
});

test('greeting and motion pause affect wrappers only and destroy removes listeners', () => {
  const h = harness(); const instance = h.api.init(h.document, h.storage);
  const pet = h.get('pet'), motion = h.get('motion'), pause = h.get('pause'), color = h.get('color');
  pet.dispatch('click');
  assert.equal(motion.getAttribute('data-greeting'), 'true');
  motion.dispatch('animationend', {animationName:'rg-interactions-greet'});
  assert.equal(motion.getAttribute('data-greeting'), null);
  pause.dispatch('click');
  assert.equal(pause.getAttribute('aria-pressed'), 'true');
  assert.equal(motion.getAttribute('data-paused'), 'true');
  pet.dispatch('click');
  assert.equal(motion.getAttribute('data-greeting'), null, 'paused motion stays still');
  pause.dispatch('click');
  assert.equal(pause.getAttribute('aria-pressed'), 'false');
  assert.deepEqual(h.sprite.attributes, {src:'/assets/gotchi/BROKEN.png', alt:'Feed unavailable'});
  instance.destroy();
  for (const el of [pet, motion, pause, color]) assert.equal([...el.listeners.values()].reduce((n,v) => n + v.size, 0), 0);
  pet.dispatch('click'); color.value = 'red'; color.dispatch('change');
  assert.equal(h.writes.length, 0);
});

test('styles keep original image filters, use bounded wrapper motion and honor reduced motion', () => {
  const cssPath = path.join(__dirname, '../src/styles/companion-interactions.css');
  assert.ok(fs.existsSync(cssPath), 'companion stylesheet exists');
  const css = fs.readFileSync(cssPath, 'utf8');
  assert.match(css, /@media\s*\(prefers-reduced-motion: reduce\)/);
  assert.match(css, /animation: none !important/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@keyframes rg-interactions-breathe/);
  assert.match(css, /@keyframes rg-interactions-greet/);
  assert.doesNotMatch(css, /(?:url\(|@import|\bimg\s*\{)/);
  assert.doesNotMatch(fs.readFileSync(sourcePath, 'utf8'), /\b(?:fetch|XMLHttpRequest|WebSocket|eval|setInterval|setTimeout)\s*\(|innerHTML|sprite\.(?:src|alt|title)\s*=/);
});

test('storage denial and missing viewport remain harmless', () => {
  const h = harness();
  const denied = {getItem() { throw Error('denied'); }, setItem() { throw Error('full'); }};
  const instance = h.api.init(h.document, denied);
  h.get('color').value = 'amber'; h.get('color').dispatch('change');
  assert.equal(h.get('pet').getAttribute('data-color'), 'amber');
  instance.destroy(); h.host.remove();
  assert.doesNotThrow(() => h.api.init(h.document, denied).destroy());
});

test('explicit init preserves authoritative sprite, is idempotent, and destroy restores its position', () => {
  const h = harness();
  assert.equal(h.host.children.length, 2, 'no automatic startup');
  const instance = h.api.init(h.document, h.storage);
  assert.equal(typeof instance.destroy, 'function');
  assert.equal(h.api.init(h.document, h.storage), instance);
  assert.ok(h.get('controls'));
  assert.equal(h.get('pet').tagName, 'button');
  assert.match(h.get('pet').getAttribute('aria-label'), /companion/i);
  assert.deepEqual(h.sprite.attributes, {src:'/assets/gotchi/BROKEN.png', alt:'Feed unavailable'});
  h.sprite.setAttribute('src', '/assets/gotchi/LONELY.png');
  instance.destroy(); instance.destroy();
  assert.deepEqual(h.host.children, [h.sprite, h.sibling]);
  assert.equal(h.sprite.getAttribute('src'), '/assets/gotchi/LONELY.png');
  assert.equal(h.get('controls'), undefined);
  assert.notEqual(h.api.init(h.document, h.storage), instance);
});
