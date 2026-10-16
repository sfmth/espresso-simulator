// SPDX-License-Identifier: GPL-2.0-or-later
//! Validation of a [`ShotSpec`]: every error names the offending field by its
//! dotted path, e.g. `bed.size_classes[1].radius_m`.
//!
//! Every number has a plausibility range (shot-model.md §2.1): wide enough
//! for any espresso equipment and recipe, narrow enough that the solver's
//! numerics hold (no overflow, no loss of the M-matrix structure, a bounded
//! state and a bounded number of steps).

use super::geometry::Profile;
use super::*;
use crate::math::fmax;

/// Highest temperature accepted, °C (the water correlations' range is 0–150 °C).
const MAX_TEMP_C: f64 = 150.0;
/// Highest pressure accepted (targets, limits, pumps), Pa: 200 bar.
const MAX_PRESSURE_PA: f64 = 2e7;
/// Highest flow accepted (targets, limits, pumps), m³/s: 100 mL/s.
const MAX_FLOW_M3_S: f64 = 1e-4;
/// Longest time accepted (phases, ramps, stop rule, max_duration), s.
const MAX_TIME_S: f64 = 3600.0;
/// Largest beverage mass accepted (targets), kg.
const MAX_BEVERAGE_KG: f64 = 10.0;
/// Longest relaxation time constant accepted, s.
const MAX_TAU_S: f64 = 600.0;
/// Longest drip time constant accepted, s.
const MAX_DRIP_TAU_S: f64 = 60.0;
/// Largest time step accepted, s: steps must resolve the breakthrough and the
/// mass events (shot-model.md §7.2).
const MAX_DT_S: f64 = 0.5;
/// Most basket profile points accepted.
const MAX_PROFILE_POINTS: usize = 256;
/// Most columns accepted.
const MAX_COLUMNS: usize = 64;
/// Most depth cells accepted.
const MAX_DEPTH_CELLS: usize = 1000;
/// Most kernel shells accepted.
const MAX_KERNEL_SHELLS: usize = 64;
/// Most size classes accepted.
const MAX_SIZE_CLASSES: usize = 200;
/// Most tracked species accepted.
const MAX_SPECIES: usize = 64;
/// Most machine phases accepted.
const MAX_PHASES: usize = 64;
/// Bound on time steps and output points, to keep a run finite.
const MAX_STEPS: f64 = 2e6;
/// Most snapshots accepted.
const MAX_SNAPSHOTS: usize = 1000;
/// Bound on the state: columns × cells × classes × (shells + 1) × (1 + species).
const MAX_STATE: f64 = 1e7;
/// Bound on the snapshot data: snapshots × columns × cells.
const MAX_SNAPSHOT_CELLS: f64 = 1e6;
/// Bound on the series data: output points × (10 + species).
const MAX_SERIES_VALUES: f64 = 1e7;
/// Bound on the total work, steps × model values: about 30 s natively at the
/// measured 1.5–6 ns per value and step (shot-model.md §2.1).
const MAX_WORK: f64 = 1e10;
/// Above this much work, validation warns that the run will take seconds.
const WARN_WORK: f64 = 1e9;
/// Post-stop drip length in time constants (as in the driver).
const DRIP_TAUS: f64 = 8.0;
/// Tier 0's fixed model size: columns (3 strata + edge), cells, classes and
/// shells per class (at most).
const TIER0_SIZE: (f64, f64, f64, f64) = (4.0, 8.0, 2.0, 2.0);

type Check = Result<(), ShotError>;

fn err(field: &str, reason: &str) -> ShotError {
    ShotError::invalid(field, reason)
}

/// lo ≤ x ≤ hi.
fn closed(field: &str, x: f64, lo: f64, hi: f64) -> Check {
    if x.is_finite() && x >= lo && x <= hi {
        Ok(())
    } else {
        Err(err(field, &format!("must be in [{lo:e}, {hi:e}]")))
    }
}

/// lo < x ≤ hi.
fn left_open(field: &str, x: f64, lo: f64, hi: f64) -> Check {
    if x.is_finite() && x > lo && x <= hi {
        Ok(())
    } else {
        Err(err(field, &format!("must be in ({lo:e}, {hi:e}]")))
    }
}

/// lo ≤ x < hi.
fn half_open(field: &str, x: f64, lo: f64, hi: f64) -> Check {
    if x.is_finite() && x >= lo && x < hi {
        Ok(())
    } else {
        Err(err(field, &format!("must be in [{lo:e}, {hi:e})")))
    }
}

fn temperature(field: &str, x: f64) -> Check {
    closed(field, x, 0.0, MAX_TEMP_C)
}

/// Checks the spec; returns warnings for the user.
pub(crate) fn validate(spec: &ShotSpec) -> Result<Vec<String>, ShotError> {
    let mut warnings = Vec::new();
    if spec.schema != SHOT_SPEC_SCHEMA {
        return Err(err(
            "schema",
            &format!("must be \"{SHOT_SPEC_SCHEMA}\", got {:?}", spec.schema),
        ));
    }
    basket(&spec.basket)?;
    bed(&spec.bed, &mut warnings)?;
    solubles(&spec.solubles, &spec.bed, &mut warnings)?;
    hydraulics(&spec.hydraulics)?;
    thermal(&spec.thermal)?;
    machine(&spec.machine)?;
    numerics(spec, &mut warnings)?;
    fits_basket(spec)?;
    Ok(warnings)
}

fn basket(b: &BasketGeometry) -> Check {
    let p = &b.profile_m;
    if p.len() < 2 || p.len() > MAX_PROFILE_POINTS {
        return Err(err(
            "basket.profile_m",
            &format!("needs 2 to {MAX_PROFILE_POINTS} points"),
        ));
    }
    for (i, pt) in p.iter().enumerate() {
        let f = format!("basket.profile_m[{i}]");
        if !pt[0].is_finite() || !pt[1].is_finite() {
            return Err(err(&f, "must hold finite numbers"));
        }
        if !(1e-3..=0.1).contains(&pt[1]) {
            return Err(err(&f, "radius must be in [1 mm, 100 mm]"));
        }
        if !(0.0..=0.2).contains(&pt[0]) {
            return Err(err(&f, "height must be in [0, 200 mm]"));
        }
    }
    if p[0][0] != 0.0 {
        return Err(err("basket.profile_m[0]", "the first height must be 0"));
    }
    for i in 1..p.len() {
        if p[i][0] <= p[i - 1][0] {
            return Err(err(
                &format!("basket.profile_m[{i}]"),
                "heights must strictly increase",
            ));
        }
    }
    closed(
        "basket.perforated_radius_m",
        b.perforated_radius_m,
        1e-4,
        0.1,
    )?;
    if b.perforated_radius_m > p[0][1] * (1.0 + 1e-12) {
        return Err(err(
            "basket.perforated_radius_m",
            "must not exceed the floor radius",
        ));
    }
    closed("basket.open_area_fraction", b.open_area_fraction, 1e-4, 1.0)?;
    if let Outlet::Pressurised {
        orifice_diameter_m,
        discharge_coefficient,
    } = &b.outlet
    {
        closed(
            "basket.outlet.orifice_diameter_m",
            *orifice_diameter_m,
            1e-5,
            0.05,
        )?;
        closed(
            "basket.outlet.discharge_coefficient",
            *discharge_coefficient,
            0.05,
            1.0,
        )?;
    }
    closed("basket.extra_headspace_m3", b.extra_headspace_m3, 0.0, 1e-3)
}

fn bed(b: &BedSpec, warnings: &mut Vec<String>) -> Check {
    closed("bed.dose_kg", b.dose_kg, 1e-3, 1.0)?;
    closed(
        "bed.intergranular_porosity",
        b.intergranular_porosity,
        0.01,
        0.95,
    )?;
    closed(
        "bed.intraparticle_porosity",
        b.intraparticle_porosity,
        0.01,
        0.95,
    )?;
    closed(
        "bed.skeletal_density_kg_m3",
        b.skeletal_density_kg_m3,
        500.0,
        3000.0,
    )?;
    if b.size_classes.is_empty() {
        return Err(err("bed.size_classes", "must not be empty"));
    }
    if b.size_classes.len() > MAX_SIZE_CLASSES {
        return Err(err(
            "bed.size_classes",
            &format!("at most {MAX_SIZE_CLASSES} classes"),
        ));
    }
    let mut total = 0.0;
    for (i, c) in b.size_classes.iter().enumerate() {
        closed(
            &format!("bed.size_classes[{i}].radius_m"),
            c.radius_m,
            1e-7,
            5e-3,
        )?;
        closed(
            &format!("bed.size_classes[{i}].volume_fraction"),
            c.volume_fraction,
            0.0,
            1.001,
        )?;
        total += c.volume_fraction;
    }
    if total.is_nan() || total <= 0.0 || (total - 1.0).abs() > 1e-3 {
        return Err(err(
            "bed.size_classes",
            &format!("volume fractions must sum to 1 (got {total})"),
        ));
    }
    if (total - 1.0).abs() > 1e-9 {
        warnings.push(format!(
            "size-class volume fractions summed to {total}; renormalised to 1"
        ));
    }
    let h = &b.heterogeneity;
    if !(1..=MAX_COLUMNS).contains(&h.columns) {
        return Err(err(
            "bed.heterogeneity.columns",
            &format!("must be between 1 and {MAX_COLUMNS}"),
        ));
    }
    closed(
        "bed.heterogeneity.sigma_ln_permeability",
        h.sigma_ln_permeability,
        0.0,
        3.0,
    )?;
    closed(
        "bed.heterogeneity.edge_area_fraction",
        h.edge_area_fraction,
        0.0,
        0.9,
    )?;
    closed(
        "bed.heterogeneity.edge_multiplier",
        h.edge_multiplier,
        0.01,
        100.0,
    )?;
    closed(
        "bed.heterogeneity.prewet_nonuniformity",
        h.prewet_nonuniformity,
        0.0,
        1.0,
    )
}

fn solubles(s: &SolublesSpec, bed: &BedSpec, warnings: &mut Vec<String>) -> Check {
    closed(
        "solubles.extractable_fraction",
        s.extractable_fraction,
        0.0,
        0.6,
    )?;
    closed("solubles.cell_size_m", s.cell_size_m, 0.0, 1e-3)?;
    closed("solubles.saturation_kg_m3", s.saturation_kg_m3, 1.0, 2000.0)?;
    closed(
        "solubles.partition_coefficient",
        s.partition_coefficient,
        0.01,
        100.0,
    )?;
    closed(
        "solubles.kernel_diffusivity_m2_s",
        s.kernel_diffusivity_m2_s,
        1e-16,
        1e-7,
    )?;
    closed("solubles.surface_rate_m_s", s.surface_rate_m_s, 0.0, 1.0)?;
    temperature("solubles.reference_temp_c", s.reference_temp_c)?;
    closed(
        "solubles.solute_specific_volume_m3_kg",
        s.solute_specific_volume_m3_kg,
        0.0,
        2e-3,
    )?;
    // The bed liquid never exceeds the larger of saturation and the kernels'
    // equilibrium K·s₀ (K·ε_c·u₀ with u₀ = s₀/ε_c; shot-model.md §5.4), and it
    // must keep a positive water content there: v̄·c_max < 0.9.
    let s0 =
        s.extractable_fraction * bed.skeletal_density_kg_m3 * (1.0 - bed.intraparticle_porosity);
    let kernel_eq = s.partition_coefficient * s0;
    let c_max = fmax(s.saturation_kg_m3, kernel_eq);
    if s.solute_specific_volume_m3_kg * c_max >= 0.9 {
        let (field, what) = if kernel_eq > s.saturation_kg_m3 {
            (
                "solubles.partition_coefficient",
                format!("kernels would hold the liquid at K·s₀ = {kernel_eq:.0} kg/m³"),
            )
        } else {
            (
                "solubles.solute_specific_volume_m3_kg",
                format!("at saturation, {:.0} kg/m³", s.saturation_kg_m3),
            )
        };
        return Err(err(
            field,
            &format!(
                "too large: {what}, where the liquid would hold almost no water \
                 (v̄·c ≥ 0.9)"
            ),
        ));
    }
    // Kernels whose equilibrium lies above saturation hold the liquid there.
    if kernel_eq > s.saturation_kg_m3 {
        warnings.push(format!(
            "the kernels' equilibrium K·s₀ = {kernel_eq:.0} kg/m³ lies above c_sat = {:.0} kg/m³: \
             the bed liquid can exceed saturation",
            s.saturation_kg_m3
        ));
    }
    // Without the loading cap, kernels in contact with liquid above K·s₀ take
    // up solute beyond their initial content, without limit.
    if !s.kernel_loading_cap && s0 > 0.0 && kernel_eq < s.saturation_kg_m3 {
        warnings.push(format!(
            "solubles.kernel_loading_cap is off and K·s₀ = {kernel_eq:.0} kg/m³ is below \
             c_sat = {:.0} kg/m³: kernels re-absorb solute from liquid above {kernel_eq:.0} kg/m³ \
             beyond their initial content",
            s.saturation_kg_m3
        ));
    }
    if s.species.len() > MAX_SPECIES {
        return Err(err(
            "solubles.species",
            &format!("at most {MAX_SPECIES} species"),
        ));
    }
    let mut total = 0.0;
    for (i, sp) in s.species.iter().enumerate() {
        let f = |name: &str| format!("solubles.species[{i}].{name}");
        if sp.id.is_empty() {
            return Err(err(&f("id"), "must not be empty"));
        }
        if s.species[..i].iter().any(|o| o.id == sp.id) {
            return Err(err(&f("id"), &format!("duplicate id {:?}", sp.id)));
        }
        closed(&f("mass_fraction"), sp.mass_fraction, 0.0, 0.6)?;
        closed(
            &f("kernel_diffusivity_m2_s"),
            sp.kernel_diffusivity_m2_s,
            1e-16,
            1e-7,
        )?;
        closed(
            &f("partition_coefficient"),
            sp.partition_coefficient,
            0.01,
            100.0,
        )?;
        closed(
            &f("surface_fraction_scale"),
            sp.surface_fraction_scale,
            0.0,
            100.0,
        )?;
        total += sp.mass_fraction;
    }
    if total > s.extractable_fraction * (1.0 + 1e-12) {
        warnings.push(format!(
            "tracked species add up to {total:.4} kg/kg, more than the lumped extractable fraction {:.4}",
            s.extractable_fraction
        ));
    }
    Ok(())
}

fn relaxation(field: &str, r: &Relaxation, max_amplitude: f64, open_top: bool) -> Check {
    let a = format!("{field}.amplitude");
    if open_top {
        half_open(&a, r.amplitude, 0.0, max_amplitude)?;
    } else {
        closed(&a, r.amplitude, 0.0, max_amplitude)?;
    }
    closed(&format!("{field}.tau_s"), r.tau_s, 0.0, MAX_TAU_S)
}

fn hydraulics(h: &HydraulicsSpec) -> Check {
    closed(
        "hydraulics.permeability_m2",
        h.permeability_m2,
        1e-18,
        1e-10,
    )?;
    if let Some(pc) = h.poroelastic_pc_pa {
        closed("hydraulics.poroelastic_pc_pa", pc, 1e4, 1e8)?;
    }
    relaxation("hydraulics.swelling", &h.swelling, 1.0, true)?;
    relaxation("hydraulics.gas", &h.gas, 1.0, true)?;
    relaxation("hydraulics.pore_air", &h.pore_air, 1.0, true)?;
    closed(
        "hydraulics.pore_air_permeability_exponent",
        h.pore_air_permeability_exponent,
        1.0,
        10.0,
    )?;
    relaxation("hydraulics.fines_layer", &h.fines_layer, 100.0, false)?;
    closed(
        "hydraulics.axial_dispersion_m2_s",
        h.axial_dispersion_m2_s,
        0.0,
        1e-3,
    )?;
    closed(
        "hydraulics.viscosity.ln_relative_a1",
        h.viscosity.ln_relative_a1,
        -50.0,
        50.0,
    )?;
    closed(
        "hydraulics.viscosity.ln_relative_a2",
        h.viscosity.ln_relative_a2,
        -50.0,
        50.0,
    )?;
    closed(
        "hydraulics.viscosity.temperature_exponent",
        h.viscosity.temperature_exponent,
        0.0,
        1.0,
    )?;
    // The relative viscosity must stay finite and positive up to w = 1.
    let v = &h.viscosity;
    let peak = v.temperature_exponent * (v.ln_relative_a1.abs() + v.ln_relative_a2.abs());
    if peak > 200.0 {
        return Err(err(
            "hydraulics.viscosity",
            "coefficients give an unbounded relative viscosity",
        ));
    }
    // The imbibed share of the particle pores joins the mobile liquid; the
    // pools and kernels keep the rest, which must not vanish.
    closed("hydraulics.wetting_uptake", h.wetting_uptake, 0.0, 0.9)?;
    if let Some(fraction) = h.intraparticle_water_fraction {
        closed(
            "hydraulics.intraparticle_water_fraction",
            fraction,
            0.0,
            1.0,
        )?;
    }
    if let Some(theta) = h.dissolution_porosity_share {
        closed("hydraulics.dissolution_porosity_share", theta, 0.0, 1.0)?;
    }
    Ok(())
}

fn thermal(t: &ThermalSpec) -> Check {
    temperature("thermal.water_temp_c", t.water_temp_c)?;
    temperature("thermal.initial_bed_temp_c", t.initial_bed_temp_c)?;
    temperature("thermal.ambient_temp_c", t.ambient_temp_c)?;
    closed("thermal.heat_capacity_j_k", t.heat_capacity_j_k, 1.0, 1e5)?;
    closed("thermal.heat_loss_w_k", t.heat_loss_w_k, 0.0, 1e3)
}

fn machine(m: &MachineSpec) -> Check {
    if m.phases.is_empty() || m.phases.len() > MAX_PHASES {
        return Err(err(
            "machine.phases",
            &format!("needs 1 to {MAX_PHASES} phases"),
        ));
    }
    for (i, ph) in m.phases.iter().enumerate() {
        let f = |name: &str| format!("machine.phases[{i}].{name}");
        // The limit is a flow under pressure control and a pressure under
        // flow control; it is ignored at full pump power.
        let limit_max = match &ph.control {
            Control::Pressure { target_pa } => {
                closed(&f("control.target_pa"), *target_pa, 0.0, MAX_PRESSURE_PA)?;
                MAX_FLOW_M3_S
            }
            Control::Flow { target_m3_s } => {
                closed(&f("control.target_m3_s"), *target_m3_s, 0.0, MAX_FLOW_M3_S)?;
                MAX_PRESSURE_PA
            }
            Control::PumpFull => f64::MAX,
        };
        closed(&f("ramp_s"), ph.ramp_s, 0.0, MAX_TIME_S)?;
        if let Some(l) = ph.limit {
            left_open(&f("limit"), l, 0.0, limit_max)?;
        }
        if let Some(x) = ph.exit.time_s {
            left_open(&f("exit.time_s"), x, 0.0, MAX_TIME_S)?;
        }
        if let Some(x) = ph.exit.beverage_mass_kg {
            left_open(&f("exit.beverage_mass_kg"), x, 0.0, MAX_BEVERAGE_KG)?;
        }
        if let Some(x) = ph.exit.pressure_pa {
            left_open(&f("exit.pressure_pa"), x, 0.0, MAX_PRESSURE_PA)?;
        }
    }
    match &m.pump {
        Pump::Ideal {
            max_flow_m3_s,
            max_pressure_pa,
        } => {
            left_open(
                "machine.pump.max_flow_m3_s",
                *max_flow_m3_s,
                0.0,
                MAX_FLOW_M3_S,
            )?;
            left_open(
                "machine.pump.max_pressure_pa",
                *max_pressure_pa,
                0.0,
                MAX_PRESSURE_PA,
            )?;
        }
        Pump::Vibratory {
            free_flow_m3_s,
            stall_pressure_pa,
            opv_pa,
        } => {
            left_open(
                "machine.pump.free_flow_m3_s",
                *free_flow_m3_s,
                0.0,
                MAX_FLOW_M3_S,
            )?;
            left_open(
                "machine.pump.stall_pressure_pa",
                *stall_pressure_pa,
                0.0,
                MAX_PRESSURE_PA,
            )?;
            if let Some(o) = opv_pa {
                left_open("machine.pump.opv_pa", *o, 0.0, MAX_PRESSURE_PA)?;
            }
        }
    }
    if let Some(t) = m.stop.time_s {
        left_open("machine.stop.time_s", t, 0.0, MAX_TIME_S)?;
    }
    if let Some(x) = m.stop.beverage_mass_kg {
        left_open("machine.stop.beverage_mass_kg", x, 0.0, MAX_BEVERAGE_KG)?;
    }
    closed(
        "machine.stop.drip_tau_s",
        m.stop.drip_tau_s,
        0.0,
        MAX_DRIP_TAU_S,
    )
}

fn numerics(spec: &ShotSpec, warnings: &mut Vec<String>) -> Check {
    let n = &spec.numerics;
    if n.tier > 1 {
        return Err(err("numerics.tier", "must be 0 or 1"));
    }
    if !(2..=MAX_DEPTH_CELLS).contains(&n.depth_cells) {
        return Err(err(
            "numerics.depth_cells",
            &format!("must be between 2 and {MAX_DEPTH_CELLS}"),
        ));
    }
    left_open("numerics.max_dt_s", n.max_dt_s, 0.0, MAX_DT_S)?;
    left_open("numerics.max_duration_s", n.max_duration_s, 0.0, MAX_TIME_S)?;
    left_open(
        "numerics.output_interval_s",
        n.output_interval_s,
        0.0,
        MAX_TIME_S,
    )?;
    // The run lasts at most max_duration plus the drip.
    let run = n.max_duration_s + DRIP_TAUS * spec.machine.stop.drip_tau_s;
    if run / n.max_dt_s.min(n.output_interval_s) > MAX_STEPS {
        return Err(err(
            "numerics.max_dt_s",
            "too small for max_duration_s and the drip: more than 2e6 steps",
        ));
    }
    let points = run / n.output_interval_s;
    if points > MAX_STEPS {
        return Err(err(
            "numerics.output_interval_s",
            "too small for max_duration_s and the drip: more than 2e6 output points",
        ));
    }
    let n_species = spec.solubles.species.len() as f64;
    if points * (10.0 + n_species) > MAX_SERIES_VALUES {
        return Err(err(
            "numerics.output_interval_s",
            "too small: the output series would hold more than 1e7 values",
        ));
    }
    if n.snapshot_count > MAX_SNAPSHOTS {
        return Err(err(
            "numerics.snapshot_count",
            &format!("must be at most {MAX_SNAPSHOTS}"),
        ));
    }
    if !(2..=MAX_KERNEL_SHELLS).contains(&n.kernel_shells) {
        return Err(err(
            "numerics.kernel_shells",
            &format!("must be between 2 and {MAX_KERNEL_SHELLS}"),
        ));
    }
    // A bounded state (memory, and work per step).
    let (cols, cells, classes, shells) = if n.tier == 0 {
        TIER0_SIZE
    } else {
        (
            spec.bed.heterogeneity.columns as f64,
            n.depth_cells as f64,
            spec.bed.size_classes.len() as f64,
            n.kernel_shells as f64,
        )
    };
    let state = cols * cells * classes * (shells + 1.0) * (1.0 + n_species);
    if state > MAX_STATE {
        return Err(err(
            "numerics.depth_cells",
            &format!(
                "the model would hold {state:.3e} values (columns × depth cells × size classes \
                 × (kernel shells + 1) × (1 + species)), more than {MAX_STATE:e}"
            ),
        ));
    }
    // A bounded total work: the step bound times the model size.
    let steps = run / n.max_dt_s.min(n.output_interval_s);
    let work = steps * state;
    if work > MAX_WORK {
        return Err(err(
            "numerics.max_duration_s",
            &format!(
                "the run could take minutes or hours: up to {steps:.3e} steps × {state:.3e} values \
                 = {work:.3e}, more than {MAX_WORK:e}; shorten max_duration_s, lengthen max_dt_s \
                 or coarsen the model"
            ),
        ));
    }
    if work > WARN_WORK {
        warnings.push(format!(
            "a large run: up to {steps:.2e} steps × {state:.2e} values = {work:.2e} (expect \
             several seconds or more)"
        ));
    }
    if n.snapshot_count as f64 * cols * cells > MAX_SNAPSHOT_CELLS {
        return Err(err(
            "numerics.snapshot_count",
            &format!(
                "too many for the grid: snapshots × columns × depth cells must be at most \
                 {MAX_SNAPSHOT_CELLS:e}"
            ),
        ));
    }
    Ok(())
}

/// The bed volume dose/((1 − ε)(1 − ε_p)ρ_s) must fit in the basket.
fn fits_basket(spec: &ShotSpec) -> Check {
    let b = &spec.bed;
    let bed_volume = b.dose_kg
        / ((1.0 - b.intergranular_porosity)
            * (1.0 - b.intraparticle_porosity)
            * b.skeletal_density_kg_m3);
    let basket_volume = Profile::new(&spec.basket.profile_m).total_volume();
    if !(bed_volume.is_finite() && bed_volume <= basket_volume) {
        return Err(err(
            "bed.dose_kg",
            &format!(
                "the dose overfills the basket: bed volume {:.2} mL, basket volume {:.2} mL",
                bed_volume * 1e6,
                basket_volume * 1e6
            ),
        ));
    }
    Ok(())
}
