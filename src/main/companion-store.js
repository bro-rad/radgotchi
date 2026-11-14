'use strict';
// One configured token represents ONE owner, not one player per login session.
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const core=require('./companion-game-core');
const ID=Object.freeze({ownerId:'owner',profileId:'companion'});
const MAX_BYTES=131072;
function noLinks(file) {
 let current=path.parse(file).root;
 for(const part of file.slice(current.length).split(path.sep).filter(Boolean)) {
  current=path.join(current,part);
  try { if(fs.lstatSync(current).isSymbolicLink()) throw new Error('store-symlink'); }
  catch(e) { if(e.code!=='ENOENT') throw e; }
 }
}
function processIdentity(pid) {
 try {
  if(process.platform==='linux') {
   const stat=fs.readFileSync(`/proc/${pid}/stat`,'utf8').split(') ')[1].split(' ');
   return fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim()+':'+stat[19];
  }
  return require('node:child_process').execFileSync('ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim() || null;
 } catch { return null; }
}
function createCompanionStore({directory,clock=Date.now,rng=()=>crypto.randomInt(0,0x100000000)/0x100000000}) {
 if(!path.isAbsolute(directory)) throw new Error('store-path');
 noLinks(directory); fs.mkdirSync(directory,{recursive:true,mode:0o700});
 if(!fs.statSync(directory).isDirectory() || fs.statSync(directory).uid!==process.getuid()) throw new Error('store-owner');
 fs.chmodSync(directory,0o700);
 const file=path.join(directory,'owner.json'), lock=path.join(directory,'writer.lock'), marker=path.join(directory,'initialized');
 noLinks(marker);
 noLinks(file); noLinks(lock);
 // Serialize startup/reclamation as well as writes. A crash while acquiring the
 // lease leaves this gate in place for explicit operator recovery (fail closed).
 const gate=path.join(directory,'startup.lock'); noLinks(gate);
 try {fs.mkdirSync(gate,{mode:0o700});} catch {throw new Error('store-writer');}
 const namespace=process.platform==='linux'?fs.readlinkSync('/proc/self/ns/pid'):'host';
 const lease=JSON.stringify({pid:process.pid,identity:processIdentity(process.pid),namespace});
 try {
 // Exclusive writer lease. A dead process lease is recoverable; an unknown lease fails closed.
 if(fs.existsSync(lock)) {
  let prior; try {prior=JSON.parse(fs.readFileSync(lock,'utf8'));} catch {throw new Error('store-writer');}
  if(!Number.isSafeInteger(prior.pid)||prior.pid<1||typeof prior.identity!=='string'||prior.namespace!==namespace) throw new Error('store-writer');
  const current=processIdentity(prior.pid);
  if(current===prior.identity) throw new Error('store-writer');
  if(current===null) {try {process.kill(prior.pid,0); throw new Error('store-writer');} catch(e) {if(e.code!=='ESRCH') throw e;}}
  fs.unlinkSync(lock);
 }
 const fd=fs.openSync(lock,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
 try {fs.writeFileSync(fd,lease); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
 } finally {fs.rmdirSync(gate);}
 let closed=false,failed=false,state;
 function close() { if(closed) return; closed=true; if(fs.readFileSync(lock,'utf8')===lease) fs.unlinkSync(lock); }
 function read() {
  noLinks(directory); noLinks(file);
  const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
   const stat=fs.fstatSync(fd);
   if(!stat.isFile()||stat.size>MAX_BYTES||stat.uid!==process.getuid()||(stat.mode&0o077)||stat.nlink!==1) throw new Error('store-file');
   const s=core.validateState(JSON.parse(fs.readFileSync(fd,'utf8')));
   if(s.ownerId!==ID.ownerId||s.profileId!==ID.profileId) throw new Error('store-owner');
   return s;
  } finally {fs.closeSync(fd);}
 }
 function write(s) {
  noLinks(directory); noLinks(file);
  const temp=path.join(directory,`.owner-${crypto.randomBytes(16).toString('hex')}`);
  let fd;
  try {
   fd=fs.openSync(temp,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
   const text=JSON.stringify(s); if(Buffer.byteLength(text)>MAX_BYTES) throw new Error('store-size');
   fs.writeFileSync(fd,text); fs.fsyncSync(fd); fs.closeSync(fd); fd=undefined;
   fs.renameSync(temp,file);
   const dir=fs.openSync(directory,fs.constants.O_RDONLY); try {fs.fsyncSync(dir);} finally {fs.closeSync(dir);}
  } catch(e) {failed=true; throw new Error('store-unavailable');}
  finally {if(fd!==undefined)fs.closeSync(fd); try{fs.unlinkSync(temp);}catch{}}
 }
 try {
  try {state=read();} catch(e) {
   if(e.code!=='ENOENT'||fs.existsSync(marker))throw e;
   // Record initialization before creating state: an interrupted first write fails
   // closed rather than silently treating a lost balance as a brand-new owner.
   const fd=fs.openSync(marker,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600);
   fs.writeFileSync(fd,'1');fs.fsyncSync(fd);fs.closeSync(fd);
   state=core.createState(ID,{clock});write(state);
  }
 } catch {close(); throw new Error('store-unavailable');}
 function check() {
  if(closed||failed)throw new Error('store-unavailable');
  try {const disk=read(); if(JSON.stringify(disk)!==JSON.stringify(state))throw new Error('store-changed');}
  catch {failed=true;throw new Error('store-unavailable');}
 }
 return {
  view(){check();return core.view(state);},
  action(command){check();const next=core.transition(state,ID,command,{clock,rng}); if(!next.replayed){write(next.state);state=next.state;}return {view:core.view(state),result:next.result,replayed:next.replayed};},
  close
 };
}
module.exports={createCompanionStore};
