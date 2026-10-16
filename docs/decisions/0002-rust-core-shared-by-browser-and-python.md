# 0002: One Rust core for the browser and Python

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

Goal G7 (one physics implementation) and the fidelity tiers ([PLAN.md §7.2](../PLAN.md#72-fidelity-tiers)) need the same model to run in two places:

- **In the browser,** fast enough for interactive use: Tier 1 within 1 s per shot.
- **Offline in Python,** where the tools run Tier 1 thousands to millions of times for calibration, surrogate training and validation reports.

Two implementations would drift apart. Results should also match across targets, so a browser result can be reproduced offline.

## Decision

- The numerical core is a Rust crate, `crates/puckcore`. It has no dependencies, keeping licensing simple, the WebAssembly small, and results deterministic.
- `crates/puckcore-wasm` exposes the core to JavaScript through wasm-bindgen. `scripts/build_wasm.sh` builds it with `--target web` into `web/src/engine/pkg/`.
- `crates/puckcore-py` exposes it to Python as the module `puckcore`, through PyO3 using the stable ABI (abi3, Python ≥ 3.10). maturin builds it.
- `rust-toolchain.toml` pins the compiler (1.99.0, with the `wasm32-unknown-unknown` target). The wasm-bindgen crate is pinned exactly (`=0.2.129`), because its CLI must match; the build script checks that it does.
- Both bindings are thin, and their APIs are contracts. New functions may be added, but existing names and signatures don't change without a new ADR.

## Consequences

- Contributors need rustup, the WASM target and the matching wasm-bindgen CLI. CONTRIBUTING.md lists the setup.
- The bindings copy result arrays at the boundary. That is negligible at M0 sizes and will be revisited if profiling shows it matters.
- **Measured at M0:** for the same inputs, the Python (native) and Node (WASM) builds give bit-identical released-fraction curves (maximum difference 0 over 2001 points). After the real solver landed, 255,640 output values over 300 random cases were bit-identical too ([ADR 0005](0005-particle-kernel-numerics.md)). The release WASM module is 49.9 KB.

## Alternatives considered

- **TypeScript-only core.** It has the simplest toolchain, but the offline tools would need a second implementation or a slow bridge to Node.
- **C++ with Emscripten and pybind11.** It would be comparable in speed, but has heavier build tooling and no memory safety.
- **Python core run in the browser through Pyodide.** It has a multi-megabyte start-up and slow inner loops; Tier 1 would miss its 1 s budget.
- **Julia.** It has no mature WebAssembly path.
