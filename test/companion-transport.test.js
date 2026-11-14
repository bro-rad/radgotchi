'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const core=require('../src/main/companion-game-core');
test('browser transport maps actual core views, serializes, retries identical uncertain command',async()=>{
 const source=fs.readFileSync(require('node:path').join(__dirname,'../src/web/companion-transport.js'),'utf8');
 let state=core.createState({ownerId:'owner',profileId:'companion'},{clock:()=>10000});const commands=[];let lost=true;
 const context={fetch:async(url,options)=>{if(url.endsWith('/state'))return {ok:true,json:async()=>({view:core.view(state)})};const command=JSON.parse(options.body);commands.push(command);const next=core.transition(state,{ownerId:'owner',profileId:'companion'},command,{clock:()=>10000,rng:()=>0.1});state=next.state;if(lost){lost=false;throw Error('lost reply');}return {ok:true,json:async()=>({view:core.view(state),result:next.result})};}};
 vm.runInNewContext(source,context);const transport=context.RadgotchiCompanionTransport.create();
 assert.equal((await transport.request('state')).state.xp,0);
 await assert.rejects(transport.request('click',{idempotencyKey:'same'}));
 assert.equal((await transport.request('state')).state.xp,2);
 assert.deepEqual(commands[0],commands[1]);assert.equal(state.revision,1);
 context.fetch=async(url)=>url.endsWith('/action')?{ok:false,status:429}:{ok:true,json:async()=>({view:core.view(state)})};
 const refused=await transport.request('click',{idempotencyKey:'fast'});
 assert.equal(refused.success,true);assert.equal(refused.state.xp,2);assert.equal(refused.reason,'WAIT / TRY AGAIN');
});
