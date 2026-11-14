'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {summarizePublicPackages}=require('../src/main/dappnode-public-packages');
test('rejects malformed or oversized input and unsafe dynamic keys',()=>{
 for (const rows of [null, {}, [null], [{}], [{name:'x',version:'1',state:'__proto__'}], [{name:'x',version:'1',state:'constructor'}], [{name:'x'.repeat(257),version:'1',state:'running'}], Array(4097).fill({name:'x',version:'1',state:'running'})]) {
  assert.throws(()=>summarizePublicPackages(rows), /invalid_public_inventory/);
 }
});
test('empty inventory is explicit, versions remain distinct and unknown state is not healthy',()=>{
 assert.deepEqual(summarizePublicPackages([]).packages,[]);
 const r=summarizePublicPackages([{name:'x',version:'2',state:'unknown'},{name:'x',version:'1',state:'running'}]);
 assert.deepEqual(r.packages[0].versions,['1','2']);
 assert.equal(r.packages[0].states.unknown,1);
 assert.equal('health' in r.packages[0],false);
});
test('public inventory groups rows without inventing container identities or leaking IPs',()=>{
 const result=summarizePublicPackages([
  {name:'game.public.dappnode.eth',version:'1.0.0',state:'running',ip:'private-address'},
  {name:'game.public.dappnode.eth',version:'1.0.0',state:'exited',ip:'private-address-2'}
 ]);
 assert.deepEqual(result,{coverage:'package-status-only',containerIdentityAvailable:false,reportedRows:2,packages:[{name:'game.public.dappnode.eth',versions:['1.0.0'],reportedRows:2,states:{running:1,exited:1}}]});
 assert.equal(JSON.stringify(result).includes('private-address'),false);
});
