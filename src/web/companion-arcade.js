/* Optional adapter; load with unmodified chat-window.css and companion-arcade.css.
 * Explicit init(document, transport) returns an idempotent destroy function.
 * No networking, storage, startup, game simulation, or privileged bridge.
 *
 * Proposed transport v1: request(action, payload) -> Promise<{success:true,state}>
 * or {success:false,reason}. Every request includes a fresh UUID idempotencyKey.
 * Actions: state {}; coinflip {bet,choice:'heads'|'tails'};
 * blackjack-deal {bet}; blackjack-hit/stand/double {handId}.
 * Transport/backend MUST authenticate, enforce original rules/limits atomically,
 * deduplicate keys per account+action+payload, and return a full authoritative
 * snapshot after each action. Never accept browser balances/results as authority.
 * State: {xp:nonnegative integer, gameStats:{wins,losses:nonnegative integers,
 * profit:signed integer}, coinflip:null|{result:'heads'|'tails',won:boolean,profit},
 * blackjack:null|{handId,state:'playing'|'complete',dealer:string[],player:string[],
 * dealerShowing:integer,playerValue:integer,canDouble:boolean,
 * dealerValue:integer (complete),outcome (complete),profit (complete)}}.
 * Cards use original rank+suit strings and '??' for hidden dealer card.
 * Errors/15s deadlines lock mutations until explicit state refresh. Transport
 * must serialize outstanding writes before serving that refresh (timeout is not
 * cancellation). No automatic mutation retries; backend reconciliation required.
 * Optional authoritative level/rank/inventory support owner shop and click actions.
 */
(() => {
  'use strict';
  const mounts = new WeakMap();
  const integer = n => Number.isSafeInteger(n);
  const outcomes = {'blackjack':'🃏 BLACKJACK!',win:'✅ YOU WIN','dealer-bust':'💥 DEALER BUSTS',push:'🤝 PUSH',bust:'💀 BUST',lose:'❌ DEALER WINS'};
  function validHand(h) {
    const cards = a => Array.isArray(a) && a.length <= 22 && a.every(c => typeof c === 'string' && /^(\?\?|(?:[2-9]|10|[AJQK])[♠♥♦♣])$/.test(c));
    return h === null || (h && typeof h.handId === 'string' && /^[\w-]{1,128}$/.test(h.handId) && ['playing','complete'].includes(h.state) && cards(h.dealer) && cards(h.player) && integer(h.playerValue) && integer(h.dealerShowing) && typeof h.canDouble === 'boolean' && (h.state !== 'complete' || (integer(h.dealerValue) && Object.hasOwn(outcomes,h.outcome) && integer(h.profit))));
  }
  function valid(s) {
    return s && validHand(s.blackjack) && integer(s.xp) && s.xp >= 0 && s.gameStats &&
      integer(s.gameStats.wins) && s.gameStats.wins >= 0 && integer(s.gameStats.losses) && s.gameStats.losses >= 0 && integer(s.gameStats.profit) &&
      (s.coinflip === null || (s.coinflip && ['heads','tails'].includes(s.coinflip.result) && typeof s.coinflip.won === 'boolean' && integer(s.coinflip.profit)));
  }
  function init(document, transport) {
    const mount = document.getElementById('companion-arcade');
    if (!mount) return () => {};
    if (mounts.has(mount)) return mounts.get(mount);
    const listeners = [];
    const el = (tag, cls, text, parent) => {
      const node = document.createElement(tag); node.className = cls;
      if (text !== undefined) node.textContent = text;
      if (parent) parent.append(node); return node;
    };
    const root = el('section','rg-arcade arcade-bar',undefined,mount);
    root.setAttribute('aria-label','Arcade');
    el('div','arcade-title','🎰 ARCADE',root);
    const summary = el('div','arcade-stats-mini','TOTAL: — · W — · L — · P/L —',root);
    const status = el('div','cf-result','ARCADE UNAVAILABLE',root);
    status.setAttribute('role','status'); status.setAttribute('aria-live','polite');
    const games = el('div','arcade-games',undefined,root);
    const cf = el('div','game-section',undefined,games);
    el('span','game-odds','1.8x',el('div','game-title','🪙 COINFLIP ',cf));
    const row = el('div','game-row',undefined,cf);
    function betInput(parent,label,min) {
      const input = el('input','game-bet-input',undefined,parent);
      input.type='number'; input.min=String(min); input.max='500'; input.step='1'; input.placeholder='BET XP';
      input.setAttribute('aria-label',label); return input;
    }
    const cfBet = betInput(row,'Coinflip bet XP',5);
    const buttons = [];
    function button(parent,label,action,extra = {}) {
      const b = el('button','game-btn',label,parent); b.type='button';
      const handler = () => send(action,extra); b.addEventListener('click',handler); listeners.push([b,handler]); buttons.push([b,action]); return b;
    }
    button(row,'HEADS','coinflip',{choice:'heads'}).className += ' heads';
    button(row,'TAILS','coinflip',{choice:'tails'}).className += ' tails';
    const cfResult = el('div','cf-result','',cf);
    const bj = el('div','game-section',undefined,games);
    el('span','game-odds','2x / 2.5x BJ',el('div','game-title','🃏 BLACKJACK ',bj));
    const bjRow = el('div','game-row',undefined,bj);
    const bjBet = betInput(bjRow,'Blackjack bet XP',10);
    button(bjRow,'DEAL','blackjack-deal').className += ' deal';
    button(bjRow,'HIT','blackjack-hit');
    button(bjRow,'STAND','blackjack-stand');
    button(bjRow,'2X','blackjack-double').setAttribute('aria-label','Double down');
    const table = el('div','bj-table',undefined,bj);
    const bjResult = el('div','bj-result','',bj);
    for (const result of [cfResult,bjResult]) { result.setAttribute('role','status'); result.setAttribute('aria-live','polite'); }
    button(root,'REFRESH','state');
    button(root,'PET','click');
    const progression=el('div','arcade-stats-mini','',root);
    const shop=el('div','game-row',undefined,root);
    const items=[['ration-pack','RATION PACK',50],['energy-cell','ENERGY CELL',50],['stim-shot','STIM SHOT',40],['full-restore','FULL RESTORE',150]];
    for(const [item,label,cost] of items) {
      button(shop,`${label} · ${cost} XP`,'buy-item',{item});
      button(shop,`USE ${label}`,'use-item',{item});
    }
    const inventory=el('div','rg-inventory arcade-stats-mini','',root);
    const pet=document.getElementById('rg-interactions-pet');
    if(pet){const handler=()=>send('click');pet.addEventListener('click',handler);listeners.push([pet,handler]);}
    let stopped=false, busy=false, state=null, sequence=0, timer;
    const configured = !!transport && typeof transport.request === 'function' && typeof globalThis.crypto?.randomUUID === 'function';
    function controls() {
      root.setAttribute('aria-busy',String(busy));
      const playing=state?.blackjack?.state === 'playing';
      for (const [b,action] of buttons) {
        b.disabled = !configured || busy || (action !== 'state' && !state) ||
          (playing && ['click','coinflip','buy-item','use-item'].includes(action)) ||
          (action === 'blackjack-deal' && playing) ||
          (['blackjack-hit','blackjack-stand','blackjack-double'].includes(action) && !playing) ||
          (action === 'blackjack-double' && !state?.blackjack?.canDouble);
      }
      cfBet.disabled = !configured || busy || !state;
      bjBet.disabled = cfBet.disabled || playing;
    }
    function render() {
      const stats=state.gameStats;
      progression.textContent=state.level ? `LV ${state.level} · ${state.rank}` : '';
      inventory.textContent=Object.entries(state.inventory || {}).map(([item,count])=>`${item} ×${count}`).join(' · ') || 'INVENTORY EMPTY';
      summary.textContent=`TOTAL: ${state.xp} · W ${stats.wins} · L ${stats.losses} · P/L ${stats.profit >= 0 ? '+' : ''}${stats.profit}`;
      table.textContent='';
      const h=state.blackjack;
      if (h) for (const [label,cards,value] of [['DEALER',h.dealer,h.state === 'playing' ? h.dealerShowing : h.dealerValue],['YOU',h.player,h.playerValue]]) {
        const hand=el('div','bj-hand',undefined,table);
        el('span','bj-hand-label',label,hand);
        const row=el('div','bj-cards',undefined,hand);
        for (const card of cards) {
          const node=el('span','bj-card' + (card === '??' ? ' face-down' : /[♥♦]/.test(card) ? ' red' : ''),card === '??' ? '🂠' : card,row);
          if (card === '??') node.setAttribute('aria-label','Hidden card');
        }
        el('span','bj-value',String(value),hand);
      }
      bjResult.textContent=h?.state === 'complete' ? `${outcomes[h.outcome]} ${h.profit === 0 ? '— BET RETURNED' : (h.profit > 0 ? '+' : '') + h.profit + ' XP'}` : '';
      bjResult.className='bj-result' + (h?.state === 'complete' ? h.profit > 0 ? ' win' : h.profit < 0 ? ' lose' : ' push' : '');
      const c=state.coinflip;
      cfResult.textContent=c ? `${c.result.toUpperCase()} — YOU ${c.won ? 'WIN' : 'LOSE'} ${c.profit > 0 ? '+' : ''}${c.profit} XP` : '';
      cfResult.className='cf-result' + (c ? c.won ? ' win' : ' lose' : '');
    }
    async function send(action,extra = {}) {
      if (stopped || busy || !configured || (action !== 'state' && !state)) return;
      const control=buttons.find(([,a]) => a === action);
      if (!control || control[0].disabled) return;
      const payload = {...extra};
      if (['blackjack-hit','blackjack-stand','blackjack-double'].includes(action)) payload.handId=state.blackjack.handId;
      if (action === 'coinflip' || action === 'blackjack-deal') {
        const input = action === 'coinflip' ? cfBet : bjBet;
        const bet = Number(input.value), min = action === 'coinflip' ? 5 : 10;
        if (!/^\d+$/.test(input.value) || !integer(bet) || bet < min || bet > 500) {status.textContent=`INVALID BET (${min}-500 XP)`; return;}
        payload.bet=bet;
      }
      busy=true; controls(); status.textContent='WAITING…';
      const token=++sequence;
      try {
        payload.idempotencyKey=globalThis.crypto.randomUUID();
        const deadline = new Promise((_,reject) => {timer=setTimeout(() => reject(new Error('deadline')),15000);});
        const response = await Promise.race([Promise.resolve().then(() => { if (stopped || token !== sequence) return null; return transport.request(action,payload); }),deadline]);
        if (stopped || token !== sequence) return;
        if (!response || response.success !== true || !valid(response.state)) throw new Error('unavailable');
        state=response.state; render(); status.textContent=['WAIT / TRY AGAIN','STATE UPDATED / TRY AGAIN','ACTION REFUSED'].includes(response.reason) ? response.reason : '';
      } catch (_) {
        if (stopped || token !== sequence) return;
        state=null; summary.textContent='TOTAL: — · W — · L — · P/L —';
        table.textContent=''; cfResult.textContent=''; bjResult.textContent=''; progression.textContent=''; inventory.textContent='';
        status.textContent='ARCADE UNAVAILABLE — REFRESH';
      } finally {
        if (!stopped && token === sequence) {clearTimeout(timer); busy=false; controls();}
      }
    }
    const destroy = () => {
      if (stopped) return; stopped=true; ++sequence; clearTimeout(timer);
      for (const [b,handler] of listeners) b.removeEventListener('click',handler);
      root.remove(); mounts.delete(mount);
    };
    mounts.set(mount,destroy); controls(); if (configured) void send('state');
    return destroy;
  }
  globalThis.RadgotchiArcade = Object.freeze({init});
})();
