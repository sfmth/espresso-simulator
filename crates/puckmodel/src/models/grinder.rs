// SPDX-License-Identifier: GPL-2.0-or-later
//! Grinder → particle-size distribution (PLAN §7.3 G; research note 03 §1–§2
//! and Implications A; docs/model/input-models.md §2).
//!
//! The volume-weighted PSD is a three-component log-normal mixture in
//! ln(diameter): fines (mode μ_f ≈ 40 µm), coarse (mode μ_c) and a boulder
//! tail (mode r_b·μ_c). From the burr gap g:
//!
//! - X50 = κ_G · g · f_roast · f_T, where κ_G is the measured X50/gap ratio
//!   (registry `psd.x50_gap_ratio`, 1.4 on the Bentwood V63);
//! - the fines weight follows the coarse mode, logit w_f = logit w_340 −
//!   γ ln(μ_c/μ_340) (`model.psd.fines_weight_slope`), anchored where the
//!   grinder's median is 340 µm and its volume share below 100 µm is u_G
//!   (Gagné's metric, from the family or preset);
//! - μ_c is solved so the mixture's median is X50.
//!
//! Note 03 writes μ_c = κ_G g …, which treats the median and the coarse mode as
//! the same; applying κ_G to the median is how it was measured. The fines
//! relation on μ_c holds from X50 ≈ 60 to 1300 µm in the PSD data (docs §2.3),
//! so fine settings reach espresso-fine and Turkish-like distributions.

use puckcore::math::exp;

use crate::api::ApiError;
use crate::bounds;
use crate::context::{Ctx, Val, join};
use crate::numeric::{bisect, ln, norm_cdf, norm_pdf};
use crate::presets::{GrinderFamilyPreset, GrinderPreset, Presets, PsdParameters};
use crate::recipe::{GrinderInput, PsdInput};

/// Smallest burr gap the model accepts, µm.
const MIN_GAP_UM: f64 = 5.0;
/// The smallest median the mixture handles, as a multiple of μ_f: below it
/// the median would sit inside the fines mode.
const MIN_X50_OVER_FINES_MODE: f64 = 1.25;
/// Reference median of the fines relation (Gagné's u_G metric), µm.
const FINES_REFERENCE_X50_UM: f64 = 340.0;
/// Below this median no grinder's X50/gap relation was measured (the finest
/// anchored settings give X50 ≈ 200–230 µm), µm.
const FINEST_ANCHORED_X50_UM: f64 = 150.0;
/// Size classes cover the mixture between these quantiles (tails folded in).
const CLASS_QUANTILES: (f64, f64) = (0.0005, 0.9995);
/// Class diameters the solver accepts (radii 0.1 µm–5 mm), µm, with a margin.
const CLASS_DIAMETER_UM: (f64, f64) = (0.25, 9000.0);
/// Points of the plotted curve.
const CURVE_POINTS: usize = 200;
/// Accepted values of `grinder.psd.method`.
const PSD_METHODS: [&str; 5] = ["dry_laser", "wet_laser", "image", "sieve", "other"];

/// One log-normal component: q₃(ln d) = w φ((ln d − ln μ)/σ)/σ.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Component {
    pub weight: f64,
    pub mode_um: f64,
    pub log_width: f64,
    ln_mode: f64,
}

impl Component {
    fn new(weight: f64, ln_mode: f64, log_width: f64) -> Self {
        Self {
            weight,
            mode_um: exp(ln_mode),
            log_width,
            ln_mode,
        }
    }
}

/// The three-component mixture.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Mixture {
    pub components: [Component; 3],
}

impl Mixture {
    /// Volume fraction below exp(l).
    fn cdf_ln(&self, l: f64) -> f64 {
        self.components
            .iter()
            .map(|c| c.weight * norm_cdf((l - c.ln_mode) / c.log_width))
            .sum()
    }

    /// Volume fraction below `d_um`.
    pub fn cdf(&self, d_um: f64) -> f64 {
        self.cdf_ln(ln(d_um))
    }

    /// Volume density per unit ln(d).
    fn density_ln(&self, l: f64) -> f64 {
        self.components
            .iter()
            .map(|c| c.weight * norm_pdf((l - c.ln_mode) / c.log_width) / c.log_width)
            .sum()
    }

    /// ln of the diameter below which a fraction `p` of the volume lies.
    fn quantile_ln(&self, p: f64) -> f64 {
        let lo = self
            .components
            .iter()
            .map(|c| c.ln_mode - 10.0 * c.log_width)
            .fold(f64::INFINITY, f64::min);
        let hi = self
            .components
            .iter()
            .map(|c| c.ln_mode + 10.0 * c.log_width)
            .fold(f64::NEG_INFINITY, f64::max);
        bisect(lo, hi, |l| self.cdf_ln(l) - p).unwrap_or(0.5 * (lo + hi))
    }

    /// Sauter mean diameter D[3,2], µm (the builder reports the classes'
    /// value, which scales the permeability).
    #[cfg(test)]
    pub fn d32(&self) -> f64 {
        let s: f64 = self
            .components
            .iter()
            .map(|c| c.weight * exp(0.5 * c.log_width * c.log_width) / c.mode_um)
            .sum();
        1.0 / s
    }

    /// Volume mean diameter D[4,3], µm.
    pub fn d43(&self) -> f64 {
        self.components
            .iter()
            .map(|c| c.weight * c.mode_um * exp(0.5 * c.log_width * c.log_width))
            .sum()
    }
}

/// Inputs of the mixture solve.
#[derive(Clone, Debug)]
pub(crate) struct MixtureInput {
    pub x50_um: f64,
    /// Target volume fraction below 100 µm.
    pub fines_fraction: f64,
    pub fines_mode_um: f64,
    pub fines_log_width: f64,
    pub coarse_log_width: f64,
    pub boulder_weight: f64,
    pub boulder_log_width: f64,
    pub boulder_mode_ratio: f64,
}

/// Solves w_f and μ_c so the mixture's median is `x50_um` and its volume
/// fraction below 100 µm is `fines_fraction`. For each trial μ_c the fines
/// weight follows linearly from the 100 µm condition; μ_c is then found by
/// bisection on the median condition.
pub(crate) fn solve_mixture(p: &MixtureInput) -> Option<Mixture> {
    let l100 = ln(100.0);
    let lx50 = ln(p.x50_um);
    let lmf = ln(p.fines_mode_um);
    let lrb = ln(p.boulder_mode_ratio);
    let wb = p.boulder_weight;
    let pf = norm_cdf((l100 - lmf) / p.fines_log_width);
    let weights = |lmc: f64| -> (f64, f64) {
        let pc = norm_cdf((l100 - lmc) / p.coarse_log_width);
        let pb = norm_cdf((l100 - lmc - lrb) / p.boulder_log_width);
        let wf = (p.fines_fraction - (1.0 - wb) * pc - wb * pb) / (pf - pc);
        let wf_max = (1.0 - wb - 0.01).max(0.0);
        let wf = if wf.is_finite() {
            wf.max(0.0).min(wf_max)
        } else {
            wf_max
        };
        (wf, 1.0 - wf - wb)
    };
    let median_gap = |lmc: f64| -> f64 {
        let (wf, wc) = weights(lmc);
        wf * norm_cdf((lx50 - lmf) / p.fines_log_width)
            + wc * norm_cdf((lx50 - lmc) / p.coarse_log_width)
            + wb * norm_cdf((lx50 - lmc - lrb) / p.boulder_log_width)
            - 0.5
    };
    let lmc = bisect(lmf + ln(1.5), lx50 + ln(8.0), median_gap)?;
    let (wf, wc) = weights(lmc);
    let m = Mixture {
        components: [
            Component::new(wf, lmf, p.fines_log_width),
            Component::new(wc, lmc, p.coarse_log_width),
            Component::new(wb, lmc + lrb, p.boulder_log_width),
        ],
    };
    // A clamped fines weight means the targets are inconsistent.
    let ok =
        (m.cdf_ln(lx50) - 0.5).abs() < 1e-6 && (m.cdf_ln(l100) - p.fines_fraction).abs() < 1e-6;
    ok.then_some(m)
}

/// The fines relation: logit w_f = logit w_ref − γ (ln μ_c − ln μ_ref).
#[derive(Clone, Copy, Debug)]
pub(crate) struct FinesRelation {
    pub ln_coarse_ref: f64,
    pub logit_ref: f64,
    pub slope: f64,
}

impl FinesRelation {
    /// Anchors the relation where the median is `x50_um` and the volume
    /// fraction below 100 µm is `fines_fraction` (u_G at 340 µm).
    pub(crate) fn anchored(p: &MixtureInput, slope: f64) -> Option<Self> {
        let m = solve_mixture(p)?;
        let (wf, mc) = (m.components[0].weight, m.components[1]);
        (wf > 0.0 && wf < 1.0).then(|| Self {
            ln_coarse_ref: mc.ln_mode,
            logit_ref: ln(wf / (1.0 - wf)),
            slope,
        })
    }

    /// Fines weight for a coarse mode exp(`ln_coarse`).
    pub(crate) fn weight(&self, ln_coarse: f64) -> f64 {
        let z = self.logit_ref - self.slope * (ln_coarse - self.ln_coarse_ref);
        1.0 / (1.0 + exp(-z))
    }
}

/// Solves μ_c so the mixture's median is `p.x50_um` while the fines weight
/// follows `rel` (`p.fines_fraction` is not used). The median rises
/// monotonically with μ_c, so the root is unique.
pub(crate) fn solve_on_relation(p: &MixtureInput, rel: &FinesRelation) -> Option<Mixture> {
    let lx50 = ln(p.x50_um);
    let lmf = ln(p.fines_mode_um);
    let lrb = ln(p.boulder_mode_ratio);
    let wb = p.boulder_weight;
    let weights = |lmc: f64| -> (f64, f64) {
        let wf = rel.weight(lmc).min((1.0 - wb).max(0.0));
        (wf, 1.0 - wf - wb)
    };
    let median_gap = |lmc: f64| -> f64 {
        let (wf, wc) = weights(lmc);
        wf * norm_cdf((lx50 - lmf) / p.fines_log_width)
            + wc * norm_cdf((lx50 - lmc) / p.coarse_log_width)
            + wb * norm_cdf((lx50 - lmc - lrb) / p.boulder_log_width)
            - 0.5
    };
    let lmc = bisect(lmf + ln(1.2), lx50 + ln(8.0), median_gap)?;
    let (wf, wc) = weights(lmc);
    let m = Mixture {
        components: [
            Component::new(wf, lmf, p.fines_log_width),
            Component::new(wc, lmc, p.coarse_log_width),
            Component::new(wb, lmc + lrb, p.boulder_log_width),
        ],
    };
    ((m.cdf_ln(lx50) - 0.5).abs() < 1e-6 && wc >= 0.0).then_some(m)
}

/// Particle size classes: representative diameters and volume fractions.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Classes {
    pub diameters_um: Vec<f64>,
    pub fractions: Vec<f64>,
}

impl Classes {
    /// Sauter mean diameter of the classes, µm.
    pub fn d32(&self) -> f64 {
        1.0 / self
            .diameters_um
            .iter()
            .zip(&self.fractions)
            .map(|(d, f)| f / d)
            .sum::<f64>()
    }

    /// Volume mean diameter of the classes, µm.
    pub fn d43(&self) -> f64 {
        self.diameters_um
            .iter()
            .zip(&self.fractions)
            .map(|(d, f)| f * d)
            .sum()
    }

    fn normalised(diameters_um: Vec<f64>, fractions: Vec<f64>) -> Self {
        let total: f64 = fractions.iter().sum();
        Self {
            diameters_um,
            fractions: fractions.iter().map(|f| f / total).collect(),
        }
    }
}

/// `n` classes log-spaced between the mixture's 0.05% and 99.95% quantiles;
/// the tails are folded into the end classes. Each class is represented by
/// the geometric midpoint of its edges.
pub(crate) fn discretise(m: &Mixture, n: usize) -> Classes {
    let (d_min, d_max) = (ln(CLASS_DIAMETER_UM.0), ln(CLASS_DIAMETER_UM.1));
    let lo = m.quantile_ln(CLASS_QUANTILES.0).max(d_min);
    let hi = m.quantile_ln(CLASS_QUANTILES.1).min(d_max).max(lo + 1e-6);
    let step = (hi - lo) / n as f64;
    let edge = |i: usize| lo + i as f64 * step;
    let cdf: Vec<f64> = (0..=n)
        .map(|i| {
            if i == 0 {
                0.0
            } else if i == n {
                1.0
            } else {
                m.cdf_ln(edge(i))
            }
        })
        .collect();
    let fractions = cdf.windows(2).map(|w| (w[1] - w[0]).max(0.0)).collect();
    let diameters = (0..n).map(|i| exp(edge(i) + 0.5 * step)).collect();
    Classes::normalised(diameters, fractions)
}

/// A plotted curve: diameters (µm) and volume density per unit ln(d).
pub(crate) type Curve = (Vec<f64>, Vec<f64>);

fn mixture_curve(m: &Mixture) -> Curve {
    let lo = ln(5.0).min(m.quantile_ln(CLASS_QUANTILES.0) - ln(2.0));
    let hi = ln(1500.0).max(m.quantile_ln(CLASS_QUANTILES.1) + ln(1.5));
    let step = (hi - lo) / (CURVE_POINTS - 1) as f64;
    (0..CURVE_POINTS)
        .map(|i| {
            let l = lo + i as f64 * step;
            (exp(l), m.density_ln(l))
        })
        .unzip()
}

/// What the grinder model hands to the builder.
#[derive(Clone, Debug)]
pub(crate) struct PsdOut {
    pub classes: Classes,
    pub curve: Curve,
    /// Provenance of the size classes.
    pub src: String,
    /// `"model"` or `"measured"`.
    pub source: &'static str,
    /// Grinder preset id (named or generic grinder).
    pub grinder: Option<String>,
    /// Burr family id.
    pub family: Option<String>,
    pub setting: Option<f64>,
    pub gap_um: Option<f64>,
    pub x50_um: f64,
    /// Volume fraction below 100 µm.
    pub fines_fraction: f64,
    pub d43_um: f64,
    pub mixture: Option<Mixture>,
    pub burr_diameter_mm: Option<f64>,
    pub rpm: Option<f64>,
}

/// The first available preset-level value: the grinder preset, then its family.
fn preset_value(chain: &[(Option<f64>, &str)]) -> Option<Val> {
    chain
        .iter()
        .find_map(|(v, src)| v.map(|v| Val::new(v, *src)))
}

fn recipe_value(v: Option<f64>, path: &str) -> Option<Val> {
    v.map(|v| Val::new(v, format!("recipe:{path}")))
}

/// The grinder model: a measured PSD, or the mixture model from a preset or a
/// family plus a gap. `roast` is the roast level and `bean_temp` the bean
/// temperature (°C), both from the bean model.
pub(crate) fn psd(
    ctx: &mut Ctx,
    g: &GrinderInput,
    presets: &Presets,
    roast: &Val,
    bean_temp: &Val,
    n_classes: usize,
) -> Result<PsdOut, ApiError> {
    if let Some(measured_psd) = &g.psd {
        if g.preset.is_some() || g.family.is_some() || g.gap_um.is_some() || g.setting.is_some() {
            ctx.note(
                "Grinder: the measured PSD is used; preset, family, setting and gap are ignored.",
            );
        }
        return measured(ctx, measured_psd, n_classes);
    }

    let (preset, family): (Option<&GrinderPreset>, &GrinderFamilyPreset) =
        match (&g.preset, &g.family) {
            (Some(id), fam) => {
                let p = presets.grinder(id)?;
                if fam.as_deref().is_some_and(|f| f != p.family) {
                    ctx.note(format!(
                    "Grinder: grinder.family is ignored; the preset {} belongs to the {} family.",
                    p.name, p.family
                ));
                }
                (Some(p), presets.grinder_family(&p.family)?)
            }
            (None, Some(fid)) => (None, presets.grinder_family(fid)?),
            (None, None) => {
                return Err(ApiError(
                    "grinder: give a preset, a family with gap_um, or a measured psd".into(),
                ));
            }
        };
    let fam_src = format!("preset:grinder_family/{}", family.id);
    let preset_src = preset.map(|p| format!("preset:grinder/{}", p.id));
    if let Some(p) = preset {
        for note in &p.notes {
            ctx.note(format!("{}: {note}", p.name));
        }
        ctx.flags.extend(p.flags.iter().cloned());
    }
    // The family's PSD widths and weights are grade-D estimates for named
    // grinders too, so its notes and flags always apply.
    for note in &family.notes {
        ctx.note(format!("{}: {note}", family.name));
    }
    ctx.flags.extend(
        family
            .flags
            .iter()
            .filter(|f| preset.is_none() || f.as_str() != "generic")
            .cloned(),
    );

    // Burr gap.
    let gap_at_ref = bounds::opt(g.gap_at_ref_um, |x| {
        bounds::check(x, 0.0, bounds::MAX_GAP_UM, "grinder.gap_at_ref_um", "µm")
    })?;
    let gap_per_unit = bounds::opt(g.gap_per_unit_um, |x| {
        bounds::check_pos(
            x,
            bounds::MAX_GAP_PER_UNIT_UM,
            "grinder.gap_per_unit_um",
            "µm",
        )
    })?;
    let mut setting_used = None;
    let mut gap = if let Some(gap_um) = g.gap_um {
        bounds::check_pos(gap_um, bounds::MAX_GAP_UM, "grinder.gap_um", "µm")?;
        if preset.is_some() && g.setting.is_some() {
            ctx.note("Grinder: grinder.gap_um is used; the dial setting is ignored.");
        }
        Val::new(gap_um, "recipe:grinder.gap_um")
    } else if let Some(p) = preset {
        let dial = &p.dial;
        let mut s = match g.setting {
            Some(s) if s.is_finite() => Val::new(s, "recipe:grinder.setting"),
            Some(_) => return Err(ApiError("grinder.setting must be a finite number".into())),
            None => {
                ctx.note(format!(
                    "Grinder: no setting given; using the {} default of {} ({}).",
                    p.name, dial.default, dial.label
                ));
                Val::new(dial.default, preset_src.clone().unwrap_or_default())
            }
        };
        if s.v < dial.min || s.v > dial.max {
            let clamped = s.v.max(dial.min).min(dial.max);
            ctx.note(format!(
                "Grinder: setting {} is outside the {} dial ({}–{}); clamped to {clamped}.",
                s.v, p.name, dial.min, dial.max
            ));
            s.v = clamped;
        }
        let ps = preset_src.as_deref().unwrap_or("");
        let g0 = match gap_at_ref {
            Some(v) => Val::new(v, "recipe:grinder.gap_at_ref_um"),
            None => Val::new(dial.gap_at_ref_um, ps),
        };
        let step = match gap_per_unit {
            Some(v) => Val::new(v, "recipe:grinder.gap_per_unit_um"),
            None => Val::new(dial.gap_per_unit_um, ps),
        };
        setting_used = Some(s.v);
        Val::new(
            g0.v + step.v * (s.v - dial.reference),
            join(&[&s.src, &g0.src, &step.src]),
        )
    } else {
        match (g.setting, gap_at_ref, gap_per_unit) {
            (Some(s), Some(g0), Some(step)) => {
                if !s.is_finite() {
                    return Err(ApiError("grinder.setting must be a finite number".into()));
                }
                setting_used = Some(s);
                Val::new(
                    g0 + step * s,
                    "recipe:grinder.setting, recipe:grinder.gap_at_ref_um, recipe:grinder.gap_per_unit_um",
                )
            }
            _ => {
                return Err(ApiError(
                    "grinder: with a family, give gap_um (or setting with gap_at_ref_um and gap_per_unit_um)".into(),
                ));
            }
        }
    };
    if gap.v > bounds::MAX_GAP_UM {
        return Err(ApiError(format!(
            "grinder: {} give a burr gap of {:.0} µm, above the plausible {} µm",
            crate::context::describe(&gap.src),
            gap.v,
            bounds::MAX_GAP_UM
        )));
    }
    if gap.v < MIN_GAP_UM {
        ctx.note(format!(
            "Grinder: a burr gap of {:.1} µm is not physical; using {MIN_GAP_UM} µm.",
            gap.v
        ));
        gap.v = MIN_GAP_UM;
    }
    bounds::opt(g.burr_diameter_mm, |x| {
        let (lo, hi) = bounds::BURR_DIAMETER_MM;
        bounds::check(x, lo, hi, "grinder.burr_diameter_mm", "mm")
    })?;
    bounds::opt(g.rpm, |x| {
        bounds::check_pos(x, bounds::MAX_RPM, "grinder.rpm", "rpm")
    })?;
    if g.burr_diameter_mm.is_some() || g.rpm.is_some() {
        ctx.note(
            "Grinder: burr diameter and rpm are recorded but have no systematic effect on the PSD in the evidence (03 §2.1).",
        );
    }

    // Parameters, by the precedence recipe > override > calibration > preset
    // (grinder, then family) > registry.
    let none = PsdParameters::default();
    let pp = preset.and_then(|p| p.psd.as_ref()).unwrap_or(&none);
    let fp = &family.psd;
    let ps = preset_src.as_deref().unwrap_or("");
    let kappa = ctx.resolve(
        "psd.x50_gap_ratio",
        "1",
        recipe_value(g.x50_gap_ratio, "grinder.x50_gap_ratio"),
        preset_value(&[(pp.x50_gap_ratio, ps), (fp.x50_gap_ratio, &fam_src)]),
        None,
    )?;
    let u_g = match g.fines_at_340_pct {
        Some(v) => {
            let (lo, hi) = bounds::FINES_AT_340_PCT;
            bounds::check(v, lo, hi, "grinder.fines_at_340_pct", "%")?;
            Val::new(v, "recipe:grinder.fines_at_340_pct")
        }
        None => preset_value(&[(pp.fines_at_340_pct, ps), (fp.fines_at_340_pct, &fam_src)])
            .ok_or_else(|| {
                ApiError(format!(
                    "internal error: family {} lacks fines_at_340_pct",
                    family.id
                ))
            })?,
    };
    let gamma = ctx.param("model.psd.fines_weight_slope", "1")?;
    let sigma_c_recipe = bounds::opt(g.coarse_log_width, |x| {
        let (lo, hi) = bounds::COARSE_LOG_WIDTH;
        bounds::check(x, lo, hi, "grinder.coarse_log_width", "")
    })?;
    let sigma_c = ctx.resolve(
        "model.psd.coarse_log_width",
        "1",
        recipe_value(sigma_c_recipe, "grinder.coarse_log_width"),
        preset_value(&[(pp.coarse_log_width, ps), (fp.coarse_log_width, &fam_src)]),
        None,
    )?;
    let w_b_recipe = bounds::opt(g.boulder_weight, |x| {
        let (lo, hi) = bounds::BOULDER_WEIGHT;
        bounds::check(x, lo, hi, "grinder.boulder_weight", "")
    })?;
    let w_b = ctx.resolve(
        "model.psd.boulder_weight",
        "1",
        recipe_value(w_b_recipe, "grinder.boulder_weight"),
        preset_value(&[(pp.boulder_weight, ps), (fp.boulder_weight, &fam_src)]),
        None,
    )?;
    let mu_f = ctx.resolve(
        "psd.fines_mode",
        "um",
        None,
        preset_value(&[(pp.fines_mode_um, ps), (fp.fines_mode_um, &fam_src)]),
        None,
    )?;
    let sigma_f = ctx.param("model.psd.fines_log_width", "1")?;
    let sigma_b = ctx.param("model.psd.boulder_log_width", "1")?;
    let r_b = ctx.param("psd.boulder_mode_ratio", "1")?;
    let a_r = ctx.param("model.psd.roast_coefficient", "1")?;
    let a_t = ctx.param("model.psd.cold_size_reduction", "1")?;

    // Median from the gap, roast and bean temperature.
    let f_roast = (1.0 - a_r.v * (roast.v - 0.5)).max(0.5);
    let f_temp = 1.0 - a_t.v * ((20.0 - bean_temp.v) / 39.0).clamp(0.0, 1.0);
    let mut x50 = kappa.v * gap.v * f_roast * f_temp;
    let x50_min = MIN_X50_OVER_FINES_MODE * mu_f.v;
    if x50 < x50_min {
        ctx.note(format!(
            "Grinder: the gap gives X50 = {x50:.0} µm, finer than the model covers (its median would sit inside the {:.0} µm fines mode); using {x50_min:.0} µm.",
            mu_f.v
        ));
        x50 = x50_min;
    }
    let anchored = preset.and_then(|p| p.dial.anchored.as_ref().map(|a| (p, a)));
    if let (Some((p, a)), Some(s)) = (anchored, setting_used)
        && (s < a.min || s > a.max)
    {
        ctx.note(format!(
            "Grinder: setting {s} is outside the settings where the {} was measured ({}–{}); its PSD is extrapolated along the dial mapping and is less certain.",
            p.name, a.min, a.max
        ));
    }
    if x50 < FINEST_ANCHORED_X50_UM {
        ctx.note(format!(
            "Grinder: X50 = {x50:.0} µm is finer than any measured X50/gap pair (κ_G was measured at X50 ≈ 220–350 µm); the median is extrapolated linearly in the gap, so the size and the Sauter diameter are uncertain (±30%). The fines relation itself holds down to X50 ≈ 60 µm (Corrochano 2017, Waszkiewicz 2026)."
        ));
    }
    if bean_temp.v < 20.0 {
        ctx.note(format!(
            "Grinder: beans at {:.0} °C grind {:.1}% finer than at 20 °C (model.psd.cold_size_reduction, grade D).",
            bean_temp.v,
            (1.0 - f_temp) * 100.0
        ));
    }

    if x50 > 1300.0 {
        ctx.note(format!(
            "Grinder: X50 = {x50:.0} µm is coarser than the PSD data behind the fines relation (up to 1300 µm, Corrochano 2017); extrapolated."
        ));
    }

    let input = MixtureInput {
        x50_um: x50,
        fines_fraction: u_g.v / 100.0,
        fines_mode_um: mu_f.v,
        fines_log_width: sigma_f.v,
        coarse_log_width: sigma_c.v,
        boulder_weight: w_b.v,
        boulder_log_width: sigma_b.v,
        boulder_mode_ratio: r_b.v,
    };
    let src = join(&[
        &gap.src,
        &kappa.src,
        &u_g.src,
        &gamma.src,
        &sigma_c.src,
        &w_b.src,
        &mu_f.src,
        &sigma_f.src,
        &sigma_b.src,
        &r_b.src,
        &a_r.src,
        &a_t.src,
        &roast.src,
        &bean_temp.src,
        ps,
        &fam_src,
    ]);
    // Anchor the fines relation at the reference median, then solve at X50.
    let anchor = MixtureInput {
        x50_um: FINES_REFERENCE_X50_UM,
        ..input.clone()
    };
    let relation = FinesRelation::anchored(&anchor, gamma.v).ok_or_else(|| {
        ApiError(format!(
            "grinder: no PSD has {:.1}% below 100 µm at a 340 µm median with these widths and weights; check {}",
            u_g.v,
            crate::context::describe(&src)
        ))
    })?;
    let mixture = solve_on_relation(&input, &relation).ok_or_else(|| {
        ApiError(format!(
            "grinder: the PSD model has no solution for X50 = {x50:.0} µm; check {}",
            crate::context::describe(&src)
        ))
    })?;
    let classes = discretise(&mixture, n_classes);
    Ok(PsdOut {
        curve: mixture_curve(&mixture),
        classes,
        src,
        source: "model",
        grinder: preset.map(|p| p.id.clone()),
        family: Some(family.id.clone()),
        setting: setting_used,
        gap_um: Some(gap.v),
        x50_um: x50,
        fines_fraction: mixture.cdf(100.0),
        d43_um: mixture.d43(),
        burr_diameter_mm: g.burr_diameter_mm.or(preset.map(|p| p.burr_diameter_mm)),
        rpm: g.rpm.or(preset.and_then(|p| p.rpm)),
        mixture: Some(mixture),
    })
}

/// A measured PSD: validated, normalised and, when it has more bins than
/// `n` classes, rebinned onto `n` log-spaced classes.
fn measured(ctx: &mut Ctx, psd: &PsdInput, n: usize) -> Result<PsdOut, ApiError> {
    let (d, f) = (&psd.diameter_um, &psd.volume_fraction);
    if d.is_empty() || d.len() != f.len() {
        return Err(ApiError(
            "grinder.psd: diameter_um and volume_fraction must be non-empty and of the same length"
                .into(),
        ));
    }
    if d.len() > bounds::MAX_PSD_BINS {
        return Err(ApiError(format!(
            "grinder.psd: at most {} bins",
            bounds::MAX_PSD_BINS
        )));
    }
    let (d_lo, d_hi) = bounds::PSD_DIAMETER_UM;
    for (i, x) in d.iter().enumerate() {
        bounds::check(
            *x,
            d_lo,
            d_hi,
            &format!("grinder.psd.diameter_um[{i}]"),
            "µm",
        )?;
    }
    if d.windows(2).any(|w| w[1] <= w[0]) {
        return Err(ApiError(
            "grinder.psd.diameter_um must be strictly increasing".into(),
        ));
    }
    if f.iter().any(|x| !(x.is_finite() && *x >= 0.0)) {
        return Err(ApiError(
            "grinder.psd.volume_fraction must be finite and ≥ 0".into(),
        ));
    }
    // Normalise by the largest value first, so huge values cannot overflow.
    let largest = f.iter().fold(0.0_f64, |a, &b| a.max(b));
    if largest <= 0.0 {
        return Err(ApiError(
            "grinder.psd.volume_fraction must not be all zero".into(),
        ));
    }
    let scaled: Vec<f64> = f.iter().map(|x| x / largest).collect();
    let k = d.len();
    let monotone = scaled.windows(2).all(|w| w[1] >= w[0]);
    let last = f[k - 1];
    let ends_at_one = (0.98..=1.02).contains(&last) || (98.0..=102.0).contains(&last);
    let total_raw_over_last: f64 = scaled.iter().sum();
    if k >= 4 && monotone && ends_at_one && total_raw_over_last > 1.5 {
        return Err(ApiError(format!(
            "grinder.psd.volume_fraction looks cumulative (it never decreases and ends at {last}); give the volume fraction in each bin"
        )));
    }
    let nonzero = scaled.iter().filter(|x| **x > 0.0).count();
    if nonzero < 2 {
        return Err(ApiError(
            "grinder.psd: at least two bins must hold volume (a single-size bed is not supported)"
                .into(),
        ));
    }
    match psd.method.as_deref() {
        None => ctx.note("Grinder: measured PSD method not given; taken as volume-weighted (as laser diffraction reports)."),
        Some("wet_laser") => ctx.note(
            "Grinder: wet laser diffraction adds a 1–10 µm population of debris that dry methods attach to particles; fines and surface area read high (03 §1.4). No correction is applied.",
        ),
        Some("image") => ctx.note(
            "Grinder: image analysis counts particles by projected area and phones miss fines below about 50 µm (03 §1.4); make sure the distribution is volume-weighted. No correction is applied.",
        ),
        Some("sieve") => ctx.note(
            "Grinder: sieve fractions are by mass and pass by the second-largest dimension; fines stick and get lost (03 §1.4). No correction is applied.",
        ),
        Some(m) if PSD_METHODS.contains(&m) => {}
        Some(m) => {
            return Err(ApiError(format!(
                "grinder.psd.method {m:?} is not one of {}",
                PSD_METHODS.join(", ")
            )));
        }
    }
    let total: f64 = scaled.iter().sum();
    let f: Vec<f64> = scaled.iter().map(|x| x / total).collect();
    let l: Vec<f64> = d.iter().map(|x| ln(*x)).collect();
    // Bin edges in ln d: midpoints between centres, mirrored at the ends.
    let mut edges = Vec::with_capacity(k + 1);
    edges.push(l[0] - 0.5 * (l[1] - l[0]));
    edges.extend(l.windows(2).map(|w| 0.5 * (w[0] + w[1])));
    edges.push(l[k - 1] + 0.5 * (l[k - 1] - l[k - 2]));
    let classes = if k <= n {
        let kept: Vec<(f64, f64)> = d
            .iter()
            .copied()
            .zip(f.iter().copied())
            .filter(|(_, x)| *x > 0.0)
            .collect();
        if kept.len() < k {
            ctx.note(format!(
                "Grinder: {} empty bins of the measured PSD were dropped.",
                k - kept.len()
            ));
        }
        let (dd, ff) = kept.into_iter().unzip();
        Classes::normalised(dd, ff)
    } else {
        let (lo, hi) = (edges[0], edges[k]);
        let step = (hi - lo) / n as f64;
        let mut dd = Vec::new();
        let mut ff = Vec::new();
        for j in 0..n {
            let (a, b) = (lo + j as f64 * step, lo + (j + 1) as f64 * step);
            let mass: f64 = (0..k)
                .map(|i| {
                    let overlap = (b.min(edges[i + 1]) - a.max(edges[i])).max(0.0);
                    f[i] * overlap / (edges[i + 1] - edges[i])
                })
                .sum();
            if mass > 0.0 {
                let (lo_d, hi_d) = CLASS_DIAMETER_UM;
                dd.push(exp(0.5 * (a + b)).clamp(lo_d, hi_d));
                ff.push(mass);
            }
        }
        ctx.note(format!(
            "Grinder: the measured PSD's {k} bins were rebinned onto {} log-spaced classes.",
            dd.len()
        ));
        Classes::normalised(dd, ff)
    };
    if classes.fractions.len() < 2 {
        return Err(ApiError(
            "grinder.psd: the distribution is too narrow for two size classes; give more bins"
                .into(),
        ));
    }
    // Statistics of the measured distribution (piecewise uniform in ln d).
    let below = |lx: f64| -> f64 {
        (0..k)
            .map(|i| f[i] * ((lx - edges[i]) / (edges[i + 1] - edges[i])).clamp(0.0, 1.0))
            .sum()
    };
    let x50 = exp(bisect(edges[0], edges[k], |lx| below(lx) - 0.5).unwrap_or(l[k / 2]));
    let fines = below(ln(100.0));
    let density: Vec<f64> = (0..k).map(|i| f[i] / (edges[i + 1] - edges[i])).collect();
    Ok(PsdOut {
        d43_um: classes.d43(),
        classes,
        curve: (d.clone(), density),
        src: "recipe:grinder.psd".into(),
        source: "measured",
        grinder: None,
        family: None,
        setting: None,
        gap_um: None,
        x50_um: x50,
        fines_fraction: fines,
        mixture: None,
        burr_diameter_mm: None,
        rpm: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn input(x50: f64, fines: f64) -> MixtureInput {
        MixtureInput {
            x50_um: x50,
            fines_fraction: fines,
            fines_mode_um: 40.0,
            fines_log_width: 0.6,
            coarse_log_width: 0.35,
            boulder_weight: 0.05,
            boulder_log_width: 0.35,
            boulder_mode_ratio: 1.75,
        }
    }

    #[test]
    fn mixture_hits_its_median_and_fines_targets() {
        for (x50, fines) in [
            (224.0, 0.257),
            (266.0, 0.22),
            (350.0, 0.146),
            (600.0, 0.04),
            (120.0, 0.4),
        ] {
            let m = solve_mixture(&input(x50, fines)).unwrap();
            assert!((m.cdf(x50) - 0.5).abs() < 1e-9, "median at {x50}");
            assert!((m.cdf(100.0) - fines).abs() < 1e-9, "fines at {x50}");
            let w: f64 = m.components.iter().map(|c| c.weight).sum();
            assert!((w - 1.0).abs() < 1e-12);
            assert!(m.components.iter().all(|c| c.weight >= 0.0));
        }
        // Inconsistent targets (median below 100 µm with only 40% below 100 µm) have no solution.
        assert!(solve_mixture(&input(90.0, 0.4)).is_none());
    }

    #[test]
    fn classes_sum_to_one_and_track_the_mixture() {
        let m = solve_mixture(&input(266.0, 0.22)).unwrap();
        let c = discretise(&m, 30);
        assert_eq!(c.diameters_um.len(), 30);
        assert!((c.fractions.iter().sum::<f64>() - 1.0).abs() < 1e-12);
        assert!(c.diameters_um.windows(2).all(|w| w[1] > w[0]));
        assert!(
            (c.d32() / m.d32() - 1.0).abs() < 0.03,
            "{} vs {}",
            c.d32(),
            m.d32()
        );
        assert!((c.d43() / m.d43() - 1.0).abs() < 0.03);
        let (x, y) = mixture_curve(&m);
        assert_eq!(x.len(), CURVE_POINTS);
        // The density integrates to about 1 over ln d.
        let integral: f64 = x
            .windows(2)
            .zip(y.windows(2))
            .map(|(xs, ys)| 0.5 * (ys[0] + ys[1]) * (ln(xs[1]) - ln(xs[0])))
            .sum();
        assert!((integral - 1.0).abs() < 0.01, "{integral}");
    }
}
