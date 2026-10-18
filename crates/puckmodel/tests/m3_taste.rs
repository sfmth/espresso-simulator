// SPDX-License-Identifier: GPL-2.0-or-later
//! Mechanistic/contract checks; none is an empirical sensory validation.
mod common;

use puckcore::shot::ShotResult;
use puckmodel::{
    Built, Recipe, build,
    taste::{TasteConditions, estimate},
};

fn fixture() -> (Recipe, Built, ShotResult) {
    let recipe: Recipe = serde_json::from_value(common::generic_recipe()).unwrap();
    let built = build(&recipe).unwrap();
    // A synthetic cup with complete identities and independently specified
    // acid/texture observations. Avoid assuming a taste calibration fixture.
    let result: ShotResult = serde_json::from_value(serde_json::json!({
        "summary": {
            "beverage_mass_kg": 0.036, "tds": 0.08,
            "species": [
                {"id":"cgl_mono","mass_kg":0.000018},
                {"id":"cgl_di","mass_kg":0.0000036},
                {"id":"phenylindanes","mass_kg":0.0000018},
                {"id":"caffeine","mass_kg":0.000108},
                {"id":"cqa3","mass_kg":0.0000108},
                {"id":"cqa4","mass_kg":0.0000108},
                {"id":"cqa5","mass_kg":0.000108},
                {"id":"fqa","mass_kg":0.0000072},
                {"id":"dicqa","mass_kg":0.0000072},
                {"id":"polysaccharides","mass_kg":0.000144},
                {"id":"melanoidins_low","mass_kg":0.000144},
                {"id":"melanoidins_medium","mass_kg":0.000072},
                {"id":"melanoidins_high","mass_kg":0.000072}
            ]
        },
        "chemistry": {
            "reference_temp_c":25,
            "acidity":{"ph":5.2,"titratable_acidity_mmol_l_to_ph_6_6":20},
            "texture":{"lipid_mass_kg":0.000054}
        }
    }))
    .unwrap();
    (recipe, built, result)
}

#[test]
fn conditions_reject_invalid_and_unknown_inputs() {
    for value in [-1.0, f64::INFINITY, f64::NAN, 501.0] {
        assert!(
            TasteConditions {
                dilution_water_g: value,
                ..Default::default()
            }
            .validate()
            .is_err()
        );
    }
    for value in [-1.0, f64::INFINITY, f64::NAN, 101.0] {
        assert!(
            TasteConditions {
                serving_temperature_c: Some(value),
                ..Default::default()
            }
            .validate()
            .is_err()
        );
    }
    assert!(serde_json::from_str::<TasteConditions>(r#"{"assume_validated":true}"#).is_err());
}

#[test]
fn unavailable_chemistry_and_no_cup_are_not_zero_taste() {
    let (recipe, built, mut result) = fixture();
    result.chemistry = None;
    let unavailable = estimate(&recipe, &built, &result, &TasteConditions::default()).unwrap();
    assert_eq!(unavailable.status, "chemistry_disabled");
    assert_eq!(unavailable.body_index, None);
    assert_eq!(unavailable.acidity_index, None);
    result.summary.beverage_mass_kg = 0.0;
    let empty = estimate(
        &recipe,
        &built,
        &result,
        &TasteConditions {
            dilution_water_g: 36.0,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(empty.status, "no_cup");
    assert_eq!(empty.bitterness_index, None);
    assert_eq!(empty.astringency_index, None);
}

#[test]
fn missing_inventory_is_not_interpreted_as_measured_zero() {
    let (recipe, built, mut result) = fixture();
    result.summary.species.retain(|sp| sp.id != "cgl_mono");
    let missing = estimate(&recipe, &built, &result, &TasteConditions::default()).unwrap();
    assert_eq!(missing.status, "incomplete_chemistry");
    assert_eq!(missing.bitterness_index, None);
    result
        .summary
        .species
        .push(serde_json::from_value(serde_json::json!({"id":"cgl_mono","mass_kg":0})).unwrap());
    let present_zero = estimate(&recipe, &built, &result, &TasteConditions::default()).unwrap();
    assert_eq!(present_zero.status, "estimated");
    assert!(present_zero.bitterness_index.is_some());
}

#[test]
fn pure_dilution_reduces_potential_without_changing_the_simulated_shot() {
    let (recipe, built, result) = fixture();
    let original_result = result.clone();
    let full = estimate(&recipe, &built, &result, &TasteConditions::default()).unwrap();
    let diluted = estimate(
        &recipe,
        &built,
        &result,
        &TasteConditions {
            dilution_water_g: 36.0,
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(result, original_result);
    for (a, b) in full.attributes.iter().zip(&diluted.attributes) {
        assert!(a.index.unwrap() > b.index.unwrap(), "{}", a.id);
        for (a, b) in a.drivers.iter().zip(&b.drivers) {
            assert!((b.value - a.value / 2.0).abs() < 1e-12, "{}", a.id);
        }
    }
    assert_eq!(diluted.trust, "low");
    assert!(
        diluted
            .assumptions
            .iter()
            .any(|s| s.contains("not recalculated"))
    );
}

#[test]
fn equal_concentrations_in_different_cup_sizes_give_equal_indices() {
    let (recipe, built, result) = fixture();
    let mut double_cup = result.clone();
    double_cup.summary.beverage_mass_kg *= 2.0;
    for sp in &mut double_cup.summary.species {
        sp.mass_kg *= 2.0;
    }
    double_cup.chemistry.as_mut().unwrap().texture.lipid_mass_kg *= 2.0;
    let small = estimate(&recipe, &built, &result, &TasteConditions::default()).unwrap();
    let large = estimate(&recipe, &built, &double_cup, &TasteConditions::default()).unwrap();
    assert_eq!(small.attributes, large.attributes);
}

#[test]
fn serving_temperature_is_recorded_without_a_fabricated_correction() {
    let (recipe, built, result) = fixture();
    let room = estimate(
        &recipe,
        &built,
        &result,
        &TasteConditions {
            serving_temperature_c: Some(25.0),
            ..Default::default()
        },
    )
    .unwrap();
    let hot = estimate(
        &recipe,
        &built,
        &result,
        &TasteConditions {
            serving_temperature_c: Some(70.0),
            ..Default::default()
        },
    )
    .unwrap();
    assert_eq!(room.attributes, hot.attributes);
    assert!(!hot.conditions.serving_temperature_modelled);
    assert_eq!(hot.conditions.serving_temperature_c, Some(70.0));
}

#[test]
fn no_acid_balance_root_only_suppresses_acidity() {
    let (recipe, built, mut result) = fixture();
    result.chemistry.as_mut().unwrap().acidity.ph = None;
    let taste = estimate(&recipe, &built, &result, &TasteConditions::default()).unwrap();
    assert_eq!(taste.acidity_index, None);
    assert!(taste.body_index.is_some());
}

#[test]
fn taste_registry_override_is_applied_and_range_checked() {
    let (mut recipe, built, result) = fixture();
    let baseline = estimate(&recipe, &built, &result, &TasteConditions::default()).unwrap();
    recipe
        .overrides
        .insert("taste.bitterness.caffeine_weight".into(), 0.0);
    let caffeine_excluded =
        estimate(&recipe, &built, &result, &TasteConditions::default()).unwrap();
    assert!(baseline.bitterness_index > caffeine_excluded.bitterness_index);
    assert_eq!(baseline.acidity_index, caffeine_excluded.acidity_index);
    recipe
        .overrides
        .insert("taste.acidity.reference_ta".into(), 0.0);
    assert!(estimate(&recipe, &built, &result, &TasteConditions::default()).is_err());
}

#[test]
fn source_water_buffering_reaches_taste_through_m2_acidity() {
    let mut input = common::generic_recipe();
    input["numerics"] = serde_json::json!({"tier":0,"size_classes":6});
    let mut acidity = Vec::new();
    let mut summaries = Vec::new();
    for alkalinity in [0.0, 200.0] {
        input["water"] = serde_json::json!({"alkalinity_mg_l_caco3":alkalinity});
        let recipe: Recipe = serde_json::from_value(input.clone()).unwrap();
        let built = build(&recipe).unwrap();
        let shot = puckcore::shot::simulate_shot(&built.spec).unwrap();
        let taste = estimate(&recipe, &built, &shot, &TasteConditions::default()).unwrap();
        acidity.push(taste.acidity_index.unwrap());
        summaries.push(shot.summary);
    }
    assert!(acidity[1] < acidity[0]);
    assert_eq!(summaries[0], summaries[1]);
}
