# Puckworks

An open-source espresso simulator that runs entirely in the browser. It models a shot from bean and grinder, through the puck and the flow, to the cup. The goal is to follow the ~55 compounds that dissolve and to end with an explainable taste estimate, giving every number a source and an uncertainty band. The status below says what exists today.

**Status:** version 0.3.0 adds M1.1 startup physics to the shot core and lab view: pore-water storage, a separate trapped-air mobility closure and conservative headspace filling. **The scientific validation targets are still not all met.** The new startup parameters are explicitly labelled estimates and were not fitted to held-out shot times. Treat predicted times and extraction yields as indicative; see the [validation report](docs/validation/m1-validation.md) and the preserved [0.2.0 baseline](docs/validation/baseline-v0.2.0/m1-validation.md).

First drops improve from 1.8 to 6.8 s against 12.8 s measured, and the flow rise from 6.7 to 12.1 s against 25.5 s. Extraction accuracy regresses: 48/60 fitted rates meet the ±10% target, versus 57/60 before. No complete M1 scientific exit criterion passes. The [M1.1 investigation](docs/validation/m11-startup.md) records the improvements, regressions and remaining model gaps.

| Part | What exists |
|---|---|
| Shot simulator | A physics solver for the whole shot. It covers flow through any basket shape (plain or pressurised), the wetting front, puck compaction, ideal or vibratory pumps, extraction from ~30 particle-size classes, four tracked compounds, temperature and the post-shot drip. It gives bit-identical results in Rust, Python and WebAssembly. Full shots run in a browser worker, with a cheaper tier for live previews; measured runtimes are in the [changelog](CHANGELOG.md). |
| Input models | Bean, grinder (burr family and gap, a grinder preset with its dial, or your own measured particle sizes), basket (any profile), puck preparation and machine programs. Every value has a source in the parameter registry. |
| Presets | 7 grinders, 12 baskets, 10 machine programs and 6 beans. The owner's own gear is just one set of presets, marked unverified. |
| Shot lab (web) | A recipe editor for gear described by preset or from scratch; the shot graph, summary tiles and particle-size chart; a compound table with sources; a cross-section of the puck with the wetting front; 1D sweeps, pinned overlays and exports. |
| Calibration and validation | 18 published datasets (Schmieder, Waszkiewicz, Cameron, Corrochano, Smrke, Vaca Guerra), with calibration on some and held-out tests on others. |
| Parameter registry | 230 sourced parameters, each with an evidence grade. The startup assumptions are exposed in the sandbox. |
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

## Principles

- **Physics first,** with machine learning for the gaps.
- **Provenance and uncertainty.** Every parameter has a source and an evidence grade; output uncertainty bands remain planned work.
- **Private by construction.** The site never collects user data. Everything you enter stays in your browser.

## Licence

GPL-2.0-or-later. See [LICENSE](LICENSE). The built site includes `third-party-licenses.md`, which lists the licences of everything it bundles.
