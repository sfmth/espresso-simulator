// SPDX-License-Identifier: GPL-2.0-or-later
//! The JSON boundary: round trips, strictness, errors, determinism and the
//! owner's recipe end to end (docs/model/m1-contract.md).

mod common;

use common::*;
use puckmodel::Recipe;
use serde_json::{Value, json};

/// A recipe with every optional field filled.
fn maximal_recipe() -> Value {
    json!({
        "schema": "puckworks.recipe/1",
        "bean": {
            "preset": "light-washed-arabica", "arabica_fraction": 0.9, "roast_level": 0.3,
            "days_off_roast": 12, "process": "honey", "bean_temp_c": -18
        },
        "grinder": {
            "preset": "bentwood-v63", "setting": 200, "family": "flat-traditional", "gap_um": 210,
            "psd": {"diameter_um": [30, 300], "volume_fraction": [0.2, 0.8], "method": "dry_laser"},
            "burr_diameter_mm": 63, "rpm": 1400, "gap_at_ref_um": 0, "gap_per_unit_um": 1,
            "x50_gap_ratio": 1.4, "fines_at_340_pct": 15
        },
        "basket": {
            "preset": "58-precision-18g",
            "custom": {
                "profile_mm": [[0, 56], [3, 58], [21, 58.5]], "perforated_diameter_mm": 50,
                "open_area_fraction": 0.03, "pressurised_orifice_mm": 0.4, "discharge_coefficient": 0.7
            }
        },
        "prep": {
            "dose_g": 18, "distribution": "wdt", "tamp_kgf": 15,
            "puck_screen": true, "paper_bottom": true, "paper_top": false
        },
        "machine": {
            "preset": "flat-9-bar", "temperature_c": 94,
            "profile": [
                {"control": "flow", "target": 4, "ramp_s": 0, "limit": 3, "until_time_s": 8,
                 "until_beverage_g": 2, "until_pressure_bar": 3},
                {"control": "pressure", "target": 9, "ramp_s": 2, "limit": 4}
            ],
            "pump": {"type": "vibratory", "free_flow_ml_s": 9, "stall_pressure_bar": 15, "opv_bar": 11},
            "headspace_ml": 4
        },
        "stop": {"beverage_g": 36, "time_s": 40},
        "numerics": {"tier": 0, "size_classes": 24},
        "overrides": {"hydraulics.permeability.reference": 2e-14}
    })
}

#[test]
fn recipes_round_trip_through_json() {
    for v in [maximal_recipe(), owner_recipe(), generic_recipe()] {
        let recipe: Recipe = serde_json::from_value(v.clone()).unwrap();
        let text = serde_json::to_string(&recipe).unwrap();
        let again: Recipe = serde_json::from_str(&text).unwrap();
        assert_eq!(recipe, again);
    }
    // The maximal recipe builds (the measured PSD and custom basket win) and simulates.
    let built = build_ok(&maximal_recipe());
    assert_eq!(built["derived"]["psd"]["source"], "measured");
    assert_eq!(built["spec"]["basket"]["outlet"]["type"], "pressurised");
    puckmodel::api::simulate_recipe_json(&maximal_recipe().to_string()).unwrap();
}

#[test]
fn unknown_fields_are_rejected_at_every_level() {
    let paths = [
        "bogus",
        "bean.bogus",
        "grinder.bogus",
        "grinder.psd.bogus",
        "basket.bogus",
        "basket.custom.bogus",
        "prep.bogus",
        "machine.bogus",
        "machine.profile.0.bogus",
        "machine.pump.bogus",
        "stop.bogus",
        "numerics.bogus",
    ];
    for path in paths {
        let mut v = maximal_recipe();
        set(&mut v, path, json!(1));
        let err = build_err(&v);
        assert!(
            err.contains("unknown field") && err.contains("bogus"),
            "{path}: {err}"
        );
    }
    // A misspelt pump type is rejected too.
    let mut v = maximal_recipe();
    set(&mut v, "machine.pump.type", json!("rotary"));
    assert!(build_err(&v).contains("unknown variant"));
}

#[test]
fn spec_json_round_trips_and_is_strict() {
    let built = build_ok(&owner_recipe());
    let spec_text = built["spec"].to_string();
    let spec: puckcore::shot::ShotSpec = serde_json::from_str(&spec_text).unwrap();
    assert_eq!(serde_json::to_value(&spec).unwrap(), built["spec"]);
    // simulate_shot on the built spec equals simulate_recipe.
    let direct: Value =
        serde_json::from_str(&puckmodel::api::simulate_shot_json(&spec_text).unwrap()).unwrap();
    let run: Value = serde_json::from_str(
        &puckmodel::api::simulate_recipe_json(&owner_recipe().to_string()).unwrap(),
    )
    .unwrap();
    assert_eq!(direct, run["result"]);
    assert_eq!(run["build"], built);
    // Unknown spec fields are rejected.
    let mut bad = built["spec"].clone();
    bad["bed"]["bogus"] = json!(1);
    assert!(
        puckmodel::api::simulate_shot_json(&bad.to_string())
            .unwrap_err()
            .0
            .contains("unknown field")
    );
}

#[test]
fn owner_recipe_builds_flags_and_simulates() {
    let run: Value = serde_json::from_str(
        &puckmodel::api::simulate_recipe_json(&owner_recipe().to_string()).unwrap(),
    )
    .unwrap();
    let built = &run["build"];
    let flags: Vec<&str> = built["derived"]["flags"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f.as_str().unwrap())
        .collect();
    for flag in ["owner-gear", "unverified", "estimated"] {
        assert!(flags.contains(&flag), "{flags:?}");
    }
    let text = notes(built);
    assert!(
        text.contains("UNVERIFIED") && text.contains("UNKNOWN pump curve"),
        "{text}"
    );
    assert_eq!(built["derived"]["presets"]["machine"], "amzchef-ultra");
    assert_eq!(
        built["derived"]["presets"]["grinder"],
        "amzchef-single-dose"
    );
    assert_eq!(num(built, "spec.bed.dose_kg"), 0.018);
    assert_eq!(num(built, "spec.machine.stop.beverage_mass_kg"), 0.036);
    assert_eq!(built["spec"]["machine"]["pump"]["type"], "vibratory");
    assert_eq!(
        built["spec"]["machine"]["phases"][0]["control"]["type"],
        "pump_full"
    );
    // The solver may change; the result must be a finite, non-empty shot.
    let s = &run["result"]["summary"];
    assert!(num(s, "beverage_mass_kg") > 0.0 && num(s, "shot_time_s") > 0.0);
    assert!(num(s, "tds").is_finite() && num(s, "ey").is_finite());
}

#[test]
fn builds_are_deterministic() {
    for v in [owner_recipe(), maximal_recipe(), generic_recipe()] {
        let a = puckmodel::api::build_shot_spec_json(&v.to_string()).unwrap();
        let b = puckmodel::api::build_shot_spec_json(&v.to_string()).unwrap();
        assert_eq!(a, b);
    }
}

#[test]
fn errors_name_the_problem() {
    let mut v = generic_recipe();
    v["schema"] = json!("puckworks.recipe/2");
    assert!(build_err(&v).contains("puckworks.recipe/1"));

    let mut v = generic_recipe();
    v["grinder"] = json!({});
    assert!(build_err(&v).contains("grinder: give a preset"));

    let mut v = generic_recipe();
    v["basket"] = json!({"preset": "58-mystery"});
    let err = build_err(&v);
    assert!(
        err.contains("58-mystery") && err.contains("58-precision-18g"),
        "{err}"
    );

    let mut v = generic_recipe();
    v["prep"]["dose_g"] = json!(0);
    assert!(build_err(&v).contains("prep.dose_g"));

    let mut v = generic_recipe();
    v["prep"]["dose_g"] = json!(30);
    let err = build_err(&v);
    assert!(err.contains("holds only"), "{err}");

    let mut v = generic_recipe();
    v["machine"] = json!({});
    assert!(build_err(&v).contains("machine: give a preset or a profile"));

    let mut v = generic_recipe();
    v["numerics"] = json!({"tier": 2});
    assert!(build_err(&v).contains("numerics.tier"));

    let mut v = generic_recipe();
    v["numerics"] = json!({"size_classes": 1});
    assert!(build_err(&v).contains("numerics.size_classes"));
}

#[test]
fn presets_and_registry_documents() {
    let p = presets();
    assert_eq!(p["schema"], puckmodel::presets::PRESETS_SCHEMA);
    let r: Value = serde_json::from_str(&puckmodel::api::registry_json()).unwrap();
    assert_eq!(r["schema"], puckmodel::registry::REGISTRY_SCHEMA);
    for param in r["parameters"].as_array().unwrap() {
        assert!(
            param["default"].as_f64().unwrap().is_finite(),
            "{}",
            param["id"]
        );
        assert!(
            param.get("comment").is_none(),
            "comments are left out of the embedded registry"
        );
        assert!(!param["sources"].as_array().unwrap().is_empty());
    }
    let mut counts = Vec::new();
    for kind in [
        "grinder_families",
        "grinders",
        "baskets",
        "machines",
        "beans",
    ] {
        counts.push(p[kind].as_array().unwrap().len());
    }
    assert!(counts.iter().all(|&n| n >= 3), "{counts:?}");
}
