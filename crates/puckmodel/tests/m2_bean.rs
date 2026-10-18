// SPDX-License-Identifier: GPL-2.0-or-later
//! M2 scientific-accounting and descriptor regression checks.
mod common;

use common::*;
use serde_json::{Value, json};
use std::collections::BTreeSet;

fn built(bean: Value) -> Value {
    let mut recipe = generic_recipe();
    recipe["bean"] = bean;
    build_ok(&recipe)
}

fn passenger<'a>(built: &'a Value, id: &str) -> &'a Value {
    built["spec"]["solubles"]["species"]
        .as_array()
        .unwrap()
        .iter()
        .find(|sp| sp["id"] == id)
        .unwrap_or_else(|| panic!("missing species {id}"))
}

fn fraction(b: &Value, id: &str) -> f64 {
    passenger(b, id)["mass_fraction"].as_f64().unwrap()
}

#[test]
fn m2_catalogue_covers_appendix_a_and_marks_overlapping_and_nondissolved_phases() {
    let b = built(json!({"preset":"medium-washed-arabica"}));
    let compounds = b["derived"]["compounds"].as_array().unwrap();
    assert_eq!(compounds.len(), 57);
    let ids: BTreeSet<_> = compounds
        .iter()
        .map(|x| x["id"].as_str().unwrap())
        .collect();
    assert_eq!(ids.len(), 57);
    let classes: BTreeSet<_> = compounds
        .iter()
        .map(|x| x["kinetic_class"].as_str().unwrap())
        .collect();
    assert_eq!(
        classes,
        BTreeSet::from(["K1", "K2", "K3", "K4", "K5", "K6"])
    );
    for id in [
        "acids",
        "lipid_emulsion",
        "cafestol",
        "kahweol",
        "co2",
        "methanethiol",
        "methylpropanal",
    ] {
        let meta = compounds.iter().find(|x| x["id"] == id).unwrap();
        assert_eq!(meta["counts_toward_tds"], false, "{id}");
    }
    let initial: Vec<_> = b["spec"]["solubles"]["species"].as_array().unwrap()[..4]
        .iter()
        .map(|x| x["id"].as_str().unwrap())
        .collect();
    assert_eq!(initial, ["caffeine", "trigonelline", "cqa5", "acids"]);
}

#[test]
fn measured_m1_composition_anchors_remain_unchanged() {
    let b = built(json!({"preset":"medium-washed-arabica"}));
    for (id, mass) in [
        ("caffeine", 0.012),
        ("trigonelline", 0.007),
        ("cqa5", 0.0114),
        ("acids", 0.024),
    ] {
        assert!((fraction(&b, id) - mass).abs() < 1e-12, "{id}");
    }
}

#[test]
fn altitude_and_variety_are_descriptors_without_fabricated_composition_effects() {
    let plain = built(json!({"preset":"light-washed-arabica"}));
    let described =
        built(json!({"preset":"light-washed-arabica","altitude_m":2200,"variety_group":"gesha"}));
    assert_eq!(plain["spec"]["solubles"], described["spec"]["solubles"]);
    assert!(notes(&described).contains("No altitude multiplier"));
    assert!(notes(&described).contains("without an invented composition multiplier"));
    let mut invalid = generic_recipe();
    invalid["bean"] = json!({"altitude_m":4001});
    assert!(build_err(&invalid).contains("bean.altitude_m"));
}

#[test]
fn storage_changes_only_estimated_aroma_and_process_effect_is_explicit() {
    let sealed = built(json!({"storage":"sealed","days_off_roast":30,"process":"washed"}));
    let open = built(json!({"storage":"open","days_off_roast":30,"process":"washed"}));
    let frozen = built(json!({"storage":"frozen","days_off_roast":30,"process":"washed"}));
    assert!(fraction(&open, "furfurylthiol") < fraction(&sealed, "furfurylthiol"));
    assert!(fraction(&sealed, "furfurylthiol") < fraction(&frozen, "furfurylthiol"));
    for id in ["caffeine", "trigonelline", "cqa5", "acids"] {
        assert_eq!(passenger(&sealed, id), passenger(&open, id));
        assert_eq!(passenger(&sealed, id), passenger(&frozen, id));
    }
    let anaerobic = built(json!({"storage":"sealed","days_off_roast":30,"process":"anaerobic"}));
    assert!(fraction(&anaerobic, "acetic_acid") > fraction(&sealed, "acetic_acid"));
    for id in ["caffeine", "trigonelline", "cqa5", "acids"] {
        assert_eq!(passenger(&sealed, id), passenger(&anaerobic, id));
    }
}

#[test]
fn unresolved_initial_inventory_is_visible_and_measured_species_are_not_rescaled() {
    let b = built(json!({"preset":"medium-washed-arabica"}));
    let sum: f64 = b["spec"]["solubles"]["species"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|x| x["id"] != "acids")
        .map(|x| x["mass_fraction"].as_f64().unwrap())
        .sum();
    let extractable = b["spec"]["solubles"]["extractable_fraction"]
        .as_f64()
        .unwrap();
    assert!((sum - extractable).abs() < 1e-12);
    assert!(fraction(&b, "unassigned_solubles") > 0.0);
    let mut recipe = generic_recipe();
    recipe["overrides"] = json!({"bean.composition.arabica.caffeine":20.0});
    let over = build_ok(&recipe);
    assert_eq!(fraction(&over, "caffeine"), 0.2);
    assert_eq!(fraction(&over, "unassigned_solubles"), 0.0);
    assert!(notes(&over).contains("not rescaled"));
}

#[test]
fn unknown_storage_and_variety_descriptors_are_rejected() {
    for (field, value) in [
        ("storage", "vacuum-unknown"),
        ("variety_group", "magic-variety"),
    ] {
        let mut recipe = generic_recipe();
        recipe["bean"] = json!({field:value});
        assert!(build_err(&recipe).contains(field));
    }
}

#[test]
fn explicit_chemistry_opt_out_restores_the_four_passenger_contract() {
    let mut recipe = generic_recipe();
    recipe["chemistry"] = json!({"enabled":false});
    let b = build_ok(&recipe);
    assert_eq!(
        b["spec"]["solubles"]["species"].as_array().unwrap().len(),
        4
    );
    assert!(b["spec"]["chemistry"].is_null());
}

#[test]
fn phase_inventories_do_not_become_dissolved_passengers() {
    let b = built(json!({"preset":"medium-washed-arabica"}));
    let dissolved: BTreeSet<_> = b["spec"]["solubles"]["species"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["id"].as_str().unwrap())
        .collect();
    let phases = b["spec"]["chemistry"]["phase_inventories"]
        .as_array()
        .unwrap();
    assert_eq!(phases.len(), 6);
    for phase in phases {
        let id = phase["id"].as_str().unwrap();
        assert!(!dissolved.contains(id));
        assert!(phase["available_mass_kg"].as_f64().unwrap() >= 0.0);
        let transfer = phase["cup_transfer_fraction"].as_f64().unwrap();
        assert!((0.0..=1.0).contains(&transfer));
    }
}
