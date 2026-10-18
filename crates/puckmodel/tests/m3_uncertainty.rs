// SPDX-License-Identifier: GPL-2.0-or-later
//! Scenario invariants and edge cases, rather than regression snapshots of
//! uncalibrated percentiles.
mod common;

use puckmodel::recipe::Recipe;
use puckmodel::uncertainty::{Groups, Knowledge, Options, UncertaintyResult, simulate};
use serde_json::{Value, json};

fn short_recipe() -> Recipe {
    let mut recipe = common::generic_recipe();
    // Enough time for actual outflow/chemistry, but cheap enough that a
    // seeded ensemble test exercises the full path rather than a mock.
    recipe["stop"] = json!({"time_s":8});
    recipe["numerics"] = json!({"tier":0,"size_classes":6});
    serde_json::from_value(recipe).unwrap()
}

fn fixed() -> Options {
    Options {
        samples: 8,
        seed: 1234,
        groups: Groups {
            grinder_psd: Some(Knowledge::Fixed),
            roast_age: Some(Knowledge::Fixed),
            composition: Some(Knowledge::Fixed),
            water: Some(Knowledge::Fixed),
        },
        ..Options::default()
    }
}

fn run(recipe: &Recipe, options: &Options) -> UncertaintyResult {
    simulate(recipe, options).unwrap()
}

#[test]
fn fixed_inputs_collapse_all_numeric_bands_and_keep_original_recipe() {
    let recipe = short_recipe();
    let before = recipe.clone();
    let result = run(&recipe, &fixed());
    assert_eq!(recipe, before);
    assert_eq!(result.samples_completed, 8);
    assert!(result.sample_failures.is_empty());
    assert!(
        result.bands.len() > 200,
        "all numeric output families included"
    );
    for (path, band) in &result.bands {
        assert_eq!(band.min, band.max, "fixed band {path}");
        assert_eq!(band.p05, band.p95, "fixed percentile {path}");
        assert_eq!(band.n, 8, "missing values at {path}");
    }
    for (name, bands) in &result.series.bands {
        for band in bands {
            assert_eq!(band.min, band.max, "fixed trajectory {name}");
        }
    }
    assert!(result.bands.contains_key("/chemistry/acidity/ph"));
    assert!(
        result
            .bands
            .contains_key("/summary/species/caffeine/mass_kg")
    );
    assert!(result.bands.contains_key("/diagnostics/mass_balance_error"));
    assert!(result.bands.contains_key("/derived/psd/x50_um"));
    assert!(result.bands.contains_key("/taste/acidity_index"));
    assert_eq!(result.series.progress.len(), 21);
    assert!(
        result.series.bands["t_s"].last().unwrap().p50
            >= result.baseline_preview.summary.shot_time_s
    );
    assert_eq!(
        result.series.bands["ey"].last().unwrap().p50,
        result.baseline_preview.summary.ey
    );
    assert_eq!(
        result.series.time_basis,
        "fraction_of_recorded_duration_including_drip"
    );
    assert!(result.unsupported.contains_key("spatial"));
}

#[test]
fn seeded_replay_is_exact_and_unknown_support_is_wider_than_measured() {
    let recipe = short_recipe();
    let options = Options {
        samples: 8,
        seed: 0,
        ..Options::default()
    };
    let a = run(&recipe, &options);
    let b = run(&recipe, &options);
    assert_eq!(
        serde_json::to_value(&a).unwrap(),
        serde_json::to_value(&b).unwrap()
    );
    assert!(a.sample_failures.is_empty(), "{:?}", a.sample_failures);
    let measured = Options {
        groups: Groups {
            grinder_psd: Some(Knowledge::Measured),
            roast_age: Some(Knowledge::Measured),
            composition: Some(Knowledge::Measured),
            water: Some(Knowledge::Measured),
        },
        ..options.clone()
    };
    let m = run(&recipe, &measured);
    assert!(m.sample_failures.is_empty());
    for (unknown, measured) in a.sample_inputs.iter().zip(&m.sample_inputs) {
        assert!((unknown.psd_scale - 1.0).abs() >= (measured.psd_scale - 1.0).abs());
        assert!(
            (unknown.composition_factor - 1.0).abs() >= (measured.composition_factor - 1.0).abs()
        );
        assert!((unknown.water_factor - 1.0).abs() >= (measured.water_factor - 1.0).abs());
    }
    assert!(a.bands["/summary/tds"].max > a.bands["/summary/tds"].min);
    assert!(a.bands["/chemistry/acidity/ph"].max > a.bands["/chemistry/acidity/ph"].min);
    assert!(
        a.bands["/summary/species/trigonelline/mass_kg"].max
            > a.bands["/summary/species/trigonelline/mass_kg"].min
    );
    let changed = run(&recipe, &Options { seed: 1, ..options });
    assert_ne!(
        a.sample_inputs[0].psd_scale,
        changed.sample_inputs[0].psd_scale
    );
}

#[test]
fn custom_psd_and_authoritative_overrides_are_preserved() {
    let mut recipe = short_recipe();
    recipe.grinder.preset = None;
    recipe.grinder.psd = Some(serde_json::from_value(json!({"diameter_um":[20,80,200,400],"volume_fraction":[0.05,0.1,0.35,0.5],"method":"sieve"})).unwrap());
    recipe
        .overrides
        .insert("bean.composition.arabica.caffeine".into(), 2.0);
    recipe
        .overrides
        .insert("water.default.calcium_mg_l".into(), 75.0);
    recipe.water = Some(serde_json::from_value(json!({"magnesium_mg_l":12})).unwrap());
    let mut options = fixed();
    options.groups.composition = Some(Knowledge::Unknown);
    options.groups.water = Some(Knowledge::Unknown);
    let result = run(&recipe, &options);
    assert!(result.sample_failures.is_empty());
    // PSD fixed: original bins are still used and no preset is needed.
    for inputs in &result.sample_inputs {
        assert_eq!(inputs.psd_scale, 1.0);
        assert_eq!(inputs.water.as_ref().unwrap().calcium_mg_l, Some(75.0));
    }
    let caffeine = &result.bands["/summary/species/caffeine/mass_kg"];
    assert_eq!(
        caffeine.min, caffeine.max,
        "overridden caffeine inventory fixed"
    );
    // Omitted group gets measured by default specifically for a supplied PSD.
    options.groups.grinder_psd = None;
    let measured = run(&recipe, &options);
    assert_eq!(measured.groups.grinder_psd, Knowledge::Measured);
    assert!(measured.sample_inputs.iter().any(|x| x.psd_scale != 1.0));
    assert!(
        measured
            .sample_inputs
            .iter()
            .all(|x| (0.97..=1.03).contains(&x.psd_scale))
    );
}

#[test]
fn water_shared_support_preserves_ratios_at_upper_boundary() {
    let mut recipe = short_recipe();
    recipe.water = Some(serde_json::from_value(json!({"calcium_mg_l":400,"magnesium_mg_l":100,"hardness_mg_l_caco3":800,"alkalinity_mg_l_caco3":300,"tds_mg_l":2000,"ph":14})).unwrap());
    let mut options = fixed();
    options.groups.water = Some(Knowledge::Unknown);
    let result = run(&recipe, &options);
    assert!(result.sample_failures.is_empty());
    for sample in &result.sample_inputs {
        assert!(sample.water_factor < 1.0 && sample.water_factor >= 0.5);
        let w = sample.water.as_ref().unwrap();
        assert!((w.calcium_mg_l.unwrap() / w.magnesium_mg_l.unwrap() - 4.0).abs() < 1e-12);
        assert!((w.hardness_mg_l_caco3.unwrap() / w.calcium_mg_l.unwrap() - 2.0).abs() < 1e-12);
        assert!(w.ph.unwrap() <= 14.0 && w.ph.unwrap() >= 13.5);
    }
}

#[test]
fn disabled_chemistry_reports_unavailable_and_recipe_is_not_mutated() {
    let mut recipe = short_recipe();
    recipe.chemistry = Some(serde_json::from_value(json!({"enabled":false})).unwrap());
    let result = run(&recipe, &fixed());
    assert!(result.unsupported.contains_key("chemistry"));
    assert!(result.sample_results.iter().all(|x| x.chemistry.is_none()));
    assert!(!result.bands.contains_key("/chemistry/acidity/ph"));
    assert!(result.baseline_preview.taste.acidity_index.is_none());
}

#[test]
fn invalid_options_fail_explicitly_and_additive_api_is_json() {
    let recipe = short_recipe();
    for samples in [0, 7, 65, usize::MAX] {
        assert!(
            simulate(&recipe, &Options { samples, ..fixed() })
                .unwrap_err()
                .0
                .contains("8 to 64")
        );
    }
    let text = serde_json::to_string(&recipe).unwrap();
    for options in [
        r#"{"samples":8.5}"#,
        r#"{"seed":-1}"#,
        r#"{"groups":{"water":"guess"}}"#,
        r#"{"extra":1}"#,
    ] {
        assert!(
            puckmodel::api::simulate_uncertainty_json(&text, options)
                .unwrap_err()
                .0
                .contains("invalid uncertainty options")
        );
    }
    let out =
        puckmodel::api::simulate_uncertainty_json(&text, &serde_json::to_string(&fixed()).unwrap())
            .unwrap();
    let document: Value = serde_json::from_str(&out).unwrap();
    assert_eq!(document["schema"], "puckworks.uncertainty/1");
    assert_eq!(document["ensemble_tier"], 0);
    assert!(document["notes"].as_array().unwrap().iter().any(|v| {
        v.as_str()
            .unwrap()
            .contains("not calibrated confidence intervals")
    }));
}

#[test]
fn valid_large_model_psd_is_kept_with_explicit_partial_support_flag() {
    let mut recipe = short_recipe();
    recipe.grinder =
        serde_json::from_value(json!({"family":"flat-unimodal","gap_um":2000})).unwrap();
    let base = puckmodel::build(&recipe).unwrap();
    assert!(
        base.spec
            .bed
            .size_classes
            .iter()
            .any(|c| 2e6 * c.radius_m > 5000.0)
    );
    let mut options = fixed();
    options.groups.grinder_psd = Some(Knowledge::Unknown);
    let result = run(&recipe, &options);
    assert!(result.sample_failures.is_empty());
    assert!(result.unsupported.contains_key("grinder_psd"));
    assert!(
        result
            .sample_inputs
            .iter()
            .all(|s| s.psd_scale == 1.0 && s.psd_fines_factor == 1.0)
    );
    assert_eq!(
        result.bands["/derived/psd/x50_um"].min,
        base.derived.psd.x50_um
    );
    assert_eq!(
        result.bands["/derived/psd/x50_um"].max,
        base.derived.psd.x50_um
    );
}
