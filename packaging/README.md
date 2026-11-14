# Radgotchi Dappnode package — 0.1.5

Version **0.1.5** has been independently verified live. Maintained descriptors
use `radgotchi.public.dappnode.eth`, service `radgotchi`, image
`radgotchi.radgotchi.public.dappnode.eth:0.1.5`. Later working-tree changes still
require separate qualification; never overwrite the deployed tag.

Upstream: https://github.com/itsTylerIRL/radgotchi (Tyler / Radgotchi contributors).
Preserve LICENSE, README, original artwork and styles. No new artwork-rights claim
is made. The runtime contains the restricted dependency-free monitoring path plus
authenticated companion games/shop and durable owner storage, not Electron,
skills, shell execution, mesh, NATS, LLM or legacy persistence/bootstrap.
Identified container/service monitoring and chat providers remain deferred.

## Container and configuration boundaries

Use the repository root as build context with `packaging/Dockerfile` and an engine
that honors `Dockerfile.dockerignore`. The parent image is digest-pinned; target
architecture and vulnerability status require fresh release qualification.
The descriptor uses UID/GID 1000, drops capabilities and sets no-new-privileges.
It mounts the named `companion` volume at `/data/companion` for games, shop,
progression, active blackjack hands and retry receipts. It declares no published
host port, Docker socket, privileged mode or host namespace. `expose: 3000` is
internal metadata, not host publication.
Native validation previously rejected `read_only`; no read-only-root claim is made.
Root-owned application files are not writable by the service user. Sessions/cache
are in memory and restart requires login again. Restart policy is `no` so blank
required configuration does not cause a restart loop.

All existing environment keys remain present. Generic defaults contain no secrets:

| Environment | Configuration |
| --- | --- |
| `RADGOTCHI_MONITORING_MODE` | Exactly `1`; invalid/unset mode refuses legacy fallback. |
| `RADGOTCHI_MONITORING_HOST` | `0.0.0.0` inside the container. |
| `RADGOTCHI_MONITORING_PORT` | `3000`, internal only. |
| `RADGOTCHI_MONITORING_ORIGIN` | Blank default; requires exact HTTPS browser origin, no trailing slash/path/query/credentials. |
| `RADGOTCHI_MONITORING_TOKEN` | Blank default; requires owner-generated random 32–64 byte hex secret. |
| `RADGOTCHI_MONITORING_INVENTORY_URL` | Blank default; optional read-only public-packages HTTP(S) URL, no credentials/query/fragment. Blank means unconfigured. |

No wizard is included. Enter secrets only through a verified confidential owner
configuration flow, never source, chat, command arguments/logs or URLs. Dappnode
environment configuration is administrator-readable, not vault storage. Use the
`/login` password form, not legacy query-token authentication. The token grants
one owner principal across sessions; it does not enroll separate players.

Graceful shutdown releases the companion writer lease. Abrupt termination can
leave an ambiguous lease that fails closed on restart. Follow the
[manual offline recovery procedure](../docs/companion-integration.md#offline-lease-recovery)
with all writers stopped and recreation inhibited; never delete the owner state.

## Ingress

Configure your own HTTPS browser origin and ingress. A manifest `links.ui`
entry supplies navigation only, not DNS, TLS or tunnel configuration.
Preserve existing ingress and sibling routes; do not create automatic exposure or
add manifest `exposable`. Private testing uses a separately approved mapping and
an explicit origin transition: the application accepts one exact origin, not
wildcards. Public delivery does not make authenticated inventory public.

The application is an HTTP listener behind trusted HTTPS termination. Exact
Host/Origin checks and Secure cookies do not encrypt the connector-to-app hop.
Verify browser-to-edge TLS, backend-hop trust, intended network access and proxy
headers independently. Shared Dappnode networks are not package-exclusive
isolation. No Dappmanager/core updates are required or authorized by this package.

## Source-only checks

```sh
npm test
npm test -- --serial
```

The portable runner includes root and packaging tests. Browser tests require an
explicit `RADGOTCHI_TEST_CHROMIUM` executable; use serial mode when opting in.
See [local acceptance](../MONITORING-LOCAL.md). Skips are not browser acceptance;
record actual results rather than relying on a fixed documented test count.
Source tests do not pull/build/run images or contact the live deployment.

## Exact-image harness — separate authorization required

`runtime-test.cjs` is not part of `npm test`. Before any authorized run, supply:

- `RADGOTCHI_TEST_IMAGE`: full immutable `sha256:` image ID of the candidate.
- `RADGOTCHI_TEST_TAG`: exact service-qualified tag matching the maintained manifest.
- `RADGOTCHI_TEST_OUTPUT`: new absolute evidence-file path in private scratch space.

Then run `node packaging/runtime-test.cjs` only after image execution approval.
There are no implicit image/tag/output defaults. The harness refuses malformed
inputs, stale/generic tags, an existing output, a tag-to-ID mismatch, unexpected
architecture/user, or an image currently used by a running local container.
It never execs into a live service. It runs only randomly named, uniquely labeled
network-none disposable containers from the verified ID with `--pull=never`,
checks source/served asset hashes including original `chat-window.css`, and
removes only containers whose exact name, image and per-run ownership label match.
Cleanup uses their inspected IDs and verifies absence. Inspect cleanup failures;
never use broad prune or name-prefix deletion. An interrupted/killed harness can
leave evidence/containers requiring separately reviewed exact-ownership cleanup.

This harness uses synthetic in-container HTTP with HTTPS Host/Origin headers:
it does **not** prove TLS, native browser behavior, live inventory or installation.
It targets linux/amd64; another architecture requires explicit qualification changes.
New source hashes must be qualified against a newly versioned candidate, not the
old deployed image. Preserve all environment keys across successor releases.

## Evidence and release hygiene

Retain these local historical files but leave them **unstaged**:
`verification.json`, `runtime-verification.json`, `deployment-preflight.md`.
Exact `.gitignore` entries keep operational records out of source publication;
do not delete or rewrite them as current evidence. New evidence should live in
private scratch/release storage, not mixed into maintained source.

Native descriptor validation, immutable-image qualification, archive hashes,
installation approval, installed-state readback and real-browser acceptance remain
separate per-release gates. This documentation does not authorize any build,
Docker execution, upload, deployment, commit or push.
