// SPDX-License-Identifier: GPL-2.0-or-later
//! [`ShotResult`]: everything a simulated shot produces.
//!
//! SI units with unit suffixes, as in [`super::spec`]. TDS and EY are
//! fractions (0.095, not 9.5 %). The JSON form is the contract in
//! `docs/model/m1-contract.md`. Fields may be added (always with a default);
//! existing fields keep their meaning.

#[cfg(feature = "serde")]
use serde::{Deserialize, Serialize};

/// Result of [`super::simulate_shot`].
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct ShotResult {
    /// Schema id, `"puckworks.shot-result/1"`.
    pub schema: String,
    /// Version of the core that produced the result.
    pub core_version: String,
    pub summary: Summary,
    pub series: Series,
    pub spatial: Spatial,
    pub diagnostics: Diagnostics,
}

/// Headline numbers.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Summary {
    /// Why the shot ended: `"beverage_mass"`, `"time"`, `"max_duration"` or
    /// `"choked"` (for 5 s the flow stayed below 0.01 mL/s and below a tenth
    /// of the flow the program asked for).
    pub stop_reason: String,
    /// Time from pump start to the stop, s.
    pub shot_time_s: f64,
    /// Time of the first drops at the outlet, s (`None` if none fell).
    pub first_drops_s: Option<f64>,
    /// Beverage mass in the cup, including the post-stop drip, kg.
    pub beverage_mass_kg: f64,
    /// Beverage mass added by the post-stop drip, kg: at most the water left
    /// in the headspace, and 0 when the machine vents it.
    pub drip_mass_kg: f64,
    /// Total dissolved solids of the cup, mass fraction.
    pub tds: f64,
    /// Extraction yield: dissolved solids in the cup / dry dose.
    pub ey: f64,
    /// Highest inlet pressure, Pa.
    pub max_pressure_pa: f64,
    /// Bed height after dosing and tamping, m.
    pub bed_height_m: f64,
    /// Headspace volume above the bed, m³.
    pub headspace_m3: f64,
    /// Per-species totals in the cup.
    pub species: Vec<SpeciesTotal>,
    /// Spread of local extraction across the bed at the end.
    pub uniformity: Uniformity,
}

/// Cup total of one species.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct SpeciesTotal {
    pub id: String,
    /// Mass in the cup, kg.
    pub mass_kg: f64,
    /// Share of the species' extractable content that reached the cup.
    pub extracted_fraction: f64,
}

/// Mass-weighted statistics of local EY over all bed cells (weights: the dry
/// solid mass of each cell). Local EY counts what has left the particles, so
/// its mean exceeds the cup EY by what is still in the bed liquid.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct Uniformity {
    pub ey_std: f64,
    pub ey_min: f64,
    pub ey_max: f64,
    /// Mass-weighted mean.
    pub ey_mean: f64,
}

/// Time series at `numerics.output_interval_s` spacing (plus the stop and the
/// end of the drip).
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Series {
    pub t_s: Vec<f64>,
    /// Pressure at the top of the bed, Pa (gauge).
    pub pressure_pa: Vec<f64>,
    /// Pump flow into the headspace, m³/s.
    pub flow_in_m3_s: Vec<f64>,
    /// Flow leaving the basket, m³/s.
    pub flow_out_m3_s: Vec<f64>,
    /// Beverage mass in the cup, kg.
    pub beverage_mass_kg: Vec<f64>,
    /// TDS of the cup so far (mass fraction).
    pub tds_cup: Vec<f64>,
    /// TDS of the extract leaving the basket now (mass fraction).
    pub tds_outlet: Vec<f64>,
    /// Extraction yield so far.
    pub ey: Vec<f64>,
    /// Temperature of the extract leaving the basket, °C.
    pub outlet_temp_c: Vec<f64>,
    /// Cumulative cup mass of each tracked species, kg.
    pub species_cup_kg: Vec<SpeciesSeries>,
    /// Wetted share of the bed volume.
    pub wetted_fraction: Vec<f64>,
}

/// One species' cumulative cup mass over time.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct SpeciesSeries {
    pub id: String,
    pub values: Vec<f64>,
}

/// Spatial state of the bed. Tier 0 reports its columns (three strata, one
/// without spread, plus the edge annulus), 8 cells and two merged size
/// classes.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Spatial {
    /// Depth of each cell centre below the bed top, m.
    pub depth_m: Vec<f64>,
    /// Depth of each cell face below the bed top, m (cells + 1 values, from
    /// 0 to the bed height).
    pub depth_edges_m: Vec<f64>,
    /// The parallel columns.
    pub columns: Vec<ColumnInfo>,
    /// Snapshots spread over the shot (the last one at the end).
    pub snapshots: Vec<Snapshot>,
    /// Extraction yield of each size class at the end.
    pub class_ey: Vec<ClassEy>,
}

/// One parallel column (radial annulus or permeability stratum). Column i
/// takes the fixed share f_i of the cross-section at every height: at height
/// h it spans radii r(h)√F_{i−1} to r(h)√F_i, where F_i is the cumulative
/// share and r(h) the wall radius, so A_i(z) = f_i·A(z).
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct ColumnInfo {
    /// Inner radius of the annulus at the floor, m.
    pub inner_radius_m: f64,
    /// Outer radius of the annulus at the floor, m.
    pub outer_radius_m: f64,
    /// Share of the bed cross-section.
    pub area_fraction: f64,
    /// Permeability multiplier relative to κ₀.
    pub permeability_multiplier: f64,
}

/// Bed state at one instant; arrays are `[column][depth cell]`.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Snapshot {
    pub t_s: f64,
    /// Local extraction yield of the solids in each cell: the net soluble
    /// loss of the cell's particles over their dry mass. Negative only where
    /// particles re-absorbed more than they lost (possible with
    /// `solubles.kernel_loading_cap = false`).
    pub local_ey: Vec<Vec<f64>>,
    /// Concentration of lumped solubles in the bed liquid (intergranular
    /// plus imbibed water), kg/m³; 0 where dry.
    pub liquid_conc_kg_m3: Vec<Vec<f64>>,
    /// Wetted share of each cell: 0 dry, 1 wet, in between where the wetting
    /// front is.
    pub wetted_fraction: Vec<Vec<f64>>,
}

/// Extraction yield of one size class: mass that left its particles over
/// its dry mass.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
#[derive(Clone, Copy, Debug, PartialEq, Default)]
pub struct ClassEy {
    pub radius_m: f64,
    pub ey: f64,
}

/// Solver diagnostics.
#[cfg_attr(feature = "serde", derive(Serialize, Deserialize))]
#[cfg_attr(feature = "serde", serde(default))]
#[derive(Clone, Debug, PartialEq, Default)]
pub struct Diagnostics {
    /// Relative error in the soluble mass balance (particles + liquid + cup):
    /// the largest over the run's check points, over the lumped solubles and
    /// every tracked species, each relative to its initial mass.
    pub mass_balance_error: f64,
    /// Time steps taken.
    pub steps: usize,
    /// Human-readable warnings (e.g. choked shot, stop rule never fired, a
    /// spread the columns cannot represent, linear partition below
    /// saturation, mass balance above 1e-9, a negative concentration).
    pub warnings: Vec<String>,
    /// Smallest concentration seen in any step (bed liquid, kernel shells and
    /// surface pools, lumped and species, each species at its own mass
    /// fraction), kg/m³; a positivity check.
    pub min_concentration_kg_m3: f64,
    /// Fidelity tier that produced the result.
    pub tier: u8,
    /// Quadrature consistency of the outlet accounting: the relative
    /// difference between the cup's solute (the implicit outflow of every
    /// step) and the trapezoidal integral of outlet flow × outlet
    /// concentration at the step ends. Both integrate the same q·c, so it
    /// checks the bookkeeping of the outlet, not the bed; it is first order in
    /// the step (about 3e-3 at Δt = 0.05 s).
    pub outflow_integral_error: f64,
    /// Most bed-liquid solves any column needed in one step (the policy
    /// iteration over pool regimes and caps; 1–3 is typical).
    pub max_regime_solves: usize,
    /// Steps rejected and retried: a regime iteration that did not converge
    /// (retried at half the step) or a mass target overshot by more than
    /// 0.1 mg (re-landed).
    pub rejected_steps: usize,
}
