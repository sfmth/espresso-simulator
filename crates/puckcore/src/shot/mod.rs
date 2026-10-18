// SPDX-License-Identifier: GPL-2.0-or-later
//! Shot simulation: the espresso puck from first water to the cup (M1).
//!
//! [`ShotSpec`] is the complete physical description of a shot (SI units);
//! [`simulate_shot`] returns a [`ShotResult`]. Their JSON form, behind the
//! `serde` feature, is the contract in `docs/model/m1-contract.md`.
//!
//! The model (PLAN §7.2–7.3, modules H and X) is specified in
//! `docs/model/shot-model.md`:
//! - a bed of any axisymmetric basket profile, split into parallel columns
//!   (radial annuli) and depth cells (`geometry`, `model`);
//! - Darcy flow with a wetting front, poroelastic compaction, viscosity,
//!   dissolution porosity, swelling, gas and a fines layer, under a pressure-
//!   or flow-profiling program, a vibratory pump curve or an ideal pump
//!   (`hydraulics`, `sim`);
//! - extraction from a broken-cell surface pool and an intact kernel per size
//!   class, with bed-liquid advection and dispersion, coupled implicitly
//!   (`transport`);
//! - a lumped thermal node, tracked species as linear passengers, the stop
//!   rule and the post-stop drip.
//!
//! `numerics.tier = 0` coarsens the same physics (3 permeability strata plus
//! the edge annulus, 8 depth cells, 2 size classes, coarse kernels of two
//! shells).

pub mod chemistry;
mod geometry;
mod hydraulics;
mod model;
mod props;
pub mod result;
mod sim;
pub mod spec;
mod transport;
mod validate;

pub use chemistry::*;
pub use result::*;
pub use spec::*;

use std::fmt;

/// Schema id of [`ShotSpec`] documents.
pub const SHOT_SPEC_SCHEMA: &str = "puckworks.shot-spec/1";
/// Schema id of [`ShotResult`] documents.
pub const SHOT_RESULT_SCHEMA: &str = "puckworks.shot-result/1";

/// Errors from [`simulate_shot`].
#[derive(Clone, Debug, PartialEq)]
pub enum ShotError {
    /// A field of the spec is invalid; `field` is its dotted path.
    InvalidSpec { field: String, reason: String },
    /// The solver failed.
    Numerical { reason: String },
}

impl ShotError {
    pub(crate) fn invalid(field: &str, reason: impl Into<String>) -> Self {
        Self::InvalidSpec {
            field: field.to_string(),
            reason: reason.into(),
        }
    }
}

impl fmt::Display for ShotError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidSpec { field, reason } => {
                write!(f, "invalid shot spec `{field}`: {reason}")
            }
            Self::Numerical { reason } => write!(f, "shot solver failed: {reason}"),
        }
    }
}

impl std::error::Error for ShotError {}

/// Simulates one shot.
///
/// Returns [`ShotError::InvalidSpec`], naming the field, when the spec is
/// invalid (for example a dose that overfills the basket, a bad wall profile,
/// no size classes or phases, or a non-finite number).
pub fn simulate_shot(spec: &ShotSpec) -> Result<ShotResult, ShotError> {
    sim::run(spec)
}

/// Checks a spec exactly as [`simulate_shot`] does, without running it.
///
/// Returns the warnings the solver would report (`diagnostics.warnings`), or
/// [`ShotError::InvalidSpec`] naming the first invalid field. Builders call
/// this so they never emit a spec the solver rejects.
pub fn validate_shot_spec(spec: &ShotSpec) -> Result<Vec<String>, ShotError> {
    validate::validate(spec)
}
