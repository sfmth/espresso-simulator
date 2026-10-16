// SPDX-License-Identifier: GPL-2.0-or-later
//! `data/schema/recipe.schema.json` mirrors the Rust recipe types: the same
//! fields at every level, and every object closed to unknown fields. (The
//! Python tests validate example recipes against the schema with jsonschema.)

use std::collections::BTreeSet;

use puckmodel::Recipe;
use puckmodel::recipe::{PhaseInput, PumpInput};
use serde_json::{Value, json};

const SCHEMA: &str = include_str!("../../../data/schema/recipe.schema.json");

fn keys(v: &Value) -> BTreeSet<String> {
    v.as_object().expect("an object").keys().cloned().collect()
}

fn def<'a>(schema: &'a Value, name: &str) -> &'a Value {
    &schema["$defs"][name]
}

fn assert_same(rust: &Value, schema_obj: &Value, what: &str) {
    assert_eq!(
        keys(rust),
        keys(&schema_obj["properties"]),
        "{what}: Rust fields vs schema properties"
    );
    assert_eq!(
        schema_obj["additionalProperties"],
        json!(false),
        "{what} must reject unknown fields"
    );
}

#[test]
fn schema_mirrors_the_rust_types() {
    let schema: Value = serde_json::from_str(SCHEMA).unwrap();
    // Serde writes every field (None as null), so any recipe shows all field names.
    let recipe: Recipe = serde_json::from_value(json!({
        "schema": "puckworks.recipe/1",
        "bean": {}, "grinder": {"psd": {"diameter_um": [1], "volume_fraction": [1]}},
        "basket": {"custom": {"profile_mm": [[0, 1], [1, 1]], "perforated_diameter_mm": 1}},
        "prep": {"dose_g": 1}, "machine": {"profile": [{"control": "pump"}]}, "stop": {}
    }))
    .unwrap();
    let v = serde_json::to_value(&recipe).unwrap();
    assert_same(&v, &schema, "recipe");
    let required: BTreeSet<String> = schema["required"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r.as_str().unwrap().to_string())
        .collect();
    let optional: BTreeSet<String> = ["numerics", "overrides"]
        .iter()
        .map(|s| s.to_string())
        .collect();
    assert_eq!(&keys(&v) - &optional, required, "required top-level blocks");
    for (field, name) in [
        ("bean", "bean"),
        ("grinder", "grinder"),
        ("basket", "basket"),
        ("prep", "prep"),
        ("machine", "machine"),
        ("stop", "stop"),
        ("numerics", "numerics"),
    ] {
        assert_same(&v[field], def(&schema, name), field);
    }
    assert_same(&v["grinder"]["psd"], def(&schema, "psd"), "grinder.psd");
    assert_same(
        &v["basket"]["custom"],
        def(&schema, "basket_custom"),
        "basket.custom",
    );
    assert_same(
        &serde_json::to_value(PhaseInput::default()).unwrap(),
        def(&schema, "phase"),
        "phase",
    );
    let pumps = def(&schema, "pump")["oneOf"].as_array().unwrap();
    let ideal = PumpInput::Ideal {
        max_flow_ml_s: None,
        max_pressure_bar: None,
    };
    let vibratory = PumpInput::Vibratory {
        free_flow_ml_s: None,
        stall_pressure_bar: None,
        opv_bar: None,
    };
    assert_same(
        &serde_json::to_value(ideal).unwrap(),
        &pumps[0],
        "ideal pump",
    );
    assert_same(
        &serde_json::to_value(vibratory).unwrap(),
        &pumps[1],
        "vibratory pump",
    );
    assert_eq!(pumps[0]["properties"]["type"]["const"], "ideal");
    assert_eq!(pumps[1]["properties"]["type"]["const"], "vibratory");
    assert_eq!(
        schema["properties"]["schema"]["const"],
        puckmodel::RECIPE_SCHEMA
    );
}
