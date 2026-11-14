'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {randomBytes} = require('node:crypto');
const {spawn} = require('node:child_process');
const {createMonitoringServer} = require('../src/main/monitoring-server');
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

// Synthetic loopback source only. Real production server, script, PNGs and Brave.
test('real browser loads original expressions for feed and selected package transitions', {timeout:60000}, async t => {
  const browser = await chromium(t); if (!browser) return;
  let mode = 'error';
  let rows = [{name:'SYNTHETIC-package', version:'1', state:'running'}];
  const upstream = http.createServer((_req,res) => {
    res.writeHead(mode === 'error' ? 503 : 200, {'Content-Type':'application/json'});
    res.end(JSON.stringify(rows));
  });
  await new Promise(r => upstream.listen(0,'127.0.0.1',r));
  t.after(() => {upstream.closeAllConnections(); upstream.close();});
  async function backend(configured) {
    const server = http.createServer();
    await new Promise(r => server.listen(0,'127.0.0.1',r));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const token = randomBytes(32).toString('hex');
    const app = createMonitoringServer({origin, token, cacheMs:0,
      ...(configured ? {inventoryUrl:`http://127.0.0.1:${upstream.address().port}/packages`} : {})});
    server.on('request', (req,res) => app.emit('request',req,res));
    t.after(() => {server.closeAllConnections(); server.close(); app.close();});
    await browser.command('Page.navigate',{url:origin+'/login'});
    await until(() => browser.evaluate('!!document.querySelector("input[name=token]")'));
    await browser.evaluate(`document.querySelector('input[name=token]').value=${JSON.stringify(token)}; document.querySelector('form').requestSubmit(); undefined`);
    await until(() => browser.evaluate('location.pathname === "/" && document.readyState === "complete"'));
    return origin;
  }
  async function sprite(face, label) {
    await until(() => browser.evaluate(`(() => { const s=document.getElementById('web-sprite'); return s && s.getAttribute('src')==='/assets/gotchi/${face}.png' && s.complete && s.naturalWidth > 0; })()`));
    const actual = await browser.evaluate(`(() => {const s=document.getElementById('web-sprite');return {alt:s.alt, filter:getComputedStyle(s).filter, rendering:getComputedStyle(s).imageRendering};})()`);
    assert.match(actual.alt,label);
    assert.match(actual.filter,/invert\(1\).*drop-shadow/);
    assert.equal(actual.rendering,'crisp-edges');
  }
  async function poll() {
    await browser.evaluate('RadgotchiMonitoring.stop(); RadgotchiMonitoring.start()');
  }
  const origin = await backend(true);
  await sprite('BROKEN', /Feed unavailable/);
  mode = 'connected'; await poll();
  await sprite('AWAKE', /Feed connected/);
  await browser.command('Emulation.setDeviceMetricsOverride',{width:390,height:800,deviceScaleFactor:1,mobile:false});
  await browser.evaluate(`document.querySelector('#package-list button').textContent='synthetic-package.dnp.dappnode.eth'`);
  await delay(350);
  const bounds = await browser.evaluate(`(() => {const e=document.querySelector('#package-list .network-node'); const b=e.getBoundingClientRect(); const c=getComputedStyle(e.querySelector('button')); return {left:b.left,right:b.right,bottom:b.bottom,whiteSpace:c.whiteSpace,minWidth:c.minWidth};})()`);
  assert.ok(bounds.left >= 0 && bounds.right <= 390 && bounds.bottom <= 800, JSON.stringify(bounds));
  await browser.evaluate('document.querySelector("#package-list button").click()');
  await sprite('MOTIVATED', /Package · running/);
  rows[0].state = 'stopped'; await poll();
  await sprite('BORED', /Package · stopped/);
  rows.push({name:'SYNTHETIC-package', version:'1', state:'running'}); await poll();
  await sprite('LONELY', /Package · mixed/);
  mode = 'error'; await poll();
  await sprite('LONELY', /Feed stale/);
  mode = 'connected'; rows[0].state = 'running'; await poll();
  await sprite('MOTIVATED', /Package · running/);
  await browser.evaluate('document.getElementById("feed-selection").click()');
  await sprite('AWAKE', /Feed connected/);
  await browser.evaluate('document.querySelector("#package-list button").click()');
  const retained = rows; rows = []; await poll();
  await sprite('AWAKE', /Feed connected/);
  rows = retained; await poll();
  assert.equal(await browser.evaluate('document.querySelector("#package-list button").ariaPressed'), 'false');
  await browser.evaluate('document.querySelector("#package-list button").click()');
  await browser.command('Network.enable');
  await browser.command('Network.setBlockedURLs',{urls:[origin+'/api/monitoring/package-status']});
  await poll(); await sprite('BROKEN', /Feed unavailable/);
  await browser.evaluate('document.querySelector("#package-list button").click()');
  await sprite('BROKEN', /Feed unavailable/);
  await browser.command('Network.setBlockedURLs',{urls:[]});
  await poll(); await sprite('MOTIVATED', /Package · running/);
  await browser.command('Network.clearBrowserCookies');
  await poll(); await sprite('ANGRY', /Feed login required/);
  assert.equal(await browser.evaluate('document.querySelectorAll("#package-list button").length'), 0);
  await browser.evaluate('document.getElementById("feed-selection").click()');
  await sprite('ANGRY', /Feed login required/);
  await backend(false); await sprite('BORED', /Feed not configured/);
  // Every selected PNG is served unchanged by the production static allowlist.
  const {createHash} = require('node:crypto');
  for (const name of ['AWAKE','MOTIVATED','BORED','LONELY','BROKEN','ANGRY']) {
    const response = await fetch(origin+`/assets/gotchi/${name}.png`);
    assert.equal(response.status,200);
    const served = Buffer.from(await response.arrayBuffer());
    const original = fs.readFileSync(path.join(__dirname,`../assets/gotchi/${name}.png`));
    assert.equal(createHash('sha256').update(served).digest('hex'),createHash('sha256').update(original).digest('hex'));
  }
});
