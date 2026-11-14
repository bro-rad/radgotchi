'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const http=require('node:http');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..');
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

test('real browser preserves upstream terminal and glowing sprite on desktop and phone',async t=>{
 const browser=await chromium(t); if(!browser) return;
 const original=fs.readFileSync(path.join(root,'chat.html'),'utf8').replace(/<script[^>]*>[\s\S]*?<\/script>/g,'').replace('<body>','<body data-web-mode="true">').replace('class="boot-overlay"','class="boot-overlay" hidden');
 const requests=[];
 const server=http.createServer((req,res)=>{
  requests.push(req.url);
  if(req.url==='/original') {res.setHeader('Content-Type','text/html');return res.end(original);}
  if(req.url==='/api/monitoring/package-status') {res.statusCode=401;return res.end('{}');}
  const file=path.join(root,req.url==='/'?'monitoring.html':req.url);
  if(!fs.existsSync(file)) {res.statusCode=404;return res.end();}
  res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.js')?'text/javascript':file.endsWith('.png')?'image/png':'text/html');res.end(fs.readFileSync(file));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>{server.closeAllConnections();server.close();});
 const origin=`http://127.0.0.1:${server.address().port}`;
 const ready=async()=>{for(let i=0;i<100;i++){if(await browser.evaluate('document.readyState === "complete" && !!document.querySelector(".terminal-container")'))return;await new Promise(r=>setTimeout(r,30));}throw Error('terminal missing');};
 const styles=`(() => {const pick=(s,props)=>{const e=document.querySelector(s);if(!e)return null;const c=getComputedStyle(e);return Object.fromEntries(props.map(p=>[p,c[p]]));};return {header:pick('.terminal-header',['backgroundImage','borderBottomColor','padding']),title:pick('.terminal-title',['fontFamily','fontSize','color','textShadow']),sprite:pick('.web-sprite-container img',['filter','transform','height','imageRendering']),viewport:pick('.web-sprite-container',['backgroundImage']),scanlines: getComputedStyle(document.body,'::before').backgroundImage};})()`;
 for(const width of [1280,390]) {
  await browser.command('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:false});
  await browser.command('Page.navigate',{url:origin+'/original'});await ready();
  const baseline=await browser.evaluate(styles);
  await browser.command('Page.navigate',{url:origin+'/'});await ready();
  assert.deepEqual(await browser.evaluate(styles),baseline,'computed original visual components');
  assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'),true);
  assert.equal(await browser.evaluate('document.querySelector("#web-sprite").naturalWidth > 0'),true);
  await browser.evaluate(`RadgotchiMonitoring.stop(); RadgotchiMonitoring.render({sourceStatus:'stale',observedAt:'2026-11-13T12:00:00Z',lastSuccessAt:'2026-11-13T12:00:00Z',coverage:'package-status-only',containerIdentityAvailable:false,reportedRows:2,packages:[{name:'synthetic-package.dnp.dappnode.eth',versions:['1.0'],reportedRows:2,states:{running:1,unknown:1}}]});`);
  assert.equal(await browser.evaluate('document.querySelectorAll("#package-list .network-node").length'),1);
  assert.match(await browser.evaluate('document.querySelector("#package-list").innerText'),/unknown: 1/);
  assert.match(await browser.evaluate('document.querySelector("#request-status").innerText'),/stale/i);
  assert.equal(await browser.evaluate('!!document.querySelector("input:not(.game-bet-input):not(#rg-audio-volume), #mesh-chat, #equalizer, #xp-fill")'),false);
  await new Promise(r=>setTimeout(r,350)); // upstream node-appear animation
  const bounds=await browser.evaluate('(() => {const r=document.querySelector("#package-list .network-node").getBoundingClientRect();return {left:r.left,right:r.right,bottom:r.bottom};})()');
  assert.ok(bounds.left>=0 && bounds.right<=width && bounds.bottom<=800);
  if (process.env.RADGOTCHI_UI_SCREENSHOTS) {
    fs.mkdirSync(process.env.RADGOTCHI_UI_SCREENSHOTS,{recursive:true});
    const shot=await browser.command('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(process.env.RADGOTCHI_UI_SCREENSHOTS,`monitoring-${width}.png`),Buffer.from(shot.data,'base64'));
  }
 }
 assert.ok(requests.includes('/src/styles/chat-window.css'));
 assert.ok(!requests.some(p=>/web-bridge|api\/invoke|\/ws|src\/chat/.test(p)));
});
