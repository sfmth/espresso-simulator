# 0008: The `puckmodel` crate and the JSON boundary

- **Status:** Accepted
- **Date:** 2026-10-14
- **Contract:** [docs/model/m1-contract.md](../model/m1-contract.md)

## Context

M1 adds a full shot simulation, plus "input models" that turn a description of the gear (a recipe) into physics: bean → composition, grinder → particle sizes, basket → geometry, machine → program. Both the browser and the Python tools need both layers. ADR 0002 requires one implementation. The core was deliberately dependency-free, but rich nested documents need serialisation.

## Decision

- **The physics stays in `puckcore`.** The shot types are plain Rust structs there, with `Default` impls.
- **Optional serde in the core.** `puckcore` gains an optional `serde` feature that derives (de)serialisation for the shot types. Built without it, the core still has no dependencies.
- **A new crate, `puckmodel`.** It depends on `puckcore` (with `serde`), `serde` and `serde_json`, and holds:
  - the recipe types and input models;
  - presets and the parameter registry, exported from `data/` to JSON and embedded at build time;
  - a JSON-in, JSON-out API (`puckmodel::api`).
- **Thin bindings.** Both bindings forward the five API functions unchanged. JavaScript sees JSON strings; Python sees dicts.
- **Strict inputs.** Input documents reject unknown fields, which catches typos and contract drift early. Output documents tolerate them.

## Consequences

- **One builder and one solver,** shared by web and Python, and bit-identical across targets: the skeleton's recipe run gave identical summaries in Node and Python.
- **Larger WebAssembly.** The module grows from 50 KB to about 390 KB with serde and serde_json. The embedded registry will add more, around 150 KB uncompressed. This is acceptable for M1. If it matters later, options include wasm-opt, `opt-level = "z"` for the WASM build, or serving the registry as a separate same-origin asset.
  - *Measured (2026-10-14), with the real solver, input models and embedded data:*
    - 1,009 KB (296 KB gzipped). Code is 612 KB, data 289 KB (215 KB of it the presets and registry JSON) and the function-name section 106 KB.
    - `scripts/build_wasm.sh` now drops the name section in release builds, giving 904 KB (284 KB gzipped).
    - `opt-level = "s"`/`"z"` would cut only 33–36 KB gzipped, and the raw module would grow. Neither is worth slowing the solver.
- **Serialisation cost.** JSON costs about 1 ms per call at M1 result sizes, which fits even the Tier-0 budget of 10 ms. If spatial snapshots grow, large arrays can move to typed-array transfers later, through new functions; the existing ones stay unchanged.
- **New dependencies.** serde, serde_json and their transitive crates are MIT or Apache-2.0 (ryu is Apache-2.0 OR BSL-1.0); cargo-deny allows them. `deny.toml` lists `puckmodel` among our own GPL crates.

## Alternatives considered

| alternative | why rejected |
|---|---|
| Typed wasm-bindgen structs for every document | hundreds of getters, and a second, different API for Python |
| serde-wasm-bindgen / pythonize | two serialisation paths to keep identical; JSON text gives one |
| Input models in TypeScript and Python separately | violates ADR 0002 and would drift |
| Keep the core dependency-free and duplicate mirror types in `puckmodel` | every field written twice; drift between the copies |
