# Architecture decision records

Implementation decisions for Puckworks, one short file per decision. Product decisions (what Puckworks is and does) live in [PLAN.md §2](../PLAN.md#2-locked-decisions-2026-10-13). These records cover how it is built.

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record architecture decisions | Accepted |
| [0002](0002-rust-core-shared-by-browser-and-python.md) | One Rust core for the browser (WebAssembly) and Python | Accepted |
| [0003](0003-web-stack.md) | Web stack: TypeScript, Vite, React | Accepted |
| [0004](0004-hosting-on-github-pages.md) | GitHub Pages hosting without cross-origin isolation | Accepted |
| [0005](0005-particle-kernel-numerics.md) | Particle-kernel numerics | Accepted |
| [0006](0006-parameter-registry.md) | Parameter registry | Accepted |
| [0007](0007-licensing-and-dependency-policy.md) | Licensing and dependency policy | Accepted |
| [0008](0008-model-crate-and-json-boundary.md) | The `puckmodel` crate and the JSON boundary | Accepted |
| [0009](0009-shot-solver-numerics.md) | Shot solver numerics and the bare base permeability | Accepted |
| [0010](0010-startup-water-and-pore-air.md) | Startup water inventory and an effective pore-air closure | Accepted |
| [0011](0011-upstream-pressure-storage.md) | Optional upstream pressure storage | Accepted, experimental |
| [0012](0012-m2-chemistry-and-phase-accounting.md) | M2 chemistry and phase accounting | Accepted, experimental |
| [0013](0013-m3-scenario-bands-and-taste.md) | Input scenario bands and explainable taste | Accepted, experimental |
| [0014](0014-local-dial-in.md) | Local journal, calibration and constrained advice | Accepted, experimental |
| [0015](0015-explore-state-and-refinement.md) | Coupled Explore state and explicit depth refinement | Accepted, experimental |
| [0016](0016-offline-release-cache.md) | Complete static release caches and explicit offline updates | Accepted |
| [0017](0017-offline-scalar-surrogate-pipeline.md) | Frozen offline scalar surrogate experiments | Accepted, experimental |
| [0018](0018-visual-equipment-and-first-visit-setup.md) | Visual equipment controls and required local setup | Accepted |

## Format

Each record has a **Status**, **Context**, **Decision**, **Consequences** and **Alternatives considered**. To change a decision, add a new record and mark the old one "Superseded by NNNN"; don't rewrite history.
