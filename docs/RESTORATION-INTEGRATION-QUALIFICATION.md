# Restoration integration qualification

## Current production scope

Release **0.1.5** has been independently verified live. This is distinct from
qualification of later source changes; private deployment records are not part
of the publishable documentation.

The restricted shell integrates package observations/freshness, token login,
original artwork and RAD TERMINAL styling, local interactions/Pomodoro,
authenticated original-rule arcade/shop with durable owner storage, and optional
muted-by-default audio. It loads no legacy bridge, executable tools, chat/LLM,
RAD MESH or NATS integration. Package-only is the monitoring scope, not a claim
that the companion has no games or storage.

## Repeatable source checks

Use [local acceptance](../MONITORING-LOCAL.md) for the portable test command and
explicit Chromium opt-in. Inspect actual pass/fail/skip results for the checkout
being reviewed; historical fixed test counts are not current acceptance.

The combined qualification should cover:

- Native `/login` form submission, session protection, Origin/Host checks and
  unauthorized behavior against the actual server.
- Exact static allowlists, served original assets and original glow/contrast;
  desktop and narrow viewport layout, visible progression, focus and controls.
- Waiting, unconfigured, connected, stale, failed and recovered observations;
  package selection and freshness independent of stalled polling.
- Companion clicks earned from zero, coinflip, blackjack hit/stand/double,
  masked cards, shop purchases/use, shared-owner sessions, CAS conflicts and
  explicit uncertain-response reconciliation without duplicate wagers.
- Volume-backed state, active-hand restart, corruption/missing-state refusal,
  atomic commit failure and fail-closed ambiguous writer leases.
- Optional audio gesture/mute behavior, local timer behavior, storage denial,
  lifecycle cleanup and remount without duplicate listeners.

Fixtures are synthetic, not live Dappnode inventory. Phone-sized desktop browser
viewports are not physical-phone tests. Simulated process death is not physical
power-loss qualification. See [companion storage and recovery](companion-integration.md)
for persistence boundaries.

## Release gates and remaining scope

Source tests do not establish built-image parity, installation or live health.
Follow [packaging qualification](../packaging/README.md) for exact-image and
per-release approval gates. A passing API test is not proof of native browser
login, TLS, configured inventory freshness or artwork rendering.

No host CPU/resource metrics, identified services, application-health claims,
chat, NATS or mesh are included. Pomodoro is local focus state, not verified
attention or server XP. Full desktop lifecycle parity remains future work,
tracked in [issue #1](https://github.com/bro-rad/radgotchi/issues/1).
