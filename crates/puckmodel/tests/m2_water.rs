// SPDX-License-Identifier: GPL-2.0-or-later
//! Cup changes must not silently change the independently simulated extraction.
mod common;

use common::*;
use serde_json::{Value, json};

fn shot(recipe: &Value) -> Value {
    serde_json::from_str(&puckmodel::api::simulate_recipe_json(&recipe.to_string()).unwrap())
        .unwrap()
}

#[test]
fn water_buffering_changes_acidity_without_changing_extraction() {
    let mut recipe = generic_recipe();
    recipe["water"] = json!({"alkalinity_mg_l_caco3":0});
    let low = shot(&recipe);
    recipe["water"] = json!({"alkalinity_mg_l_caco3":200});
    let high = shot(&recipe);
    assert_eq!(low["result"]["summary"], high["result"]["summary"]);
    assert_eq!(low["result"]["series"], high["result"]["series"]);
    let ph = |r: &Value| r["result"]["chemistry"]["acidity"]["ph"].as_f64().unwrap();
    assert!(ph(&high) > ph(&low));
}

#[test]
fn cup_aging_binds_aroma_without_changing_the_shot() {
    let mut recipe = generic_recipe();
    recipe["chemistry"] = json!({"aroma_age_s":0});
    let fresh = shot(&recipe);
    recipe["chemistry"] = json!({"aroma_age_s":600});
    let aged = shot(&recipe);
    assert_eq!(fresh["result"]["summary"], aged["result"]["summary"]);
    let thiol = |r: &Value| {
        r["result"]["chemistry"]["aroma"]
            .as_array()
            .unwrap()
            .iter()
            .find(|a| a["id"] == "furfurylthiol")
            .unwrap()["bound_mass_kg"]
            .as_f64()
            .unwrap()
    };
    assert!(thiol(&aged) > thiol(&fresh));
}

#[test]
fn observation_overrides_keep_their_real_provenance() {
    let mut recipe = generic_recipe();
    recipe["water"] = json!({"alkalinity_mg_l_caco3":12});
    recipe["overrides"] = json!({"water.default.alkalinity_mg_l_caco3":100,
        "chemistry.species.citric_acid.mw":193.0});
    let b = build_ok(&recipe);
    assert_eq!(
        b["spec"]["chemistry"]["water"]["alkalinity_mg_l_caco3"],
        12.0
    );
    let provenance = b["derived"]["provenance"].as_object().unwrap();
    assert_eq!(
        provenance["chemistry.water.alkalinity_mg_l_caco3"],
        "recipe:water.alkalinity_mg_l_caco3"
    );
    assert!(provenance.values().any(|v| {
        v.as_str()
            .unwrap()
            .contains("override:chemistry.species.citric_acid.mw")
    }));
}

#[test]
fn invalid_water_is_rejected_even_when_postprocessing_is_disabled() {
    let mut recipe = generic_recipe();
    recipe["water"] = json!({"ph":15});
    recipe["chemistry"] = json!({"enabled":false});
    assert!(build_err(&recipe).contains("water.ph"));
}
