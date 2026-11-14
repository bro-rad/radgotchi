/* Same-origin owner API adapter. Never simulate outcomes or persist browser XP. */
(function () {
 'use strict';
 function create() {
  let revision, pending, queue=Promise.resolve();
  function project(body) {
   const v=body.view;
   if(!v || !Number.isSafeInteger(v.revision) || !v.pet || !v.game)throw new Error('invalid-view');
   revision=v.revision;
   const stats=v.game.stats,r=body.result;
   const hand=v.game.activeBlackjack || (r?.state==='complete'?r:null);
   return {success:true,state:{xp:v.pet.totalXp,level:v.pet.level,rank:v.pet.rank,inventory:v.game.inventory,
    gameStats:{wins:stats.coinflipWins+stats.blackjackWins,losses:stats.coinflipLosses+stats.blackjackLosses,profit:stats.coinflipProfit+stats.blackjackProfit},
    coinflip:typeof r?.won==='boolean'?r:null,
    blackjack:hand?{...hand,handId:'owner-hand',dealerShowing:hand.dealerShowing ?? hand.dealerValue,canDouble:hand.canDouble ?? false}:null}};
  }
  async function read() {
   const response=await fetch('/api/companion/state',{credentials:'same-origin',cache:'no-store',redirect:'error'});
   if(!response.ok)throw new Error('unavailable');return project(await response.json());
  }
  async function commit() {
   const response=await fetch('/api/companion/action',{method:'POST',credentials:'same-origin',cache:'no-store',redirect:'error',headers:{'Content-Type':'application/json'},body:JSON.stringify(pending)});
   // A definitive refusal did not commit. An ambiguous server/network failure retains
   // the exact ID + revision for reconciliation, never creates a second wager.
   if(!response.ok){
    if(response.status<500)pending=undefined;
    if([400,409,429].includes(response.status))return {...await read(),reason:response.status===429?'WAIT / TRY AGAIN':response.status===409?'STATE UPDATED / TRY AGAIN':'ACTION REFUSED'};
    throw new Error('unavailable');
   }
   const body=await response.json();const result=project(body);pending=undefined;return result;
  }
  async function request(action,payload={}) {
   if(action==='state'){if(pending)await commit();return read();}
   if(pending || !Number.isSafeInteger(revision))throw new Error('refresh-required');
   pending={id:payload.idempotencyKey,revision,action:action==='blackjack-deal'?'blackjack-start':action};
   for(const key of ['bet','choice','item'])if(Object.hasOwn(payload,key))pending[key]=payload[key];
   return commit();
  }
  return {request(action,payload){const next=queue.then(()=>request(action,payload));queue=next.catch(()=>{});return next;}};
 }
 globalThis.RadgotchiCompanionTransport=Object.freeze({create});
}());
