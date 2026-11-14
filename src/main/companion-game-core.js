'use strict';
// Pure companion state machine. Original rule citations: docs/companion-game-contract.md.
const LEVELS = Object.freeze([0, 50, 150, 300, 500, 750, 1100, 1500, 2000, 2600,
  3300, 4100, 5000, 6000, 7200, 8500, 10000, 12000, 14500, 17500, 21000]);
function fail(code) { throw new Error(code); }
const LIMIT = 1000000000;
const STAT_KEYS = ['coinflipWins','coinflipLosses','coinflipProfit','blackjackWins','blackjackLosses','blackjackPushes','blackjackProfit','totalWagered','totalWon'];
const ACTIONS = { click: [], coinflip: ['bet','choice'], 'blackjack-start': ['bet'], 'blackjack-hit': [], 'blackjack-stand': [], 'blackjack-double': [], 'buy-item': ['item'], 'use-item': ['item'] };
const SHOP = { 'ration-pack': [50,50,0], 'energy-cell': [50,0,50], 'stim-shot': [40,25,25], 'full-restore': [150,100,100] };
const RANKS = [[1,'TRAINEE'],[3,'ANALYST'],[5,'OPERATIVE'],[8,'AGENT'],[11,'SPECIALIST'],[14,'HANDLER'],[17,'CONTROLLER'],[20,'DIRECTOR'],[24,'EXECUTIVE'],[28,'OVERSEER'],[33,'SENTINEL'],[40,'ARCHITECT'],[50,'PHANTOM']];
function integer(x, min = 0, max = LIMIT) { return Number.isSafeInteger(x) && x >= min && x <= max; }
function token(x) { return typeof x === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(x); }
function keys(o, expected, code) {
  if (!o || Object.getPrototypeOf(o) !== Object.prototype || Object.keys(o).sort().join('|') !== [...expected].sort().join('|')) fail(code);
}
function identityCheck(identity) {
  keys(identity, ['ownerId','profileId'], 'invalid-identity');
  if (!token(identity.ownerId) || !token(identity.profileId)) fail('invalid-identity');
}
function commandCheck(c) {
  if (!c || !Object.hasOwn(ACTIONS, c.action)) fail('invalid-action');
  keys(c, ['id','revision','action',...ACTIONS[c.action]], 'invalid-command');
  if (!token(c.id) || !integer(c.revision)) fail('invalid-command');
  if (Object.hasOwn(c,'bet') && !integer(c.bet,c.action === 'coinflip' ? 5 : 10,500)) fail('invalid-bet');
  if (Object.hasOwn(c,'choice') && !['heads','h','tails','t'].includes(c.choice)) fail('invalid-choice');
  if (Object.hasOwn(c,'item') && (typeof c.item !== 'string' || !Object.hasOwn(SHOP,c.item))) fail('invalid-item');
}
function validateState(s) {
  keys(s, ['version','ownerId','profileId','revision','updatedAt','pet','game','receipts'], 'invalid-state');
  if (s.version !== 1 || !token(s.ownerId) || !token(s.profileId) || !integer(s.revision) || !integer(s.updatedAt,0,Number.MAX_SAFE_INTEGER)) fail('invalid-state');
  keys(s.pet, ['totalXp','hunger','energy','lastClickAt','totalClicks'], 'invalid-state');
  if (!integer(s.pet.totalXp) || !integer(s.pet.totalClicks) || ![s.pet.hunger,s.pet.energy].every(n => Number.isFinite(n) && n >= 0 && n <= 100) || !(s.pet.lastClickAt === null || integer(s.pet.lastClickAt,0,s.updatedAt))) fail('invalid-state');
  keys(s.game, ['activeBlackjack','inventory','stats'], 'invalid-state');
  keys(s.game.stats, STAT_KEYS, 'invalid-state');
  for (const k of STAT_KEYS) if (!integer(s.game.stats[k], k.endsWith('Profit') ? -LIMIT : 0)) fail('invalid-state');
  if (!s.game.inventory || Object.getPrototypeOf(s.game.inventory) !== Object.prototype || Object.keys(s.game.inventory).length > 4) fail('invalid-state');
  for (const [k,v] of Object.entries(s.game.inventory)) if (!Object.hasOwn(SHOP,k) || !integer(v,1,99)) fail('invalid-state');
  const g = s.game.activeBlackjack;
  if (g !== null) {
    keys(g,['deck','playerHand','dealerHand','bet','doubledDown'],'invalid-state');
    if (!integer(g.bet,10,1000) || g.bet > s.pet.totalXp || typeof g.doubledDown !== 'boolean' || g.doubledDown) fail('invalid-state');
    if (![g.deck,g.playerHand,g.dealerHand].every(a => Array.isArray(a) && a.length <= 52) || g.playerHand.length < 2 || g.playerHand.length > 22 || g.dealerHand.length !== 2) fail('invalid-state');
    const all = [...g.deck,...g.playerHand,...g.dealerHand];
    if (all.length !== 52) fail('invalid-state');
    for (const c of all) { keys(c,['suit','value'],'invalid-state'); if (!SUITS.includes(c.suit) || !VALUES.includes(c.value)) fail('invalid-state'); }
    if (new Set(all.map(c => c.suit+c.value)).size !== 52 || handValue(g.playerHand) >= 21) fail('invalid-state');
  }
  if (!Array.isArray(s.receipts) || s.receipts.length > 64) fail('invalid-state');
  const ids = new Set();
  for (const r of s.receipts) {
    keys(r,['id','fingerprint','result'],'invalid-state');
    if (!token(r.id) || ids.has(r.id) || typeof r.fingerprint !== 'string' || r.fingerprint.length > 512) fail('invalid-state');
    ids.add(r.id);
    // Receipts are server-only JSON. Bound every nested value before cloning.
    let count = 0;
    function bounded(v, depth) {
      if (++count > 128 || depth > 4) fail('invalid-state');
      if (v === null || typeof v === 'boolean') return;
      if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= LIMIT) return;
      if (typeof v === 'string' && v.length <= 128) return;
      if (typeof v !== 'object' || (!Array.isArray(v) && Object.getPrototypeOf(v) !== Object.prototype) || Object.keys(v).length > 32) fail('invalid-state');
      for (const [k,val] of Object.entries(v)) { if (k.length > 64) fail('invalid-state'); bounded(val,depth+1); }
    }
    bounded(r.result,0);
  }
  return s;
}
function stat(s, key, amount) { s.game.stats[key] = Math.max(-LIMIT, Math.min(LIMIT,s.game.stats[key]+amount)); }
function createState(identity, { clock } = {}) {
  identityCheck(identity);
  const now = typeof clock === 'function' ? clock() : NaN;
  if (!integer(now,0,Number.MAX_SAFE_INTEGER)) fail('invalid-clock');
  return { version: 1, ...identity, revision: 0, updatedAt: now,
    pet: { totalXp: 0, hunger: 100, energy: 100, lastClickAt: null, totalClicks: 0 },
    game: { activeBlackjack: null, inventory: {}, stats: Object.fromEntries(STAT_KEYS.map(k => [k,0])) }, receipts: [] };
}
function view(state) {
  validateState(state);
  const s = structuredClone(state);
  if (state.game.activeBlackjack) s.game.activeBlackjack = playing(state);
  const xp = s.pet.totalXp;
  s.pet.level = xp >= 21000 ? 21 + Math.floor((xp - 21000) / 3000) : LEVELS.filter(x => x <= xp).length;
  s.pet.rank = RANKS.filter(([min]) => min <= s.pet.level).at(-1)[1];
  delete s.receipts;
  return s;
}
const SUITS = ['♠', '♥', '♦', '♣'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
function cardValue(c) { return c.value === 'A' ? 11 : ['J','Q','K'].includes(c.value) ? 10 : Number(c.value); }
function handValue(hand) {
  let total = hand.reduce((n,c) => n + cardValue(c), 0);
  let aces = hand.filter(c => c.value === 'A').length;
  while (total > 21 && aces-- > 0) total -= 10;
  return total;
}
function gain(s, amount) { s.pet.totalXp += s.pet.hunger < 20 || s.pet.energy < 20 ? Math.max(1, Math.floor(amount / 2)) : amount; }
function playing(s) {
  const g = s.game.activeBlackjack;
  return { success: true, state: 'playing', player: g.playerHand.map(c => c.value + c.suit),
    playerValue: handValue(g.playerHand), dealer: [g.dealerHand[0].value + g.dealerHand[0].suit, '??'],
    dealerShowing: cardValue(g.dealerHand[0]), bet: g.bet, canDouble: g.playerHand.length === 2 && s.pet.totalXp >= g.bet * 2 };
}
function end(s, outcome) {
  const g = s.game.activeBlackjack;
  const payout = outcome === 'blackjack' ? Math.floor(g.bet * 2.5) : ['win','dealer-bust'].includes(outcome) ? g.bet * 2 : outcome === 'push' ? g.bet : 0;
  const profit = payout - g.bet;
  if (profit > 0) gain(s, profit); else s.pet.totalXp += profit;
  stat(s, profit > 0 ? 'blackjackWins' : profit < 0 ? 'blackjackLosses' : 'blackjackPushes', 1);
  stat(s, 'blackjackProfit', profit);
  if (profit > 0) stat(s, 'totalWon', payout);
  s.game.activeBlackjack = null;
  return { success: true, state: 'complete', outcome, bet: g.bet, payout, profit,
    player: g.playerHand.map(c => c.value + c.suit), playerValue: handValue(g.playerHand),
    dealer: g.dealerHand.map(c => c.value + c.suit), dealerValue: handValue(g.dealerHand) };
}
function draw(g, hand) { if (!g.deck.length || hand.length >= 22) fail('deck-exhausted'); hand.push(g.deck.pop()); }
function dealerPlay(s) {
  const g = s.game.activeBlackjack;
  while (handValue(g.dealerHand) < 17) draw(g, g.dealerHand);
  const p = handValue(g.playerHand), d = handValue(g.dealerHand);
  return end(s, d > 21 ? 'dealer-bust' : p > d ? 'win' : p < d ? 'lose' : 'push');
}
function blackjack(s, command, rng) {
  if (command.action === 'blackjack-start') {
    if (s.game.activeBlackjack) fail('game-in-progress');
    const bet = command.bet;
    if (!Number.isSafeInteger(bet) || bet < 10 || bet > 500) fail('invalid-bet');
    if (s.pet.totalXp < bet) fail('insufficient-xp');
    if (s.pet.totalXp > LIMIT - 1500 || s.revision > LIMIT - 24) fail('limit-exceeded');
    stat(s, 'totalWagered', bet);
    const deck = SUITS.flatMap(suit => VALUES.map(value => ({suit,value})));
    for (let i = 51; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [deck[i],deck[j]] = [deck[j],deck[i]]; }
    const playerHand = [deck.pop(),deck.pop()], dealerHand = [deck.pop(),deck.pop()];
    s.game.activeBlackjack = { deck, playerHand, dealerHand, bet, doubledDown: false };
    if (handValue(playerHand) === 21) return end(s, handValue(dealerHand) === 21 ? 'push' : 'blackjack');
    return playing(s);
  }
  const g = s.game.activeBlackjack;
  if (!g) fail('no-game');
  if (command.action === 'blackjack-stand') return dealerPlay(s);
  if (command.action === 'blackjack-double') {
    if (g.playerHand.length !== 2) fail('cannot-double');
    if (s.pet.totalXp < g.bet * 2) fail('insufficient-xp');
    stat(s, 'totalWagered', g.bet);
    g.bet *= 2; g.doubledDown = true;
  } else if (command.action !== 'blackjack-hit') fail('invalid-action');
  draw(g, g.playerHand);
  const value = handValue(g.playerHand);
  if (value > 21) return end(s, 'bust');
  if (value === 21 || g.doubledDown) return dealerPlay(s);
  return playing(s);
}
function transition(state, identity, command, { clock, rng } = {}) {
  validateState(state);
  identityCheck(identity);
  if (state.ownerId !== identity.ownerId || state.profileId !== identity.profileId) fail('owner-mismatch');
  commandCheck(command);
  const fingerprint = JSON.stringify(Object.keys(command).sort().map(k => [k,command[k]]));
  const receipt = state.receipts.find(r => r.id === command.id);
  if (receipt) {
    if (receipt.fingerprint !== fingerprint) fail('idempotency-conflict');
    return { state: structuredClone(state), result: structuredClone(receipt.result), replayed: true };
  }
  if (command.revision !== state.revision) fail('stale-revision');
  if (state.revision >= LIMIT) fail('limit-exceeded');
  const s = structuredClone(state);
  const now = typeof clock === 'function' ? clock() : NaN;
  if (!integer(now,state.updatedAt,Number.MAX_SAFE_INTEGER)) fail('invalid-clock');
  const random = () => {
    const n = typeof rng === 'function' ? rng() : NaN;
    if (!Number.isFinite(n) || n < 0 || n >= 1) fail('invalid-rng');
    return n;
  };
  if (s.game.activeBlackjack && !['blackjack-hit','blackjack-stand','blackjack-double'].includes(command.action)) fail('game-in-progress');
  let result = { success: true };
  if (command.action === 'coinflip') {
    const { bet, choice } = command;
    if (!Number.isSafeInteger(bet) || bet < 5 || bet > 500) fail('invalid-bet');
    if (s.pet.totalXp < bet) fail('insufficient-xp');
    if (!['heads', 'h', 'tails', 't'].includes(choice)) fail('invalid-choice');
    const landed = random() < 0.5 ? 'heads' : 'tails';
    const normalized = choice === 'h' ? 'heads' : choice === 't' ? 'tails' : choice;
    const won = landed === normalized;
    const winnings = won ? Math.floor(bet * 1.8) : 0;
    const profit = winnings - bet;
    s.pet.totalXp += profit > 0 && (s.pet.hunger < 20 || s.pet.energy < 20) ? Math.max(1, Math.floor(profit / 2)) : profit;
    result = { success: true, won, result: landed, choice: normalized, bet, winnings, profit };
    stat(s, 'totalWagered', bet);
    stat(s, won ? 'coinflipWins' : 'coinflipLosses', 1);
    stat(s, 'coinflipProfit', profit);
    if (won) stat(s, 'totalWon', winnings);
  } else if (command.action.startsWith('blackjack-')) {
    result = blackjack(s, command, random);
  } else if (command.action === 'buy-item' || command.action === 'use-item') {
    const item = command.item;
    if (typeof item !== 'string' || !Object.hasOwn(SHOP,item)) fail('invalid-item');
    const [cost,hunger,energy] = SHOP[item];
    const count = s.game.inventory[item] || 0;
    if (command.action === 'buy-item') {
      if (s.pet.totalXp < cost) fail('insufficient-xp');
      if (count >= 99) fail('inventory-full');
      s.pet.totalXp -= cost;
      s.game.inventory[item] = count + 1;
      result = { success:true, item, count:count+1, xpSpent:cost };
    } else {
      if (!count) fail('no-item');
      if (count === 1) delete s.game.inventory[item]; else s.game.inventory[item]--;
      s.pet.hunger = Math.min(100,s.pet.hunger+hunger);
      s.pet.energy = Math.min(100,s.pet.energy+energy);
      result = { success:true, item, remaining:count-1 };
    }
  } else {
    if (command.action !== 'click') fail('invalid-action');
    if (s.pet.lastClickAt !== null && now - s.pet.lastClickAt < 3000) fail('cooldown');
    s.pet.lastClickAt = now;
    s.pet.totalXp += s.pet.hunger < 20 || s.pet.energy < 20 ? 1 : 2;
    s.pet.hunger = Math.min(100, s.pet.hunger + 2);
    s.pet.totalClicks = Math.min(LIMIT, s.pet.totalClicks + 1);
  }
  s.revision++;
  s.updatedAt = now;
  if (!integer(s.pet.totalXp)) fail('limit-exceeded');
  s.receipts.push({id:command.id, fingerprint, result:structuredClone(result)});
  s.receipts = s.receipts.slice(-64);
  validateState(s);
  return { state: s, result, replayed: false };
}
module.exports = { createState, transition, view, validateState };
