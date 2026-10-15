// SPDX-License-Identifier: GPL-2.0-or-later
//! Helpers shared by the integration tests.
#![allow(dead_code)]

use std::collections::BTreeSet;

use serde_json::{Value, json};

/// The owner's gear (PLAN D10): AMZCHEF Ultra, AMZCHEF grinder, 58 mm basket,
/// 18 g → 36 g.
pub fn owner_recipe() -> Value {
    json!({
        "schema": "puckworks.recipe/1",
        "bean": {"preset": "medium-washed-arabica"},
        "grinder": {"preset": "amzchef-single-dose", "setting": 10},
        "basket": {"preset": "58-stock-double"},
        "prep": {"dose_g": 18, "distribution": "wdt", "tamp_kgf": 15},
        "machine": {"preset": "amzchef-ultra"},
        "stop": {"beverage_g": 36}
    })
}

/// A plain recipe on generic gear.
pub fn generic_recipe() -> Value {
    json!({
        "schema": "puckworks.recipe/1",
        "bean": {},
        "grinder": {"preset": "generic-flat-traditional-64", "setting": 190},
        "basket": {"preset": "58-precision-18g"},
        "prep": {"dose_g": 18},
        "machine": {"preset": "flat-9-bar"},
        "stop": {"beverage_g": 36}
    })
}

/// Builds a recipe through the JSON API: `{spec, derived}` or the error message.
pub fn build(recipe: &Value) -> Result<Value, String> {
    puckmodel::api::build_shot_spec_json(&recipe.to_string())
        .map(|text| serde_json::from_str(&text).expect("the API returns JSON"))
        .map_err(|e| e.0)
}

/// Builds a recipe that must succeed.
pub fn build_ok(recipe: &Value) -> Value {
    build(recipe).unwrap_or_else(|e| panic!("build failed: {e}\nrecipe: {recipe}"))
}

/// Builds a recipe that must fail; returns the message.
pub fn build_err(recipe: &Value) -> String {
    match build(recipe) {
        Ok(_) => panic!("build unexpectedly succeeded: {recipe}"),
        Err(e) => e,
    }
}

/// The embedded presets document.
pub fn presets() -> Value {
    serde_json::from_str(&puckmodel::api::presets_json()).unwrap()
}

/// Ids of one preset list (`grinders`, `baskets`, …).
pub fn preset_ids(kind: &str) -> Vec<String> {
    presets()[kind]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap().to_string())
        .collect()
}

/// The preset with this id from one list.
pub fn preset(kind: &str, id: &str) -> Value {
    presets()[kind]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == id)
        .cloned()
        .unwrap_or_else(|| panic!("no {kind} preset {id}"))
}

/// All registry ids.
pub fn registry_ids() -> BTreeSet<String> {
    let doc: Value = serde_json::from_str(&puckmodel::api::registry_json()).unwrap();
    doc["parameters"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["id"].as_str().unwrap().to_string())
        .collect()
}

/// A field of a JSON value by dotted path (array indices as numbers).
pub fn at<'a>(v: &'a Value, path: &str) -> &'a Value {
    path.split('.')
        .fold(v, |v, key| match key.parse::<usize>() {
            Ok(i) => &v[i],
            Err(_) => &v[key],
        })
}

/// A number at a dotted path.
pub fn num(v: &Value, path: &str) -> f64 {
    at(v, path)
        .as_f64()
        .unwrap_or_else(|| panic!("{path} is not a number: {}", at(v, path)))
}

/// Sets a field of a JSON object by dotted path, creating objects on the way.
pub fn set(v: &mut Value, path: &str, value: Value) {
    let mut cur = v;
    let keys: Vec<&str> = path.split('.').collect();
    for key in &keys[..keys.len() - 1] {
        cur = match key.parse::<usize>() {
            Ok(i) => &mut cur[i],
            Err(_) => {
                if cur.get(*key).is_none() {
                    cur[*key] = json!({});
                }
                &mut cur[*key]
            }
        };
    }
    cur[keys[keys.len() - 1]] = value;
}

/// The notes of a build, joined.
pub fn notes(built: &Value) -> String {
    built["derived"]["notes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n.as_str().unwrap())
        .collect::<Vec<_>>()
        .join("\n")
}
