# 0003: Web stack

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

The site is a static, offline-capable single-page app ([PLAN.md §7.5](../PLAN.md#75-technology-proposed-recorded-as-adrs-in-m0), §9). It has three modes sharing one simulation state, live charts, and later a 3D particle view. It must never make third-party requests at runtime (D9).

## Decision

- **Language and framework:** TypeScript in strict mode, built with Vite; React for the UI and Zustand for shared state.
- **Charts:** uPlot for time series; D3 modules with SVG or Canvas for distributions, heatmaps and radar charts.
- **3D (M5):** Three.js through react-three-fiber, with the WebGPU renderer and a WebGL2 fallback.
- **Off the main thread:** all simulation runs in Web Workers. The UI talks to them through a typed, Promise-based client (`web/src/engine/`).
- **Self-contained bundle:** all assets are bundled locally, with system fonts, no CDNs and no analytics.

## Consequences

- The app needs a build step (npm, Vite). It depends on the WebAssembly bundle, so CI builds the WASM before the web app.
- A licence check over production dependencies runs in CI ([ADR 0007](0007-licensing-and-dependency-policy.md)).

## Alternatives considered

- **Svelte 5.** Less boilerplate, but a smaller ecosystem for 3D and charting.
- **Vue.** Similar trade-offs to React with a smaller pool of contributors in scientific visualisation.
- **Plain TypeScript without a framework.** Too much hand-written state plumbing for three linked modes.
