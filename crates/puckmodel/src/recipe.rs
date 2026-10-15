// SPDX-License-Identifier: GPL-2.0-or-later
//! [`Recipe`]: a shot as a person describes it, in practical units (g, mm,
//! bar, mL/s, °C, µm). The JSON form is the contract in
//! `docs/model/m1-contract.md`; its JSON Schema is
//! `data/schema/recipe.schema.json`.
//!
//! Each gear block either names a preset or describes the gear from scratch
//! (PLAN design principle 7). Explicit fields override the preset's values.
//! Fields may be added, always optional; existing fields keep their meaning.
//! What every field does to the physics is documented in
//! `docs/model/input-models.md`.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// A complete shot description.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Recipe {
    /// Schema id, `"puckworks.recipe/1"`.
    pub schema: String,
    pub bean: BeanInput,
    pub grinder: GrinderInput,
    pub basket: BasketInput,
    pub prep: PrepInput,
    pub machine: MachineInput,
    pub stop: StopInput,
    #[serde(default)]
    pub numerics: NumericsInput,
    /// Parameter-registry id → value (in the registry's units), for the
    /// sandbox. Applied last: an override replaces the parameter wherever the
    /// input models use it, including values a preset or the bean model would
    /// otherwise supply. An unknown id is an error.
    #[serde(default)]
    pub overrides: BTreeMap<String, f64>,
}

/// The coffee. Fields left out come from the preset, or from the default bean
/// preset (a medium-roast washed Arabica).
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct BeanInput {
    pub preset: Option<String>,
    /// Arabica share of the blend, 0–1 (the rest is Robusta).
    pub arabica_fraction: Option<f64>,
    /// Roast degree: 0 = very light … 1 = very dark.
    pub roast_level: Option<f64>,
    pub days_off_roast: Option<f64>,
    /// "washed", "natural", "honey", "anaerobic". Recorded; no effect in bean
    /// model v1.
    pub process: Option<String>,
    /// Bean temperature when ground, °C (room temperature if omitted). Colder
    /// beans grind finer at the same gap. *(Added in M1.)*
    pub bean_temp_c: Option<f64>,
}

/// The grinder: a preset plus a dial setting, a burr family plus a gap, or a
/// measured particle-size distribution.
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct GrinderInput {
    pub preset: Option<String>,
    /// Dial setting, in the preset's own scale.
    pub setting: Option<f64>,
    /// Burr family id (e.g. "flat-unimodal", "conical"), used with `gap_um`
    /// when there is no preset.
    pub family: Option<String>,
    /// Nominal burr gap, µm.
    pub gap_um: Option<f64>,
    /// Measured distribution; overrides everything else.
    pub psd: Option<PsdInput>,
    /// Burr diameter, mm. Recorded; no systematic effect in the evidence.
    /// *(Added in M1.)*
    pub burr_diameter_mm: Option<f64>,
    /// Burr speed, rpm. Recorded; no systematic effect in the evidence.
    /// *(Added in M1.)*
    pub rpm: Option<f64>,
    /// Dial calibration: burr gap at the preset's reference setting, µm
    /// (replaces the preset's value; with a family and no preset, the gap at
    /// setting 0). *(Added in M1.)*
    pub gap_at_ref_um: Option<f64>,
    /// Dial calibration: change of burr gap per unit of setting, µm
    /// (replaces the preset's value). *(Added in M1.)*
    pub gap_per_unit_um: Option<f64>,
    /// κ_G, volume median X50 divided by the burr gap (replaces the preset's,
    /// family's or registry value). *(Added in M1.)*
    pub x50_gap_ratio: Option<f64>,
    /// u_G, the grinder's "unimodality": volume % below 100 µm when X50 is
    /// 340 µm (replaces the preset's or family's value). *(Added in M1.)*
    pub fines_at_340_pct: Option<f64>,
    /// σ_c, standard deviation of ln(diameter) of the coarse mode (replaces
    /// the preset's or family's value). *(Added in M1.)*
    pub coarse_log_width: Option<f64>,
    /// w_b, volume share of the boulder tail (replaces the preset's or
    /// family's value). *(Added in M1.)*
    pub boulder_weight: Option<f64>,
}

/// A measured particle-size distribution, volume-weighted. Bins are taken as
/// contiguous in ln(diameter), with edges at the geometric midpoints between
/// neighbouring diameters. Up to `numerics.size_classes` bins are used as
/// they are; longer distributions are rebinned onto that many log-spaced
/// classes.
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct PsdInput {
    /// Particle diameters, µm, increasing.
    pub diameter_um: Vec<f64>,
    /// Volume fraction in each bin (normalised by the builder).
    pub volume_fraction: Vec<f64>,
    /// How it was measured: "dry_laser", "wet_laser", "image", "sieve" or
    /// "other". Recorded with a note; no correction is applied.
    /// *(Added in M1.)*
    pub method: Option<String>,
}

/// The basket: a preset, or any axisymmetric shape from scratch.
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct BasketInput {
    pub preset: Option<String>,
    pub custom: Option<BasketCustom>,
}

/// A basket described from scratch.
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct BasketCustom {
    /// Inner wall profile as `[height above the floor, inner diameter]`, mm.
    pub profile_mm: Vec<[f64; 2]>,
    /// Diameter of the perforated area on the floor, mm.
    pub perforated_diameter_mm: f64,
    /// Open (hole) fraction of the perforated area, 0–1.
    pub open_area_fraction: Option<f64>,
    /// Orifice diameter of a pressurised (dual-wall) basket, mm; `None` for a
    /// normal basket.
    pub pressurised_orifice_mm: Option<f64>,
    /// Discharge coefficient of the pressurised orifice, 0–1 (registry default
    /// if omitted). *(Added in M1.)*
    pub discharge_coefficient: Option<f64>,
}

/// Puck preparation.
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct PrepInput {
    /// Dry dose, g.
    pub dose_g: f64,
    /// "none", "tap", "wdt".
    pub distribution: Option<String>,
    pub tamp_kgf: Option<f64>,
    pub puck_screen: Option<bool>,
    pub paper_bottom: Option<bool>,
    pub paper_top: Option<bool>,
}

/// The machine: a preset, optionally with its own temperature, program, pump
/// or headspace; or a program (and pump) from scratch.
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct MachineInput {
    pub preset: Option<String>,
    pub temperature_c: Option<f64>,
    /// Pressure/flow program; replaces the preset's program.
    pub profile: Option<Vec<PhaseInput>>,
    /// Pump; replaces the preset's pump (a pump of the same type keeps the
    /// preset's values for the fields it omits). Without a preset or pump, an
    /// ideal (profiling) pump is assumed. *(Added in M1.)*
    pub pump: Option<PumpInput>,
    /// Water volume between the basket rim and the shower screen, mL
    /// (replaces the preset's or registry value). *(Added in M1.)*
    pub headspace_ml: Option<f64>,
    /// True if a three-way valve vents the group at the stop, so no headspace
    /// water drips into the cup (replaces the preset's value; default false).
    /// *(Added in M1.)*
    pub vent_headspace: Option<bool>,
}

/// A pump. Omitted values come from the preset's pump when it has the same
/// type, else from the registry (`model.machine.*`). *(Added in M1.)*
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum PumpInput {
    /// Follows the program exactly within these limits (profiling machines,
    /// levers, rotary pumps with a bypass).
    Ideal {
        max_flow_ml_s: Option<f64>,
        max_pressure_bar: Option<f64>,
    },
    /// Vibratory pump: Q = Q_free·(1 − P/P_stall), optionally capped by an
    /// over-pressure valve.
    Vibratory {
        free_flow_ml_s: Option<f64>,
        stall_pressure_bar: Option<f64>,
        opv_bar: Option<f64>,
    },
}

/// One phase of a pressure/flow program.
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct PhaseInput {
    /// "pressure" (target in bar), "flow" (target in mL/s) or "pump" (full power).
    pub control: String,
    pub target: Option<f64>,
    pub ramp_s: Option<f64>,
    /// Flow limit (mL/s) under pressure control, or pressure limit (bar) under
    /// flow control.
    pub limit: Option<f64>,
    pub until_time_s: Option<f64>,
    pub until_beverage_g: Option<f64>,
    pub until_pressure_bar: Option<f64>,
}

/// When to stop the shot (the first condition met).
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct StopInput {
    pub beverage_g: Option<f64>,
    pub time_s: Option<f64>,
}

/// Numerical options.
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields, default)]
pub struct NumericsInput {
    /// 0 = preview, 1 = standard (default).
    pub tier: Option<u8>,
    /// Number of particle size classes, 2–60 (default 30). *(Added in M1.)*
    pub size_classes: Option<usize>,
}
