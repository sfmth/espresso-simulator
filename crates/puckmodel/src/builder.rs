// SPDX-License-Identifier: GPL-2.0-or-later
//! Recipe → [`ShotSpec`]: runs the input models (bean B, grinder G, basket
//! and puck preparation P, machine M) on presets and the parameter registry,
//! and records where every spec field came from (docs/model/input-models.md).
//!
//! Every ShotSpec struct is built with `..Default::default()`, so fields the
//! solver workstream adds (always with defaults) keep this code compiling;
//! clippy's `needless_update` is therefore allowed in this module.
#![allow(clippy::needless_update)]

use std::collections::{BTreeMap, BTreeSet};

use puckcore::shot::{
    BasketGeometry, BedSpec, Heterogeneity, HydraulicsSpec, MachineSpec, NumericsSpec, Relaxation,
    ShotError, ShotSpec, SizeClass, SolublesSpec, SpeciesSpec, StopRule, ThermalSpec, Viscosity,
};
use serde::{Deserialize, Serialize};

use crate::api::ApiError;
use crate::bounds;
use crate::context::{Ctx, Val, describe, join, user_controlled};
use crate::models::{basket, bean, grinder, machine, prep};
use crate::numeric::pow;
use crate::presets::presets;
use crate::recipe::Recipe;
use crate::registry::registry;

/// Default number of particle size classes (PLAN §7.2: ~30).
pub const DEFAULT_SIZE_CLASSES: usize = 30;
/// Doses the plan supports (PLAN §4), g; others get a note.
const PLAN_DOSE_RANGE_G: (f64, f64) = (7.0, 25.0);

/// A built spec plus what the UI needs to explain it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Built {
    pub spec: ShotSpec,
    pub derived: Derived,
}

/// Quantities derived while building the spec. Output document: unknown
/// fields are tolerated and new fields may be added.
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Derived {
    /// M2 compound identity, phase and evidence metadata.
    pub compounds: Vec<crate::SpeciesMeta>,
    /// Volume-weighted size distribution for plotting.
    pub psd_curve: PsdCurve,
    /// Notes for the user (assumptions, clamped inputs, flagged presets).
    pub notes: Vec<String>,
    /// Spec field (dotted path) → comma-separated provenance tokens:
    /// `registry:<id>`, `calibration:<id>`, `override:<id>`,
    /// `preset:<kind>/<id>`, `recipe:<field>` or `model:<description>`.
    pub provenance: BTreeMap<String, String>,
    /// PSD statistics. *(Added in M1.)*
    pub psd: PsdSummary,
    /// The bean as modelled. *(Added in M1.)*
    pub bean: BeanSummary,
    /// The bed in the basket. *(Added in M1.)*
    pub bed: BedSummary,
    /// Presets used, by kind (`bean`, `grinder` or `grinder_family`,
    /// `basket`, `machine`). *(Added in M1.)*
    pub presets: BTreeMap<String, String>,
    /// Flags of the presets used (`estimated`, `unverified`, `disputed`,
    /// `owner-gear`, `generic`). *(Added in M1.)*
    pub flags: Vec<String>,
}

/// A size distribution for plotting.
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PsdCurve {
    pub diameter_um: Vec<f64>,
    /// Volume density per unit ln(diameter).
    pub volume_density: Vec<f64>,
}

/// Statistics of the particle-size distribution.
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PsdSummary {
    /// `"model"` (grinder model) or `"measured"` (recipe PSD).
    pub source: String,
    /// Grinder preset or family id.
    pub grinder: Option<String>,
    pub setting: Option<f64>,
    pub gap_um: Option<f64>,
    /// Volume median diameter, µm.
    pub x50_um: f64,
    /// Volume fraction below 100 µm.
    pub fines_fraction: f64,
    /// Sauter mean diameter D[3,2], µm.
    pub d32_um: f64,
    /// Volume mean diameter D[4,3], µm.
    pub d43_um: f64,
    /// The log-normal components (empty for a measured PSD).
    pub mixture: Vec<MixtureComponent>,
    /// Number of size classes handed to the solver.
    pub classes: usize,
    pub burr_diameter_mm: Option<f64>,
    pub rpm: Option<f64>,
}

/// One component of the PSD mixture.
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MixtureComponent {
    /// `"fines"`, `"coarse"` or `"boulders"`.
    pub component: String,
    /// Volume share.
    pub weight: f64,
    /// Mode of q₃(ln d), µm.
    pub mode_um: f64,
    /// Standard deviation of ln d.
    pub log_width: f64,
}

/// The bean as modelled.
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BeanSummary {
    pub altitude_m: Option<f64>,
    pub variety_group: Option<String>,
    pub storage: Option<String>,
    /// The bean preset whose values filled the recipe's gaps.
    pub preset: String,
    pub arabica_fraction: f64,
    pub roast_level: f64,
    /// The roast level on the Colorette scale (internal mapping).
    pub roast_colorette_pt: f64,
    pub days_off_roast: f64,
    pub process: Option<String>,
    pub bean_temp_c: f64,
    /// CO₂ still in the whole beans, mg/g.
    pub co2_beans_mg_g: f64,
    /// CO₂ in the ground coffee in the puck, mg/g.
    pub co2_puck_mg_g: f64,
}

/// The bed in the basket.
#[derive(Clone, Debug, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BedSummary {
    /// Dry, tamped bed height, mm.
    pub height_mm: f64,
    pub bulk_density_kg_m3: f64,
    /// Intergranular plus intraparticle pore volume per bed volume.
    pub total_porosity: f64,
    pub basket_volume_ml: f64,
    /// Water volume above the bed (basket and group), mL.
    pub headspace_ml: f64,
    /// Sauter diameter of the size classes, µm (scales the permeability).
    pub sauter_diameter_um: f64,
    /// Base permeability κ₀, m².
    pub permeability_m2: f64,
}

/// Kozeny–Carman porosity factor ε³/(1 − ε)².
fn kozeny_carman(eps: f64) -> f64 {
    eps * eps * eps / ((1.0 - eps) * (1.0 - eps))
}

/// Base permeabilities the solver accepts, m² (shot-model.md §2.1).
const KAPPA0_RANGE_M2: (f64, f64) = (1e-18, 1e-10);

/// A porosity in the solver's range [0.01, 0.95].
fn in_open_unit(v: &Val, what: &str) -> Result<f64, ApiError> {
    if v.v.is_finite() && (0.01..=0.95).contains(&v.v) {
        Ok(v.v)
    } else {
        Err(ApiError(format!(
            "{what} = {} must lie between 0.01 and 0.95; it comes from {}",
            v.v,
            describe(&v.src)
        )))
    }
}

/// Builds the physical spec for a recipe.
pub fn build(recipe: &Recipe) -> Result<Built, ApiError> {
    build_traced(recipe).map(|(built, _)| built)
}

/// Like [`build`], and also returns the parameter-registry ids the input
/// models read for this recipe (see `crates/puckmodel/registry-reads.txt`).
pub fn build_traced(recipe: &Recipe) -> Result<(Built, BTreeSet<String>), ApiError> {
    if recipe.schema != crate::RECIPE_SCHEMA {
        return Err(ApiError(format!(
            "unknown recipe schema {:?}; expected {:?}",
            recipe.schema,
            crate::RECIPE_SCHEMA
        )));
    }
    let presets = presets()?;
    let mut ctx = Ctx::new(registry()?, &recipe.overrides)?;

    // Dose and numerics.
    let dose_g = bounds::check(
        recipe.prep.dose_g,
        bounds::DOSE_G.0,
        bounds::DOSE_G.1,
        "prep.dose_g",
        "g",
    )?;
    if dose_g < PLAN_DOSE_RANGE_G.0 || dose_g > PLAN_DOSE_RANGE_G.1 {
        ctx.note(format!(
            "Prep: a {dose_g} g dose is outside the {}–{} g range the models were built for.",
            PLAN_DOSE_RANGE_G.0, PLAN_DOSE_RANGE_G.1
        ));
    }
    let tier = recipe.numerics.tier.unwrap_or(1);
    if tier > 1 {
        return Err(ApiError(
            "numerics.tier must be 0 (preview) or 1 (standard)".into(),
        ));
    }
    let n_classes = recipe.numerics.size_classes.unwrap_or(DEFAULT_SIZE_CLASSES);
    if !(bounds::SIZE_CLASSES.0..=bounds::SIZE_CLASSES.1).contains(&n_classes) {
        return Err(ApiError(format!(
            "numerics.size_classes = {n_classes} must be between {} and {}",
            bounds::SIZE_CLASSES.0,
            bounds::SIZE_CLASSES.1
        )));
    }

    // Input models.
    let bean_state = bean::resolve(&mut ctx, &recipe.bean, presets)?;
    let mut bean = bean::model(&mut ctx, &bean_state)?;
    if recipe.chemistry.as_ref().and_then(|c| c.enabled) == Some(false) {
        bean.species
            .retain(|s| ["caffeine", "trigonelline", "cqa5", "acids"].contains(&s.id));
    }
    let machine = machine::resolve(&mut ctx, &recipe.machine, presets)?;
    let basket = basket::resolve(
        &mut ctx,
        &recipe.basket,
        machine.default_basket.as_deref(),
        presets,
    )?;
    if let Some(d) = machine.basket_diameter_mm
        && (basket.rim_diameter_mm() - d).abs() > 2.0
    {
        ctx.note(format!(
            "Basket: its {:.1} mm rim does not match the machine's {d} mm portafilter.",
            basket.rim_diameter_mm()
        ));
    }
    if let Some([lo, hi]) = basket.dose_range_g
        && !(lo..=hi).contains(&dose_g)
    {
        ctx.note(format!(
            "Basket: a {dose_g} g dose is outside the {} range of {lo}–{hi} g.",
            basket.name
        ));
    }
    let psd = grinder::psd(
        &mut ctx,
        &recipe.grinder,
        presets,
        &bean_state.roast,
        &bean_state.temp_c,
        n_classes,
    )?;

    // Bed: porosities, height, headspace.
    let eps = ctx.param("bed.porosity.intergranular", "1")?;
    in_open_unit(&eps, "bed.porosity.intergranular")?;
    in_open_unit(&bean.intraparticle_porosity, "bed.porosity.intraparticle")?;
    let rho_s = &bean.skeletal_density;
    let bulk = (1.0 - eps.v) * (1.0 - bean.intraparticle_porosity.v) * rho_s.v;
    let dose_kg = dose_g / 1e3;
    let bed_volume = dose_kg / bulk;
    let basket_volume = basket::total_volume(&basket.profile_m);
    let bed_height = basket::fill_height(&basket.profile_m, bed_volume).ok_or_else(|| {
        ApiError(format!(
            "prep.dose_g: {dose_g} g makes a {:.1} mL bed (bulk density {bulk:.0} kg/m³), but the {} holds only {:.1} mL",
            bed_volume * 1e6,
            basket.name,
            basket_volume * 1e6
        ))
    })?;
    // Volume-equivalent radius of the bed: smaller than the rim in a tapered basket.
    let bed_radius = (bed_volume / (std::f64::consts::PI * bed_height)).sqrt();
    let headspace_ml = (basket_volume - bed_volume) * 1e6 + machine.group_headspace_ml.v;
    if bed_height > 0.95 * basket.height_m() {
        ctx.note("Basket: the bed nearly fills the basket; the puck may touch the shower screen.");
    }

    // Puck preparation → heterogeneity.
    let prep = prep::heterogeneity(
        &mut ctx,
        &recipe.prep,
        &basket,
        bed_radius,
        psd.fines_fraction,
        headspace_ml,
        machine.fill_flow_ml_s,
    )?;

    // Hydraulics: the bare base permeability κ_ref is defined at D32_ref and
    // the registry's porosity; the relative Kozeny–Carman closure scales it to
    // this bed: κ₀ = κ_ref (D32/D32_ref)² [KC(ε)/KC(ε_ref)]^α, with α the
    // closure's density exponent (V6; α = 1 is plain Kozeny–Carman, and α = 1
    // keeps the exact v1 arithmetic).
    let kappa_ref = ctx.param("hydraulics.permeability.reference", "m^2")?;
    let d32_ref = ctx.param("model.hydraulics.reference_sauter_diameter", "um")?;
    let eps_ref = ctx.default_of("bed.porosity.intergranular", "1")?;
    let alpha = ctx.param("hydraulics.kozeny_carman.density_exponent", "1")?;
    let kc = |e: f64| {
        let k = kozeny_carman(e);
        if alpha.v == 1.0 { k } else { pow(k, alpha.v) }
    };
    let d32 = psd.classes.d32();
    let kappa0 = kappa_ref.v * (d32 / d32_ref.v) * (d32 / d32_ref.v) * kc(eps.v) / kc(eps_ref.v);
    let kappa_src = join(&[
        &kappa_ref.src,
        &d32_ref.src,
        &eps.src,
        &eps_ref.src,
        &alpha.src,
        &psd.src,
    ]);
    if !(KAPPA0_RANGE_M2.0..=KAPPA0_RANGE_M2.1).contains(&kappa0) {
        return Err(ApiError(format!(
            "the base permeability comes out at {kappa0:.3e} m², outside {:e} to {:e} m²; it comes from {}",
            KAPPA0_RANGE_M2.0,
            KAPPA0_RANGE_M2.1,
            describe(&kappa_src)
        )));
    }
    let swell = ctx.param("hydraulics.swelling.diameter_increase", "%")?;
    let closure = ctx.param("model.hydraulics.swelling_pore_closure", "1")?;
    let swell_tau = ctx.param("hydraulics.swelling.relaxation_time", "s")?;
    let s = swell.v / 100.0;
    let growth = (1.0 + s) * (1.0 + s) * (1.0 + s) - 1.0;
    let eps_swollen = (eps.v - closure.v * (1.0 - eps.v) * growth).max(0.02);
    let swell_amp = (1.0 - kozeny_carman(eps_swollen) / kozeny_carman(eps.v)).clamp(0.0, 0.95);
    let pc = ctx.param("hydraulics.poroelastic.critical_pressure", "bar")?;
    let fines_amp = ctx.param("model.hydraulics.fines_layer_amplitude", "1")?;
    let fines_tau = ctx.param("model.hydraulics.fines_layer_time", "s")?;
    let dispersion = ctx.param("extraction.dispersion.axial_coefficient", "m^2/s")?;
    let a1 = ctx.param("model.hydraulics.viscosity_ln_a1", "1")?;
    let a2 = ctx.param("model.hydraulics.viscosity_ln_a2", "1")?;
    let gamma = ctx.param("model.hydraulics.viscosity_temperature_exponent", "1")?;
    let uptake = ctx.param("model.hydraulics.wetting_uptake", "1")?;
    let particle_water = ctx.param("model.hydraulics.intraparticle_water_fraction", "1")?;
    let pore_air_amp = ctx.param("model.hydraulics.pore_air_amplitude", "1")?;
    let pore_air_power = ctx.param("model.hydraulics.pore_air_permeability_exponent", "1")?;
    let moisture_d = ctx.param("model.hydraulics.moisture_diffusivity", "m^2/s")?;
    // First diffusion-mode time at the Sauter radius. Mapping moisture uptake
    // to hydraulic mobility is an explicit grade-D approximation, not a fit
    // to the held-out first-drop/flow-rise observations.
    let pore_radius = d32 / 2e6;
    let pore_air_tau =
        pore_radius * pore_radius / (std::f64::consts::PI * std::f64::consts::PI * moisture_d.v);
    let pore_air_tau = if pore_air_tau > 600.0 {
        ctx.note(format!(
            "Wetting: the estimated pore-air relaxation time ({pore_air_tau:.0} s) exceeds the solver's 600 s limit and is capped; this grind lies outside the startup closure's useful range."
        ));
        600.0
    } else {
        pore_air_tau
    };
    if pore_air_amp.v > 0.0 {
        ctx.note(format!(
            "Wetting: trapped pore air reduces early permeability, relaxing over an estimated {pore_air_tau:.1} s. The mobility law and its moisture-diffusion timescale are uncertain (grade D); they were not fitted to held-out shot times."
        ));
    }
    let theta = ctx.param("hydraulics.dissolution_porosity_share", "1")?;

    // Solubles.
    let shell = ctx.param("model.extraction.broken_shell_thickness", "um")?;
    let c_sat = ctx.param("extraction.saturation.lumped", "kg/m^3")?;
    let k_lumped = ctx.param("extraction.partition.lumped_80c", "1")?;
    let d_lumped = ctx.param("extraction.diffusivity.lumped.corrochano_80c", "m^2/s")?;
    let k_surface = ctx.param("extraction.surface_rate.grudeva2026", "m/s")?;
    let solute_density = ctx.param("model.extraction.solute_apparent_density", "kg/m^3")?;
    // The solver's water-content check (v̄·max(c_sat, K·s₀) < 0.9) depends on all
    // of these; its error is mapped back to them below.
    let water_src = join(&[
        &bean.extractable.src,
        &bean.intraparticle_porosity.src,
        &rho_s.src,
        &c_sat.src,
        &k_lumped.src,
        &solute_density.src,
    ]);

    // Thermal node and stop rule.
    let (t0, capacity, loss) =
        machine::thermal(&mut ctx, dose_g, &bean_state.temp_c, &machine.preheat)?;
    let ambient = ctx.param("model.thermal.room_temperature", "degC")?;
    let (beverage, time, hard_stop) =
        machine::stop(&mut ctx, &recipe.stop, dose_g, machine.program_time_s)?;

    let chemistry = crate::models::water::model(
        &mut ctx,
        &recipe.water.clone().unwrap_or_default(),
        &recipe.chemistry.clone().unwrap_or_default(),
        &bean,
        dose_g / 1000.0,
    )?;
    let spec = ShotSpec {
        chemistry,
        basket: BasketGeometry {
            profile_m: basket.profile_m.clone(),
            perforated_radius_m: basket.perforated_radius_m,
            open_area_fraction: basket.open_area.v,
            outlet: basket.outlet.clone(),
            extra_headspace_m3: machine.group_headspace_ml.v / 1e6,
            ..Default::default()
        },
        bed: BedSpec {
            dose_kg,
            intergranular_porosity: eps.v,
            intraparticle_porosity: bean.intraparticle_porosity.v,
            skeletal_density_kg_m3: rho_s.v,
            size_classes: psd
                .classes
                .diameters_um
                .iter()
                .zip(&psd.classes.fractions)
                .map(|(d, f)| SizeClass {
                    radius_m: d / 2e6,
                    volume_fraction: *f,
                    ..Default::default()
                })
                .collect(),
            heterogeneity: Heterogeneity {
                sigma_ln_permeability: prep.sigma_ln_permeability.v,
                edge_area_fraction: prep.edge_area_fraction.v,
                edge_multiplier: prep.edge_multiplier.v,
                prewet_nonuniformity: prep.prewet_nonuniformity.v,
                ..Default::default()
            },
            ..Default::default()
        },
        solubles: SolublesSpec {
            extractable_fraction: bean.extractable.v,
            cell_size_m: shell.v / 1e6,
            saturation_kg_m3: c_sat.v,
            partition_coefficient: k_lumped.v,
            kernel_diffusivity_m2_s: d_lumped.v,
            surface_rate_m_s: k_surface.v,
            reference_temp_c: 80.0,
            solute_specific_volume_m3_kg: 1.0 / solute_density.v,
            species: bean
                .species
                .iter()
                .map(|sp| SpeciesSpec {
                    id: sp.id.to_string(),
                    mass_fraction: sp.mass_fraction.v,
                    kernel_diffusivity_m2_s: sp.diffusivity.v,
                    partition_coefficient: sp.partition.v,
                    surface_fraction_scale: sp.surface_scale.v,
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        },
        hydraulics: HydraulicsSpec {
            permeability_m2: kappa0,
            poroelastic_pc_pa: Some(pc.v * 1e5),
            swelling: Relaxation {
                amplitude: swell_amp,
                tau_s: swell_tau.v,
                ..Default::default()
            },
            gas: Relaxation {
                amplitude: bean.gas_amplitude.v,
                tau_s: bean.gas_tau.v,
                ..Default::default()
            },
            fines_layer: Relaxation {
                amplitude: fines_amp.v,
                tau_s: fines_tau.v,
                ..Default::default()
            },
            axial_dispersion_m2_s: dispersion.v,
            viscosity: Viscosity {
                ln_relative_a1: a1.v,
                ln_relative_a2: a2.v,
                temperature_exponent: gamma.v,
                ..Default::default()
            },
            wetting_uptake: uptake.v,
            intraparticle_water_fraction: Some(particle_water.v),
            pore_air: Relaxation {
                amplitude: pore_air_amp.v,
                tau_s: pore_air_tau,
                ..Default::default()
            },
            pore_air_permeability_exponent: pore_air_power.v,
            dissolution_porosity_share: Some(theta.v),
            ..Default::default()
        },
        thermal: ThermalSpec {
            water_temp_c: machine.temperature.v,
            initial_bed_temp_c: t0.v,
            heat_capacity_j_k: capacity.v,
            heat_loss_w_k: loss.v,
            ambient_temp_c: ambient.v,
            ..Default::default()
        },
        machine: MachineSpec {
            phases: machine.phases.clone(),
            pump: machine.pump.clone(),
            hydraulic_compliance_m3_pa: machine.hydraulic_compliance_ml_bar.v / 1e11,
            stop: StopRule {
                time_s: time.as_ref().map(|t| t.v),
                beverage_mass_kg: beverage.as_ref().map(|b| b.v),
                drip_tau_s: machine.drip_tau.v,
                vent_headspace: machine.vent_headspace,
                ..Default::default()
            },
            ..Default::default()
        },
        numerics: NumericsSpec {
            tier,
            max_duration_s: hard_stop,
            ..Default::default()
        },
        ..Default::default()
    };

    // Provenance.
    let solver_default = "model:solver default";
    let entries: Vec<(&str, String)> = vec![
        ("basket.profile_m", basket.src.clone()),
        ("basket.perforated_radius_m", basket.src.clone()),
        ("basket.open_area_fraction", basket.open_area.src.clone()),
        ("basket.outlet", basket.outlet_src.clone()),
        (
            "basket.extra_headspace_m3",
            machine.group_headspace_ml.src.clone(),
        ),
        ("bed.dose_kg", "recipe:prep.dose_g".into()),
        ("bed.intergranular_porosity", eps.src.clone()),
        (
            "bed.intraparticle_porosity",
            bean.intraparticle_porosity.src.clone(),
        ),
        ("bed.skeletal_density_kg_m3", rho_s.src.clone()),
        (
            "bed.size_classes",
            join(&[&psd.src, "model:log-spaced size classes"]),
        ),
        (
            "bed.heterogeneity.columns",
            "model:solver default of 8 columns (PLAN §7.2)".into(),
        ),
        (
            "bed.heterogeneity.sigma_ln_permeability",
            prep.sigma_ln_permeability.src.clone(),
        ),
        (
            "bed.heterogeneity.edge_area_fraction",
            prep.edge_area_fraction.src.clone(),
        ),
        (
            "bed.heterogeneity.edge_multiplier",
            join(&[
                &prep.edge_multiplier.src,
                "recipe:prep.dose_g",
                &bean.intraparticle_porosity.src,
            ]),
        ),
        (
            "bed.heterogeneity.prewet_nonuniformity",
            join(&[
                &prep.prewet_nonuniformity.src,
                &machine.group_headspace_ml.src,
                &basket.src,
                &machine.phases_src,
            ]),
        ),
        (
            "solubles.extractable_fraction",
            bean.extractable.src.clone(),
        ),
        ("solubles.cell_size_m", shell.src.clone()),
        ("solubles.saturation_kg_m3", c_sat.src.clone()),
        ("solubles.partition_coefficient", k_lumped.src.clone()),
        ("solubles.kernel_diffusivity_m2_s", d_lumped.src.clone()),
        ("solubles.surface_rate_m_s", k_surface.src.clone()),
        (
            "solubles.reference_temp_c",
            join(&[
                "model:temperature of the registry diffusivities (80 °C)",
                &d_lumped.src,
            ]),
        ),
        (
            "solubles.solute_specific_volume_m3_kg",
            solute_density.src.clone(),
        ),
        (
            "solubles.kernel_loading_cap",
            "model:solver default (kernel re-uptake capped at the initial content; shot-model.md §5.3)".into(),
        ),
        ("hydraulics.permeability_m2", kappa_src),
        ("hydraulics.poroelastic_pc_pa", pc.src.clone()),
        (
            "hydraulics.dissolution_kozeny_carman",
            "model:relative Kozeny–Carman with dissolution (contract §4)".into(),
        ),
        ("hydraulics.dissolution_porosity_share", theta.src.clone()),
        (
            "hydraulics.swelling.amplitude",
            join(&[&swell.src, &closure.src, &eps.src]),
        ),
        ("hydraulics.swelling.tau_s", swell_tau.src.clone()),
        ("hydraulics.gas.amplitude", bean.gas_amplitude.src.clone()),
        ("hydraulics.gas.tau_s", bean.gas_tau.src.clone()),
        ("hydraulics.fines_layer.amplitude", fines_amp.src.clone()),
        ("hydraulics.fines_layer.tau_s", fines_tau.src.clone()),
        ("hydraulics.axial_dispersion_m2_s", dispersion.src.clone()),
        (
            "hydraulics.viscosity",
            join(&[&a1.src, &a2.src, &gamma.src]),
        ),
        ("hydraulics.wetting_uptake", uptake.src.clone()),
        (
            "hydraulics.intraparticle_water_fraction",
            particle_water.src.clone(),
        ),
        ("hydraulics.pore_air.amplitude", pore_air_amp.src.clone()),
        (
            "hydraulics.pore_air.tau_s",
            join(&[
                &psd.src,
                &moisture_d.src,
                "model:Sauter-radius diffusion time capped at 600 s",
            ]),
        ),
        (
            "hydraulics.pore_air_permeability_exponent",
            pore_air_power.src.clone(),
        ),
        ("thermal.water_temp_c", machine.temperature.src.clone()),
        ("thermal.initial_bed_temp_c", t0.src.clone()),
        ("thermal.heat_capacity_j_k", capacity.src.clone()),
        ("thermal.heat_loss_w_k", loss.src.clone()),
        ("thermal.ambient_temp_c", ambient.src.clone()),
        ("machine.phases", machine.phases_src.clone()),
        ("machine.pump", machine.pump_src.clone()),
        (
            "machine.hydraulic_compliance_m3_pa",
            machine.hydraulic_compliance_ml_bar.src.clone(),
        ),
        ("machine.stop.drip_tau_s", machine.drip_tau.src.clone()),
        ("machine.stop.vent_headspace", machine.vent_src.clone()),
        (
            "numerics.tier",
            if recipe.numerics.tier.is_some() {
                "recipe:numerics.tier"
            } else {
                "model:default tier 1"
            }
            .into(),
        ),
        (
            "numerics.max_duration_s",
            join(&[
                "model:hard stop of at least 120 s and well past the stop time and program (at most 1200 s)",
                time.as_ref().map_or("", |t| t.src.as_str()),
                &machine.phases_src,
            ]),
        ),
        ("numerics.depth_cells", solver_default.into()),
        ("numerics.max_dt_s", solver_default.into()),
        ("numerics.output_interval_s", solver_default.into()),
        ("numerics.snapshot_count", solver_default.into()),
        ("numerics.kernel_shells", solver_default.into()),
    ];
    for (path, src) in entries {
        ctx.prov(path, &src);
    }
    if let Some(b) = &beverage {
        ctx.prov("machine.stop.beverage_mass_kg", &b.src);
    }
    if let Some(t) = &time {
        ctx.prov("machine.stop.time_s", &t.src);
    }
    for (i, sp) in bean.species.iter().enumerate() {
        ctx.prov(
            &format!("solubles.species[{i}].mass_fraction"),
            &sp.mass_fraction.src,
        );
        ctx.prov(
            &format!("solubles.species[{i}].kernel_diffusivity_m2_s"),
            &sp.diffusivity.src,
        );
        ctx.prov(
            &format!("solubles.species[{i}].partition_coefficient"),
            &sp.partition.src,
        );
        ctx.prov(
            &format!("solubles.species[{i}].surface_fraction_scale"),
            &sp.surface_scale.src,
        );
    }

    // The solver's own check: the builder never emits a spec it rejects.
    match puckcore::shot::validate_shot_spec(&spec) {
        Ok(warnings) => {
            for w in warnings {
                ctx.note(format!("Solver: {w}"));
            }
        }
        Err(ShotError::InvalidSpec { field, reason }) => {
            let mut src = ctx.provenance_of(&field).cloned().unwrap_or_default();
            if field == "solubles.solute_specific_volume_m3_kg"
                || field == "solubles.partition_coefficient"
            {
                src = join(&[&src, &water_src]);
            }
            return Err(ApiError(if user_controlled(&src) {
                format!(
                    "the built shot is invalid at {field} ({reason}); it comes from {}",
                    describe(&src)
                )
            } else {
                format!("internal error: the input models built an invalid spec: {field}: {reason}")
            }));
        }
        Err(e) => return Err(ApiError(format!("internal error: {e}"))),
    }
    for id in ctx.unused_overrides() {
        ctx.note(format!(
            "Override {id} has no effect on this recipe: the input models do not use it here."
        ));
    }

    // Derived output.
    let mut used_presets = BTreeMap::new();
    used_presets.insert("bean".to_string(), bean_state.preset.clone());
    if let Some(g) = &psd.grinder {
        used_presets.insert("grinder".to_string(), g.clone());
    }
    if let Some(f) = &psd.family {
        used_presets.insert("grinder_family".to_string(), f.clone());
    }
    if let Some(b) = &basket.preset {
        used_presets.insert("basket".to_string(), b.clone());
    }
    if let Some(m) = &machine.preset {
        used_presets.insert("machine".to_string(), m.clone());
    }
    let mixture = psd
        .mixture
        .as_ref()
        .map(|m| {
            ["fines", "coarse", "boulders"]
                .iter()
                .zip(&m.components)
                .map(|(name, c)| MixtureComponent {
                    component: name.to_string(),
                    weight: c.weight,
                    mode_um: c.mode_um,
                    log_width: c.log_width,
                })
                .collect()
        })
        .unwrap_or_default();
    let used = ctx.used().clone();
    let derived = Derived {
        compounds: crate::models::chemistry_catalog::catalog().to_vec(),
        psd_curve: PsdCurve {
            diameter_um: psd.curve.0.clone(),
            volume_density: psd.curve.1.clone(),
        },
        notes: std::mem::take(&mut ctx.notes),
        provenance: std::mem::take(&mut ctx.provenance),
        psd: PsdSummary {
            source: psd.source.to_string(),
            grinder: psd.grinder.clone().or_else(|| psd.family.clone()),
            setting: psd.setting,
            gap_um: psd.gap_um,
            x50_um: psd.x50_um,
            fines_fraction: psd.fines_fraction,
            d32_um: d32,
            d43_um: psd.d43_um,
            mixture,
            classes: psd.classes.fractions.len(),
            burr_diameter_mm: psd.burr_diameter_mm,
            rpm: psd.rpm,
        },
        bean: BeanSummary {
            altitude_m: bean_state.altitude_m,
            variety_group: bean_state.variety_group.clone(),
            storage: bean_state.storage.clone(),
            preset: bean_state.preset.clone(),
            arabica_fraction: bean_state.arabica.v,
            roast_level: bean_state.roast.v,
            roast_colorette_pt: bean.colorette_pt,
            days_off_roast: bean_state.days.v,
            process: bean_state.process.clone(),
            bean_temp_c: bean_state.temp_c.v,
            co2_beans_mg_g: bean.co2_beans_mg_g,
            co2_puck_mg_g: bean.co2_puck_mg_g,
        },
        bed: BedSummary {
            height_mm: bed_height * 1e3,
            bulk_density_kg_m3: bulk,
            total_porosity: 1.0 - bulk / rho_s.v,
            basket_volume_ml: basket_volume * 1e6,
            headspace_ml,
            sauter_diameter_um: d32,
            permeability_m2: kappa0,
        },
        presets: used_presets,
        flags: ctx.flags.iter().cloned().collect(),
    };
    Ok((Built { spec, derived }, used))
}
