// SPDX-License-Identifier: GPL-2.0-or-later
//! Puck preparation → bed heterogeneity (PLAN §7.3 P; research note 03 §4 and
//! Implications B; docs/model/input-models.md §5).
//!
//! Distribution, fines, a bottom paper, a puck screen, the headspace and the
//! fill flow set three heterogeneity numbers: the spread of column
//! permeabilities, the edge (outer annulus) multiplier and the pre-wetting
//! non-uniformity. Tamp force and a top paper have no modelled effect. The
//! evidence is almost all community data (grade D), so every coefficient is a
//! wide-prior estimate.

use crate::api::ApiError;
use crate::bounds;
use crate::context::{Ctx, Val, join};
use crate::numeric::pow;
use crate::recipe::PrepInput;

/// The solver's largest spread of ln κ over the columns (shot-model.md §2.1).
const MAX_SIGMA_LN_PERMEABILITY: f64 = 3.0;

use super::basket::BasketOut;

/// Accepted values of `prep.distribution`.
const DISTRIBUTIONS: [&str; 3] = ["none", "tap", "wdt"];
/// Below this tamp force a loose bed is flagged (community claim, 03 §4), kgf.
const LOOSE_TAMP_KGF: f64 = 5.0;
/// Above this tamp force no effect was found in three datasets (03 §4), kgf.
const NO_EFFECT_TAMP_KGF: f64 = 10.0;

/// The heterogeneity numbers, with provenance.
#[derive(Clone, Debug)]
pub(crate) struct PrepOut {
    pub sigma_ln_permeability: Val,
    pub edge_area_fraction: Val,
    pub edge_multiplier: Val,
    pub prewet_nonuniformity: Val,
}

/// `fines` is the PSD's volume fraction below 100 µm, `bed_radius_m` the
/// bed's volume-equivalent radius (√(V_bed/(π L)), which shrinks in a
/// tapered basket), `headspace_ml` the water volume above the bed (basket plus
/// group) and `fill_flow_ml_s` the flow that fills it.
pub(crate) fn heterogeneity(
    ctx: &mut Ctx,
    prep: &PrepInput,
    basket: &BasketOut,
    bed_radius_m: f64,
    fines: f64,
    headspace_ml: f64,
    fill_flow_ml_s: f64,
) -> Result<PrepOut, ApiError> {
    ctx.note(
        "Puck prep: distribution, paper, screen and headspace effects rest on community data (grade D); their parameters are wide priors (03 §4).",
    );
    // Permeability spread.
    let dist = match prep.distribution.as_deref() {
        Some(d) if DISTRIBUTIONS.contains(&d) => Val::new(0.0, "recipe:prep.distribution"),
        Some(d) => {
            return Err(ApiError(format!(
                "prep.distribution {d:?} is not one of {}",
                DISTRIBUTIONS.join(", ")
            )));
        }
        None => {
            ctx.note("Puck prep: distribution not given; assumed tapping only (\"tap\").");
            Val::new(0.0, "model:distribution assumed tap")
        }
    };
    let which = prep.distribution.as_deref().unwrap_or("tap");
    let sigma_d = ctx.param(&format!("model.prep.sigma_ln_permeability.{which}"), "1")?;
    let k_fines = ctx.param("model.prep.sigma_fines_sensitivity", "1")?;
    let mut sigma = (sigma_d.v * (1.0 + k_fines.v * (fines - 0.2))).max(0.5 * sigma_d.v);
    if sigma > MAX_SIGMA_LN_PERMEABILITY {
        ctx.note(format!(
            "Puck prep: the permeability spread comes out at σ = {sigma:.2}; held at the solver's {MAX_SIGMA_LN_PERMEABILITY}."
        ));
        sigma = MAX_SIGMA_LN_PERMEABILITY;
    }
    let sigma_ln_permeability = Val::new(
        sigma,
        join(&[
            &dist.src,
            &sigma_d.src,
            &k_fines.src,
            "model:PSD fines fraction",
        ]),
    );

    // Edge multiplier: preparation, then basket geometry.
    let screen = prep.puck_screen == Some(true);
    let paper = prep.paper_bottom == Some(true);
    let base = ctx.param("model.prep.edge_multiplier.base", "1")?;
    let mut m = base.clone();
    if paper {
        let p = ctx.param("model.prep.edge_multiplier.paper", "1")?;
        if p.v > m.v {
            m = Val::new(p.v, join(&[&p.src, "recipe:prep.paper_bottom"]));
        }
    }
    if screen {
        let s = ctx.param("model.prep.edge_multiplier.screen", "1")?;
        if s.v > m.v {
            m = Val::new(s.v, join(&[&s.src, "recipe:prep.puck_screen"]));
        }
    }
    let ratio_ref = ctx.param("model.basket.edge_reference_ratio", "1")?;
    let exponent = ctx.param("model.basket.edge_ratio_exponent", "1")?;
    // The perforated field against the bed's mean radius: holes that stop
    // short of the wall, or a bed that widens above a narrow floor, both make
    // the outer annulus funnel inward (an untested mechanism, grade D).
    let ratio = (basket.perforated_radius_m / bed_radius_m).min(1.0);
    let geometric = pow(ratio / ratio_ref.v, exponent.v);
    let edge = (m.v * geometric).clamp(0.05, 1.0);
    let edge_multiplier = Val::new(
        edge,
        join(&[&m.src, &ratio_ref.src, &exponent.src, &basket.src]),
    );
    let edge_area_fraction = ctx.param("model.bed.edge_area_fraction", "1")?;

    // Pre-wetting non-uniformity: headspace, screen, fill flow.
    let u_max = ctx.param("model.prep.prewet_max", "1")?;
    let v_half = ctx.param("model.prep.prewet_half_headspace", "mL")?;
    let q_jet = ctx.param("model.prep.prewet_jet_flow", "mL/s")?;
    let mut u = u_max.v * headspace_ml / (headspace_ml + v_half.v);
    let mut src = join(&[
        &u_max.src,
        &v_half.src,
        &q_jet.src,
        "model:headspace above the bed",
        "model:fill flow",
    ]);
    if screen {
        let r = ctx.param("model.prep.prewet_screen_reduction", "1")?;
        u *= 1.0 - r.v;
        src = join(&[&src, &r.src, "recipe:prep.puck_screen"]);
    }
    if fill_flow_ml_s > 0.0 {
        u *= (q_jet.v / fill_flow_ml_s).clamp(0.5, 1.0);
    }
    let prewet_nonuniformity = Val::new(u.clamp(0.0, 1.0), src);

    // Inputs without a modelled effect.
    if let Some(t) = prep.tamp_kgf {
        bounds::check(t, 0.0, bounds::MAX_TAMP_KGF, "prep.tamp_kgf", "kgf")?;
        if t < LOOSE_TAMP_KGF {
            ctx.note(format!(
                "Puck prep: a tamp below {LOOSE_TAMP_KGF} kgf risks a loose bed (community claim, unverified); not modelled."
            ));
        } else if t >= NO_EFFECT_TAMP_KGF {
            ctx.note(format!(
                "Puck prep: tamp force has no measurable effect above about {NO_EFFECT_TAMP_KGF} kgf (three datasets, 03 §4); not modelled."
            ));
        } else {
            ctx.note("Puck prep: tamp force between 5 and 10 kgf has no modelled effect (03 §4).");
        }
    }
    if prep.paper_top == Some(true) {
        ctx.note("Puck prep: a top paper has no measurable effect on resistance or EY (second-hand, 03 §4); not modelled.");
    }
    Ok(PrepOut {
        sigma_ln_permeability,
        edge_area_fraction,
        edge_multiplier,
        prewet_nonuniformity,
    })
}
