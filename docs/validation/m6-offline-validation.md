# M6.1 offline verification

Version 0.10.0 · 2026-10-19. This verifies the offline application lifecycle. It
does not complete M6 or establish scientific accuracy, prospective V9, predictive
coverage, physical phone installation behavior or hardware G5 performance.

## Browser evidence

`cd web && npm run e2e:offline` builds the production app and starts a temporary
same-origin static server. The test uses installed headless Chrome 131 on Linux,
real service workers, a 1280×900 desktop viewport and 390×844 phone layout.
Serving headers use `Cache-Control: no-store`; the main page additionally has
HTTP caching disabled through CDP. During offline sections both the browser and
the server refuse network downloads. The server guard matters: this Chrome can
still attempt browser-managed worker-update requests during offline emulation;
the test refuses those requests rather than mistaking them for offline assets.

The generated local artifact `web/test-results/offline-checks.json` records the
browser version, synthetic A/B release IDs and passed assertions. A/B fixtures
clone the production output and add distinct content-hashed probe assets so
cross-release routing is tested without changing production code.

The browser checks cover:

- Scope and relative install metadata under `/puckworks-offline/`, with a second
  independent root deployment. Both receive complete-cache confirmation from
  their controlling worker and reload with the engine offline.
- Fresh `index.html?…#…` navigation offline, a new engine worker and a full Tier 1
  simulation. Explore has never been opened online: its lazy renderer, packing
  worker and coupled particle state still load while disconnected.
- A real journal prediction saved in IndexedDB, offline reload, export and
  idempotent import, followed by persistence across a release update. The local
  privacy/storage page also opens offline.
- No successful app-file delivery from the HTTP server during the offline
  application flow. Unknown files and queried assets cannot be satisfied by
  the app cache. Connection status and phone layout remain usable.
- A new release with a missing asset fails installation and leaves the old
  release ready for another offline reload.
- A complete new release waits without replacing live page state. The explicit
  update button reloads only the selected page; another old tab retains its
  sentinel state, offers its own update action and can fetch its old immutable
  probe from the retained cache while offline.
- No third-party requests or page errors across the main, second-tab and root
  flows. Intentionally rejected offline/network-install requests are expected
  transport failures, not application exceptions.

The existing production E2E remains part of `npm run e2e`, covering actual
WASM/Node agreement, both Explore grids, all four particle populations,
fallbacks, journal concurrency, request privacy and console/CSP errors.

## Build, cache and runtime checks

VM tests execute the emitted classic worker against explicit storage/network
models. They exercise complete inventory and digest checks, deterministic
finalization, Vite/native-loader identity, malformed or missing completion state,
HTTP/network/integrity/quota failures, first-install claiming, explicit waiting
activation, query/scope/method boundaries, old immutable assets and scoped cleanup
only with no windows. Runtime tests exercise registration paths, build matching,
waiting and other-tab updates, explicit reload targets, incomplete/malformed
status, event races, timeouts, unavailable features, listener/port disposal and
development-mode exclusion. UI tests check readiness, update warnings and actions.

All production dependencies remain on the existing licence allow-list; no new
runtime package is added. Native, Python and WASM bindings agree on 0.10.0.
All 717 web tests in 50 files pass, including 20 build/worker and 20 runtime/UI
regressions. Type checking, lint, formatting, production build and licence checks
pass. The local build inventory contains 17 app files totaling about 3.07 MB,
plus the generated inventory report and worker script.
Focused Rust/Python/cross-language checks and exact fixture audits preserve every
one of the 218,221 golden numerical values. Generated M0–M3 reports change only
version/build/timestamp/hash metadata and timing observations; existing empirical
limitations remain unchanged.
