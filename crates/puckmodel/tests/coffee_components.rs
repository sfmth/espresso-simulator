// SPDX-License-Identifier: GPL-2.0-or-later
//! Single coffees keep their original path; custom mixtures resolve each leaf
//! before combining nonlinear composition, degassing and particle volumes.
mod common;

use common::{build_err, build_ok, generic_recipe};
use serde_json::{Value, json};

fn coffee(input: Value) -> Value {
    let mut r = generic_recipe();
    r["prep"]["dose_g"] = json!(12);
    r["bean"] = input;
    r
}
fn value(v: &Value, pointer: &str) -> f64 {
    v.pointer(pointer).unwrap().as_f64().unwrap()
}
fn close(a: f64, b: f64) {
    assert!(
        (a - b).abs() <= 1e-12 * a.abs().max(b.abs()).max(1.0),
        "{a} != {b}"
    );
}

#[test]
fn one_component_is_exactly_the_original_coffee() {
    let leaf = json!({"preset":"light-washed-arabica", "days_off_roast":4});
    let single = build_ok(&coffee(leaf.clone()));
    let wrapped = build_ok(&coffee(json!({"components":[{"weight":18,"bean":leaf}]})));
    assert_eq!(single, wrapped);
}

#[test]
fn dry_mass_inventories_and_co2_are_mixed_after_each_coffee_is_resolved() {
    let first = json!({"arabica_fraction":1, "roast_level":0.2,"days_off_roast":1});
    let second = json!({"arabica_fraction":0, "roast_level":0.8,"days_off_roast":30});
    let a = build_ok(&coffee(first.clone()));
    let b = build_ok(&coffee(second.clone()));
    let mixed = build_ok(&coffee(json!({"components":[
        {"weight":3,"bean":first}, {"weight":1,"bean":second}
    ]})));
    for path in [
        "/spec/solubles/extractable_fraction",
        "/derived/bean/co2_puck_mg_g",
        "/derived/bean/co2_beans_mg_g",
    ] {
        close(
            value(&mixed, path),
            0.75 * value(&a, path) + 0.25 * value(&b, path),
        );
    }
    let species = |built: &Value, id: &str| {
        built["spec"]["solubles"]["species"]
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["id"] == id)
            .unwrap()["mass_fraction"]
            .as_f64()
            .unwrap()
    };
    for entry in mixed["spec"]["solubles"]["species"].as_array().unwrap() {
        let id = entry["id"].as_str().unwrap();
        close(
            species(&mixed, id),
            0.75 * species(&a, id) + 0.25 * species(&b, id),
        );
    }
    let mean_descriptor = build_ok(&coffee(
        json!({"arabica_fraction":0.75,"roast_level":0.35,"days_off_roast":8.25}),
    ));
    assert!(
        (value(&mixed, "/derived/bean/co2_puck_mg_g")
            - value(&mean_descriptor, "/derived/bean/co2_puck_mg_g"))
        .abs()
            > 0.01
    );
}

#[test]
fn component_weights_are_relative_and_order_does_not_change_the_physics() {
    let a = json!({"weight":30,"bean":{"roast_level":0.2,"days_off_roast":2}});
    let b = json!({"weight":70,"bean":{"roast_level":0.7,"days_off_roast":12}});
    let original = build_ok(&coffee(json!({"components":[a.clone(),b.clone()]})));
    let reverse = build_ok(&coffee(json!({"components":[b,a]})));
    assert_eq!(original["spec"], reverse["spec"]);
    let scaled = build_ok(&coffee(json!({"components":[
        {"weight":3,"bean":{"roast_level":0.2,"days_off_roast":2}},
        {"weight":7,"bean":{"roast_level":0.7,"days_off_roast":12}}
    ]})));
    assert_eq!(original["spec"], scaled["spec"]);
}

#[test]
fn roaster_facts_preserve_large_color_readings_without_inventing_physics() {
    let plain = build_ok(&coffee(json!({"roast_level":0.3})));
    let mut input = coffee(json!({"roast_level":0.3,"coffee":{
        "name":"Published single origin","varieties":["SL28","Batian"],
        "roast_color":{"scale":"agtron-gourmet","value":129.2,"sample":"ground","instrument":"M Basic III"}
    }}));
    let sourced = build_ok(&input);
    assert_eq!(plain, sourced);
    input["bean"]["coffee"]["roast_color"]["scale"] = json!("invented-scale");
    assert!(build_err(&input).contains("roast_color"));
}

#[test]
fn reject_ambiguous_nested_or_invalid_mixtures() {
    for bean in [
        json!({"components":[]}),
        json!({"roast_level":0.5,"components":[{"weight":1,"bean":{}}]}),
        json!({"components":[{"weight":0,"bean":{}}]}),
        json!({"components":[{"weight":-1,"bean":{}}]}),
        json!({"components":[{"weight":1,"bean":{"components":[{"weight":1,"bean":{}}]}}]}),
        json!({"components":vec![json!({"weight":1,"bean":{}});7]}),
    ] {
        assert!(build_err(&coffee(bean)).contains("bean.components"));
    }
}

#[test]
fn porous_volume_and_phase_inventories_follow_dry_mass_mixing() {
    let first = json!({"roast_level":0.2,"days_off_roast":2,"storage":"sealed"});
    let second =
        json!({"roast_level":0.8,"days_off_roast":20,"storage":"open","process":"anaerobic"});
    let a = build_ok(&coffee(first.clone()));
    let b = build_ok(&coffee(second.clone()));
    let mixed = build_ok(&coffee(json!({"components":[
        {"weight":3,"bean":first}, {"weight":1,"bean":second}
    ]})));
    let density = |v: &Value| value(v, "/spec/bed/skeletal_density_kg_m3");
    let porosity = |v: &Value| value(v, "/spec/bed/intraparticle_porosity");
    let solids = 0.75 / density(&a) + 0.25 / density(&b);
    let particles =
        0.75 / (density(&a) * (1.0 - porosity(&a))) + 0.25 / (density(&b) * (1.0 - porosity(&b)));
    close(density(&mixed), 1.0 / solids);
    close(porosity(&mixed), 1.0 - solids / particles);
    assert!((porosity(&mixed) - (0.75 * porosity(&a) + 0.25 * porosity(&b))).abs() > 1e-4);
    let phases = |v: &Value, id: &str| {
        v["spec"]["chemistry"]["phase_inventories"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == id)
            .unwrap()["available_mass_kg"]
            .as_f64()
            .unwrap()
    };
    for phase in mixed["spec"]["chemistry"]["phase_inventories"]
        .as_array()
        .unwrap()
    {
        let id = phase["id"].as_str().unwrap();
        close(
            phases(&mixed, id),
            0.75 * phases(&a, id) + 0.25 * phases(&b, id),
        );
    }
}
