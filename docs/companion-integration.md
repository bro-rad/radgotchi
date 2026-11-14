# Durable companion integration — 0.1.5

The monitoring server now composes the original-rule core through `companion-store.js`; it does not load the legacy bootstrap, chat, mesh, NATS, Electron bridge or executable skills. See [core rule provenance and exclusions](companion-game-contract.md).

## Wire contract

- Existing `/login` and HttpOnly session remain unchanged. The configured token grants access to **one owner principal**, `{ownerId:'owner',profileId:'companion'}`. Different sessions and token rotation do not create players or new balances.
- `GET /api/companion/state` returns `{view: core.view(snapshot)}`.
- `POST /api/companion/action` takes the exact core command `{id,revision,action,...}` and returns `{view:core.view(committedSnapshot),result,replayed}` only after commit. Never return raw state: deck, hole card and receipts remain server-only.
- Both endpoints require the existing session and Host/fetch-metadata checks. POST additionally requires exact Origin, JSON content type, at most 2048 bytes, and a three-second body deadline. The owner shares a 120 mutation-attempt/minute bound across all sessions. Original click cooldown is independently persisted and enforced at 3000 ms.
- 400 invalid action, 401 unauthenticated, 403 origin refusal, 405 method refusal, 409 stale revision/idempotency conflict, 413 body limit, 415 content type, 429 cooldown/rate limit, 503 unavailable store. Unexpected errors are redacted.
- `companion-transport.js` serializes browser writes, maps authoritative views to the original arcade adapter, and retains the exact uncertain command for explicit Refresh reconciliation. No automatic repeated wager or browser balance authority. Definitive refusal reloads authority without replaying the action.

## Storage

- Packaged path: `/data/companion`, named volume `companion:/data/companion`. This is the persistent storage topology of the independently live-verified 0.1.5 release. Image directory is owned by UID/GID 1000 with mode 0700; state and lease files are 0600. The package entrypoint pins this path and rejects alternative environment overrides.
- Native non-package `startMonitoringFromEnv` default is `~/.radgotchi/companion`; `RADGOTCHI_COMPANION_DIR` may select an absolute path there. Test child processes explicitly use isolated scratch paths. Direct `createMonitoringServer` callers must supply `companionDirectory`; without it the API returns 503 rather than fabricating an ephemeral economy.
- One snapshot `owner.json` (maximum 131072 bytes) contains balances, original stats, inventory, active deck and last 64 receipts. Core schema, owner identity, file type, ownership, permissions, hard-link count and path symlinks are checked before use. An initialized marker prevents silent reinitialization when a previously initialized snapshot disappears.
- A process-identity lease refuses another writer. Linux identity uses kernel boot ID plus `/proc/<pid>/stat` start time, with PID namespace identity; macOS uses process start identity. A lease from a different PID namespace is ambiguous and refused (never mistake a second container’s PID 1 for a dead writer). Startup/reclamation is serialized by `startup.lock`. Graceful shutdown releases the lease; a demonstrably dead writer in the same PID namespace can be reclaimed. A hard-killed container’s lease requires operator review before reuse from a new PID namespace; its snapshot is preserved, not reset. An ambiguous lease or startup crash fails closed. With the service stopped and no writer, an operator must review/back up state before removing an abandoned startup gate. Never delete `owner.json` or `initialized` as an error-recovery shortcut.
- Mutations are synchronous and atomic in the single writer, with core revision CAS and exact idempotency fingerprints. Write a unique exclusive temp file, fsync it, atomically rename, fsync the directory, then acknowledge. Any commit error disables further use until restart; corruption, changed state, unknown versions and missing initialized snapshots never silently reset or overwrite.
- This is single-service/local-volume persistence, not a distributed filesystem or multi-replica database. A same-UID administrator can tamper with files; schema validation is not cryptographic integrity. Backup/restore is an operator action, not an HTTP capability.

## Offline lease recovery

An abrupt kill or crash during startup can leave `writer.lock` or `startup.lock`.
A foreign PID namespace is ambiguous: another container's PID 1 is not proof the
previous writer died. The store fails closed rather than resetting the economy.
Normal graceful restart releases the writer lease; automatic recovery across
ambiguous container namespaces is not promised.

Recovery is a manual administrator operation, never an HTTP action:

1. Stop **all** writers to the exact companion volume. Administratively inhibit
   container recreation, upgrades, automation and other starts for the whole
   maintenance window. A stopped-container scan alone is not a concurrency lock.
   If exclusivity cannot be established, stop here.
2. Back up the volume privately, including `owner.json`, `initialized` and lease
   artifacts. Record state hashes without publishing snapshots, cards or identities.
3. Offline, check the snapshot against the current core schema and owner identity,
   byte bound, regular-file/no-symlink constraints, ownership and permissions.
   Confirm the initialized marker is intact. Unknown versions, missing or corrupt
   state require separate investigation, not a reset.
4. Only after establishing that no writer remains, quarantine the abandoned
   lease/startup gate for review. Preserve `owner.json` and `initialized` unchanged;
   never delete or edit them to bypass a startup error. Verify state hashes before
   restarting and keep the backup/quarantine private.
5. Start exactly one service, verify authenticated state and any active hand,
   then restore normal administration. If startup still refuses, stop and
   investigate rather than repeatedly clearing locks.

This does not provide distributed locking, multi-replica support or guaranteed
recovery from physical storage failure. Further recovery hardening is tracked in
[issue #1](https://github.com/bro-rad/radgotchi/issues/1).

## Original mechanics and interface

Zero initial XP; actual clicks earn original +2 XP (3000ms cooldown), original level/rank thresholds, coinflip 5–500 with 1.8× gross payout, blackjack 10–500 with original dealing/ace/soft-17/natural/double/settlement rules, four original consumables/prices and bounded inventory. Sprite click and PET use the same authoritative action. Games cannot alter the observed sprite or package data. Local Pomodoro/contracts do not mint XP. No passive XP, offline needs decay, sleep economy, chat or daily-contract rewards are claimed.

The production shell loads original arcade styles with a narrow full-width, scrollable grid extension. Optional audio starts muted and requires user interaction; Pomodoro start/completion events are wired to the audio adapter. Neither audio nor focus events change the authoritative economy. Original artwork and shared styles are preserved.

## Packaging/release gates

All six existing `RADGOTCHI_MONITORING_*` Compose keys and defaults remain unchanged. The companion directory setting is image-internal, not a seventh owner Config key. Maintained descriptors target 0.1.5; do not overwrite the qualified release with later source changes.

For successors: obtain explicit topology/version approval; validate native manifest/Compose; qualify the exact image including volume ownership, entrypoint, restart recovery and original assets; preserve the prior release; stage/install only with separate authorization. Source tests alone do not establish installation or live acceptance.

Source qualification command:

```sh
RADGOTCHI_TEST_CHROMIUM="/absolute/path/to/chromium" npm test -- --serial
```

Synthetic tests cover native browser token login, real API earned progression and all shop item paths, browser coinflip and blackjack hit/stand/double, masked cards, reload/lifecycle/layout, shared owner sessions, concurrent CAS, retry reconciliation, authenticated refusal matrix, restrictive storage, corruption/symlink/missing-state refusal, failed commit, active-hand restart and killed-process lease recovery. Injected fixture clock/RNG are function options only, never HTTP controls. This is not live inventory or real-phone acceptance, and simulated failed commit/process death is not a physical power-loss test.
