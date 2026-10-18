// SPDX-License-Identifier: GPL-2.0-or-later
//! `puckmodel`: from a description of the beans, grinder, basket, puck prep
//! and machine (a [`Recipe`]) to a physical [`puckcore::shot::ShotSpec`].
//! Also the presets, the parameter registry, and the JSON API that both
//! bindings call. The contract is `docs/model/m1-contract.md`; the input
//! models are specified in `docs/model/input-models.md`.
//!
//! - [`recipe`]: the recipe types (`puckworks.recipe/1`).
//! - [`builder`]: recipe → spec, with `derived` (PSD curve, notes, provenance).
//! - [`presets`] and [`registry`]: the embedded `generated/*.json` documents,
//!   exported from `data/` by `python -m puckworks_tools.export`.
//! - [`api`]: the JSON-in, JSON-out functions the bindings forward.
//! - [`validate`]: structural checks of a spec.
//!
//! All arithmetic in the models uses IEEE basic operations, `sqrt` and the
//! core's deterministic `exp` (see `numeric`), so native and WebAssembly
//! builds give bit-identical specs.

#![forbid(unsafe_code)]

pub mod api;
pub mod builder;
pub mod presets;
pub mod recipe;
pub mod registry;
pub mod taste;
pub mod uncertainty;
pub mod validate;

mod bounds;
mod context;
mod models;
mod numeric;

pub use builder::{Built, Derived, build, build_traced};
pub use context::registry_reads;
pub use models::chemistry_catalog::SpeciesMeta;
pub use recipe::Recipe;

/// Schema id of [`Recipe`] documents.
pub const RECIPE_SCHEMA: &str = "puckworks.recipe/1";
