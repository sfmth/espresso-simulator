# M6.1: offline app contract

Version 0.10.0 · 2026-10-19. This is the offline slice of M6; it does not establish
the scientific, prospective accuracy or device-performance exit gates.

## Installation and storage

The production build adds a relative install manifest and a classic service worker
at `sw.js`, scoped to the app directory. HTTPS or a trustworthy localhost origin
is required by browsers. Development mode never registers it. Home-screen install
availability depends on the browser; ordinary offline tabs use the same cache.

The post-build inventory includes HTML/CSS, all entry/lazy JavaScript, both module
workers, the WASM engine, icons, manifest, local privacy page and third-party
notices. `offline-release.json` lists each app asset's bytes and SHA-256 digest.
The derived report itself is also precached. The build ID covers the canonical
inventory and entire generator source, including the worker; its injected HTML meta is omitted from that
identity and included in the final HTML installation digest.

Installation fetches exact same-origin URLs and verifies responses and bytes.
The completion marker is written only after every asset is stored. A failed
download, integrity check or quota write cannot publish a partial build or delete
an already complete incumbent release. No recipes, imports, journal records,
ratings, calibration or simulation results enter this app-file cache.

`Ready for offline use` requires a controlling worker to confirm a complete cache
whose ID matches the page. A saved but uncontrolled copy offers a reload to enable
offline use. Connection events refresh status; unavailable storage and messaging
failures do not block connected simulation. Browser eviction or clearing site
data can remove files after readiness; the cache is not a durable backup.

## Fetch boundaries

Only GET requests within the exact origin and deployment scope are eligible.
The app root and `index.html` navigation return that build's cached index,
including when the navigation URL has a query or fragment; neither becomes a
cache key. Other known assets use their exact stored URLs. Queried assets,
unknown paths, sibling applications and non-GET requests receive normal network
behavior. There is no runtime cache-write policy and no general navigation
fallback for unrelated paths.

## Updates and open tabs

A fresh first installation may claim the page only when there is no incumbent
worker or older scoped cache. A new release otherwise waits. Choosing
`Reload to update` permits activation and reloads only the requesting page once
the requested release is ready. The UI explains that reload closes simulations
and can reset unsaved recipe inputs. Other tabs show update availability and
continue their current session without an automatic reload.

Older complete release caches remain while windows are open. After activation,
exact content-hashed assets from those caches can satisfy old tabs' module graphs;
unhashed public assets and navigation remain tied to the active build. Activation
with no windows may remove old caches under this exact app scope only. IndexedDB,
local storage and other applications' caches are never cleared by this lifecycle.

## Privacy and limits

All app and worker requests remain same-origin. The cached privacy page explains
hosting access logs, browser storage, exports and backups. Local journal data
remains subject to existing IndexedDB durability and private-session limits.
Installation is optional, an initial visit needs a connection, and offline support
does not make a browser database a backup. Physical phone install behavior and
hardware G5 measurements remain separate from automated desktop browser checks.
