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

// Runs the actual served HTML, all deferred scripts and production HTTP together.
test('production companion composition: native login, layout, interactions, focus, timer and cleanup', {timeout:60000}, async t => {
  const browser = await chromium(t); if (!browser) return;
  const evidence = process.env.RADGOTCHI_INTEGRATION_EVIDENCE;
  if (evidence) fs.mkdirSync(evidence, {recursive:true,mode:0o700});
  const records = [];
  async function capture(name) {
    if (!evidence) return;
    const {data} = await browser.command('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(evidence,name+'.png'),Buffer.from(data,'base64'),{mode:0o600});
  }
  const upstream = http.createServer((req,res)=>{res.setHeader('Content-Type','application/json'); res.end(JSON.stringify([{name:'SYNTHETIC-alpha.dnp.dappnode.eth',version:'1.0',state:'running'},{name:'SYNTHETIC-beta.dnp.dappnode.eth',version:'2.0',state:'stopped'}]));});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const server = http.createServer();
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const token = randomBytes(32).toString('hex');
  const app = createMonitoringServer({origin,token,inventoryUrl:`http://127.0.0.1:${upstream.address().port}/inventory`});
  const posts = [];
  server.on('request',(req,res)=>{
    if(req.method==='POST') res.on('finish',()=>posts.push({method:req.method,origin:req.headers.origin,site:req.headers['sec-fetch-site'],status:res.statusCode}));
    app.emit('request',req,res);
  });
  t.after(()=>{server.closeAllConnections();server.close();upstream.closeAllConnections();upstream.close();app.close();});
  await browser.command('Page.navigate',{url:origin+'/login'});
  await until(()=>browser.evaluate('document.readyState==="complete" && !!document.querySelector("input[name=token]")'));
  for(const width of [1280,390,320]) {
    await browser.command('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:false});
    assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'),true);
    assert.equal(await browser.evaluate('new URL(document.querySelector("form").action).origin === location.origin'),true);
    assert.equal(await browser.evaluate('document.querySelector("input[name=token]").type'),'password');
    await capture('login-'+width);
  }
  await browser.evaluate(`document.querySelector('input[name=token]').value=${JSON.stringify(token)}; document.querySelector('form').requestSubmit(); undefined`);
  await until(()=>browser.evaluate('location.pathname==="/" && document.querySelector(".rg-activities") && document.querySelector("#rg-interactions-pet") && document.querySelector("#source-status").textContent.includes("connected")'));
  assert.deepEqual(posts,[{method:'POST',origin,site:'same-origin',status:303}]);
  for(const width of [1280,390,320]) {
    await browser.command('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:false});
    await delay(400);
    const layout = await browser.evaluate(`(() => {
      const box=id=>{const b=document.getElementById(id).getBoundingClientRect();return {x:b.x,y:b.y,right:b.right,bottom:b.bottom,width:b.width,height:b.height};};
      const sprite=document.getElementById('web-sprite');
      return {width:innerWidth,scrollWidth:document.documentElement.scrollWidth,activities:box('companion-activities'),packages:box('packages'),host:box('web-sprite-container'),filter:getComputedStyle(sprite).filter,decoded:sprite.complete&&sprite.naturalWidth>0,src:sprite.getAttribute('src'),controls:[...document.querySelectorAll('.rg-activities button,.rg-interactions-controls > *')].map(e=>{const r=e.getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom};})};
    })()`);
    records.push(layout); await capture('companion-'+width);
    assert.ok(layout.scrollWidth<=width,JSON.stringify(layout));
    assert.ok(layout.activities.width>=width-40 && layout.activities.right<=width && layout.activities.bottom<=800,JSON.stringify(layout));
    assert.ok(layout.packages.bottom<=layout.activities.y && layout.host.bottom<=layout.packages.y,JSON.stringify(layout));
    for(const c of layout.controls) assert.ok(c.left>=0 && c.right<=width && c.top>=0 && c.bottom<=800,JSON.stringify(c));
    assert.ok(layout.decoded); assert.match(layout.filter,/invert\(1\).*drop-shadow/);
    assert.equal(layout.src,'/assets/gotchi/AWAKE.png');
  }
  await browser.evaluate(`document.querySelector('#rg-interactions-color').value='cyan'; document.querySelector('#rg-interactions-color').dispatchEvent(new Event('change')); document.querySelector('#rg-interactions-zoom').value='125'; document.querySelector('#rg-interactions-zoom').dispatchEvent(new Event('change')); document.querySelector('#rg-interactions-pet').click()`);
  assert.equal(await browser.evaluate('document.querySelector("#rg-interactions-motion").dataset.greeting'),'true');
  assert.equal(await browser.evaluate('document.querySelector("#rg-interactions-pet").dataset.color'),'cyan');
  assert.equal(await browser.evaluate('document.querySelector("#web-sprite").getAttribute("src")'),'/assets/gotchi/AWAKE.png');
  await browser.evaluate('document.querySelector("#rg-interactions-pause").click()');
  assert.equal(await browser.evaluate('getComputedStyle(document.querySelector("#rg-interactions-motion")).animationName'),'none');
  await browser.evaluate('document.querySelector(".rg-activities .start").focus()');
  assert.equal(await browser.evaluate('document.activeElement.matches(":focus-visible")'),true);
  assert.notEqual(await browser.evaluate('getComputedStyle(document.activeElement).outlineStyle'),'none');
  await browser.command('Page.bringToFront');
  await browser.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',windowsVirtualKeyCode:13});
  await browser.command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await until(()=>browser.evaluate('document.querySelector(".pomo-timer").textContent!=="25:00"'));
  await browser.evaluate('[...document.querySelectorAll(".rg-activities button")].find(e=>e.textContent==="PAUSE").click()');
  const paused=await browser.evaluate('document.querySelector(".pomo-timer").textContent'); await delay(1100);
  assert.equal(await browser.evaluate('document.querySelector(".pomo-timer").textContent'),paused);
  await capture('interactions-pomodoro-320');
  await browser.evaluate('[...document.querySelectorAll(".rg-activities button")].find(e=>e.textContent==="RESET").click()');
  assert.equal(await browser.evaluate('document.querySelector(".pomo-timer").textContent'),'25:00');
  await browser.command('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await browser.evaluate('document.querySelector("#rg-interactions-pause").click(); document.querySelector("#rg-interactions-pet").click()');
  assert.equal(await browser.evaluate('getComputedStyle(document.querySelector("#rg-interactions-motion")).animationName'),'none');
  await browser.evaluate('dispatchEvent(new PageTransitionEvent("pagehide"))');
  assert.equal(await browser.evaluate('document.querySelector(".rg-activities")===null && document.querySelector("#rg-interactions-pet")===null && document.querySelector("#web-sprite").parentNode.id==="web-sprite-container"'),true);
  await browser.evaluate('dispatchEvent(new PageTransitionEvent("pageshow"))');
  assert.equal(await browser.evaluate('document.querySelectorAll(".rg-activities").length'),1);
  assert.equal(await browser.evaluate('document.querySelector("#rg-interactions-pet").dataset.color'),'cyan');
  assert.equal(await browser.evaluate('typeof electronAPI'),'undefined');
  if(evidence) fs.writeFileSync(path.join(evidence,'browser-checks.json'),JSON.stringify({scope:'Synthetic loopback production server + served HTML in isolated Brave; not live inventory or real-phone acceptance',posts,records,passed:true},null,2),{mode:0o600});
});
