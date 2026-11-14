'use strict';
const {test}=require('node:test'); const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomBytes}=require('node:crypto');
const {createMonitoringServer}=require('../src/main/monitoring-server');
let port=19670;
async function fixture(t) {
 const directory=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'rg-api-'));let now=10000;
 const token=randomBytes(32).toString('hex'),origin=`http://127.0.0.1:${++port}`;
 const server=createMonitoringServer({token,origin,companionDirectory:directory,companionClock:()=>now,companionRng:()=>0.1});
 await new Promise(r=>server.listen(port,'127.0.0.1',r));
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(directory,{recursive:true,force:true});});
 async function login(){const r=await fetch(origin+'/login',{method:'POST',redirect:'manual',headers:{Origin:origin,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token})});return r.headers.get('set-cookie').split(';')[0];}
 const cookie=await login();
 const request=(route,body,headers={})=>fetch(origin+route,{method:body===undefined?'GET':'POST',headers:{Origin:origin,Cookie:cookie,'Content-Type':'application/json',...headers},...(body===undefined?{}:{body:typeof body==='string'?body:JSON.stringify(body)})});
 return {request,login,directory,tick:()=>now+=3000};
}
test('real API: shared owner, earned progression, retry, concurrency, games and shop',async t=>{
 const f=await fixture(t); let r=await f.request('/api/companion/state'); assert.equal(r.status,200); let state=(await r.json()).view;
 assert.equal(state.pet.totalXp,0);assert.equal(state.receipts,undefined);
 let id=0; const action=async(action,extra={})=>{const c={id:'cmd'+(++id),revision:state.revision,action,...extra};const r=await f.request('/api/companion/action',c);assert.equal(r.status,200,JSON.stringify(await r.clone().json()));const b=await r.json();state=b.view;return {c,b};};
 const {c}=await action('click');
 const retries=await Promise.all([f.request('/api/companion/action',c),f.request('/api/companion/action',c)]);
 for(const r of retries){assert.equal(r.status,200);assert.equal((await r.json()).replayed,true);}
 const other=await f.login(); assert.equal((await (await f.request('/api/companion/state',undefined,{Cookie:other})).json()).view.pet.totalXp,2);
 f.tick();const competing=await Promise.all(['a','b'].map(id=>f.request('/api/companion/action',{id,revision:state.revision,action:'click'})));
 assert.deepEqual(competing.map(r=>r.status).sort(),[200,409]);state=(await (await f.request('/api/companion/state')).json()).view;
 for(let n=0;n<40;n++){f.tick();await action('click');}
 const flip=await action('coinflip',{bet:5,choice:'heads'});assert.equal(flip.b.result.won,true);
 const deal=await action('blackjack-start',{bet:10});assert.equal(JSON.stringify(deal.b).includes('deck'),false);assert.equal(JSON.stringify(deal.b).includes('dealerHand'),false);
 if(state.game.activeBlackjack)await action('blackjack-stand');
 await action('buy-item',{item:'ration-pack'});assert.equal(state.game.inventory['ration-pack'],1);
 await action('use-item',{item:'ration-pack'});assert.equal(state.game.inventory['ration-pack'],undefined);
});
for(const item of ['energy-cell','stim-shot','full-restore'])test(`API shop earns, buys and uses ${item}`,async t=>{
 const f=await fixture(t);let revision=0;
 const action=async(action,extra={})=>{const r=await f.request('/api/companion/action',{id:'shop'+revision,revision,action,...extra});assert.equal(r.status,200);const body=await r.json();revision=body.view.revision;return body;};
 for(let i=0;i<80;i++){f.tick();await action('click');}
 assert.equal((await action('buy-item',{item})).view.game.inventory[item],1);
 assert.equal((await action('use-item',{item})).view.game.inventory[item],undefined);
});
test('API refuses unauthenticated, cross-origin, malformed and oversized mutations',async t=>{
 const {request,directory}=await fixture(t);
 assert.equal((await request('/api/companion/state',undefined,{Cookie:''})).status,401);
 assert.equal((await request('/api/companion/action',{}, {Origin:'https://evil.invalid'})).status,403);
 assert.equal((await request('/api/companion/action',{}, {Origin:''})).status,403);
 assert.equal((await request('/api/companion/action','x')).status,400);
 assert.equal((await request('/api/companion/action','x'.repeat(2049))).status,413);
 assert.equal((await request('/api/companion/action',{id:'bad',revision:0,action:'click',totalXp:900})).status,400);
 assert.equal((await request('/api/companion/action',{id:'bad',revision:0,action:'blackjack-start',bet:10})).status,400);
 assert.equal((await request('/api/companion/action',{}, {'Content-Type':'text/plain'})).status,415);
 assert.equal((await request('/api/companion/state',{})).status,405);
 assert.equal((await request('/api/companion/state?x=1')).status,400);
 for(let i=0;i<120;i++)await request('/api/companion/action',{});
 assert.equal((await request('/api/companion/action',{})).status,429);
 fs.writeFileSync(path.join(directory,'owner.json'),'broken');
 assert.equal((await request('/api/companion/state')).status,503);
 assert.equal(fs.readFileSync(path.join(directory,'owner.json'),'utf8'),'broken');
});
