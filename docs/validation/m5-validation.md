# M5: Explore verification

Version 0.9.0 · 2026-10-18. These checks verify representation and orchestration,
not measured puck geometry or independent espresso accuracy. **G5 hardware frame-rate
targets remain open.** The [contract](../model/m5-explore.md) specifies what the
view represents and the distinction between refined 1D and future 2D Tier 2.

## Coupled state and resolution

The Rust selected-cell tests compare opt-in exports against the actual retained
solver arrays. Existing outputs remain bit-identical when selected-cell export
is enabled at standard resolution. Class dry-mass-weighted extraction agrees
with the selected continuum cell; kernel shells are exact state copies, not an
analytic reconstruction. Dry, all-surface and absent-pool cases remain explicit.
Index, resolution and retained-snapshot memory bounds reject invalid requests
before solving.

Native and production-worker WASM tests exercise both standard and high requests.
High changes only the depth grid, from 30 to 150 cells, and checks refined indices
through cell 149. It retains the same column count, source PSD classes and kernel
shells. Full default 30-class/51-passenger runs produce finite concentrations
bounded by initial content, surface fractions in [0,1], and hydraulic/solute
conservation residuals below 1e-9 at both resolutions. The implicit transport
and thermal stepping do not need a new explicit CFL limit.

High-only resource accounting counts the distinct transport groups actually
solved by the existing model (10 in the default recipe). The prior species-by-species
upper bound would reject the refined default despite shared transport states.
Existing state/work limits still apply; normal and standard-export checks keep
their prior accounting and warning text.

One native release measurement on the development machine (AMD Ryzen 9 7945HX,
Linux x86_64) took **0.951 s standard / 4.866 s high** for the default recipe. This
is a local sample, not a calibrated benchmark or a promise that refinement
improves empirical accuracy.

## Representative geometry and UI

Tests cover seeded deterministic packing, exact PSD class weights including
fine and rare classes, bounds through 150,000 particles, and a complete small
overlap audit compared with brute force. Large packing is bounded and can retain
overlap; diagnostics do not declare it mechanically equilibrated. The small
pore lattice is checked for CG residual and inlet/outlet conservation, including
the explicit disconnected case. No lattice potential or flux feeds the shot
solver.

Shared-controller tests cover one automatic/full run owner, cancellation,
supersession, late results, refined request forwarding and retry. Playback uses
actual stored snapshots, initializes from returned cell metadata, and pauses
when hidden. Worker tests cover stale count/outcome results, hidden/unmounted
cancellation, cache reuse and security/clone failures. Inspector tests preserve
exact shell tables and honest absent-data cases. All seven guided recipes are
built with the actual WASM module and checked against their declared changes.

The browser E2E includes the standard and refined runs, keyboard cell selection,
timeline scrubbing, mismatched-cell data suppression, all four particle budgets,
mobile layout, network/cutaway controls, 3D-context-loss and startup-without-WebGL
fallbacks. Preview-to-Tier-1 selection retains the edge annulus and physical depth. The existing
privacy audit includes the model worker and checks same-origin requests and CSP.

## Frame-rate evidence and outstanding gates

The optional device measurement rotates the current view for approximately
three seconds. It measures presented render callbacks in the current browser;
it is not a guarantee across recipes, viewport sizes, DPR, thermals or devices.
The E2E writes raw per-count measurements to
`web/test-results/explore-frame-rates.json` (generated local test artifact).

Headless Chrome uses **ANGLE SwiftShader software rendering** in this environment.
The [recorded software measurements](m5-rendering.json) were:

| Particle count | Viewport width | Measured frame rate |
|---|---|---|
| 30,000 | 1280 px | 2.5 fps |
| 150,000 | 1280 px | 1.3 fps |
| 5,000 | 390 px | 19.0 fps |
| 25,000 | 390 px | 4.8 fps |

These do not meet the planned targets in software. They establish that each
display budget can render and be inspected, but do not establish either hardware target:

| Gate | Required evidence | Status |
|---|---|---|
| G4 local EY | Representative weighted EY within 0.5 percentage points of selected continuum cell | Verified by actual core/WASM and model/UI checks |
| G5 laptop | At least 60 fps around 30,000 particles on a mid-range laptop | Open: hardware measurement needed |
| G5 phone | At least 30 fps at 5,000–10,000 particles on a recent phone | Open: hardware measurement needed |
| No WebGPU | Working 3D or inspection fallback | WebGL2 plus SVG/data fallback exercised |

Increasing particle count 5× is optional and does not relax the existing G5 gates.
Default golden fixture numbers and the published calibration/data splits remain
unchanged. Existing M1/M2/M3/M4 empirical validation limitations remain open.

## Release checks

- All 641 web tests pass; TypeScript, ESLint, Prettier, production build and
  production dependency licence checks pass.
- All 439 Python tests pass. Rust formatting, strict workspace clippy and all 272
  workspace tests pass. One existing opt-in full preset sweep remains ignored.
- The real Chrome E2E passes, including only same-origin requests, both worker types,
  no console/CSP errors and zero horizontal overflow at 390 px.
- Native golden checks retain all 4,203 kernel and 214,018 shot values exactly;
  only core-version strings change. M0/M1/M2/M3 report refreshes preserve all
  non-timing numbers, including existing failed empirical targets.
- Version manifests and native binding agree at 0.9.0.
