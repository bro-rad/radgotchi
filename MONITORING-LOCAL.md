# Local monitoring acceptance

## Scope

These source checks use synthetic fixtures, not live inventory. The deployed
0.1.5 release has been independently verified live; passing local tests does not
qualify later working-tree changes as installed or prove they match that image.

Run from the repository root with Node's built-in test runner:

```sh
node --test test/monitoring-integration.test.js
npm test
npm test -- --serial
```

`npm test` discovers root and packaging `.test.js`/`.test.cjs` files without
shell glob expansion. Browser tests explicitly skip unless
`RADGOTCHI_TEST_CHROMIUM` names a Chromium-compatible executable. For real
browser acceptance set that environment variable to your own absolute executable
path, then run `npm test -- --serial`. On POSIX shells, for example:

```sh
RADGOTCHI_TEST_CHROMIUM="/absolute/path/to/chromium" npm test -- --serial
```

Use serial mode for browser runs to avoid competing browser fixtures. The browser
tests create isolated temporary profiles, not the owner's logged-in session.
Inspect pass/fail/skip output for each run: skipped browser tests are not browser
qualification. No browser, dependency or container installation is implicit.

## What is exercised

The integration starts the actual `createMonitoringServer` HTTP server and an
explicitly SYNTHETIC loopback public-inventory server on ephemeral ports. It
creates an ephemeral random access token internally, posts the actual login
form over HTTP, and uses the returned session cookie. No token or session is
printed or persisted. No real node inventory or live credential is accessed.

It fetches the real HTML and its referenced CSS, JS and PNG assets, checking
HTTP status, MIME types, nonempty bodies and PNG signatures. The HTTP-served
production panel script runs unchanged in a minimal Node VM DOM harness.
Its fetch wrapper makes real same-origin HTTP requests with the session cookie;
there are no mocked API responses. The harness manually advances the panel's
30-second scheduling callback rather than waiting in real time.

Assertions cover:

- Three synthetic inventory rows grouped into two packages, distinct versions
  and running/exited counts; IP fields absent from API and rendered output.
- Package-only coverage without invented container identity or health.
- Upstream receives neither browser cookie nor authorization header.
- Actual upstream shutdown yields stale last-good observations retained by the
  backend and rendered as stale by the frontend.
- Removing the harness cookie produces an actual HTTP 401: displayed inventory
  clears, login link appears, and polling stops.
- Both servers close, including cleanup hooks on assertion failure.

**This is DOM-harness integration, not a real-browser test.** It does not prove
layout, browser cookie enforcement, CSP enforcement or automatic script startup.
Separate opt-in real-browser tests cover native form submission and expression
rendering. Panel unit tests additionally cover the automatic-start contract.
Identity-rich container/service monitoring is deferred and not shipped.
Companion API, store, arcade and audio tests cover separate restored features;
package-only describes the observation scope, not the whole application.

## Existing runtime environment configuration

For owner-controlled local operation, `node headless.js` selects the isolated
monitoring path only when `RADGOTCHI_MONITORING_MODE=1`.

| Variable | Configuration |
| --- | --- |
| `RADGOTCHI_MONITORING_MODE` | Exactly `1`; other nonempty values fail closed. |
| `RADGOTCHI_MONITORING_ORIGIN` | Required exact browser origin, e.g. `http://127.0.0.1:3000`, with no trailing slash. Plain HTTP is loopback-only. |
| `RADGOTCHI_MONITORING_HOST` | Bind address; defaults to `127.0.0.1`. Keep loopback for local HTTP. |
| `RADGOTCHI_MONITORING_PORT` | Port; defaults to `3000`; match the browser origin's port for direct local access. |
| `RADGOTCHI_MONITORING_TOKEN` | Owner-supplied cryptographically random 32+ byte hex token (64–128 hex characters), kept private. Not the legacy web token. |
| `RADGOTCHI_MONITORING_INVENTORY_URL` | Optional backend-only public-packages HTTP(S) URL. No URL credentials, query or fragment. Omission reports `unconfigured`. |

The public projection is an array of `{name, version, state}` rows (extra fields
such as IP are dropped), not the separate identity-rich monitor adapter format.
The runtime defaults to a 10-second backend cache and 3-second upstream timeout;
the acceptance overrides cache to zero for immediate outage testing and uses a
500 ms upstream timeout. Browser polling remains 30 seconds.

Open `/login` and use the private token through the form, never in a URL. These
notes do not establish a live upstream endpoint or configure a real node. The
acceptance needs none of these environment variables and does not consume any
existing runtime token.

The native companion store defaults to `~/.radgotchi/companion`; use an isolated
absolute `RADGOTCHI_COMPANION_DIR` for local experiments. Packaged operation pins
`/data/companion` to its named volume. Games, shop, receipts and active blackjack
hands persist independently of monitoring. See [storage and offline recovery](docs/companion-integration.md#offline-lease-recovery).
