// SPDX-License-Identifier: GPL-2.0-or-later
//! Bounded, reproducible M3 input scenarios. Percentiles describe selected
//! assumptions, not calibrated probability coverage; see m3-uncertainty.md.

use std::collections::{BTreeMap, BTreeSet};

use puckcore::shot::{ChemistryResult, ShotResult, Summary, simulate_shot};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::api::ApiError;
use crate::builder::{Built, build};
use crate::recipe::{PsdInput, Recipe, WaterInput};
use crate::registry::{Registry, registry};
use crate::taste::{TasteConditions, TasteEstimate};

/// User-selected knowledge state. An explicit recipe value is not
/// automatically a measured quantity; the caller selects the knowledge state.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Knowledge {
    #[default]
    Unknown,
    Measured,
    Fixed,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Groups {
    pub grinder_psd: Option<Knowledge>,
    pub roast_age: Option<Knowledge>,
    pub composition: Option<Knowledge>,
    pub water: Option<Knowledge>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Options {
    pub samples: usize,
    pub seed: u32,
    pub groups: Groups,
    pub taste_conditions: TasteConditions,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            samples: 16,
            seed: 1729,
            groups: Groups::default(),
            taste_conditions: TasteConditions::default(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ResolvedGroups {
    pub grinder_psd: Knowledge,
    pub roast_age: Knowledge,
    pub composition: Knowledge,
    pub water: Knowledge,
}

/// Linear-interpolated empirical percentiles of finite successful members.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Band {
    pub p05: f64,
    pub p50: f64,
    pub p95: f64,
    pub min: f64,
    pub max: f64,
    pub n: usize,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SampleResult {
    pub summary: Summary,
    pub chemistry: Option<ChemistryResult>,
    pub taste: TasteEstimate,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SampleInputs {
    pub sample_index: usize,
    pub psd_scale: f64,
    pub psd_fines_factor: f64,
    pub days_off_roast: f64,
    pub composition_factor: f64,
    pub water_factor: f64,
    pub water_ph: Option<f64>,
    pub water: Option<WaterInput>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SampleFailure {
    pub sample_index: usize,
    pub message: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SeriesBands {
    pub progress: Vec<f64>,
    pub time_basis: String,
    /// Series field name, or species_cup_kg/<id>, to bands at each progress point.
    pub bands: BTreeMap<String, Vec<Band>>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UncertaintyResult {
    pub schema: String,
    pub seed: u32,
    pub samples_requested: usize,
    pub samples_completed: usize,
    pub ensemble_tier: u8,
    pub band_kind: String,
    pub groups: ResolvedGroups,
    /// JSON pointers into summary, chemistry, diagnostics, derived and taste.
    /// Arrays with id fields use the id in place of the array index.
    pub bands: BTreeMap<String, Band>,
    pub series: SeriesBands,
    pub baseline_preview: SampleResult,
    pub sample_results: Vec<SampleResult>,
    /// Inputs for every attempted scenario, including failed ones.
    pub sample_inputs: Vec<SampleInputs>,
    pub sample_failures: Vec<SampleFailure>,
    pub warning_counts: BTreeMap<String, usize>,
    pub registry_refs: Vec<String>,
    pub notes: Vec<String>,
    pub unsupported: BTreeMap<String, String>,
}

struct Supports<'a> {
    reg: &'a Registry,
    recipe: &'a Recipe,
    refs: BTreeSet<String>,
}

impl Supports<'_> {
    fn half_width(&mut self, state: Knowledge, key: &str, units: &str) -> Result<f64, ApiError> {
        let prefix = match state {
            Knowledge::Fixed => return Ok(0.0),
            Knowledge::Unknown => "unknown",
            Knowledge::Measured => "measured",
        };
        let id = format!("uncertainty.{prefix}.{key}");
        let p = self
            .reg
            .get(&id)
            .ok_or_else(|| ApiError(format!("missing uncertainty registry parameter {id}")))?;
        if p.units != units {
            return Err(ApiError(format!("{id}: expected units {units}")));
        }
        self.refs.insert(id.clone());
        let value = self.recipe.overrides.get(&id).copied().unwrap_or(p.default);
        if !value.is_finite() || !p.range.contains(value) {
            return Err(ApiError(format!("{id}: invalid uncertainty support")));
        }
        Ok(value)
    }
}

/// Small specified generator, identical on native and WASM. No platform RNG,
/// transcendental sampling or implicit global state is involved.
struct Rng(u32);
impl Rng {
    fn signed(&mut self) -> f64 {
        self.0 = self.0.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        2.0 * (f64::from(self.0) + 0.5) / 4_294_967_296.0 - 1.0
    }
}

fn uniform(center: f64, half: f64, lo: f64, hi: f64, z: f64) -> f64 {
    // Truncate the SUPPORT rather than clip draws: no artificial point masses
    // at zero roast age or at physical input limits.
    let a = (center - half).max(lo);
    let b = (center + half).min(hi);
    a + (b - a) * ((z + 1.0) * 0.5)
}

fn escaped(key: &str) -> String {
    key.replace('~', "~0").replace('/', "~1")
}

fn collect_numbers(value: &Value, path: &str, out: &mut BTreeMap<String, Vec<f64>>) {
    match value {
        Value::Number(n) => {
            if let Some(x) = n.as_f64().filter(|x| x.is_finite()) {
                out.entry(path.to_owned()).or_default().push(x);
            }
        }
        Value::Object(map) => {
            for (key, value) in map {
                collect_numbers(value, &format!("{path}/{}", escaped(key)), out);
            }
        }
        Value::Array(array) => {
            for (index, value) in array.iter().enumerate() {
                let key = value
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| index.to_string());
                collect_numbers(value, &format!("{path}/{}", escaped(&key)), out);
            }
        }
        _ => {}
    }
}

fn band(mut values: Vec<f64>) -> Band {
    values.sort_by(f64::total_cmp);
    let quantile = |q: f64| {
        let x = q * (values.len() - 1) as f64;
        let a = x.floor() as usize;
        let b = x.ceil() as usize;
        values[a] + (values[b] - values[a]) * (x - a as f64)
    };
    Band {
        p05: quantile(0.05),
        p50: quantile(0.5),
        p95: quantile(0.95),
        min: values[0],
        max: values[values.len() - 1],
        n: values.len(),
    }
}

fn interpolate(times: &[f64], values: &[f64], t: f64) -> f64 {
    let b = times.partition_point(|x| *x <= t);
    if b == 0 {
        return values[0];
    }
    if b >= times.len() {
        return values[values.len() - 1];
    }
    let a = b - 1;
    let dt = times[b] - times[a];
    if dt <= 0.0 {
        return values[b];
    }
    values[a] + (values[b] - values[a]) * ((t - times[a]) / dt)
}

fn collect_series(
    result: &ShotResult,
    progress: &[f64],
    accum: &mut BTreeMap<String, Vec<Vec<f64>>>,
) -> Result<(), ApiError> {
    let times = &result.series.t_s;
    if times.is_empty() {
        return Ok(());
    }
    let start = times[0];
    let end = times[times.len() - 1];
    let value = serde_json::to_value(&result.series).map_err(|e| ApiError(e.to_string()))?;
    let mut collect = |key: String, values: &[f64]| {
        if values.len() != times.len() || values.iter().any(|x| !x.is_finite()) {
            return;
        }
        let dst = accum
            .entry(key)
            .or_insert_with(|| vec![Vec::new(); progress.len()]);
        for (i, &p) in progress.iter().enumerate() {
            dst[i].push(interpolate(times, values, start + p * (end - start)));
        }
    };
    if let Value::Object(fields) = value {
        for (key, value) in fields {
            if let Some(array) = value.as_array() {
                let numeric: Option<Vec<f64>> = array.iter().map(Value::as_f64).collect();
                if let Some(values) = numeric {
                    collect(key, &values);
                }
            }
        }
    }
    for sp in &result.series.species_cup_kg {
        collect(format!("species_cup_kg/{}", sp.id), &sp.values);
    }
    Ok(())
}

fn result_summary(
    recipe: &Recipe,
    built: &Built,
    result: &ShotResult,
    conditions: &TasteConditions,
) -> Result<SampleResult, ApiError> {
    Ok(SampleResult {
        summary: result.summary.clone(),
        chemistry: result.chemistry.clone(),
        taste: crate::taste::estimate(recipe, built, result, conditions)?,
    })
}

/// Simulate a bounded ensemble with Tier 0. The original recipe and all its
/// parameter overrides remain unchanged; source overrides stay fixed while
/// uncertainty-support overrides control the scenario widths.
pub fn simulate(recipe: &Recipe, options: &Options) -> Result<UncertaintyResult, ApiError> {
    if !(8..=64).contains(&options.samples) {
        return Err(ApiError(
            "uncertainty samples must be an integer from 8 to 64".into(),
        ));
    }
    options.taste_conditions.validate()?;
    let base = build(recipe)?;
    let groups = ResolvedGroups {
        grinder_psd: options
            .groups
            .grinder_psd
            .unwrap_or(if recipe.grinder.psd.is_some() {
                Knowledge::Measured
            } else {
                Knowledge::Unknown
            }),
        roast_age: options.groups.roast_age.unwrap_or_default(),
        composition: options.groups.composition.unwrap_or_default(),
        water: options.groups.water.unwrap_or_default(),
    };
    let reg = registry()?;
    let mut supports = Supports {
        reg,
        recipe,
        refs: BTreeSet::new(),
    };
    let psd_width = supports.half_width(groups.grinder_psd, "psd_scale_relative", "1")?;
    let fines_width = supports.half_width(groups.grinder_psd, "psd_fines_relative", "1")?;
    let age_half = supports
        .half_width(groups.roast_age, "age_absolute", "d")?
        .max(
            base.derived.bean.days_off_roast
                * supports.half_width(groups.roast_age, "age_relative", "1")?,
        );
    let composition_width = supports.half_width(groups.composition, "composition_relative", "1")?;
    let water_width = supports.half_width(groups.water, "water_relative", "1")?;
    let ph_width = supports.half_width(groups.water, "water_ph", "1")?;
    let mut preview_spec = base.spec.clone();
    preview_spec.numerics.tier = 0;
    let preview = simulate_shot(&preview_spec).map_err(|e| ApiError(e.to_string()))?;
    let baseline_preview = result_summary(recipe, &base, &preview, &options.taste_conditions)?;
    let mut notes = vec![
        "Scenario percentiles are conditional on selected illustrative input supports; they are not calibrated confidence intervals or a probability of the real shot falling inside the band.".into(),
        "Every ensemble member and the baseline preview use Tier 0; the central shot retains its requested tier. Tier 0 approximation error and model discrepancy are not included in these bands, and the Tier 1 central value may lie outside them.".into(),
        "PSD bins share a diameter scale; fines bins share one reweighting factor. Compound composition inventories share one multiplier. Water minerals, hardness, alkalinity and TDS share a multiplier, preserving baseline ratios; source pH varies independently. These correlations are assumptions, not measurements.".into(),
        "Measured means narrower illustrative measurement supports, not zero uncertainty. Fixed groups and explicit source parameter overrides stay fixed. Selecting unknown can vary an explicitly entered recipe input.".into(),
        "Trajectory bands align fractional recorded duration including post-stop drip, not physical time. Spatial fields are not pooled because particle radii and bed geometry can change.".into(),
    ];
    let mut unsupported = BTreeMap::from([("spatial".into(), "No spatial bands: class radii, geometry and snapshot grids differ between members; view the central simulation spatial result.".into()), ("model_discrepancy".into(), "No calibrated physics discrepancy, taste coefficient, sensory threshold or Tier 0/Tier 1 discrepancy distribution is available.".into())]);
    if base.spec.chemistry.is_none() {
        unsupported.insert("chemistry".into(), "Chemistry disabled by the recipe; chemistry bands and chemistry-dependent taste indices are unavailable.".into());
    }
    // Use the actual user PSD when present, otherwise the fully resolved model
    // classes. No grinder preset is reconstructed or silently substituted.
    let base_psd = recipe.grinder.psd.clone().unwrap_or_else(|| PsdInput {
        diameter_um: base
            .spec
            .bed
            .size_classes
            .iter()
            .map(|c| 2e6 * c.radius_m)
            .collect(),
        volume_fraction: base
            .spec
            .bed
            .size_classes
            .iter()
            .map(|c| c.volume_fraction)
            .collect(),
        method: Some("other".into()),
    });
    // An overridden source remains authoritative; do not perturb a different
    // parameter to evade a fixed grinder source override.
    let psd_outside_measured_bounds = base_psd.diameter_um.iter().any(|d| {
        !(crate::bounds::PSD_DIAMETER_UM.0..=crate::bounds::PSD_DIAMETER_UM.1).contains(d)
    });
    let psd_locked = psd_outside_measured_bounds
        || recipe
            .overrides
            .keys()
            .any(|id| id.starts_with("psd.") || id.starts_with("model.psd."));
    if psd_outside_measured_bounds && groups.grinder_psd != Knowledge::Fixed {
        unsupported.insert("grinder_psd".into(), "Resolved model PSD bins exceed the accepted measured-PSD input diameter range; PSD held fixed rather than projecting to another distribution. Other input groups still vary.".into());
    }
    if psd_locked && !psd_outside_measured_bounds && groups.grinder_psd != Knowledge::Fixed {
        notes.push("PSD variation is held fixed because the recipe contains an explicit PSD source parameter override; its resolved distribution is honored.".into());
    }
    let composition_ids: Vec<String> = reg
        .ids()
        .filter(|id| {
            (id.starts_with("bean.composition.")
                || id.starts_with("model.bean.trigonelline.")
                || (id.starts_with("chemistry.composition.")
                    && (id.ends_with(".arabica") || id.ends_with(".robusta"))))
                && !recipe.overrides.contains_key(*id)
        })
        .map(str::to_owned)
        .collect();
    let mut composition_lo: f64 = 0.0;
    let mut composition_hi: f64 = f64::INFINITY;
    for id in &composition_ids {
        let p = reg.get(id).expect("ids came from registry");
        if p.default > 0.0 {
            if let Some(lo) = p.range.min {
                composition_lo = composition_lo.max(lo / p.default);
            }
            if let Some(hi) = p.range.max {
                composition_hi = composition_hi.min(hi / p.default);
            }
        }
    }
    let mut water_hi: f64 = f64::INFINITY;
    if let Some(c) = &base.spec.chemistry {
        let w = &c.water;
        for (key, center, hi) in [
            ("alkalinity_mg_l_caco3", w.alkalinity_mg_l_caco3, 500.0),
            ("hardness_mg_l_caco3", w.hardness_mg_l_caco3, 1000.0),
            ("calcium_mg_l", w.calcium_mg_l, 400.0),
            ("magnesium_mg_l", w.magnesium_mg_l, 200.0),
            ("tds_mg_l", w.tds_mg_l, 5000.0),
        ] {
            if center > 0.0
                && !recipe
                    .overrides
                    .contains_key(&format!("water.default.{key}"))
            {
                water_hi = water_hi.min(hi / center);
            }
        }
    }
    let progress: Vec<f64> = (0..=20).map(|i| i as f64 / 20.0).collect();
    let mut rng = Rng(options.seed);
    let mut numbers = BTreeMap::new();
    let mut trajectories = BTreeMap::new();
    let mut sample_results = Vec::new();
    let mut sample_inputs = Vec::new();
    let mut sample_failures = Vec::new();
    let mut warning_counts = BTreeMap::new();
    for index in 0..options.samples {
        // Always draw the same latent slots, so changing one knowledge state
        // leaves the other groups' draws unchanged for paired comparisons.
        let z_psd = rng.signed();
        let z_fines = rng.signed();
        let z_age = rng.signed();
        let z_composition = rng.signed();
        let z_water = rng.signed();
        let z_ph = rng.signed();
        let mut sampled = recipe.clone();
        sampled.numerics.tier = Some(0);
        let mut psd_scale = 1.0;
        let mut fines_factor = 1.0;
        if !psd_locked && (psd_width > 0.0 || fines_width > 0.0) {
            let min = base_psd.diameter_um[0];
            let max = base_psd.diameter_um[base_psd.diameter_um.len() - 1];
            psd_scale = uniform(
                1.0,
                psd_width,
                crate::bounds::PSD_DIAMETER_UM.0 / min,
                crate::bounds::PSD_DIAMETER_UM.1 / max,
                z_psd,
            );
            fines_factor = 1.0 + fines_width * z_fines;
            sampled.grinder.psd = Some(PsdInput {
                diameter_um: base_psd.diameter_um.iter().map(|d| d * psd_scale).collect(),
                volume_fraction: base_psd
                    .volume_fraction
                    .iter()
                    .zip(&base_psd.diameter_um)
                    .map(|(f, d)| if *d <= 100.0 { f * fines_factor } else { *f })
                    .collect(),
                method: base_psd.method.clone(),
            });
        }
        let days = uniform(
            base.derived.bean.days_off_roast,
            age_half,
            0.0,
            crate::bounds::MAX_DAYS_OFF_ROAST,
            z_age,
        );
        if age_half > 0.0 {
            sampled.bean.days_off_roast = Some(days);
        }
        let composition_factor = uniform(
            1.0,
            composition_width,
            composition_lo,
            composition_hi,
            z_composition,
        );
        if composition_width > 0.0 {
            for id in &composition_ids {
                let p = reg.get(id).expect("ids came from registry");
                let v = p.default * composition_factor;
                sampled.overrides.insert(id.clone(), v);
                supports.refs.insert(id.clone());
            }
        }
        let water_factor = uniform(1.0, water_width, 0.0, water_hi, z_water);
        let mut ph = base.spec.chemistry.as_ref().map(|c| c.water.ph);
        if let Some(chemistry) = &base.spec.chemistry {
            let w = &chemistry.water;
            let mut water = WaterInput {
                alkalinity_mg_l_caco3: Some(w.alkalinity_mg_l_caco3),
                hardness_mg_l_caco3: Some(w.hardness_mg_l_caco3),
                calcium_mg_l: Some(w.calcium_mg_l),
                magnesium_mg_l: Some(w.magnesium_mg_l),
                tds_mg_l: Some(w.tds_mg_l),
                ph: Some(w.ph),
            };
            let mut vary = |key: &str, center: f64, _hi: f64, target: &mut Option<f64>| {
                let id = format!("water.default.{key}");
                if !recipe.overrides.contains_key(&id) && water_width > 0.0 {
                    *target = Some(center * water_factor);
                }
                supports.refs.insert(id);
            };
            vary(
                "alkalinity_mg_l_caco3",
                w.alkalinity_mg_l_caco3,
                500.0,
                &mut water.alkalinity_mg_l_caco3,
            );
            vary(
                "hardness_mg_l_caco3",
                w.hardness_mg_l_caco3,
                1000.0,
                &mut water.hardness_mg_l_caco3,
            );
            vary(
                "calcium_mg_l",
                w.calcium_mg_l,
                400.0,
                &mut water.calcium_mg_l,
            );
            vary(
                "magnesium_mg_l",
                w.magnesium_mg_l,
                200.0,
                &mut water.magnesium_mg_l,
            );
            vary("tds_mg_l", w.tds_mg_l, 5000.0, &mut water.tds_mg_l);
            if !recipe.overrides.contains_key("water.default.ph") && ph_width > 0.0 {
                water.ph = Some(uniform(w.ph, ph_width, 0.0, 14.0, z_ph));
                ph = water.ph;
            }
            sampled.water = Some(water);
        }
        sample_inputs.push(SampleInputs {
            sample_index: index,
            psd_scale,
            psd_fines_factor: fines_factor,
            days_off_roast: days,
            composition_factor,
            water_factor,
            water_ph: ph,
            water: sampled.water.clone(),
        });
        let run = || -> Result<(Built, ShotResult, SampleResult), ApiError> {
            let built = build(&sampled)?;
            let result = simulate_shot(&built.spec).map_err(|e| ApiError(e.to_string()))?;
            let summary = result_summary(&sampled, &built, &result, &options.taste_conditions)?;
            Ok((built, result, summary))
        };
        match run() {
            Ok((built, result, summary)) => {
                for warning in &result.diagnostics.warnings {
                    *warning_counts.entry(warning.clone()).or_insert(0) += 1;
                }
                if let Some(c) = &result.chemistry {
                    for warning in &c.warnings {
                        *warning_counts.entry(warning.clone()).or_insert(0) += 1;
                    }
                }
                let value = serde_json::json!({"summary":result.summary,"chemistry":result.chemistry,"diagnostics":result.diagnostics,"derived":built.derived,"taste":summary.taste});
                collect_numbers(&value, "", &mut numbers);
                collect_series(&result, &progress, &mut trajectories)?;
                sample_results.push(summary);
            }
            Err(error) => sample_failures.push(SampleFailure {
                sample_index: index,
                message: error.to_string(),
            }),
        }
    }
    if sample_results.is_empty() {
        return Err(ApiError(format!(
            "all {} uncertainty scenarios failed: {}",
            options.samples, sample_failures[0].message
        )));
    }
    if !sample_failures.is_empty() {
        notes.push(format!("{} of {} scenarios failed; bands condition on successful members and must not be interpreted as unconditional coverage. Failed draws were not replaced.",sample_failures.len(),options.samples));
    }
    let bands = numbers
        .into_iter()
        .map(|(key, values)| (key, band(values)))
        .collect();
    let series = SeriesBands {
        progress,
        time_basis: "fraction_of_recorded_duration_including_drip".into(),
        bands: trajectories
            .into_iter()
            .map(|(key, values)| (key, values.into_iter().map(band).collect()))
            .collect(),
    };
    Ok(UncertaintyResult {
        schema: "puckworks.uncertainty/1".into(),
        seed: options.seed,
        samples_requested: options.samples,
        samples_completed: sample_results.len(),
        ensemble_tier: 0,
        band_kind: "scenario_percentiles_not_confidence_interval".into(),
        groups,
        bands,
        series,
        baseline_preview,
        sample_results,
        sample_inputs,
        sample_failures,
        warning_counts,
        registry_refs: supports.refs.into_iter().collect(),
        notes,
        unsupported,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_species_identity_and_nullable_measurements_keep_their_counts() {
        let mut values = BTreeMap::new();
        collect_numbers(
            &serde_json::json!({"summary":{"first_drops_s":null,"species":[{"id":"b","mass_kg":2.0},{"id":"a","mass_kg":1.0}]}}),
            "",
            &mut values,
        );
        collect_numbers(
            &serde_json::json!({"summary":{"first_drops_s":3.0,"species":[{"id":"a","mass_kg":3.0},{"id":"b","mass_kg":4.0}]}}),
            "",
            &mut values,
        );
        assert_eq!(values["/summary/species/a/mass_kg"], vec![1.0, 3.0]);
        assert_eq!(values["/summary/species/b/mass_kg"], vec![2.0, 4.0]);
        assert_eq!(band(values["/summary/first_drops_s"].clone()).n, 1);
        assert_eq!(band(values["/summary/species/a/mass_kg"].clone()).p50, 2.0);
    }

    #[test]
    fn physical_time_is_interpolated_without_pretending_fractional_progress_is_seconds() {
        let values = vec![0.0, 0.5, 1.0];
        assert_eq!(interpolate(&[0.0, 10.0, 20.0], &values, 5.0), 0.25);
        assert_eq!(interpolate(&[0.0, 20.0, 40.0], &values, 10.0), 0.25);
        assert_eq!(interpolate(&[0.0, 20.0, 40.0], &values, 5.0), 0.125);
    }
}
