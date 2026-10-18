// SPDX-License-Identifier: GPL-2.0-or-later
//! Bean model v2 (PLAN §7.3 B; research note 02 §1, §4;
//! docs/model/input-models.md §3).
//!
//! Arabica share a, roast level r (0 = very light … 1 = very dark), days off
//! roast and process map to the extractable fraction, compound inventories,
//! skeletal density and intraparticle porosity, and the CO₂ left in
//! the grounds, which sets the gas permeability penalty. Blends mix the
//! Arabica and Robusta values linearly by mass. New chemistry coefficients
//! are broad estimates; the three measured M1 species remain unchanged.

use puckcore::math::exp;

use super::chemistry_catalog::{self, PhaseInventory};
use crate::api::ApiError;
use crate::bounds;
use crate::context::{Ctx, Val, describe, join};
use crate::numeric::{interp_clamped, pow};
use crate::presets::{PresetMeta, Presets};
use crate::recipe::BeanInput;

/// Accepted values of `bean.process`.
const PROCESSES: [&str; 4] = ["washed", "natural", "honey", "anaerobic"];
/// Colorette (Pt) readings of the light, medium and dark roasts of the Smrke
/// 2018 degassing fits: the `conditions` of the registry records bean.co2.*.
const SMRKE_ROAST_PT: [f64; 3] = [131.0, 101.0, 78.0];

/// The bean as described, with gaps filled from a preset.
#[derive(Clone, Debug)]
pub(crate) struct BeanState {
    pub preset: String,
    pub arabica: Val,
    pub roast: Val,
    pub days: Val,
    pub process: Option<String>,
    pub altitude_m: Option<f64>,
    pub variety_group: Option<String>,
    pub storage: Option<String>,
    pub temp_c: Val,
}

/// One tracked species.
#[derive(Clone, Debug)]
pub(crate) struct Species {
    pub id: &'static str,
    /// Extractable mass per dry dose, kg/kg.
    pub mass_fraction: Val,
    /// Kernel diffusivity at 80 °C, m²/s.
    pub diffusivity: Val,
    pub partition: Val,
    pub surface_scale: Val,
}

/// What the bean model hands to the builder.
#[derive(Clone, Debug)]
pub(crate) struct BeanOut {
    pub extractable: Val,
    pub species: Vec<Species>,
    /// Separate K5/K6 available inventories; never included in dissolved TDS.
    pub phase_inventories: Vec<PhaseInventory>,
    pub skeletal_density: Val,
    pub intraparticle_porosity: Val,
    /// CO₂ still in the whole beans and in the ground coffee in the puck, mg/g.
    pub co2_beans_mg_g: f64,
    pub co2_puck_mg_g: f64,
    pub gas_amplitude: Val,
    pub gas_tau: Val,
    /// Roast level on the Colorette scale (internal index → Pt).
    pub colorette_pt: f64,
}

fn in_range(v: f64, lo: f64, hi: f64, what: &str) -> Result<f64, ApiError> {
    bounds::check(v, lo, hi, what, "")
}

/// Fills the bean description from the recipe, its preset and the default bean.
pub(crate) fn resolve(
    ctx: &mut Ctx,
    b: &BeanInput,
    presets: &Presets,
) -> Result<BeanState, ApiError> {
    let (preset, explicit) = match &b.preset {
        Some(id) => (presets.bean(id)?, true),
        None => (presets.default_bean(), false),
    };
    let psrc = format!("preset:bean/{}", preset.id);
    if explicit {
        for note in preset.notes() {
            ctx.note(format!("{}: {note}", preset.name()));
        }
        ctx.flags.extend(preset.flags().iter().cloned());
    }
    let mut assumed = Vec::new();
    let mut take = |value: Option<f64>, path: &str, fallback: f64, label: &str| match value {
        Some(v) => Val::new(v, format!("recipe:bean.{path}")),
        None => {
            if !explicit {
                assumed.push(label.to_string());
            }
            Val::new(fallback, psrc.clone())
        }
    };
    let arabica = take(
        b.arabica_fraction,
        "arabica_fraction",
        preset.arabica_fraction,
        "Arabica share",
    );
    let roast = take(
        b.roast_level,
        "roast_level",
        preset.roast_level,
        "roast level",
    );
    let days = take(
        b.days_off_roast,
        "days_off_roast",
        preset.days_off_roast,
        "days off roast",
    );
    if !assumed.is_empty() {
        ctx.note(format!(
            "Bean: {} not given; taken from {} ({}).",
            assumed.join(", "),
            preset.name,
            preset.id
        ));
    }
    in_range(arabica.v, 0.0, 1.0, "bean.arabica_fraction")?;
    in_range(roast.v, 0.0, 1.0, "bean.roast_level")?;
    in_range(
        days.v,
        0.0,
        bounds::MAX_DAYS_OFF_ROAST,
        "bean.days_off_roast",
    )?;
    let process = b.process.clone().or_else(|| {
        if explicit {
            preset.process.clone()
        } else {
            None
        }
    });
    if let Some(p) = &process {
        if !PROCESSES.contains(&p.as_str()) {
            return Err(ApiError(format!(
                "bean.process {p:?} is not one of {}",
                PROCESSES.join(", ")
            )));
        }
        if p != "anaerobic" {
            ctx.note(format!("Bean v2: process ({p}) is recorded; no quantitative correction is applied to the tracked compounds. For example, dry processing changes reducing sugars in green coffee, not a demonstrated universal sucrose correction in roasted coffee (02 §4.2)."));
        }
    }
    let altitude_m = b.altitude_m.or(preset.altitude_m);
    if let Some(h) = altitude_m {
        in_range(h, 0.0, 4000.0, "bean.altitude_m")?;
        ctx.note("Bean v2: altitude is recorded, but the published origin/process-dependent correlations do not identify a universal roasted-bean composition correction. No altitude multiplier is applied.");
    }
    let variety_group = b
        .variety_group
        .clone()
        .or_else(|| preset.variety_group.clone());
    if let Some(v) = &variety_group {
        const VARIETIES: [&str; 6] = [
            "unspecified",
            "typica-bourbon",
            "gesha",
            "ethiopian-landrace",
            "canephora",
            "hybrid",
        ];
        if !VARIETIES.contains(&v.as_str()) {
            return Err(ApiError(format!(
                "bean.variety_group {v:?} is not one of {}",
                VARIETIES.join(", ")
            )));
        }
        ctx.note("Bean v2: variety group is recorded without an invented composition multiplier. Arabica/Robusta share remains the quantitative species descriptor; variety-specific lot assays are unavailable.");
    }
    let storage = b
        .storage
        .clone()
        .or_else(|| preset.storage.clone())
        .or_else(|| Some("sealed".to_string()));
    if let Some(v) = &storage
        && !["sealed", "open", "frozen"].contains(&v.as_str())
    {
        return Err(ApiError(format!(
            "bean.storage {v:?} must be sealed, open or frozen"
        )));
    }
    let temp_c = match b.bean_temp_c {
        Some(t) => Val::new(
            in_range(
                t,
                bounds::BEAN_TEMP_C.0,
                bounds::BEAN_TEMP_C.1,
                "bean.bean_temp_c",
            )?,
            "recipe:bean.bean_temp_c",
        ),
        None => ctx.param("model.thermal.room_temperature", "degC")?,
    };
    if days.v > 120.0 {
        ctx.note("Bean: coffee more than four months off roast has lost nearly all its CO₂; its aroma loss is only an estimated storage scenario, not a validated staling model.");
    }
    if days.v < 2.0 {
        ctx.note("Bean: coffee under two days off roast is very gassy; the CO₂ effect on flow is large and its size uncertain.");
    }
    Ok(BeanState {
        preset: preset.id.clone(),
        arabica,
        roast,
        days,
        process,
        altitude_m,
        variety_group,
        storage,
        temp_c,
    })
}

/// Composition, physical properties and CO₂ of the bean.
pub(crate) fn model(ctx: &mut Ctx, s: &BeanState) -> Result<BeanOut, ApiError> {
    let (a, r) = (s.arabica.v, s.roast.v);
    let mix = |ar: f64, rob: f64| a * ar + (1.0 - a) * rob;
    let blend = join(&[&s.arabica.src, &s.roast.src]);

    // Tracked species, % db → kg/kg.
    let caf_ar = ctx.param("bean.composition.arabica.caffeine", "%")?;
    let caf_rob = ctx.param("bean.composition.robusta.caffeine", "%")?;
    let caffeine = Val::new(
        mix(caf_ar.v, caf_rob.v) / 100.0,
        join(&[&caf_ar.src, &caf_rob.src, &s.arabica.src]),
    );

    let t_al = ctx.param("model.bean.trigonelline.arabica_light", "%")?;
    let t_ad = ctx.param("model.bean.trigonelline.arabica_dark", "%")?;
    let t_rl = ctx.param("model.bean.trigonelline.robusta_light", "%")?;
    let t_rd = ctx.param("model.bean.trigonelline.robusta_dark", "%")?;
    let trig = mix(
        t_al.v + (t_ad.v - t_al.v) * r,
        t_rl.v + (t_rd.v - t_rl.v) * r,
    ) / 100.0;
    let trigonelline = Val::new(
        trig,
        join(&[&t_al.src, &t_ad.src, &t_rl.src, &t_rd.src, &blend]),
    );

    let c_med = ctx.param("bean.composition.arabica.5cqa", "%")?;
    let c_roast = ctx.param("model.bean.cqa5_roast_change", "1")?;
    let c_ratio = ctx.param("model.bean.cqa5_robusta_ratio", "1")?;
    let c_ar = c_med.v * (1.0 + c_roast.v * (1.0 - 2.0 * r));
    let cqa5 = Val::new(
        mix(c_ar, c_ar * c_ratio.v) / 100.0,
        join(&[&c_med.src, &c_roast.src, &c_ratio.src, &blend]),
    );

    let ac_ar = ctx.param("bean.composition.arabica.aliphatic_acids", "%")?;
    let qu_ar = ctx.param("bean.composition.arabica.quinic_acid", "%")?;
    let ac_rob = ctx.param("bean.composition.robusta.aliphatic_acids", "%")?;
    let qu_rob = ctx.param("bean.composition.robusta.quinic_acid", "%")?;
    let acids = Val::new(
        mix(ac_ar.v + qu_ar.v, ac_rob.v + qu_rob.v) / 100.0,
        join(&[
            &ac_ar.src,
            &qu_ar.src,
            &ac_rob.src,
            &qu_rob.src,
            &s.arabica.src,
        ]),
    );

    let mut species = Vec::new();
    for (id, mass, d_id, k_id, scale_id) in [
        (
            "caffeine",
            caffeine,
            "extraction.diffusivity.caffeine.particle_80c",
            "extraction.partition.caffeine",
            "model.species.caffeine.surface_fraction_scale",
        ),
        (
            "trigonelline",
            trigonelline,
            "model.species.trigonelline.diffusivity_80c",
            "model.species.trigonelline.partition",
            "model.species.trigonelline.surface_fraction_scale",
        ),
        (
            "cqa5",
            cqa5,
            "model.species.cqa5.diffusivity_80c",
            "model.species.cqa5.partition",
            "model.species.cqa5.surface_fraction_scale",
        ),
        (
            "acids",
            acids,
            "model.species.acids.diffusivity_80c",
            "model.species.acids.partition",
            "model.species.acids.surface_fraction_scale",
        ),
    ] {
        species.push(Species {
            id,
            mass_fraction: mass,
            diffusivity: ctx.param(d_id, "m^2/s")?,
            partition: ctx.param(k_id, "1")?,
            surface_scale: ctx.param(scale_id, "1")?,
        });
    }

    // Extractable fraction (maximum EY).
    let ey = ctx.param("extraction.max_yield", "%")?;
    let k_roast = ctx.param("model.bean.extractable_roast_slope", "%")?;
    let k_rob = ctx.param("model.bean.extractable_robusta_increase", "%")?;
    let ext = (ey.v + k_roast.v * (r - 0.5) + k_rob.v * (1.0 - a)) / 100.0;
    let extractable = Val::new(ext, join(&[&ey.src, &k_roast.src, &k_rob.src, &blend]));
    if !(ext.is_finite() && (0.0..=0.6).contains(&ext)) {
        return Err(ApiError(format!(
            "bean: the extractable fraction comes out at {:.1}% of the dose, outside the solver's 0–60%; it comes from {}",
            ext * 100.0,
            describe(&extractable.src)
        )));
    }
    let species_total: f64 = species.iter().map(|sp| sp.mass_fraction.v).sum();
    if species_total >= ext {
        let srcs: Vec<&str> = species
            .iter()
            .map(|sp| sp.mass_fraction.src.as_str())
            .collect();
        ctx.note(format!(
            "Bean: the tracked species add up to {:.1}% of the dose, more than the extractable {:.1}%; check {}.",
            species_total * 100.0,
            ext * 100.0,
            describe(&join(&[&join(&srcs), &extractable.src]))
        ));
    }

    // Skeletal density and intraparticle porosity.
    let skeletal_density = ctx.param("bed.density.skeletal", "kg/m^3")?;
    let eps_med = ctx.param("model.bean.intraparticle_porosity_medium", "1")?;
    let eps_slope = ctx.param("model.bean.intraparticle_porosity_roast_slope", "1")?;
    let eps_bean = (eps_med.v + eps_slope.v * (r - 0.5)).clamp(0.2, 0.8);
    let intraparticle_porosity = ctx.resolve(
        "bed.porosity.intraparticle",
        "1",
        None,
        None,
        Some(Val::new(
            eps_bean,
            join(&[&eps_med.src, &eps_slope.src, &s.roast.src]),
        )),
    )?;

    // CO₂: Weibull degassing of whole beans (Smrke 2018), interpolated in roast level.
    let pt_light = ctx.param("model.bean.roast_index.colorette_light", "1")?;
    let pt_dark = ctx.param("model.bean.roast_index.colorette_dark", "1")?;
    if pt_light.v <= pt_dark.v {
        return Err(ApiError(format!(
            "the Colorette reading of roast level 0 ({}) must exceed that of level 1 ({}); check {}",
            pt_light.v,
            pt_dark.v,
            describe(&join(&[&pt_light.src, &pt_dark.src]))
        )));
    }
    let index = |pt: f64| (pt_light.v - pt) / (pt_light.v - pt_dark.v);
    let rs = SMRKE_ROAST_PT.map(index);
    let total = [
        ctx.param("bean.co2.total.light", "mg/g")?,
        ctx.param("bean.co2.total.medium", "mg/g")?,
        ctx.param("bean.co2.total.dark", "mg/g")?,
    ];
    let scale = [
        ctx.param("bean.co2.weibull_scale.light", "h")?,
        ctx.param("bean.co2.weibull_scale.medium", "h")?,
        ctx.param("bean.co2.weibull_scale.dark", "h")?,
    ];
    let k_light = ctx.param("bean.co2.weibull_shape.light", "1")?;
    let k_dark = ctx.param("bean.co2.weibull_shape.dark", "1")?;
    let k_medium = k_light.v + (k_dark.v - k_light.v) * (rs[1] - rs[0]) / (rs[2] - rs[0]);
    let (m_inf, clamped) = interp_clamped(r, &rs, &total.each_ref().map(|v| v.v));
    let (lambda_h, _) = interp_clamped(r, &rs, &scale.each_ref().map(|v| v.v));
    let (shape, _) = interp_clamped(r, &rs, &[k_light.v, k_medium, k_dark.v]);
    if clamped {
        ctx.note(format!(
            "Bean: roast level {r} lies outside the degassing data (roast levels {:.2}–{:.2}); the nearest roast's CO₂ fit is used.",
            rs[0], rs[2]
        ));
    }
    let hours = s.days.v * 24.0;
    let remaining = if hours > 0.0 {
        exp(-pow(hours / lambda_h, shape))
    } else {
        1.0
    };
    // The 400 h fits underestimate the total (02 §4.4), so they set only the
    // roast ratio and the time course; the level is anchored to the measured
    // CO₂ of freshly ground coffee, taken as Smrke's medium roast.
    let residual = ctx.param("bean.co2.ground_residual", "mg/g")?;
    let loss = ctx.param("model.bean.co2_grinding_loss", "%")?;
    let co2_puck = residual.v * (m_inf / total[1].v) * remaining;
    let co2_beans = co2_puck / (1.0 - loss.v / 100.0);
    let a_max = ctx.param("model.hydraulics.gas_amplitude_max", "1")?;
    let c_half = ctx.param("model.hydraulics.gas_half_content", "mg/g")?;
    let amp = a_max.v * co2_puck / (co2_puck + c_half.v);
    let co2_src = join(&[
        &residual.src,
        &pt_light.src,
        &pt_dark.src,
        &total[0].src,
        &total[1].src,
        &total[2].src,
        &scale[0].src,
        &scale[1].src,
        &scale[2].src,
        &k_light.src,
        &k_dark.src,
        &s.roast.src,
        &s.days.src,
    ]);
    let gas_amplitude = Val::new(amp, join(&[&co2_src, &a_max.src, &c_half.src]));
    let gas_tau = ctx.param("model.hydraulics.gas_relaxation_time", "s")?;
    ctx.note(format!(
        "Bean: about {co2_puck:.1} mg/g of CO₂ is left in the grounds after {:.0} days (fresh-ground residual scaled by the Smrke 2018 degassing fits); it slows early flow by up to {:.0}% (gas mapping estimated, grade D).",
        s.days.v,
        amp * 100.0
    ));
    let phase_inventories = chemistry_catalog::augment(
        ctx,
        s,
        &mut species,
        &extractable,
        Val::new(co2_puck / 1000.0, co2_src),
    )?;
    Ok(BeanOut {
        extractable,
        species,
        phase_inventories,
        skeletal_density,
        intraparticle_porosity,
        co2_beans_mg_g: co2_beans,
        co2_puck_mg_g: co2_puck,
        gas_amplitude,
        gas_tau,
        colorette_pt: pt_light.v - r * (pt_light.v - pt_dark.v),
    })
}
