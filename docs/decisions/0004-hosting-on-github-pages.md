# 0004: Hosting on GitHub Pages without cross-origin isolation

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

The owner chose GitHub Pages (D14). Pages serves static files from a project sub-path (`https://<user>.github.io/<repo>/`) and cannot set custom HTTP headers. WebAssembly threads and `SharedArrayBuffer` require cross-origin isolation (the COOP and COEP headers), so they are unavailable there.

## Decision

- **Deployment.** GitHub Actions builds and deploys the site (`.github/workflows/pages.yml`). The repository's Pages source must be set to "GitHub Actions".
- **No shared memory.** The app does not use `SharedArrayBuffer` or WASM threads. Parallelism comes from a pool of Web Workers, each with its own WebAssembly instance. Results return as transferable `ArrayBuffer`s, not copies.
- **Relative paths.** Vite builds with `base: './'`, so the site works under any repository sub-path.
- **No third-party requests.** Every asset is served from the same origin (privacy, D9).

## Consequences

- Each worker holds its own WASM instance and memory. That costs little: the module is about 50 KB, and the state is a few MB per worker at Tier 1.
- Work is split by independent units (species, columns, ensemble members), not by shared-memory loops.
- The privacy page has to name GitHub Pages as the host, because its access logs are outside the app's control.

## Alternatives considered

- **Cloudflare Pages or Netlify.** Both can send COOP/COEP headers, but the owner chose GitHub Pages.
- **A service worker that adds the isolation headers (the coi-serviceworker approach).** It is fragile, intercepts every request, and breaks on first load.
