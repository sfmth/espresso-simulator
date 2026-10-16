// SPDX-License-Identifier: GPL-2.0-or-later
//! Basket geometry (PLAN §7.3 P, design principle 7;
//! docs/model/input-models.md §4).
//!
//! Any axisymmetric basket: an inner wall profile of [height, diameter]
//! points (straight, tapered or stepped), a perforated field on the floor,
//! and plain holes or a pressurised (dual-wall) orifice. Presets use the same
//! fields as a custom basket. The volume helpers integrate the profile as
//! stacked frusta, which is how the solver fills the bed (contract §4).

use puckcore::shot::Outlet;

use crate::api::ApiError;
use crate::bounds;
use crate::context::{Ctx, Val, describe, field_src, join};
use crate::numeric::bisect;
use crate::presets::{PresetMeta, Presets};
use crate::recipe::{BasketCustom, BasketInput};

/// The basket in SI units, with provenance.
#[derive(Clone, Debug)]
pub(crate) struct BasketOut {
    /// `[height above the floor, inner radius]`, m.
    pub profile_m: Vec<[f64; 2]>,
    pub perforated_radius_m: f64,
    pub open_area: Val,
    pub outlet: Outlet,
    /// Provenance of the profile and perforated radius.
    pub src: String,
    /// Provenance of the outlet.
    pub outlet_src: String,
    pub preset: Option<String>,
    pub name: String,
    pub dose_range_g: Option<[f64; 2]>,
}

impl BasketOut {
    pub fn rim_diameter_mm(&self) -> f64 {
        self.profile_m[self.profile_m.len() - 1][1] * 2000.0
    }

    pub fn height_m(&self) -> f64 {
        self.profile_m[self.profile_m.len() - 1][0]
    }
}

/// Resolves the basket: a custom description, a preset, or the machine's
/// default basket.
pub(crate) fn resolve(
    ctx: &mut Ctx,
    b: &BasketInput,
    machine_default: Option<&str>,
    presets: &Presets,
) -> Result<BasketOut, ApiError> {
    if let Some(custom) = &b.custom {
        if b.preset.is_some() {
            ctx.note("Basket: the custom basket is used; basket.preset is ignored.");
        }
        return geometry(
            ctx,
            custom,
            "recipe:basket.custom".into(),
            None,
            "custom basket".into(),
            None,
        );
    }
    let id = match (&b.preset, machine_default) {
        (Some(id), _) => id.clone(),
        (None, Some(id)) => {
            ctx.note(format!(
                "Basket: none given; using the machine's default basket ({id})."
            ));
            id.to_string()
        }
        (None, None) => return Err(ApiError("basket: give a preset or a custom basket".into())),
    };
    let p = presets.basket(&id)?;
    for note in p.notes() {
        ctx.note(format!("{}: {note}", p.name()));
    }
    ctx.flags.extend(p.flags().iter().cloned());
    let custom = BasketCustom {
        profile_mm: p.profile_mm.clone(),
        perforated_diameter_mm: p.perforated_diameter_mm,
        open_area_fraction: p.open_area_fraction,
        pressurised_orifice_mm: p.pressurised_orifice_mm,
        discharge_coefficient: p.discharge_coefficient,
    };
    geometry(
        ctx,
        &custom,
        format!("preset:basket/{id}"),
        Some(id),
        p.name.clone(),
        Some(p.dose_range_g),
    )
}

fn geometry(
    ctx: &mut Ctx,
    c: &BasketCustom,
    src: String,
    preset: Option<String>,
    name: String,
    dose_range_g: Option<[f64; 2]>,
) -> Result<BasketOut, ApiError> {
    let from_recipe = preset.is_none();
    let what = if from_recipe {
        "basket.custom"
    } else {
        "basket preset"
    };
    let profile = &c.profile_mm;
    if profile.len() < 2 {
        return Err(ApiError(format!(
            "{what}: profile_mm needs at least two [height, diameter] points"
        )));
    }
    let (d_lo, d_hi) = bounds::BASKET_DIAMETER_MM;
    for (i, p) in profile.iter().enumerate() {
        bounds::check(
            p[0],
            0.0,
            bounds::MAX_BASKET_HEIGHT_MM,
            &format!("{what}.profile_mm[{i}] height"),
            "mm",
        )?;
        bounds::check(
            p[1],
            d_lo,
            d_hi,
            &format!("{what}.profile_mm[{i}] diameter"),
            "mm",
        )?;
    }
    if profile[0][0] != 0.0 {
        return Err(ApiError(format!(
            "{what}: profile_mm must start at height 0 (the floor)"
        )));
    }
    if profile.windows(2).any(|w| w[1][0] <= w[0][0]) {
        return Err(ApiError(format!(
            "{what}: profile_mm heights must strictly increase (give a vertical step a small height, e.g. 0.1 mm)"
        )));
    }
    let floor_d = profile[0][1];
    let perf = c.perforated_diameter_mm;
    if !(perf.is_finite()
        && perf >= bounds::MIN_PERFORATED_DIAMETER_MM
        && perf <= floor_d * (1.0 + 1e-12))
    {
        return Err(ApiError(format!(
            "{what}: perforated_diameter_mm = {perf} must be at least {} mm and at most the floor diameter ({floor_d} mm)",
            bounds::MIN_PERFORATED_DIAMETER_MM
        )));
    }
    let given = |v: Option<f64>, name: &str| v.map(|x| Val::new(x, field_src(&src, name)));
    let (recipe_area, preset_area) = if from_recipe {
        (given(c.open_area_fraction, "open_area_fraction"), None)
    } else {
        (None, given(c.open_area_fraction, "open_area_fraction"))
    };
    if let Some(f) = c.open_area_fraction {
        bounds::check(
            f,
            bounds::MIN_OPEN_AREA,
            1.0,
            &format!("{what}.open_area_fraction"),
            "",
        )?;
    }
    let open_area = ctx.resolve(
        "model.basket.open_area_fraction",
        "1",
        recipe_area,
        preset_area,
        None,
    )?;
    if !(open_area.v > 0.0 && open_area.v <= 1.0) {
        return Err(ApiError(format!(
            "the open area fraction {} from {} must be in (0, 1]",
            open_area.v,
            describe(&open_area.src)
        )));
    }
    let (outlet, outlet_src) = match c.pressurised_orifice_mm {
        None => {
            if c.discharge_coefficient.is_some() {
                ctx.note(
                    "Basket: discharge_coefficient applies only to a pressurised basket; ignored.",
                );
            }
            (Outlet::Holes, src.clone())
        }
        Some(d) => {
            let (o_lo, o_hi) = bounds::ORIFICE_MM;
            bounds::check(
                d,
                o_lo,
                o_hi,
                &format!("{what}.pressurised_orifice_mm"),
                "mm",
            )?;
            if d >= perf {
                return Err(ApiError(format!(
                    "{what}: pressurised_orifice_mm must be smaller than the perforated diameter"
                )));
            }
            if let Some(cd) = c.discharge_coefficient {
                let (c_lo, c_hi) = bounds::DISCHARGE_COEFFICIENT;
                bounds::check(cd, c_lo, c_hi, &format!("{what}.discharge_coefficient"), "")?;
            }
            let (recipe_cd, preset_cd) = if from_recipe {
                (
                    given(c.discharge_coefficient, "discharge_coefficient"),
                    None,
                )
            } else {
                (
                    None,
                    given(c.discharge_coefficient, "discharge_coefficient"),
                )
            };
            let cd = ctx.resolve(
                "model.basket.pressurised_discharge_coefficient",
                "1",
                recipe_cd,
                preset_cd,
                None,
            )?;
            if !(cd.v > 0.0 && cd.v <= 1.0) {
                return Err(ApiError(format!(
                    "the discharge coefficient {} from {} must be in (0, 1]",
                    cd.v,
                    describe(&cd.src)
                )));
            }
            ctx.note(format!(
                "Basket: pressurised (dual-wall) outlet, a {d} mm orifice with C_d = {}: it adds a resistance growing with the square of the flow.",
                cd.v
            ));
            (
                Outlet::Pressurised {
                    orifice_diameter_m: d / 1e3,
                    discharge_coefficient: cd.v,
                },
                join(&[&src, &cd.src]),
            )
        }
    };
    Ok(BasketOut {
        profile_m: profile.iter().map(|p| [p[0] / 1e3, p[1] / 2e3]).collect(),
        perforated_radius_m: perf / 2e3,
        open_area,
        outlet,
        src,
        outlet_src,
        preset,
        name,
        dose_range_g,
    })
}

/// Volume of a frustum of height h between radii r0 and r1.
fn frustum(h: f64, r0: f64, r1: f64) -> f64 {
    std::f64::consts::PI * h * (r0 * r0 + r0 * r1 + r1 * r1) / 3.0
}

/// Volume enclosed between the floor and height h, m³ (the radius is linear
/// between profile points).
pub(crate) fn volume_to(profile: &[[f64; 2]], h: f64) -> f64 {
    let mut v = 0.0;
    for w in profile.windows(2) {
        let ([h0, r0], [h1, r1]) = (w[0], w[1]);
        if h <= h0 {
            break;
        }
        let top = h.min(h1);
        let r_top = r0 + (r1 - r0) * (top - h0) / (h1 - h0);
        v += frustum(top - h0, r0, r_top);
    }
    v
}

/// Total volume of the basket, m³.
pub(crate) fn total_volume(profile: &[[f64; 2]]) -> f64 {
    volume_to(profile, profile[profile.len() - 1][0])
}

/// Height of a bed of volume v, m; None if it does not fit.
pub(crate) fn fill_height(profile: &[[f64; 2]], v: f64) -> Option<f64> {
    let top = profile[profile.len() - 1][0];
    if v > total_volume(profile) {
        return None;
    }
    bisect(0.0, top, |h| volume_to(profile, h) - v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cylinder_and_cone_volumes() {
        let cyl = [[0.0, 0.03], [0.02, 0.03]];
        let want = std::f64::consts::PI * 0.03 * 0.03 * 0.02;
        assert!((total_volume(&cyl) / want - 1.0).abs() < 1e-12);
        let h = fill_height(&cyl, want / 2.0).unwrap();
        assert!((h - 0.01).abs() < 1e-12);
        assert!(fill_height(&cyl, want * 1.01).is_none());
        // Truncated cone, then a straight section: volumes add up.
        let stepped = [[0.0, 0.02], [0.01, 0.03], [0.02, 0.03]];
        let cone = frustum(0.01, 0.02, 0.03);
        let rest = std::f64::consts::PI * 0.03 * 0.03 * 0.01;
        assert!((total_volume(&stepped) - cone - rest).abs() < 1e-15);
        assert!((volume_to(&stepped, 0.005) - frustum(0.005, 0.02, 0.025)).abs() < 1e-15);
    }
}
