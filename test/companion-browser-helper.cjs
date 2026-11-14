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
module.exports={chromium,until,delay};
