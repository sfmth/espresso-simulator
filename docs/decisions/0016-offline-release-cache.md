# ADR 0016: complete static release caches and explicit offline updates

## Status

Accepted, 2026-10-19. First M6 slice in 0.10.0; public launch gates remain open.

## Context

The GitHub Pages app has a shared WASM engine, two module workers and lazy Explore
code. Caching only the landing page would leave unvisited features unavailable
offline. Replacing a worker while old tabs are open can mix release assets or
interrupt simulations. User records must remain separate from app downloads.

## Decision

- Generate an exact inventory after Vite has emitted every production/public file.
  Hash paths, content and the generator source (including the worker) into a release identity. Omit
  its derived HTML meta value from that identity to avoid self-reference, then
  check the final HTML bytes during installation like every other asset.
- Precache the complete same-origin build and verify each asset digest before
  writing the completion marker. Failed installation leaves the incumbent cache
  intact. Never write arbitrary runtime requests into the app cache.
- Scope registration, URLs and cache names to the current deployment path. Serve
  the cached index for app-root/index.html navigation, ignoring its query/fragment
  without storing either. Exact known public pages keep their own content.
  Queried assets and unrelated routes remain network requests.
- Claim clients automatically only for a fresh installation with no incumbent
  worker or previous scoped cache. Updates wait for an explicit user
  reload action. Other open tabs are never reloaded by that action.
- Retain prior complete release assets while any window remains. A newly active
  worker can serve exact old content-hashed assets for tabs using an old module
  graph. Remove old scoped caches only during activation with no open windows.
- Confirm readiness against the current page's release ID. Treat unsupported
  storage, installation failures and eviction as unavailable, while keeping the
  connected app usable. Show offline state and a plain reload warning.
- Keep app caches separate from IndexedDB journal records. Document exports,
  eviction, clearing site data and hosting logs in a local privacy page.

## Consequences

The first complete download costs a few megabytes and needs a connection. Cached
files can be evicted by the browser. Retaining older builds protects open tabs
but uses storage until safe cleanup; quota failure preserves the existing build.
An explicit reload can reset unsaved editor state, so the update UI says to export
inputs first. Journal storage and numerical behavior are unchanged.

## Alternatives considered

- Runtime caching on demand: fails for unvisited lazy code or workers offline.
- Unconditional skipWaiting/claim/reload: can replace a running session.
- Deleting every old cache on activation: breaks old tabs and sibling apps.
- A service-worker framework: unnecessary for a small, fixed static inventory;
  browser and VM tests exercise the minimal implementation directly.
