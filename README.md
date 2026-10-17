# Puckworks

An open-source espresso simulator that runs entirely in the browser. It models a shot from bean and grinder, through the puck and the flow, to the cup. The goal is to follow the ~55 compounds that dissolve and to end with an explainable taste estimate, giving every number a source and an uncertainty band. The status below says what exists today.

**Status:** version 0.6.4 adds a [5×/10× mesh-refinement study](docs/validation/m11-mesh-refinement.md): 240 full shots and 16 short pressure checks with fixed v5 coefficients. Increasing depth from 30 to 300 layers changes final cup extraction by at most 0.170 percentage points across the 24 conditions, but two pour-pressure predictions move from 6.12/7.58 bar to the 12-bar pump cap. The finer runs leave substantial startup and extraction-peak errors. Numerical defaults and fitted parameters are unchanged.

The preserved 0.6.3 [pressure-event correction](docs/validation/m11-pressure-events.md) and v5 calibration give 51/60 extraction rates and 174/180 cup masses within ±10%. All 15 leave-one-condition-out refits complete, giving 58/60 rates and 180/180 cup masses within ±15%. Those scores belong to their recorded build and grid; the refinement study performs no refit. Scientific validation remains open. See the [validation report](docs/validation/m1-validation.md) and [v5 calibration record](docs/validation/calibration.md#results-of-the-pressure-event-calibration-v5-2026-10-17).

The original calibration blocks, held-out split, physical priors and acceptance thresholds are unchanged. Guarded pruning retains 22 fitted parameters, with seven at or near bounds. Halving the timestep across all 15 training conditions preserves the rate and cup pass counts; the [resolution check](docs/validation/m11-pressure-v5-resolution.md) also reports pressure and switch-time changes. Numerical completion does not establish physical identification or a global optimum.

All nine sensitivity refits and 117 validation shots complete. First-fraction TDS passes, but startup delay, flow rise, the extraction-yield peak and shot timing remain inaccurate. Held-out timing slightly worsens. **No complete M1 scientific exit criterion passes, so M2 remains deferred.** The [calibration results](docs/validation/calibration.md#held-out-validation) report these limits alongside the cross-validation improvement.

Historical calibrations, the [0.6.2 evaluation](docs/validation/baseline-v0.6.2/m1-validation.md), [startup-parameter review](docs/validation/m11-startup-identification.md) and [particle audit](docs/validation/m11-particle-inputs.md) remain preserved. Optional pressure storage remains available for [community comparisons](docs/validation/community-shot-comparison.md), disabled by default.

| Part | What exists |
|---|---|
| Shot simulator | A physics solver for the whole shot. It covers flow through any basket shape (plain or pressurised), the wetting front, puck compaction, ideal or vibratory pumps, extraction from ~30 particle-size classes, four tracked compounds, temperature and the post-shot drip. It gives bit-identical results in Rust, Python and WebAssembly. Full shots run in a browser worker, with a cheaper tier for live previews; measured runtimes are in the [changelog](CHANGELOG.md). |
| Input models | Bean, grinder (burr family and gap, a grinder preset with its dial, or your own measured particle sizes), basket (any profile), puck preparation and machine programs. Every value has a source in the parameter registry. |
| Presets | 7 grinders, 12 baskets, 10 machine programs and 6 beans. The owner's own gear is just one set of presets, marked unverified. |
| Shot lab (web) | A recipe editor for gear described by preset or from scratch; the shot graph, summary tiles and particle-size chart; a compound table with sources; a cross-section of the puck with the wetting front; 1D sweeps, pinned overlays and exports. |
| Calibration and validation | 19 published datasets (Schmieder, Waszkiewicz, Cameron, Corrochano, Smrke, Vaca Guerra), including the qualified wet particle-size input selected for v3. The original calibration and held-out split remains unchanged. |
| Community comparisons | Safe offline import of original DE1 logs and the matching measurement sheet, followed by fixed-scenario comparisons. The [community report](docs/validation/community-shot-comparison.md) separates observed scale mass from estimated inlet flow and conditional model output; these sources have not entered the numerical fit. |
| Parameter registry | 233 sourced parameters, each with an evidence grade. Startup assumptions and experimental pressure storage are exposed in the sandbox. |
| CI | Rust, Python and web workflows, plus GitHub Pages deployment. |

Nothing you enter leaves your browser.

M1.1 takes priority over M2's full compound set and water chemistry ([plan §12](docs/PLAN.md#12-roadmap-and-milestones)). The owner's AMZCHEF preset now records a confirmed **58 mm single-wall basket**.

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
- [Shot model](docs/model/shot-model.md): the shot solver's physics and numerics, with verification results.
- [Input models](docs/model/input-models.md): from a recipe to the physics, including the presets.
- [Particle kernel](docs/model/particle-kernel.md): the diffusion solver, with measured verification results.
- [M1 validation report](docs/validation/m1-validation.md) and [calibration](docs/validation/calibration.md).
- [M1.1 startup investigation](docs/validation/m11-startup.md): before/after results, fixed-fit ablations and remaining work.
- [Particle-input audit](docs/validation/m11-particle-inputs.md): fixed-fit comparisons using a source-constrained wet PSD, with measurement and model assumptions separated.
- [Pressure-event correction and v5 calibration](docs/validation/m11-pressure-events.md): event verification, timestep checks, predictive refits and remaining accuracy limits.
- [Mesh refinement](docs/validation/m11-mesh-refinement.md): fixed-v5 comparisons at 5×/10× depth resolution, separate column/shell refinements, smaller timesteps, runtime and pressure-window checks.
- [Startup-parameter review](docs/validation/m11-startup-identification.md): training-only connectivity refits, numerical pressure sensitivity and independent-source limits.
- [Community shot comparisons](docs/validation/community-shot-comparison.md): reproducible online-data diagnostics, assumptions and remaining model limitations.
- [M0 kernel verification report](docs/validation/m0-kernel-verification.md), generated by `puckworks-tools verify`.
- Research notes:
  - [01 Extraction and flow physics](docs/research/01-extraction-and-flow-physics.md)
  - [02 Chemistry and sensory](docs/research/02-chemistry-and-sensory.md)
  - [03 Grinding, PSD and data](docs/research/03-grinding-psd-and-data.md)
  - [04 Community shot data](docs/research/04-community-shot-data.md): online archives, measurement provenance and calibration admission.
  - [05 Water and particle inventory](docs/research/05-water-and-particle-inventory.md): source definitions, solute-capacity overlap, wet particle sizes and remaining model work.
  - [06 Transport identification](docs/research/06-transport-identification.md): bounded transport and preparation fits, source capacities, numerical checks and identification limits.
- [Contributing](CONTRIBUTING.md): setup, everyday commands and project rules.
- [Changelog](CHANGELOG.md).

## Quick start

You need Rust (via rustup), Node 22 or later, and Python 3.10 or later. Full setup is in [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
scripts/build_wasm.sh                 # build the WebAssembly engine
cd web && npm ci && npm run dev       # run the web app locally
```

## Principles

- **Physics first,** with machine learning for the gaps.
- **Provenance and uncertainty.** Every parameter has a source and an evidence grade; output uncertainty bands remain planned work.
- **Private by construction.** The site never collects user data. Everything you enter stays in your browser.

## Licence

GPL-2.0-or-later. See [LICENSE](LICENSE). The built site includes `third-party-licenses.md`, which lists the licences of everything it bundles.
