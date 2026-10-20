# Puckworks

An open-source espresso simulator that runs entirely in the browser. It models a shot from bean and grinder, through the puck and the flow, to the cup. The goal is to follow the ~55 compounds that dissolve and to end with an explainable taste estimate, giving every number a source and an uncertainty band. The status below says what exists today.

**Status:** version 0.10.1 continues **M6 with offline support and keyboard accessibility fixes**. After the app reports **Ready for offline use**, Lab, Dial-in and Explore can work without a connection, including the WASM engine and previously unopened Explore renderer. Supported browsers can install the app from their own menu. Updates wait for **Reload to update**; export current recipe inputs before reloading. Saved journals remain in this browser. [Offline contract](docs/model/m6-offline.md) · [Verification](docs/validation/m6-offline-validation.md) · [Privacy and storage](web/public/privacy.html). **M6 public launch and the existing scientific, personal accuracy and hardware performance gates remain open.**

Explore's camera supports keyboard orbit, zoom and reset; its timeline and selected-cell/particle readouts expose the actual numerical state. Every chart has **Read chart values** for all plotted samples and runs. Journal actions retain keyboard focus when a form or row disappears. A production browser audit covers expanded controls, light/dark themes and phone layouts; this is a regression check, not a claim of full accessibility conformance. [Keyboard controls and audit limits](docs/model/m6-accessibility.md).

M5 experimental Explore provides exact sphere rendering, a reproducible rendering benchmark, representative particles, the puck cross-section and actual selected-cell kernel shells on one shared timeline. Refined cross-sections show 150 depth cells with boundaries and scrollable detail. Standard and 5× depth refinement use the same Tier 1 parallel 1D physics; displayed particle counts change visual detail independently. WebGL2 has SVG/table fallbacks and needs no WebGPU. Packing and its optional pore lattice are illustrative and do not feed back into extraction. [Explore contract](docs/model/m5-explore.md) · [M5 verification](docs/validation/m5-validation.md) · [Rendering performance](docs/validation/m5-rendering-performance.md).

M4 experimental Dial-in remains available: forecast-before-observation records in IndexedDB, finite-grid local calibration, bounded advice with Tier 1 rechecks, shot-log imports, personal ratings and prospective scoring. [Dial-in contract](docs/model/m4-dial-in.md) · [M4 verification](docs/validation/m4-validation.md). Personal accuracy target V9 remains open; synthetic checks do not establish it.

M3 input ensembles and explainable taste remain available in the Lab: [uncertainty contract](docs/model/m3-uncertainty.md) · [taste contract](docs/model/m3-taste.md).

The existing v2 fit is unchanged. **Scientific validation remains incomplete:** the [M1 report](docs/validation/m1-validation.md) retains its existing targets, and the [M2 report](docs/validation/m2-validation.md) distinguishes conditional Gloess comparisons from independent validation. Estimated species, acidity, aroma, phase recovery and taste indices are labelled. Scenario percentiles do not establish predictive coverage, and the taste indices have not been validated against an espresso sensory panel. The pre-M2 report is [preserved](docs/validation/baseline-v0.5.0/README.md).

| Part | What exists |
|---|---|
| Shot simulator | A physics solver for the whole shot. It covers flow through any basket shape (plain or pressurised), the wetting front, puck compaction, ideal or vibratory pumps, extraction from ~30 particle-size classes, 55 catalogue compounds with shared transport bases and separate phase recovery, temperature and the post-shot drip. It gives bit-identical results in Rust, Python and WebAssembly. Full shots run in a browser worker, with a cheaper tier for live previews; measured runtimes are in the [changelog](CHANGELOG.md). |
| Input models | Bean, grinder (burr family and gap, a grinder preset with its dial, or your own measured particle sizes), basket (any profile), puck preparation and machine programs. Every value has a source in the parameter registry. |
| Presets | 7 grinders, 12 baskets, 10 machine programs and 9 beans. The owner's own gear is just one set of presets, marked unverified. |
| Shot lab (web) | A recipe editor for gear described by preset or from scratch; the shot graph, summary tiles and particle-size chart; a compound table with sources; a cross-section of the puck with the wetting front; 1D sweeps, pinned overlays and exports. |
| Uncertainty and taste | Seeded Tier 0 input ensembles with scenario quantiles, central Tier 0/Tier 1 comparisons, full report export and chemistry-based relative taste indices. Assumptions, evidence and omitted model errors remain visible. |
| Explore | Selected-cell particle/shell data copied from the coupled Tier 1 shot, standard or 5× depth refinement, a synchronized cross-section and inspector, deterministic representative packing, an illustrative pore lattice, seven guided scenarios and WebGL2/SVG/table paths. Hardware frame-rate targets remain open. |
| Dial-in | Shared recipe controls; immutable forecasts and measured shots in IndexedDB; finite-grid local calibration with identifiability diagnostics; three constrained inverse modes verified on Tier 1; CSV/DE1 imports, journal backups, Bayesian personal ratings and a prospective scorecard. |
| Offline app | A complete cached production build, install metadata, visible readiness and explicit update controls. App downloads and journal data use separate browser storage. First installation needs a connection; browser storage can be evicted. |
| Calibration and validation | 19 published datasets (Schmieder, Waszkiewicz, Cameron, Corrochano, Smrke, Vaca Guerra), with calibration on some and held-out tests on others. |
| Community comparisons | Safe offline import of original DE1 logs and the matching measurement sheet, followed by fixed-scenario comparisons. The [community report](docs/validation/community-shot-comparison.md) separates observed scale mass from estimated inlet flow and conditional model output; these sources have not entered the numerical fit. |
| Parameter registry | 540 sourced parameters, each with an evidence grade. Startup assumptions and experimental pressure storage are exposed in the sandbox. |
| CI | Rust, Python and web workflows, plus GitHub Pages deployment. |

Nothing you enter leaves your browser.

M5 is implemented and M6 offline support is available; remaining scientific accuracy, device-performance and surrogate work stays documented ([plan §12](docs/PLAN.md#12-roadmap-and-milestones)). The owner's AMZCHEF preset records a confirmed **58 mm single-wall basket**. No personal measurements or new equipment are required for development.

Calibration source selection includes online community shot archives and controlled hobbyist experiments; it does not depend on the owner's equipment. The [community-source audit](docs/research/04-community-shot-data.md) records candidate datasets and what each can support. Newly discovered sources have not yet entered the numerical fit.

## Repository

| Path | Contents |
|---|---|
| [`crates/puckcore`](crates/puckcore) | Rust numerical core: the particle kernel and the shot solver, deterministic, no required dependencies |
| [`crates/puckmodel`](crates/puckmodel) | input models, presets and the JSON API |
| [`crates/puckcore-wasm`](crates/puckcore-wasm), [`crates/puckcore-py`](crates/puckcore-py) | its WebAssembly and Python bindings |
| [`web/`](web) | the web app: TypeScript, Vite, React |
| [`python/`](python) | project tools: registry validation, preset export, calibration, validation reports, golden fixtures, version checks |
| [`data/`](data) | parameter registry, presets, datasets, calibration, fixtures |
| [`docs/`](docs) | plan, research notes, decision records, model documentation, validation reports |

## Documents

- [Consolidated plan and goals](docs/PLAN.md): vision, locked decisions, architecture, validation and roadmap.
- [Architecture decision records](docs/decisions/README.md): how it is built, and why.
- [M1 contract](docs/model/m1-contract.md): the recipe, shot-spec and shot-result documents, and the API in Rust, JavaScript and Python.
- [M2 chemistry, beans and water](docs/model/m2-chemistry.md): compound classes, water, cup observations and evidence limits.
- [M3 uncertainty](docs/model/m3-uncertainty.md), [taste](docs/model/m3-taste.md) and [verification report](docs/validation/m3-validation.md): scenario ranges, explainable indices and the distinction between numerical checks and sensory validation.
- [M4 Dial-in](docs/model/m4-dial-in.md): local records, calibration, inverse advice, preference learning and prospective scoring.
- [M5 Explore](docs/model/m5-explore.md): coupled particle state, depth refinement, representative graphics and open hardware performance gates.
- [M6 accessibility](docs/model/m6-accessibility.md): keyboard controls, numerical text alternatives and browser audit scope.
- [M5 rendering performance](docs/validation/m5-rendering-performance.md): benchmark protocol, rendering quality and device evidence.
- [Shot model](docs/model/shot-model.md): the shot solver's physics and numerics, with verification results.
- [Input models](docs/model/input-models.md): from a recipe to the physics, including the presets.
- [Particle kernel](docs/model/particle-kernel.md): the diffusion solver, with measured verification results.
- [M1 validation report](docs/validation/m1-validation.md) and [calibration](docs/validation/calibration.md).
- [M1.1 startup investigation](docs/validation/m11-startup.md): before/after results, fixed-fit ablations and remaining work.
- [Community shot comparisons](docs/validation/community-shot-comparison.md): reproducible online-data diagnostics, assumptions and remaining model limitations.
- [M0 kernel verification report](docs/validation/m0-kernel-verification.md), generated by `puckworks-tools verify`.
- Research notes:
  - [01 Extraction and flow physics](docs/research/01-extraction-and-flow-physics.md)
  - [02 Chemistry and sensory](docs/research/02-chemistry-and-sensory.md)
  - [03 Grinding, PSD and data](docs/research/03-grinding-psd-and-data.md)
  - [04 Community shot data](docs/research/04-community-shot-data.md): online archives, measurement provenance and calibration admission.
- [Contributing](CONTRIBUTING.md): setup, everyday commands and project rules.
- [Changelog](CHANGELOG.md).

## Quick start

You need Rust (via rustup), Node 22 or later, and Python 3.10 or later. Full setup is in [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
scripts/build_wasm.sh                 # build the WebAssembly engine
cd web && npm ci && npm run dev       # run the web app locally
```

## Rendering benchmark

Build the production app, then measure all four display populations with three trials:

```bash
cd web
npm run build
node scripts/render-benchmark.mjs --backend auto --quality exact --counts 30000,150000,5000,25000 --trials 3 --dpr 1
```

Use `--backend software` for explicit SwiftShader measurements. `--quality exact` requires exact sphere quality; `--quality current` accepts the build's recorded rendering path, including the frozen reference. The benchmark retains the requested particle count and DPR, reports actual canvas dimensions and WebGL backend, warms up for at least 1.5 seconds and 30 submissions, and samples a fixed five-second camera orbit. JSON includes frame interval median/p95, CPU submission times and optional asynchronous GPU timing. RAF cadence does not establish GPU completion or compositor presentation. The detected RTX 4080 Laptop GPU is high end hardware; midrange laptop and physical phone G5 gates remain open. See [reproduction and comparison rules](CONTRIBUTING.md#rendering-performance-measurements) and the [performance report](docs/validation/m5-rendering-performance.md).

## Principles

- **Physics first,** with machine learning for the gaps.
- **Provenance and uncertainty.** Every parameter has a source and an evidence grade. Scenario bands expose selected input uncertainty; they do not include every source of model error.
- **Private by construction.** The site never collects user data. Everything you enter stays in your browser.

## Licence

GPL-2.0-or-later. See [LICENSE](LICENSE). The built site includes `third-party-licenses.md`, which lists the licences of everything it bundles.
