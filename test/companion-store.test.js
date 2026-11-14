'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createCompanionStore}=require('../src/main/companion-store');
function fixture(t) { const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'rg-store-')); t.after(()=>fs.rmSync(dir,{recursive:true,force:true})); return path.join(dir,'companion'); }
test('owner store persists earned clicks, CAS and exact retry across restart without secrets',t=>{
 const directory=fixture(t); let now=10000;
 let store=createCompanionStore({directory,clock:()=>now});
 assert.equal(store.view().pet.totalXp,0);
 const command={id:'click1',revision:0,action:'click'};
 const result=store.action(command); assert.equal(result.view.pet.totalXp,2);
 assert.equal(result.view.receipts,undefined);
 assert.throws(()=>store.action({id:'other',revision:0,action:'click'}),/stale-revision/);
 assert.throws(()=>createCompanionStore({directory}),/writer/);
 store.close(); store=createCompanionStore({directory,clock:()=>now});
 assert.equal(store.view().pet.totalXp,2);
 assert.equal(store.action(command).replayed,true);
 assert.throws(()=>store.action({...command,action:'blackjack-hit'}),/idempotency-conflict/);
 assert.throws(()=>store.action({id:'fast',revision:1,action:'click'}),/cooldown/);
 now+=3000; assert.equal(store.action({id:'click2',revision:1,action:'click'}).view.pet.totalXp,4);
 store.close(); assert.equal(fs.statSync(path.join(directory,'owner.json')).mode & 0o777,0o600);
 assert.equal(fs.statSync(directory).mode & 0o777,0o700);
});
test('crashed writer is reclaimed without losing earned state',async t=>{
 const directory=fixture(t),{spawn}=require('node:child_process');
 const modulePath=require.resolve('../src/main/companion-store');
 const child=spawn(process.execPath,['-e',`const s=require(${JSON.stringify(modulePath)}).createCompanionStore({directory:process.argv[1]});s.action({id:'earned',revision:0,action:'click'});process.stdout.write('ready');setInterval(()=>{},1000);`,directory],{stdio:['ignore','pipe','pipe']});
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
 assert.throws(()=>createCompanionStore({directory}),/writer/);
 const exited=new Promise(r=>child.once('exit',r));child.kill('SIGKILL');await exited;
 const store=createCompanionStore({directory});assert.equal(store.view().pet.totalXp,2);store.close();
});
test('failed commit never acknowledges rewards or overwrites last durable snapshot',t=>{
 const directory=fixture(t);const store=createCompanionStore({directory});
 const file=path.join(directory,'owner.json'),before=fs.readFileSync(file,'utf8');
 t.mock.method(fs,'renameSync',()=>{throw new Error('disk failure');});
 assert.throws(()=>store.action({id:'failed',revision:0,action:'click'}),/store-unavailable/);
 assert.throws(()=>store.view(),/store-unavailable/);assert.equal(fs.readFileSync(file,'utf8'),before);
 t.mock.restoreAll();store.close();const reopened=createCompanionStore({directory});assert.equal(reopened.view().pet.totalXp,0);reopened.close();
});
test('active hand survives restart with hidden deck and a single settlement',t=>{
 const directory=fixture(t);let now=10000;let store=createCompanionStore({directory,clock:()=>now,rng:()=>0.1});
 for(let i=0;i<20;i++){now+=3000;store.action({id:'click'+i,revision:i,action:'click'});}
 const deal=store.action({id:'deal',revision:20,action:'blackjack-start',bet:10});
 assert.equal(deal.view.game.activeBlackjack.dealer[1],'??');store.close();
 store=createCompanionStore({directory,clock:()=>now,rng:()=>{throw new Error('must use stored deck');}});
 assert.deepEqual(store.view(),deal.view);
 const command={id:'settle',revision:21,action:'blackjack-stand'},settled=store.action(command);
 assert.equal(settled.view.game.activeBlackjack,null);assert.equal(store.action(command).replayed,true);store.close();
});
test('foreign namespace lease and interrupted startup gate refuse takeover',t=>{
 const directory=fixture(t);const store=createCompanionStore({directory});store.close();
 const lock=path.join(directory,'writer.lock');fs.writeFileSync(lock,JSON.stringify({pid:process.pid,identity:'other',namespace:'foreign'}),{mode:0o600});
 assert.throws(()=>createCompanionStore({directory}),/writer/);fs.unlinkSync(lock);
 fs.mkdirSync(path.join(directory,'startup.lock'),{mode:0o700});assert.throws(()=>createCompanionStore({directory}),/writer/);
});
test('missing previously initialized state fails closed on restart',t=>{
 const directory=fixture(t);const store=createCompanionStore({directory});store.close();
 fs.unlinkSync(path.join(directory,'owner.json'));
 assert.throws(()=>createCompanionStore({directory}),/store/);
 assert.equal(fs.existsSync(path.join(directory,'owner.json')),false);
});
test('corruption and symlinks fail closed without overwriting',t=>{
 const directory=fixture(t); const store=createCompanionStore({directory}); store.close();
 const file=path.join(directory,'owner.json'); fs.writeFileSync(file,'corrupt');
 assert.throws(()=>createCompanionStore({directory}),/store/); assert.equal(fs.readFileSync(file,'utf8'),'corrupt');
 fs.unlinkSync(file); fs.symlinkSync(path.join(directory,'missing'),file);
 assert.throws(()=>createCompanionStore({directory}),/store/); assert.ok(fs.lstatSync(file).isSymbolicLink());
});
