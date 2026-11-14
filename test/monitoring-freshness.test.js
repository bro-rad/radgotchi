'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function harness() {
  let now = Date.parse('2026-11-13T12:00:00Z'), next = 0;
  const timers = new Map(), requests = [];
  class Element {
    constructor() {this.children=[]; this.textContent='';}
    append(...children) {this.children.push(...children);}
    replaceChildren(...children) {this.children=children;}
  }
  const elements = Object.fromEntries(['feed-selection','web-sprite','source-status','freshness','package-list','request-status','login-link','reported-rows','package-count'].map(id=>[id,new Element()]));
  const context = {document:{getElementById:id=>elements[id],createElement:()=>new Element()}, AbortController,
    Date:class extends Date {static now(){return now;}},
    setTimeout:(fn,delay)=>{timers.set(++next,{fn,at:now+delay});return next;}, clearTimeout:id=>timers.delete(id),
    fetch:(_url,options)=>new Promise((resolve,reject)=>requests.push({resolve,reject,signal:options.signal}))};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/web/monitoring-panel.js'),'utf8'),context);
  const data = (extra={}) => ({sourceStatus:'connected',observedAt:new Date(now).toISOString(),lastSuccessAt:new Date(now).toISOString(),coverage:'package-status-only',containerIdentityAvailable:false,reportedRows:1,packages:[{name:'synthetic',versions:['1'],reportedRows:1,states:{running:1}}],...extra});
  async function advance(ms) {
    const end=now+ms;
    while (true) {
      const due=[...timers].filter(([,v])=>v.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];
      if (!due) break;
      now=due[1].at; timers.delete(due[0]); due[1].fn();
      await new Promise(setImmediate);
    }
    now=end;
  }
  const respond=(index,payload=data())=>requests[index].resolve({ok:true,json:async()=>payload});
  const button=()=>elements['package-list'].children[0].children[0].children[0].children[0];
  return {panel:context.RadgotchiMonitoring,elements,timers,requests,data,advance,respond,button};
}
test('stop clears pending request and freshness timers; restart rejects queued old callbacks', async () => {
  const h=harness(), first=h.panel.start(); h.respond(0); await first;
  const callbacks=[...h.timers.values()].map(timer=>timer.fn);
  await h.advance(30000);
  h.panel.stop();
  assert.equal(h.timers.size,0, 'all timers cleaned even when fetch ignores abort');
  await h.advance(60000);
  const restart=h.panel.start();
  assert.match(h.elements['web-sprite'].src,/LONELY/, 'restart does not relabel old observations live');
  h.respond(2); await restart;
  for (const callback of callbacks) callback();
  assert.equal(h.requests.length,3, 'queued old poll cannot create a request');
  assert.match(h.elements['web-sprite'].src,/AWAKE/);
  h.respond(1,h.data({sourceStatus:'stale'})); await new Promise(setImmediate);
  assert.match(h.elements['web-sprite'].src,/AWAKE/);
  h.panel.stop(); assert.equal(h.timers.size,0);
});

test('authentication and fetch failures cannot be overwritten by an old age deadline', async () => {
  for (const outcome of ['unauthorized','error']) {
    const h=harness(), started=h.panel.start(); h.respond(0); await started;
    await h.advance(30000);
    if (outcome === 'unauthorized') h.requests[1].resolve({status:401});
    else h.requests[1].reject(new Error('synthetic'));
    await new Promise(setImmediate);
    await h.advance(60000);
    assert.match(h.elements['web-sprite'].src,outcome === 'unauthorized' ? /ANGRY/ : /BROKEN/);
    h.panel.stop(); assert.equal(h.timers.size,0);
  }
});

test('connected responses with old or missing evidence are immediately stale', async () => {
  for (const fields of [{lastSuccessAt:'2026-11-13T11:58:30Z'}, {observedAt:'2026-11-13T11:58:30Z'}, {lastSuccessAt:null}, {observedAt:null}]) {
    const h=harness(), started=h.panel.start(); h.respond(0,h.data(fields)); await started;
    assert.match(h.elements['web-sprite'].src,/LONELY/);
    h.panel.stop(); assert.equal(h.timers.size,0);
  }
});

test('age deadline overrides selected expression during a hung fetch and recovers without data loss', async () => {
  const h=harness(), started=h.panel.start(); h.respond(0); await started;
  h.button().onclick(); assert.match(h.elements['web-sprite'].src,/MOTIVATED/);
  const list=h.elements['package-list'].children, stamp=h.elements.freshness.textContent;
  await h.advance(89999);
  assert.equal(h.requests.length,2);
  assert.match(h.elements['web-sprite'].src,/MOTIVATED/);
  await h.advance(1);
  assert.match(h.elements['web-sprite'].src,/LONELY/);
  assert.equal(h.elements['source-status'].textContent,'Source: stale');
  assert.match(h.elements['request-status'].textContent,/stale/i);
  assert.equal(h.elements['package-list'].children,list);
  assert.equal(h.elements.freshness.textContent,stamp);
  h.button().onclick(); assert.match(h.elements['web-sprite'].src,/LONELY/);
  h.respond(1); await new Promise(setImmediate);
  assert.match(h.elements['web-sprite'].src,/MOTIVATED/);
  assert.equal(h.elements['source-status'].textContent,'Source: connected');
  h.panel.stop(); assert.equal(h.timers.size,0);
});
