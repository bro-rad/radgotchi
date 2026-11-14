'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/main/companion-game-core');
const owner = { ownerId: 'owner-a', profileId: 'pet-a' };
const deps = { clock: () => 10000, rng: () => 0 };
function fresh(xp = 100) { const s = core.createState(owner, deps); s.pet.totalXp = xp; return s; }
function run(s, action, args = {}, options = deps) {
  return core.transition(s, owner, { id: `op-${s.revision}`, revision: s.revision, action, ...args }, options);
}
// Fixture RNG produces a specific valid Fisher-Yates permutation, not client cards.
function deal(values) {
  const deck = ['♠','♥','♦','♣'].flatMap(suit => ['A','2','3','4','5','6','7','8','9','10','J','Q','K'].map(value => ({suit,value})));
  const picks = values.map(value => deck.splice(deck.findIndex(c => c.value === value), 1)[0]);
  const target = [...deck, ...picks.reverse()];
  const original = ['♠','♥','♦','♣'].flatMap(suit => ['A','2','3','4','5','6','7','8','9','10','J','Q','K'].map(value => ({suit,value})));
  const random = [];
  for (let i = 51; i > 0; i--) {
    const j = original.findIndex(c => c.suit === target[i].suit && c.value === target[i].value);
    random.push((j + 0.1) / (i + 1));
    [original[i],original[j]] = [original[j],original[i]];
  }
  return { clock: deps.clock, rng: () => random.shift() };
}
test('blackjack original natural payout, push, soft-17 stand, double and bust', () => {
  const natural = run(fresh(), 'blackjack-start', {bet: 11}, deal(['A','K','9','8']));
  assert.equal(natural.result.outcome, 'blackjack');
  assert.equal(natural.result.payout, 27);
  assert.equal(natural.state.pet.totalXp, 116);
  assert.equal(run(fresh(), 'blackjack-start', {bet:10}, deal(['A','K','A','Q'])).result.outcome, 'push');
  const start = run(fresh(), 'blackjack-start', {bet:10}, deal(['10','8','A','6','K']));
  assert.deepEqual(start.result.dealer, ['A♠','??']);
  const stand = run(start.state, 'blackjack-stand');
  assert.equal(stand.result.outcome, 'win');
  assert.equal(stand.result.dealer.length, 2);
  const d = run(fresh(), 'blackjack-start', {bet:10}, deal(['5','6','10','7','10']));
  const doubled = run(d.state, 'blackjack-double');
  assert.equal(doubled.result.bet, 20);
  assert.equal(doubled.result.profit, 20);
  const b = run(fresh(), 'blackjack-start', {bet:10}, deal(['10','8','9','8','K']));
  assert.equal(run(b.state, 'blackjack-hit').result.outcome, 'bust');
});
test('strict commands, ownership, atomic failures, finite dependencies and limits', () => {
  const s = fresh();
  for (const bet of [-1, 0, 4, 501, 1.5, NaN, Infinity, '5']) assert.throws(() => run(s, 'coinflip', {bet,choice:'heads'}), /invalid-bet/);
  for (const args of [{xp:100}, {outcome:'win'}, {ownerId:'other'}]) assert.throws(() => run(s,'click',args), /invalid-command/);
  assert.throws(() => run(s,'coinflip',{bet:5,choice:'bad'}), /invalid-choice/);
  assert.throws(() => core.transition(s,{...owner,ownerId:'other'},{id:'x',revision:0,action:'click'},deps), /owner-mismatch/);
  for (const value of [NaN, Infinity, -1, 1]) assert.throws(() => run(s,'coinflip',{bet:5,choice:'heads'},{...deps,rng:()=>value}), /invalid-rng/);
  for (const value of [NaN, Infinity, -1, 9999]) assert.throws(() => run(s,'click',{}, {...deps,clock:()=>value}), /invalid-clock/);
  assert.throws(() => run(fresh(1000000000),'click'), /limit-exceeded/);
  assert.equal(s.pet.totalXp,100);
  const bad = fresh(); bad.pet.totalXp = NaN;
  assert.throws(() => run(bad,'click'), /invalid-state/);
});
test('idempotent retries, conflicting ids, stale revisions and bounded receipt eviction', () => {
  const s = fresh(1000), cmd = {id:'first',revision:0,action:'coinflip',bet:5,choice:'heads'};
  const a = core.transition(s,owner,cmd,deps);
  const retry = core.transition(a.state,owner,cmd,{clock:()=>{throw Error('clock called');},rng:()=>{throw Error('rng called');}});
  assert.deepEqual(retry.result,a.result);
  assert.deepEqual(retry.state,a.state);
  assert.equal(retry.replayed,true);
  assert.throws(() => core.transition(a.state,owner,{...cmd,choice:'tails'},deps), /idempotency-conflict/);
  let current = a.state;
  for (let i=0;i<70;i++) current=run(current,'coinflip',{bet:5,choice:'heads'}).state;
  assert.equal(current.receipts.length,64);
  assert.throws(() => core.transition(current,owner,cmd,deps), /stale-revision/);
  assert.equal(current.game.stats.coinflipWins,71);
});
test('blackjack hides deck, locks spending and prevents underfunded double', () => {
  const s=run(fresh(10),'blackjack-start',{bet:10},deal(['5','6','9','8','2'])).state;
  const v=core.view(s);
  assert.equal(v.game.activeBlackjack.deck,undefined);
  assert.deepEqual(v.game.activeBlackjack.dealer,['9♠','??']);
  assert.throws(() => run(s,'blackjack-start',{bet:10}), /game-in-progress/);
  assert.throws(() => run(s,'coinflip',{bet:5,choice:'heads'}), /game-in-progress/);
  assert.throws(() => run(s,'blackjack-double'), /insufficient-xp/);
  const hit=run(s,'blackjack-hit').state;
  assert.throws(() => run(hit,'blackjack-double'), /cannot-double/);
  assert.throws(() => run(fresh(),'blackjack-hit'), /no-game/);
  const exhausted=structuredClone(s); exhausted.game.activeBlackjack.deck=[];
  assert.throws(() => run(exhausted,'blackjack-hit'), /invalid-state|deck-exhausted/);
  const tooLong=structuredClone(s); tooLong.game.activeBlackjack.playerHand=Array(53).fill({suit:'♠',value:'A'});
  assert.throws(() => run(tooLong,'blackjack-hit'), /invalid-state/);
});
test('original shop prices and bounded inventory restore needs without minting XP', () => {
  let s=fresh(500); s.pet.hunger=10; s.pet.energy=15;
  const expected={'ration-pack':[50,60,15],'energy-cell':[50,10,65],'stim-shot':[40,35,40],'full-restore':[150,100,100]};
  for (const [item,[cost,hunger,energy]] of Object.entries(expected)) {
    const bought=run(s,'buy-item',{item});
    assert.equal(bought.state.pet.totalXp,500-cost);
    const used=run(bought.state,'use-item',{item});
    assert.equal(used.state.pet.hunger,hunger); assert.equal(used.state.pet.energy,energy);
    assert.throws(() => run(used.state,'use-item',{item}), /no-item/);
  }
  assert.throws(() => run(s,'buy-item',{item:'__proto__'}), /invalid-item/);
  assert.throws(() => run(fresh(0),'buy-item',{item:'ration-pack'}), /insufficient-xp/);
  s.game.inventory['ration-pack']=99;
  assert.throws(() => run(s,'buy-item',{item:'ration-pack'}), /inventory-full/);
  assert.equal(core.view(fresh(24000)).pet.rank,'DIRECTOR');
});
test('malformed payloads are rejected before serialization and settlement counters saturate', () => {
  const circular={}; circular.self=circular;
  assert.throws(() => run(fresh(),'coinflip',{bet:circular,choice:'heads'}), /invalid-bet/);
  assert.throws(() => run(fresh(),'coinflip',{bet:5,choice:circular}), /invalid-choice/);
  const s=fresh(); s.game.stats.totalWon=1000000000;
  assert.equal(run(s,'coinflip',{bet:5,choice:'heads'}).state.game.stats.totalWon,1000000000);
  const high=fresh(999999999);
  assert.throws(() => run(high,'blackjack-start',{bet:10}), /limit-exceeded/);
  const max=fresh(); max.revision=1000000000;
  assert.throws(() => run(max,'click'), /limit-exceeded/);
  assert.throws(() => core.createState({...owner,profileId:''},deps), /invalid-identity/);
  assert.throws(() => core.createState(owner,{clock:()=>Infinity}), /invalid-clock/);
});
test('differential compatibility with original arcade over seeded coinflip and blackjack rounds', () => {
  const vm=require('node:vm');
  const fs=require('node:fs');
  const source=fs.readFileSync(require.resolve('../src/main/arcade.js'),'utf8');
  function random(seed) { return () => { seed=(Math.imul(seed,1664525)+1013904223)>>>0; return seed/4294967296; }; }
  for (let seed=1;seed<=120;seed++) {
    let xp=1000;
    const box={module:{exports:{}},Math:Object.create(Math),require:()=>({broadcastToWindows(){},recordEvent(){}})};
    box.Math.random=random(seed);
    vm.runInNewContext(source,box);
    const original=box.module.exports;
    original.init({xpSystem:{getXpData:()=>({totalXp:xp}),addXp:n=>xp+=n,removeXp:n=>xp-=n},petNeeds:{},persistence:{loadArcadeDataFromDisk:()=>null,saveArcadeDataToDisk(){}},addActivityLogEntry(){}});
    const rng=random(seed), options={clock:deps.clock,rng};
    const coin=original.playCoinflip(11,'heads');
    let ours=run(fresh(1000),'coinflip',{bet:11,choice:'heads'},options);
    assert.deepEqual(ours.result,JSON.parse(JSON.stringify(coin)));
    let ref=original.startBlackjack(11);
    ours=run(ours.state,'blackjack-start',{bet:11},options);
    let steps=0;
    while (ref.state==='playing') {
      const action=steps===0 && seed%3===0 ? 'double' : steps===0 && seed%3===1 ? 'hit' : 'stand';
      ref=original[{double:'blackjackDouble',hit:'blackjackHit',stand:'blackjackStand'}[action]]();
      ours=run(ours.state,`blackjack-${action}`,{},options);
      assert.ok(++steps<23);
    }
    assert.deepEqual(ours.result,JSON.parse(JSON.stringify(ref)));
    assert.equal(ours.state.pet.totalXp,xp);
    assert.deepEqual(ours.state.game.stats,JSON.parse(JSON.stringify(original.getArcadeState().gameStats)));
  }
});
test('RNG exhaustion and invalid snapshots fail atomically; profiles cannot share actions', () => {
  const s=fresh(), before=structuredClone(s);
  let calls=0;
  assert.throws(() => run(s,'blackjack-start',{bet:10},{clock:deps.clock,rng:()=>++calls<12 ? 0.5 : undefined}), /invalid-rng/);
  assert.deepEqual(s,before);
  for (const n of [-1,NaN,Infinity,1000000001]) {
    const corrupt=fresh(); corrupt.pet.totalXp=n;
    assert.throws(() => core.validateState(corrupt), /invalid-state/);
  }
  const bad=fresh(); bad.receipts=Array(65).fill({});
  assert.throws(() => core.validateState(bad), /invalid-state/);
  assert.throws(() => core.transition(s,{...owner,profileId:'other'},{id:'p',revision:0,action:'click'},deps), /owner-mismatch/);
  const other=core.createState({...owner,ownerId:'other'},deps);
  run(s,'click');
  assert.equal(other.pet.totalXp,0);
  const clicked=run(s,'click').state;
  assert.equal(run(clicked,'click',{}, {...deps,clock:()=>13000}).state.pet.totalXp,104);
});
test('coinflip retains 5..500 bets, 1.8 gross payout and needs penalty', () => {
  const s = fresh();
  const a = run(s, 'coinflip', { bet: 5, choice: 'heads' });
  assert.equal(a.result.winnings, 9);
  assert.equal(a.result.profit, 4);
  assert.equal(a.state.pet.totalXp, 104);
  assert.equal(run(s, 'coinflip', { bet: 5, choice: 'tails' }).state.pet.totalXp, 95);
  s.pet.hunger = 19;
  assert.equal(run(s, 'coinflip', { bet: 5, choice: 'h' }).state.pet.totalXp, 102);
});
test('isolated versioned state starts at original zero XP and click earns two with cooldown', () => {
  const s = core.createState(owner, deps);
  assert.equal(s.version, 1);
  assert.equal(s.pet.totalXp, 0);
  const a = run(s, 'click');
  assert.equal(a.state.pet.totalXp, 2);
  assert.equal(s.pet.totalXp, 0);
  assert.throws(() => run(a.state, 'click'), /cooldown/);
  assert.equal(core.view(a.state).pet.level, 1);
  assert.equal(core.view(fresh(24000)).pet.level, 22);
  assert.equal(JSON.parse(JSON.stringify(a.state)).ownerId, owner.ownerId);
});
