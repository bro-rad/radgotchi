'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
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

test('real browser integrated cues schedule native audible graphs only after opt-in', {timeout:60000}, async t=>{
  const browser=await chromium(t); if(!browser)return;
  const scripts=['companion-audio.js','companion-interactions.js','companion-activities.js','companion-audio-bootstrap.js'];
  const html='<div id="companion-audio"></div><div id="web-sprite-container"><img id="web-sprite"></div><div id="companion-activities"></div>'+scripts.map(s=>`<script defer src="/${s}"></script>`).join('');
  const server=http.createServer((req,res)=>{
    res.setHeader('Content-Type',req.url==='/'?'text/html':'text/javascript');
    if(req.url==='/')return res.end(html);
    if(scripts.includes(req.url.slice(1)))return res.end(fs.readFileSync(path.join(__dirname,'../src/web',req.url.slice(1))));
    res.statusCode=404;res.end();
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>{server.closeAllConnections();server.close();});
  await browser.command('Page.enable');
  await browser.command('Page.addScriptToEvaluateOnNewDocument',{source:`
    globalThis.contexts=[];globalThis.tones=[];globalThis.links=[];
    const Native=AudioContext;
    const connect=AudioNode.prototype.connect;
    AudioNode.prototype.connect=function(to,...args){links.push([this,to]);return connect.call(this,to,...args);};
    globalThis.AudioContext=class extends Native {
      constructor(){super();contexts.push(this);}
      createOscillator(){const osc=super.createOscillator();let frequency;const set=osc.frequency.setValueAtTime.bind(osc.frequency);osc.frequency.setValueAtTime=(value,time)=>{frequency=value;return set(value,time);};const start=osc.start.bind(osc);osc.start=(time)=>{tones.push({osc,time,frequency});return start(time);};return osc;}
    };
  `});
  await browser.command('Page.navigate',{url:`http://127.0.0.1:${server.address().port}/`});
  await until(()=>browser.evaluate('!!globalThis.RadgotchiAudioBootstrap'));
  await browser.evaluate('globalThis.interactions=RadgotchiInteractions.init(document);globalThis.activities=RadgotchiActivities.init(document)');
  const press=async selector=>{
    await browser.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);
    await browser.command('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',windowsVirtualKeyCode:13});
    await browser.command('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  };
  await press('#rg-interactions-pet');
  await browser.evaluate('document.querySelector("#rg-audio-toggle").click()');
  assert.equal(await browser.evaluate('contexts.length'),0);
  await press('#rg-audio-toggle');
  await until(()=>browser.evaluate('contexts[0]?.state==="running"'));
  assert.equal(await browser.evaluate('tones.length'),0,'enable does not play a cue');
  await press('#rg-interactions-pet');
  assert.deepEqual(await browser.evaluate('tones.map(t=>t.frequency)'),[220,440]);
  assert.equal(await browser.evaluate(`tones.every(({osc,time})=>Number.isFinite(time)&&links.some(([a,b])=>a===osc&&links.some(([c,d])=>c===b&&links.some(([e,f])=>e===d&&d.gain.value>0&&f===contexts[0].destination))))`),true,'native oscillators connect through envelopes and positive master gain to destination');
  await delay(150);
  // Listbox rendering avoids the OS-native popup in headless Chromium.
  await browser.evaluate('document.querySelector("#rg-interactions-color").size=6; document.querySelector("#rg-interactions-color").focus()');
  await browser.command('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
  await browser.command('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowDown',code:'ArrowDown',windowsVirtualKeyCode:40});
  await press('#rg-interactions-color');
  assert.deepEqual(await browser.evaluate('({tones:tones.length,value:document.querySelector("#rg-interactions-color").value,hidden:document.hidden,state:contexts[0].state})'),{tones:4,value:'red',hidden:false,state:'running'});
  assert.deepEqual(await browser.evaluate('tones.slice(2).map(t=>t.frequency)'),[440,660]);
  await delay(150);
  // Hook contract fixture: real activity emitter integration is separately owned.
  await browser.evaluate('document.dispatchEvent(new CustomEvent("radgotchi:pomodoro-start"))');
  assert.deepEqual(await browser.evaluate('tones.slice(4).map(t=>t.frequency)'),[440,550,660]);
  await delay(550);
  await browser.evaluate('document.dispatchEvent(new CustomEvent("radgotchi:pomodoro-complete"))');
  assert.deepEqual(await browser.evaluate('tones.slice(7).map(t=>t.frequency)'),[880,1100,880,1100]);
  await browser.evaluate('dispatchEvent(new PageTransitionEvent("pagehide",{persisted:true}))');
  await until(()=>browser.evaluate('contexts[0].state==="closed"'));
  await browser.evaluate('dispatchEvent(new PageTransitionEvent("pageshow",{persisted:true})); RadgotchiAudioBootstrap.start()');
  assert.equal(await browser.evaluate('document.querySelectorAll("#rg-audio-toggle").length'),1);
  await press('#rg-interactions-pet');
  assert.equal(await browser.evaluate('tones.length'),11,'bfcache restoration requires fresh enable');
  assert.equal(await browser.evaluate('contexts.length'),1);
});
const source = path.join(__dirname, '../src/web/companion-audio-bootstrap.js');
function fixture(host = true) {
  const listeners = new Map(), calls = [], mount = {};
  const document = {hidden:false, getElementById: id => host && id === 'companion-audio' ? mount : null};
  function add(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); }
  function remove(type, fn) { listeners.get(type)?.delete(fn); }
  document.addEventListener = add; document.removeEventListener = remove;
  const sandbox = {document, addEventListener:add, removeEventListener:remove,
    RadgotchiAudio:{init(doc, storage) { calls.push('init'); assert.equal(storage, undefined); return {play:name=>calls.push(name),destroy:()=>calls.push('destroy')}; }}};
  Object.defineProperty(sandbox,'localStorage',{get(){throw Error('denied');}});
  const load = () => vm.runInNewContext(fs.existsSync(source) ? fs.readFileSync(source,'utf8') : '',sandbox);
  const fire = (type, event={}) => {for(const fn of [...(listeners.get(type)||[])]) fn(event);};
  load(); return {calls,load,fire,listeners,document};
}
test('only trusted scoped interactions and actual timer hooks select cues',()=>{
  const f=fixture();
  const target={disabled:false,closest:s=>s.includes('#rg-interactions-pet') ? target : null};
  f.fire('click',{target,isTrusted:false});
  f.fire('click',{target,isTrusted:true,defaultPrevented:true});
  assert.deepEqual(f.calls,['init']);
  f.fire('click',{target,isTrusted:true});
  const select={disabled:false,matches:()=>true};
  f.fire('change',{target:select,isTrusted:true});
  f.fire('radgotchi:pomodoro-start'); f.fire('radgotchi:pomodoro-complete');
  assert.deepEqual(f.calls,['init','click','selectChange','pomodoroStart','pomodoroComplete']);
  f.fire('pagehide'); f.fire('radgotchi:pomodoro-complete');
  assert.equal(f.calls.at(-1),'destroy');
});
test('explicit asset mounts once, guards storage and safely remounts muted audio across page lifecycle',()=>{
  const f=fixture(); assert.deepEqual(f.calls,['init']); f.load(); f.fire('pageshow');
  assert.deepEqual(f.calls,['init']); f.fire('pagehide'); f.fire('pagehide');
  assert.deepEqual(f.calls,['init','destroy']); f.fire('pageshow');
  assert.deepEqual(f.calls,['init','destroy','init']);
  assert.equal(f.listeners.get('click').size,1);
  assert.deepEqual(fixture(false).calls,[]);
});
