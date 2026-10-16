// SPDX-License-Identifier: GPL-2.0-or-later
//! `puckcore`: the Puckworks numerical core.
//!
//! One physics implementation, shared by the browser (through `puckcore-wasm`)
//! and the offline Python tools (through `puckcore-py`). See `docs/PLAN.md` §7.
//!
//! Milestone M0 contains:
//! - [`kernel::sphere`]: the particle-scale diffusion kernel and its analytic
//!   reference solution. Together they verify the toolchain end to end
//!   (specification: `docs/model/particle-kernel.md`).
//! - [`linalg`]: a reusable tridiagonal solver.
//! - [`math`]: deterministic elementary functions, so native and WebAssembly
//!   builds give bit-identical results.
//!
//! Milestone M1 adds [`shot`]: the shot simulation (`ShotSpec` → `ShotResult`),
//! whose JSON form is the contract in `docs/model/m1-contract.md`. The model
//! (wetting, Darcy flow through parallel columns, surface pools and kernels,
//! dispersion, heat, species, two fidelity tiers) is specified in
//! `docs/model/shot-model.md`.
//!
//! The crate has no required dependencies and no `unsafe` code. The optional
//! `serde` feature adds (de)serialisation of the shot types for the bindings
//! (ADR 0008).

#![forbid(unsafe_code)]

pub mod kernel;
pub mod linalg;
pub mod math;
pub mod shot;

pub use kernel::sphere::{
    Grid, KernelError, Scheme, SolverDiagnostics, SolverOptions, SphereReleaseParams,
    SphereReleaseResult, crank_sphere_release_fraction, simulate_sphere_release,
    simulate_sphere_release_with,
};

/// Version of the core, taken from the Cargo manifest.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
