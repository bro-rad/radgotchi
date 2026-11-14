# Dappnode companion — integration boundaries

This derivative preserves upstream Radgotchi attribution, license, original artwork
and RAD TERMINAL styling. Version **0.1.5** has been independently verified live.
That verification applies to the deployed release, not arbitrary later checkout
changes. Further restoration is tracked in [issue #1](https://github.com/bro-rad/radgotchi/issues/1).

## Shipped boundary

`RADGOTCHI_MONITORING_MODE=1` selects a restricted Node entry point, separate from
the original desktop and legacy headless paths. One owner token entered through
`/login` creates a session; production requires a configured exact HTTPS origin.
Sessions share one companion owner, not independent player accounts.

The existing read-only `/public-packages` projection supplies grouped package
states. IPs and unrelated fields are stripped; unknown health stays unknown.
Anonymous rows cannot establish stable container/service identities. This is not
host CPU, memory, process or application-health monitoring, and running does not
mean healthy. Stale and failed observations must remain visible.

Original-rule coinflip, blackjack, shop, click-earned XP, ranks and inventory are
integrated through the bounded companion API. A named companion volume preserves
state, active hands and retry receipts across normal restarts. Optional browser
Pomodoro and muted-by-default audio are separate from that economy: local focus
completion does not mint XP or change observations. See the
[companion contract](docs/companion-integration.md), including
[offline lease recovery](docs/companion-integration.md#offline-lease-recovery).

No Dappmanager/core patch, Docker socket, administrative credentials, automatic
remediation, executable skills or unrestricted Electron/web bridge is required.
The observation API is read-only; authenticated companion actions write only the
companion store. This is not a monitoring-only application or a stateless package.

## Deferred integrations

Chat/LLM, NATS/Natsyndor, RAD MESH, identified container/service monitoring and
DMS/Prometheus resource metrics are **not wired into this production path**.
Standalone experiments are not shipped capabilities or prerequisites for this
release. Upstream RAD MESH is UDP peer discovery, not NATS or package monitoring.

Future adapters need explicit read-only sources, provenance, freshness, bounded
requests and separately approved identity/authentication contracts. Natsyndor
must stay optional: broker failure must not block monitoring or game persistence.
Extend existing game APIs/score storage for external game telemetry, not the pet
ledger. Do not infer players from connections or IP addresses, invent missing
metrics, or put session identifiers in Prometheus labels.

The [capability roadmap](docs/ORIGINAL-CAPABILITY-RESTORATION.md) distinguishes
implemented restoration from future prerequisites; it is not a parity claim.

## Verification and release gates

See [local tests](MONITORING-LOCAL.md), [combined qualification](docs/RESTORATION-INTEGRATION-QUALIFICATION.md)
and [packaging](packaging/README.md). Source tests, exact-image qualification,
native validation, installed-state readback and browser acceptance are distinct
milestones. New source requires fresh qualification; do not overwrite a deployed
tag. Private deployment configuration, credentials and operational evidence are
not publication material. These documents authorize no build or deployment.

## References

- https://docs.dappnode.io/docs/dev/metrics
- https://docs.dappnode.io/docs/user/packages/dms
- https://prometheus.io/docs/prometheus/latest/querying/api
- https://docs.nats.io/running-a-nats-service/nats_admin/monitoring
- https://docs.docker.com/engine/security
