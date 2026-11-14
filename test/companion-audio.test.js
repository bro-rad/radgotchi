'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=path.join(__dirname,'../src/web/companion-audio.js');
function fixture(saved='0.5') {
  const nodes=[], contexts=[];
  class Element {
    constructor(){this.children=[];this.listeners={};this.attrs={};this.value='';}
    appendChild(e){this.children.push(e);return e;}
    remove(){this.removed=true;}
    setAttribute(k,v){this.attrs[k]=String(v);}
    addEventListener(k,f){this.listeners[k]=f;}
    removeEventListener(k){delete this.listeners[k];}
    async fire(k, trusted=true){await this.listeners[k]?.({isTrusted:trusted});}
  }
  function param(){return {value:0,setValueAtTime(v,t){this.value=v;this.time=t;},linearRampToValueAtTime(v){this.peak=v;},exponentialRampToValueAtTime(v){this.end=v;}};}
  class Context {
    constructor(){this.state='suspended';this.currentTime=10;this.destination={};contexts.push(this);}
    createGain(){const n={gain:param(),connect(){},disconnect(){this.disconnected=true;}};nodes.push(n);return n;}
    createOscillator(){const n={frequency:param(),connect(){},disconnect(){this.disconnected=true;},start(t){this.started=t;},stop(t){this.stopped=t;}};nodes.push(n);return n;}
    async resume(){this.state='running';}
    async suspend(){this.state='suspended';}
    async close(){this.state='closed';}
  }
  const root=new Element(), doc=new Element();
  doc.hidden=false;doc.defaultView={AudioContext:Context};doc.createElement=()=>new Element();doc.getElementById=id=>id==='companion-audio'?root:null;
  const storage={getItem:()=>saved,setItem(k,v){this[k]=v;}};
  const sandbox={};vm.runInNewContext(fs.existsSync(source)?fs.readFileSync(source,'utf8'):'',sandbox);
  assert.equal(typeof sandbox.RadgotchiAudio?.init,'function','explicit audio API exists');
  const api=sandbox.RadgotchiAudio.init(doc,storage);
  return {api,doc,root,contexts,nodes,storage,init:sandbox.RadgotchiAudio.init};
}
test('trusted opt-in plays original selectChange with bounded nodes and mute cleanup',async()=>{
  const f=fixture();const button=f.root.children[0];assert.ok(button,'opt-in button');
  await button.fire('click',false);assert.equal(f.contexts.length,0);
  await button.fire('click');assert.equal(f.contexts[0].state,'running');
  assert.equal(f.api.play('selectChange'),true);
  const tones=f.nodes.filter(n=>n.frequency);assert.deepEqual(tones.map(n=>n.frequency.value),[440,660]);
  assert.ok(tones.every(n=>n.stopped>n.started && n.stopped-n.started<=0.31));
  assert.equal(f.api.play('__proto__'),false);
  assert.equal(f.api.play('selectChange'),false,'no overlapping event floods');
  await button.fire('click');assert.equal(f.contexts[0].state,'suspended');
  assert.ok(tones.every(n=>n.disconnected));assert.equal(f.api.play('click'),false);
  await button.fire('click');assert.equal(f.contexts[0].state,'running');
  f.api.destroy();assert.equal(f.contexts[0].state,'closed');assert.equal(f.api.play('click'),false);
});
test('volume bounds, hidden lifecycle, natural cleanup and unavailable audio',async()=>{
  for (const saved of ['NaN','Infinity','-1','3','0.25']) {
    const f=fixture(saved); const [button,label]=f.root.children; const slider=label?.children[0];
    assert.ok(slider,'labeled volume slider'); await button.fire('click');
    assert.ok(f.nodes[0].gain.value>=0 && f.nodes[0].gain.value<=.5);
    slider.value='99';await slider.fire('input');assert.equal(f.nodes[0].gain.value,.5);
    assert.equal(f.api.play('click'),true);
    f.nodes.filter(n=>n.frequency).forEach(n=>n.onended());
    assert.equal(f.root.attrs['data-audio-active'],'false');
    f.doc.hidden=true;await f.doc.fire('visibilitychange');assert.equal(f.contexts[0].state,'suspended');
    f.doc.hidden=false;await f.doc.fire('visibilitychange');assert.equal(f.api.play('click'),false);
    slider.value='NaN';await slider.fire('input');assert.equal(slider.value,'0.5');f.api.destroy();
  }
  const f=fixture();f.doc.defaultView.AudioContext=undefined;await f.root.children[0].fire('click');assert.equal(f.api.play('click'),false);f.api.destroy();
});
test('all supported original scores are bounded and disconnect on completion',async()=>{
  const f=fixture();await f.root.children[0].fire('click');
  for (const name of ['selectChange','click','chatClose','sleepStart','sleepEnd','pomodoroStart','pomodoroComplete']) {
    f.contexts[0].currentTime+=1;
    assert.equal(f.api.play(name),true,name);
    const active=f.nodes.filter(n=>n.frequency && !n.disconnected);
    assert.ok(active.length<=4);
    for (const n of active) {
      assert.ok(n.frequency.value>=220 && n.frequency.value<=1100);
      assert.ok(n.stopped-n.started<=.301);
      assert.ok(n.stopped-f.contexts[0].currentTime<=.751); n.onended();
    }
  }
  f.api.destroy();
});
test('pending unlock cannot survive destroy',async()=>{
  const f=fixture();let release;
  f.doc.defaultView.AudioContext.prototype.resume=function(){return new Promise(r=>{release=()=>{this.state='running';r();};});};
  const pending=f.root.children[0].fire('click');f.api.destroy();release();await pending;
  assert.equal(f.api.play('click'),false);assert.equal(f.nodes[0].gain.value,0);
});
test('duplicate init is idempotent and remount without host or usable storage is silent',()=>{
  const f=fixture();assert.equal(f.init(f.doc,f.storage),f.api);assert.equal(f.root.children.length,2);
  f.api.destroy();f.doc.getElementById=()=>null;
  const api=f.init(f.doc,{getItem(){throw Error('denied');},setItem(){throw Error('denied');}});
  assert.equal(api.play('click'),false);api.destroy();assert.equal(f.contexts.length,0);
});
test('silent by default, even with persisted preferences',()=>{
  const f=fixture();assert.equal(f.contexts.length,0);assert.equal(f.api.play('click'),false);
  f.api.destroy();f.api.destroy();assert.equal(f.contexts.length,0);
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
test('real browser remains silent until trusted opt-in and cleans finite UI sounds', {timeout:60000}, async t=>{
  const browser=await chromium(t);if(!browser)return;
  const html='<div id="companion-audio"></div><script src="/audio.js"></script><script src="/init.js"></script>';
  const server=http.createServer((req,res)=>{
    res.setHeader('Content-Type',req.url==='/'?'text/html':'text/javascript');
    if(req.url==='/')return res.end(html);
    if(req.url==='/audio.js')return res.end(fs.readFileSync(source));
    if(req.url==='/init.js')return res.end(`globalThis.contexts=[];const Native=AudioContext;globalThis.AudioContext=class extends Native {constructor(){super();contexts.push(this);}};globalThis.fixture=RadgotchiAudio.init(document,localStorage);`);
    res.statusCode=404;res.end();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close();});
  await browser.command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});
  await until(()=>browser.evaluate('!!globalThis.fixture'));
  assert.equal(await browser.evaluate('contexts.length'),0);
  assert.equal(await browser.evaluate('fixture.play("click")'),false);
  await browser.evaluate('document.getElementById("rg-audio-toggle").click()');
  assert.equal(await browser.evaluate('contexts.length'),0,'synthetic click cannot unlock');
  await browser.evaluate('document.getElementById("rg-audio-toggle").focus()');
  await browser.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',windowsVirtualKeyCode:13});
  await browser.command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await until(()=>browser.evaluate('contexts[0]?.state === "running"'));
  assert.equal(await browser.evaluate('fixture.play("selectChange")'),true);
  await until(()=>browser.evaluate('document.getElementById("companion-audio").getAttribute("data-audio-active") === "false"'));
  await browser.evaluate('fixture.destroy()');
  await until(()=>browser.evaluate('contexts[0].state === "closed"'));
  assert.equal(await browser.evaluate('document.getElementById("companion-audio").children.length'),0);
});
