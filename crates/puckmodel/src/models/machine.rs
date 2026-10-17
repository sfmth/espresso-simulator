// SPDX-License-Identifier: GPL-2.0-or-later
//! Machine model (PLAN §7.3 M; docs/model/input-models.md §8): program,
//! pump, brew temperature, group headspace, drip, the lumped thermal node
//! and the stop rule.
//!
//! A program is a list of phases in practical units (bar, mL/s, g, s),
//! converted to SI. Pumps are ideal (profiling machines, levers, rotary pumps
//! with a bypass) or vibratory with a linear curve and an optional
//! over-pressure valve. No research note covers pump curves, drip or group
//! thermal masses, so their defaults are estimates (grade D).

// ShotSpec structs are built with `..Default::default()` so fields the solver
// workstream adds keep this code compiling (see builder.rs).
#![allow(clippy::needless_update)]

use puckcore::shot::{Control, Phase, PhaseExit, Pump};

use crate::api::ApiError;
use crate::bounds;
use crate::context::{Ctx, Val, describe, join};
use crate::presets::{PresetMeta, Presets};
use crate::recipe::{MachineInput, PhaseInput, PumpInput, StopInput};

/// Specific heat of water, J/(g K): converts the water-equivalent masses of
/// the thermal parameters to heat capacities.
const WATER_SPECIFIC_HEAT_J_G_K: f64 = 4.186;
/// The solver's default hard stop, s (`NumericsSpec::max_duration_s`).
const MIN_MAX_DURATION_S: f64 = 120.0;
/// Temperatures the solver accepts for the bed, °C.
const BED_TEMP_C: (f64, f64) = (0.0, 150.0);

/// The machine, resolved and in SI units.
#[derive(Clone, Debug)]
pub(crate) struct MachineOut {
    pub preset: Option<String>,
    pub phases: Vec<Phase>,
    pub phases_src: String,
    pub pump: Pump,
    pub pump_src: String,
    /// Brew water temperature, °C.
    pub temperature: Val,
    /// Water volume between basket rim and shower screen, mL.
    pub group_headspace_ml: Val,
    pub drip_tau: Val,
    /// Upstream hydraulic compliance, mL/bar (zero keeps legacy hydraulics).
    pub hydraulic_compliance_ml_bar: Val,
    /// True if a three-way valve vents the group at the stop (no drip).
    pub vent_headspace: bool,
    pub vent_src: String,
    /// Basket and portafilter temperature at the start, °C.
    pub preheat: Val,
    /// Flow that fills the headspace at the start, mL/s.
    pub fill_flow_ml_s: f64,
    pub default_basket: Option<String>,
    pub basket_diameter_mm: Option<f64>,
    /// Sum of the program's phase time limits and ramps, s (for the hard stop).
    pub program_time_s: f64,
}

/// The fields of an ideal pump: (max flow mL/s, max pressure bar).
fn ideal_fields(p: &PumpInput) -> Option<(Option<f64>, Option<f64>)> {
    match p {
        PumpInput::Ideal {
            max_flow_ml_s,
            max_pressure_bar,
        } => Some((*max_flow_ml_s, *max_pressure_bar)),
        PumpInput::Vibratory { .. } => None,
    }
}

/// The fields of a vibratory pump: (free flow mL/s, stall bar, OPV bar).
fn vibratory_fields(p: &PumpInput) -> Option<(Option<f64>, Option<f64>, Option<f64>)> {
    match p {
        PumpInput::Vibratory {
            free_flow_ml_s,
            stall_pressure_bar,
            opv_bar,
        } => Some((*free_flow_ml_s, *stall_pressure_bar, *opv_bar)),
        PumpInput::Ideal { .. } => None,
    }
}

fn pump_type(p: &PumpInput) -> &'static str {
    match p {
        PumpInput::Ideal { .. } => "ideal",
        PumpInput::Vibratory { .. } => "vibratory",
    }
}

/// Converts the pump, field by field by the precedence recipe > override >
/// calibration > preset > registry: a recipe pump of the preset's type keeps
/// the preset's values for the fields it omits; one of another type takes the
/// registry defaults. Also returns the largest flow (mL/s) and pressure (bar).
fn convert_pump(
    ctx: &mut Ctx,
    recipe: Option<&PumpInput>,
    preset: Option<(&PumpInput, &str, &str)>,
) -> Result<(Pump, String, f64, f64), ApiError> {
    let ideal = PumpInput::Ideal {
        max_flow_ml_s: None,
        max_pressure_bar: None,
    };
    let base = recipe.or(preset.map(|(p, _, _)| p)).unwrap_or(&ideal);
    let base_src = match (recipe, preset) {
        (Some(_), _) => "recipe:machine.pump".to_string(),
        (None, Some((_, src, _))) => src.to_string(),
        (None, None) => "model:ideal pump".to_string(),
    };
    // The preset's pump fills the gaps of a recipe pump of the same type.
    let fill = preset.filter(|(p, _, _)| recipe.is_none_or(|r| pump_type(r) == pump_type(p)));
    if let (Some(r), Some((p, _, name))) = (recipe, preset)
        && pump_type(r) != pump_type(p)
    {
        ctx.note(format!(
            "Machine: machine.pump ({}) replaces the {name} {} pump; the fields it omits come from the registry defaults.",
            pump_type(r),
            pump_type(p)
        ));
    }
    let check = |x: Option<f64>, from_recipe: bool, name: &str, hi: f64, unit: &str| {
        let path = if from_recipe {
            format!("machine.pump.{name}")
        } else {
            format!("machine preset pump {name}")
        };
        bounds::opt(x, |v| bounds::check_pos(v, hi, &path, unit))
    };
    let recipe_val =
        |x: Option<f64>, name: &str| x.map(|v| Val::new(v, format!("recipe:machine.pump.{name}")));
    let preset_val = |x: Option<f64>| fill.and_then(|(_, src, _)| x.map(|v| Val::new(v, src)));
    let mut filled = Vec::new();
    let flow_max = bounds::MAX_PUMP_FLOW_ML_S;
    let pressure_max = bounds::MAX_PUMP_PRESSURE_BAR;
    let out = if let Some((r_flow, r_pressure)) = ideal_fields(base) {
        let (r_flow, r_pressure) = if recipe.is_some() {
            (r_flow, r_pressure)
        } else {
            (None, None)
        };
        let (p_flow, p_pressure) = fill
            .and_then(|(p, _, _)| ideal_fields(p))
            .unwrap_or_default();
        let rf = check(r_flow, true, "max_flow_ml_s", flow_max, "mL/s")?;
        let pf = check(p_flow, false, "max_flow_ml_s", flow_max, "mL/s")?;
        let rp = check(r_pressure, true, "max_pressure_bar", pressure_max, "bar")?;
        let pp = check(p_pressure, false, "max_pressure_bar", pressure_max, "bar")?;
        if recipe.is_some() {
            if rf.is_none() && pf.is_some() {
                filled.push("max_flow_ml_s");
            }
            if rp.is_none() && pp.is_some() {
                filled.push("max_pressure_bar");
            }
        }
        let f = ctx.resolve(
            "model.machine.ideal_max_flow",
            "mL/s",
            recipe_val(rf, "max_flow_ml_s"),
            preset_val(pf),
            None,
        )?;
        let pr = ctx.resolve(
            "model.machine.ideal_max_pressure",
            "bar",
            recipe_val(rp, "max_pressure_bar"),
            preset_val(pp),
            None,
        )?;
        (
            Pump::Ideal {
                max_flow_m3_s: f.v / 1e6,
                max_pressure_pa: pr.v * 1e5,
            },
            join(&[&base_src, &f.src, &pr.src]),
            f.v,
            pr.v,
        )
    } else {
        let (r_flow, r_stall, r_opv) = vibratory_fields(base)
            .filter(|_| recipe.is_some())
            .unwrap_or_default();
        let (p_flow, p_stall, p_opv) = fill
            .and_then(|(p, _, _)| vibratory_fields(p))
            .unwrap_or_default();
        let rf = check(r_flow, true, "free_flow_ml_s", flow_max, "mL/s")?;
        let pf = check(p_flow, false, "free_flow_ml_s", flow_max, "mL/s")?;
        let rs = check(r_stall, true, "stall_pressure_bar", pressure_max, "bar")?;
        let ps = check(p_stall, false, "stall_pressure_bar", pressure_max, "bar")?;
        let ro = check(r_opv, true, "opv_bar", pressure_max, "bar")?;
        let po = check(p_opv, false, "opv_bar", pressure_max, "bar")?;
        if recipe.is_some() {
            if rf.is_none() && pf.is_some() {
                filled.push("free_flow_ml_s");
            }
            if rs.is_none() && ps.is_some() {
                filled.push("stall_pressure_bar");
            }
            if ro.is_none() && po.is_some() {
                filled.push("opv_bar");
            }
        }
        let f = ctx.resolve(
            "model.machine.vibratory_free_flow",
            "mL/s",
            recipe_val(rf, "free_flow_ml_s"),
            preset_val(pf),
            None,
        )?;
        let st = ctx.resolve(
            "model.machine.vibratory_stall_pressure",
            "bar",
            recipe_val(rs, "stall_pressure_bar"),
            preset_val(ps),
            None,
        )?;
        // The OPV has no registry default: recipe > preset > none.
        let (opv, opv_src) = match (ro, po) {
            (Some(o), _) => (Some(o), "recipe:machine.pump.opv_bar".to_string()),
            (None, Some(o)) => (
                Some(o),
                fill.map_or(String::new(), |(_, src, _)| src.to_string()),
            ),
            (None, None) => (None, String::new()),
        };
        let top = match opv {
            Some(o) if o < st.v => o,
            Some(o) => {
                ctx.note(format!(
                    "Machine: the over-pressure valve ({o} bar) is above the pump's stall pressure ({} bar), so it never opens.",
                    st.v
                ));
                st.v
            }
            None => st.v,
        };
        (
            Pump::Vibratory {
                free_flow_m3_s: f.v / 1e6,
                stall_pressure_pa: st.v * 1e5,
                opv_pa: opv.map(|o| o * 1e5),
            },
            join(&[&base_src, &f.src, &st.src, &opv_src]),
            f.v,
            top,
        )
    };
    if let (false, Some((_, _, name))) = (filled.is_empty(), fill) {
        ctx.note(format!(
            "Machine: machine.pump gives no {}; taken from the {name} pump.",
            filled.join(", ")
        ));
    }
    Ok(out)
}

/// Converts a program to phases; returns the phases, their total timed length
/// (s) and the provenance of the ramps that use the default.
fn convert_phases(
    ctx: &mut Ctx,
    program: &[PhaseInput],
    what: &str,
    pump_flow_ml_s: f64,
    pump_pressure_bar: f64,
) -> Result<(Vec<Phase>, f64, String), ApiError> {
    if program.is_empty() {
        return Err(ApiError(format!("{what} must have at least one phase")));
    }
    let ramp_default = ctx.param("model.machine.ramp_time", "s")?;
    let mut ramp_src = String::new();
    let mut explicit_ramps = 0;
    let mut out = Vec::new();
    let mut total_time = 0.0;
    for (i, ph) in program.iter().enumerate() {
        let at = format!("{what}[{i}]");
        let target = |name: &str, hi: f64, unit: &str| -> Result<f64, ApiError> {
            let t = ph
                .target
                .ok_or_else(|| ApiError(format!("{at}: a {name} phase needs a target")))?;
            bounds::check(t, 0.0, hi, &format!("{at}.target"), unit)
        };
        let (control, limit) = match ph.control.as_str() {
            "pressure" => {
                let t = target("pressure", bounds::MAX_TARGET_PRESSURE_BAR, "bar")?;
                if t > pump_pressure_bar {
                    ctx.note(format!(
                        "Machine: {at} asks for {t} bar but the pump reaches only {pump_pressure_bar:.1} bar."
                    ));
                }
                let limit = bounds::opt(ph.limit, |l| {
                    bounds::check_pos(
                        l,
                        bounds::MAX_PUMP_FLOW_ML_S,
                        &format!("{at}.limit"),
                        "mL/s",
                    )
                })?;
                (
                    Control::Pressure { target_pa: t * 1e5 },
                    limit.map(|l| l / 1e6),
                )
            }
            "flow" => {
                let t = target("flow", bounds::MAX_TARGET_FLOW_ML_S, "mL/s")?;
                if t > pump_flow_ml_s {
                    ctx.note(format!(
                        "Machine: {at} asks for {t} mL/s but the pump delivers at most {pump_flow_ml_s:.1} mL/s."
                    ));
                }
                let limit = bounds::opt(ph.limit, |l| {
                    bounds::check_pos(
                        l,
                        bounds::MAX_PUMP_PRESSURE_BAR,
                        &format!("{at}.limit"),
                        "bar",
                    )
                })?;
                (
                    Control::Flow {
                        target_m3_s: t / 1e6,
                    },
                    limit.map(|l| l * 1e5),
                )
            }
            "pump" => {
                if ph.target.is_some() || ph.limit.is_some() {
                    ctx.note(format!(
                        "Machine: {at} runs the pump at full power; its target and limit are ignored."
                    ));
                }
                (Control::PumpFull, None)
            }
            other => {
                return Err(ApiError(format!(
                    "{at}.control {other:?} must be \"pressure\", \"flow\" or \"pump\""
                )));
            }
        };
        let ramp_s = match ph.ramp_s {
            Some(r) => {
                explicit_ramps += 1;
                bounds::check(
                    r,
                    0.0,
                    bounds::MAX_PHASE_TIME_S,
                    &format!("{at}.ramp_s"),
                    "s",
                )?
            }
            None => {
                ramp_src = ramp_default.src.clone();
                ramp_default.v
            }
        };
        let time_s = bounds::opt(ph.until_time_s, |x| {
            bounds::check_pos(
                x,
                bounds::MAX_PHASE_TIME_S,
                &format!("{at}.until_time_s"),
                "s",
            )
        })?;
        let beverage = bounds::opt(ph.until_beverage_g, |x| {
            bounds::check_pos(
                x,
                bounds::MAX_BEVERAGE_G,
                &format!("{at}.until_beverage_g"),
                "g",
            )
        })?;
        let pressure = bounds::opt(ph.until_pressure_bar, |x| {
            bounds::check_pos(
                x,
                bounds::MAX_PUMP_PRESSURE_BAR,
                &format!("{at}.until_pressure_bar"),
                "bar",
            )
        })?;
        let last = i + 1 == program.len();
        let has_exit = time_s.is_some() || beverage.is_some() || pressure.is_some();
        let exit = if last {
            if has_exit {
                ctx.note(format!(
                    "Machine: {at} is the last phase and runs until the stop rule; its exit conditions are ignored."
                ));
            }
            PhaseExit::default()
        } else {
            if !has_exit {
                return Err(ApiError(format!(
                    "{at}: only the last phase may run without an exit condition (until_time_s, until_beverage_g or until_pressure_bar)"
                )));
            }
            PhaseExit {
                time_s,
                beverage_mass_kg: beverage.map(|g| g / 1e3),
                pressure_pa: pressure.map(|p| p * 1e5),
                ..Default::default()
            }
        };
        total_time += time_s.unwrap_or(0.0) + ramp_s;
        out.push(Phase {
            control,
            ramp_s,
            limit,
            exit,
            ..Default::default()
        });
    }
    if explicit_ramps > 0 && ctx.is_overridden("model.machine.ramp_time") {
        ctx.note(format!(
            "Machine: the override of model.machine.ramp_time is the default ramp of phases that state none; {explicit_ramps} phase(s) of the {what} state their own ramp and keep it."
        ));
    }
    Ok((out, total_time, ramp_src))
}

/// Resolves the machine: preset, recipe program and pump, temperature,
/// headspace, drip and preheat.
pub(crate) fn resolve(
    ctx: &mut Ctx,
    m: &MachineInput,
    presets: &Presets,
) -> Result<MachineOut, ApiError> {
    let preset = m
        .preset
        .as_deref()
        .map(|id| presets.machine(id))
        .transpose()?;
    let psrc = preset
        .map(|p| format!("preset:machine/{}", p.id))
        .unwrap_or_default();
    if let Some(p) = preset {
        for note in p.notes() {
            ctx.note(format!("{}: {note}", p.name()));
        }
        ctx.flags.extend(p.flags().iter().cloned());
    }
    // Pump.
    let preset_pump = preset.and_then(|p| {
        p.pump
            .as_ref()
            .map(|pump| (pump, psrc.as_str(), p.name.as_str()))
    });
    if m.pump.is_none() && preset.is_none() {
        ctx.note("Machine: no pump given; an ideal (profiling) pump follows the program.");
    }
    let (pump, pump_src, pump_flow, pump_pressure) =
        convert_pump(ctx, m.pump.as_ref(), preset_pump)?;
    // Program.
    let (program, program_src, what) = match (&m.profile, preset) {
        (Some(profile), _) => (
            profile.as_slice(),
            "recipe:machine.profile".to_string(),
            "machine.profile".to_string(),
        ),
        (None, Some(p)) => (
            p.program.as_slice(),
            psrc.clone(),
            format!("machine preset {} program", p.id),
        ),
        (None, None) => return Err(ApiError("machine: give a preset or a profile".into())),
    };
    let (phase_list, program_time_s, ramp_src) =
        convert_phases(ctx, program, &what, pump_flow, pump_pressure)?;
    // Flow that fills the headspace.
    let fill_flow_ml_s = match &phase_list[0].control {
        Control::Flow { target_m3_s } => (target_m3_s * 1e6).min(pump_flow).max(0.1),
        Control::Pressure { .. } => phase_list[0]
            .limit
            .map_or(pump_flow, |l| (l * 1e6).min(pump_flow)),
        Control::PumpFull => pump_flow,
    };
    // Temperature: recipe > override > calibration > preset > registry.
    let t_recipe = bounds::opt(m.temperature_c, |t| {
        let (lo, hi) = bounds::WATER_TEMP_C;
        bounds::check(t, lo, hi, "machine.temperature_c", "°C")
    })?
    .map(|t| Val::new(t, "recipe:machine.temperature_c"));
    let t_preset = preset.map(|p| Val::new(p.temperature_c, psrc.clone()));
    let temperature = ctx.resolve("shot.temperature", "degC", t_recipe, t_preset, None)?;
    if let Some(p) = preset
        && let Some([lo, hi]) = p.temperature_range_c
        && !(lo..=hi).contains(&temperature.v)
    {
        ctx.note(format!(
            "Machine: {} °C is outside the {} temperature range ({lo}–{hi} °C).",
            temperature.v, p.name
        ));
    }
    let h_recipe = bounds::opt(m.headspace_ml, |h| {
        bounds::check(
            h,
            0.0,
            bounds::MAX_HEADSPACE_ML,
            "machine.headspace_ml",
            "mL",
        )
    })?
    .map(|h| Val::new(h, "recipe:machine.headspace_ml"));
    let h_preset = preset
        .and_then(|p| p.group_headspace_ml)
        .map(|h| Val::new(h, psrc.clone()));
    let group_headspace_ml = ctx.resolve(
        "model.machine.group_headspace",
        "mL",
        h_recipe,
        h_preset,
        None,
    )?;
    let drip_tau = ctx.resolve(
        "model.machine.drip_time_constant",
        "s",
        None,
        preset
            .and_then(|p| p.drip_tau_s)
            .map(|v| Val::new(v, psrc.clone())),
        None,
    )?;
    let hydraulic_compliance_ml_bar = ctx.param("model.machine.hydraulic_compliance", "mL/bar")?;
    if hydraulic_compliance_ml_bar.v > 0.0 {
        ctx.note(format!(
            "Machine: experimental upstream hydraulic compliance is {} mL/bar; stored pump water can continue through the puck during a pause. This lumped closure is an uncalibrated modeling assumption (grade D).",
            hydraulic_compliance_ml_bar.v
        ));
    }
    // Three-way valve: recipe > preset > none.
    let (vent_headspace, vent_src) = match (m.vent_headspace, preset.and_then(|p| p.vent_headspace))
    {
        (Some(v), _) => (v, "recipe:machine.vent_headspace".to_string()),
        (None, Some(v)) => (v, psrc.clone()),
        (None, None) => {
            ctx.note(if hydraulic_compliance_ml_bar.v > 0.0 {
                "Machine: no three-way valve assumed, so charged pressure storage can drain through the puck after the stop; set machine.vent_headspace to true if your machine vents the group."
            } else {
                "Machine: no three-way valve assumed, so the water above the puck drips into the cup after the stop; set machine.vent_headspace to true if your machine vents the group."
            });
            (false, "model:no three-way valve assumed".to_string())
        }
    };
    let preheat = ctx.resolve(
        "model.thermal.hardware_temperature",
        "degC",
        None,
        preset
            .and_then(|p| p.preheat_temp_c)
            .map(|v| Val::new(v, psrc.clone())),
        None,
    )?;
    Ok(MachineOut {
        preset: preset.map(|p| p.id.clone()),
        phases: phase_list,
        phases_src: join(&[&program_src, &ramp_src]),
        pump,
        pump_src,
        temperature,
        group_headspace_ml,
        drip_tau,
        hydraulic_compliance_ml_bar,
        vent_headspace,
        vent_src,
        preheat,
        fill_flow_ml_s,
        default_basket: preset.and_then(|p| p.default_basket.clone()),
        basket_diameter_mm: preset.and_then(|p| p.basket_diameter_mm),
        program_time_s,
    })
}

/// The lumped thermal node: (initial bed temperature °C, heat capacity J/K,
/// heat loss W/K). The basket and portafilter start at `preheat`, the grounds
/// at the bean temperature; the initial temperature is their
/// heat-capacity-weighted mean.
pub(crate) fn thermal(
    ctx: &mut Ctx,
    dose_g: f64,
    bean_temp: &Val,
    preheat: &Val,
) -> Result<(Val, Val, Val), ApiError> {
    let hw = ctx.param("model.thermal.hardware_water_equivalent", "g")?;
    let ratio = ctx.param("model.thermal.coffee_heat_capacity_ratio", "1")?;
    let tau = ctx.param("model.thermal.loss_time_constant", "s")?;
    let c_hw = hw.v * WATER_SPECIFIC_HEAT_J_G_K;
    let c_coffee = dose_g * ratio.v * WATER_SPECIFIC_HEAT_J_G_K;
    let capacity = c_hw + c_coffee;
    let capacity_src = join(&[&hw.src, &ratio.src, "recipe:prep.dose_g"]);
    if !capacity.is_finite() || capacity <= 0.0 {
        return Err(ApiError(format!(
            "the heat capacity of bed and basket must be > 0; it comes from {}",
            describe(&capacity_src)
        )));
    }
    let initial = (c_hw * preheat.v + c_coffee * bean_temp.v) / capacity;
    let initial_src = join(&[
        &hw.src,
        &ratio.src,
        &preheat.src,
        &bean_temp.src,
        "recipe:prep.dose_g",
    ]);
    if !(BED_TEMP_C.0..=BED_TEMP_C.1).contains(&initial) {
        return Err(ApiError(format!(
            "the bed starts at {initial:.1} °C, outside the solver's {} to {} °C; it comes from {}",
            BED_TEMP_C.0,
            BED_TEMP_C.1,
            describe(&initial_src)
        )));
    }
    Ok((
        Val::new(initial, initial_src),
        Val::new(capacity, capacity_src),
        Val::new(c_hw / tau.v, join(&[&hw.src, &tau.src])),
    ))
}

/// The stop rule: (beverage mass kg, time s, hard stop s).
pub(crate) fn stop(
    ctx: &mut Ctx,
    s: &StopInput,
    dose_g: f64,
    program_time_s: f64,
) -> Result<(Option<Val>, Option<Val>, f64), ApiError> {
    let beverage = bounds::opt(s.beverage_g, |x| {
        bounds::check_pos(x, bounds::MAX_BEVERAGE_G, "stop.beverage_g", "g")
    })?;
    let time = bounds::opt(s.time_s, |x| {
        bounds::check_pos(x, bounds::MAX_STOP_TIME_S, "stop.time_s", "s")
    })?;
    let beverage = match (beverage, time) {
        (Some(g), _) => Some(Val::new(g / 1e3, "recipe:stop.beverage_g")),
        (None, Some(_)) => None,
        (None, None) => {
            let ratio = ctx.param("model.stop.default_ratio", "1")?;
            ctx.note(format!(
                "Stop: no beverage mass or time given; stopping at {}× the dose ({:.1} g).",
                ratio.v,
                ratio.v * dose_g
            ));
            Some(Val::new(
                ratio.v * dose_g / 1e3,
                join(&[&ratio.src, "recipe:prep.dose_g"]),
            ))
        }
    };
    let time = time.map(|t| Val::new(t, "recipe:stop.time_s"));
    let wanted = MIN_MAX_DURATION_S
        .max(time.as_ref().map_or(0.0, |t| t.v + 30.0))
        .max(program_time_s + 60.0);
    if wanted > bounds::MAX_DURATION_S {
        ctx.note(format!(
            "Stop: the program's timed phases run {program_time_s:.0} s; the simulation stops at {} s at the latest.",
            bounds::MAX_DURATION_S
        ));
    }
    Ok((beverage, time, wanted.min(bounds::MAX_DURATION_S)))
}
