# Companion game core v1 (pure state machine)

The core remains independent of HTTP/storage. The integrated server, durable owner store, actual `{view,result,replayed}` wire envelope and release gates are documented in [Companion integration](companion-integration.md); the route section below points to the implemented HTTP contract.

`src/main/companion-game-core.js` is a dependency-free, synchronous state machine. It imports no legacy singleton, filesystem, process, networking, Electron, monitoring or LLM module. The core itself provides no storage; the production server composes it with the durable companion store. Original code is retained unchanged, including its attribution/license.

## API frozen for integration

```js
const { createState, transition, view, validateState } = require('./companion-game-core');
const identity = { ownerId: 'authenticated-owner', profileId: 'pet-1' };
const dependencies = { clock: () => Date.now(), rng: serverRandomFraction };
let stored = createState(identity, dependencies); // zero XP, full needs
const command = { id: 'unique-request-id', revision: 0, action: 'click' };
const next = transition(stored, identity, command, dependencies);
// Atomically commit next.state before acknowledging. Never return next.state to browser.
const response = { state: view(next.state), result: next.result, replayed: next.replayed };
```

- `createState(identity, {clock})`: new v1 server-owned JSON state. Identity fields and request IDs are 1–64 ASCII letters/digits/underscore/hyphen; use opaque server-side identifiers, not raw email addresses.
- `transition(state, authenticatedIdentity, command, {clock,rng})`: returns `{state,result,replayed}` or throws `Error` with a fixed reason string. Does not mutate input. Dependencies must be supplied by server, never browser. RNG must return finite `[0,1)`; use server cryptographic randomness in deployment. Clock must return a nondecreasing nonnegative safe-integer epoch millisecond time. A retry does not call RNG or clock.
- `view(state)`: deep-copied public projection. Adds derived `pet.level` and `pet.rank`; removes receipts and replaces blackjack internals with a masked playing response. **Only this projection and `result` may leave the server.** Raw state includes dealer hole card and shuffled deck.
- `validateState(state)`: validates a server-side JSON snapshot, returning it unchanged. This is not authorization or a signature: valid-looking client state is still forbidden. Do not accept executable JS objects/proxies/accessors as state or commands; bounded parsed JSON and trusted server objects only.

All commands require exactly `id`, `revision`, `action`, plus the listed fields:

| action | additional fields |
|---|---|
| `click` | none |
| `coinflip` | integer `bet` 5–500; `choice` heads/h/tails/t |
| `blackjack-start` | integer `bet` 10–500 |
| `blackjack-hit`, `blackjack-stand`, `blackjack-double` | none |
| `buy-item`, `use-item` | `item`: ration-pack, energy-cell, stim-shot, full-restore |

No XP, score, cards, outcome, timestamp, owner override, arbitrary action or balance setters. `result` preserves original coinflip and blackjack completion payload field names. Playing payload includes `state:'playing'`, player/card value, masked dealer, dealerShowing, bet, canDouble. Shop replies retain original item/count/remaining/xpSpent semantics. Errors are fixed strings including invalid-command/action/bet/choice/item/state/identity/clock/rng, owner-mismatch, stale-revision, idempotency-conflict, cooldown, insufficient-xp, game-in-progress, no-game, cannot-double, no-item, inventory-full, deck-exhausted, limit-exceeded. Do not expose unexpected exception messages.

## Original rule provenance

References are to preserved repository source, not invented game rules:

- [`arcade.js:59–64`](../src/main/arcade.js): coinflip min 5/max 500/payout 1.8; blackjack min 10/max 500.
- [`arcade.js:183–218`](../src/main/arcade.js): heads below RNG 0.5, floor(bet × 1.8) gross win, only net profit added to XP; loss removes wager; original stats record gross winnings and nominal net profit.
- [`arcade.js:225–258`](../src/main/arcade.js): single 52-card deck, suits ♠♥♦♣, A through K, Fisher–Yates shuffle, ace 11 reduced to 1 as needed. Dealing pops two player cards then two dealer cards, **not alternating**, at lines 283–285.
- [`arcade.js:293–311,315–385`](../src/main/arcade.js): both natural 21 push; player natural wins immediately; dealer-only natural does not end immediately; hit auto-stands at 21; double only on the initial two cards draws exactly one then stands. Dealer code draws while `<17`, therefore **stands on soft 17** despite the misleading comment “hits on soft 17.” This core follows executable behavior.
- [`arcade.js:388–445`](../src/main/arcade.js): natural gross floor(bet × 2.5), ordinary win/dealer bust gross 2×bet, push returns bet without XP change, loss costs wager. No split, insurance, surrender or invented rewards.
- [`arcade.js:15–56,125–176`](../src/main/arcade.js): ration pack costs 50, hunger +50; energy cell 50, energy +50; stim shot 40, both +25; full restore 150, both +100 clamped to 100. Inventory is consumed once.
- [`xp-system.js:7–49,295–319,322–345`](../src/main/xp-system.js): click +2 with 3000ms cooldown (enforced by original `windows.js:307–311`); original threshold table through 21000 XP, then 3000 per level, original rank names. Needs below 20 halve positive gains using max(1,floor(gain/2)); click feeds hunger +2 **after** applying penalty. Arcade `profit` remains nominal, while totalXp reflects actual needs-adjusted credit, matching original behavior.
- [`pet-needs.js:20–24,143–149`](../src/main/pet-needs.js): full initial needs and feeding clamped at 100.

Tests include 120 seeded differential rounds running the original arcade source in a test-only VM with isolated dependencies, comparing coinflip replies, blackjack completion replies, XP balances and all original statistics. Production core does not execute/read the original file.

## Narrow hardening deltas and deliberate exclusions

1. Strict integer wager validation replaces Number coercion/flooring; invalid choices no longer silently become tails. Only explicit h/t aliases are accepted.
2. Original double checks only the pre-double bet (`arcade.js:353–360`), despite UI advertising a requirement for twice the bet. Core requires full doubled liability. Other actions are locked while blackjack is active, preventing a wager from being spent in shop/coinflip before settlement. A game cannot be discarded/restarted or replaced with a new hand. Closing/reopening UI must resume persisted active state.
3. Original addXp/removeXp return early while sleeping (`xp-system.js:323,397`), while purchases/inventory mutations continue in arcade. Exposing that sleep switch could permit free inventory. This core has **no sleep action or sleeping bypass**: purchases and losses always debit. Sleep restoration requires a separately reviewed coherent economy transaction, not forwarding legacy APIs.
4. XP/revision are capped at 1,000,000,000; gains exceeding cap fail atomically. Counters saturate at that bound (profits signed). Blackjack start reserves 1500 XP headroom and 24 revision increments, so a valid active hand can settle without hitting a ceiling. Inventory has at most four item kinds and 99 of each. One active 52-card deck with uniqueness checks, maximum 22 player/dealer draw slots, no arbitrary history. Corrupt/exhausted snapshots fail closed without state mutation; do not silently reset them.
5. Last 64 successful command receipts are retained. Same ID and exact canonical payload returns original result plus current state with `replayed:true`, without charging/rewarding again. Same retained ID/different payload conflicts. Evicted request payloads retain an old revision and are rejected, not replayed. IDs are deduplicated only within that receipt window; a new command with a current revision is a new operation. Rejections do not advance revision or cache errors.
6. No arbitrary add-XP endpoint, auto passive reward, client-reported chat/pomodoro reward, daily-contract payout, offline decay/catch-up, milestone/morale side effects or sleep scheduler is implemented. Those legacy integrations need trusted event provenance, server timing and separate tests before enabling. Local timers/chat/UI events must not mint XP. The current restored progression path is click + original arcade XP, levels/ranks, needs penalty and consumables; it does not claim full desktop lifecycle parity.

## Implemented HTTP contract

The server uses `{view: core.view(snapshot)}` for state and
`{view: core.view(committedSnapshot), result, replayed}` for actions, not the
core's internal `{state,...}` envelope. See [Companion integration](companion-integration.md#wire-contract)
for endpoints, authentication, limits and response codes. The browser never
supplies a full state, owner identity, clock or RNG.

## Required persistence contract

State has `version`, ownerId/profileId, revision, updatedAt, `pet`, `game`, receipts. It is **separate from infrastructure observations, monitoring metrics and observed health**. XP cannot modify health or vice versa.

Provide an owner/profile-scoped transactional store with atomic compare-and-swap on revision, serialized per-profile mutation or equivalent DB locking, and complete snapshot writes covering pet balances, inventory, active deck, statistics and receipts together. Retrying a concurrent stale command must reload committed state and consult receipts; never reroll and overwrite an already committed winner. No response before durable commit. An in-memory Map is acceptable only when explicitly advertised as ephemeral; it is not durable, cross-device, restart-safe or multi-process-safe.

Encrypt/restrict access to snapshots as appropriate; never log deck, session secret or raw identity. Validate snapshots before use, enforce total stored byte/profile budgets, version migrations explicitly, and preserve active hands across restart. Unknown versions/corruption must fail closed, not create replacement balances or fresh decks. Test power-loss/restart, CAS contention, duplicate delivery, commit failure, multi-owner separation and store exhaustion with the actual store before claiming durable progression. The integrated single-owner store implements this boundary; see [storage](companion-integration.md#storage). Multi-owner enrollment is not shipped.
