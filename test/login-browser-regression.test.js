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
// Node fetch overwrites Sec-Fetch-Mode; raw HTTP preserves adversarial test headers.
function requestStatus(url, options={}) {
  return new Promise((resolve,reject)=>{
    const req=http.request(url,options,res=>{res.resume();res.on('end',()=>resolve({status:res.statusCode}));});
    req.on('error',reject); req.end();
  });
}
async function until(fn) {
  for (let i=0; i<100; i++) { const value=await fn(); if (value) return value; await delay(50); }
  throw new Error('Synthetic browser condition timed out');
}
async function fixture(t) {
  const token=randomBytes(32).toString('hex');
  const records=[];
  const server=http.createServer();
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const app=createMonitoringServer({origin,token});
  server.on('request',(req,res)=>{
    // Never collect request bodies, cookies, or arbitrary headers.
    const record={method:req.method,origin:req.headers.origin ?? '(absent)',site:req.headers['sec-fetch-site'] ?? '(absent)'};
    res.on('finish',()=>{record.status=res.statusCode; records.push(record);});
    app.emit('request',req,res);
  });
  t.after(()=>{server.closeAllConnections(); server.close(); app.close();});
  return {origin,token,records};
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
test('public login and shell accept cross-site top-level navigation only',async t=>{
  const {origin}=await fixture(t);
  for (const site of ['cross-site','same-site']) {
    for (const route of ['/login','/','/monitoring.html']) {
      const response=await requestStatus(origin+route,{headers:{'Sec-Fetch-Site':site,'Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'}});
      assert.equal(response.status,200,`${site} navigation to ${route}`);
    }
  }
});
test('navigation exception does not expose API, subresources, or mutations',async t=>{
  const {origin}=await fixture(t);
  const navigation={'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'navigate','Sec-Fetch-Dest':'document'};
  for (const route of ['/api/monitoring/package-status','/healthz','/src/web/monitoring-panel.js']) {
    assert.equal((await requestStatus(origin+route,{headers:navigation})).status,403);
  }
  for (const route of ['/login','/','/monitoring.html']) {
    for (const headers of [
      {...navigation,'Sec-Fetch-Dest':'iframe'},
      {...navigation,'Sec-Fetch-Mode':'cors'},
      {...navigation,Origin:'http://evil.test'},
      {...navigation,Origin:'null'},
      {...navigation,Host:'evil.test'}
    ]) assert.equal((await requestStatus(origin+route,{headers})).status,403);
  }
  for (const suppliedOrigin of [undefined,'null','http://evil.test',origin]) {
    const headers={...navigation}; if(suppliedOrigin) headers.Origin=suppliedOrigin;
    assert.equal((await requestStatus(origin+'/login',{method:'POST',headers})).status,403);
  }
  for (const suppliedOrigin of [undefined,'null','http://evil.test']) {
    const headers={'Sec-Fetch-Site':'same-origin'}; if(suppliedOrigin) headers.Origin=suppliedOrigin;
    assert.equal((await requestStatus(origin+'/login',{method:'POST',headers})).status,403);
  }
});
test('real Chromium follows an external link to the public login',async t=>{
  const browser=await chromium(t); if(!browser) return;
  const {origin,records}=await fixture(t);
  const source=http.createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(`<a href="${origin}/login">Login</a>`);});
  await new Promise(r=>source.listen(0,'127.0.0.1',r));
  t.after(()=>{source.closeAllConnections();source.close();});
  await browser.command('Page.navigate',{url:`http://localhost:${source.address().port}`});
  await browser.evaluate('document.querySelector("a").click(); undefined');
  const navigation=await until(()=>records.find(record=>record.site==='cross-site'));
  t.diagnostic(JSON.stringify(navigation));
  assert.equal(navigation.status,200);
  await until(()=>browser.evaluate('!!document.querySelector("form input[name=token]")'));
});
test('real Chromium native login form preserves Origin and establishes cookie authentication',async t=>{
  const browser=await chromium(t); if(!browser) return;
  const {origin,token,records}=await fixture(t);
  await browser.command('Page.navigate',{url:origin+'/login'});
  await until(()=>browser.evaluate('!!document.querySelector("form input[name=token]")'));
  // Ephemeral synthetic credential stays in memory; never print CDP expressions or form values.
  await browser.evaluate(`document.querySelector('input[name=token]').value=${JSON.stringify(token)}; document.querySelector('form').requestSubmit(); undefined`);
  const post=await until(()=>records.find(record=>record.method==='POST'));
  t.diagnostic(JSON.stringify(post));
  assert.equal(post.status,303,'native login POST must redirect, not return Forbidden');
  assert.equal(post.origin,origin);
  assert.equal(post.site,'same-origin');
  await until(()=>browser.evaluate('location.pathname === "/" && document.readyState === "complete"'));
  assert.equal(await browser.evaluate('fetch("/api/monitoring/package-status").then(r=>r.status)'),200);
  assert.equal(await browser.evaluate('document.cookie.includes("radgotchi_monitor")'),false,'session must remain HttpOnly');
  assert.equal((await requestStatus(origin+'/api/monitoring/package-status')).status,401,'no cookie means no API access');
});
