// SPDX-License-Identifier: GPL-2.0-or-later
//! Synthetic shared-core API checks, not validation against measured espresso.
use puckcore::shot::{ExploreRequest, ExploreResolution};
use puckmodel::api::{simulate_explore_json, simulate_recipe_json};
use serde_json::{Value, json};

fn recipe() -> Value {
    json!({
        "schema": "puckworks.recipe/1", "bean": {"preset": "medium-washed-arabica"},
        "grinder": {"preset": "generic-flat-traditional-64", "setting": 190},
        "basket": {"preset": "58-precision-18g"}, "prep": {"dose_g": 18},
        "machine": {"preset": "flat-9-bar"}, "stop": {"beverage_g": 24},
        "numerics": {"tier": 0, "size_classes": 3}
    })
}

#[test]
fn selected_cell_api_forces_tier1_and_preserves_all_baseline_physical_values() {
    let mut recipe = recipe();
    let explore: Value = serde_json::from_str(
        &simulate_explore_json(&recipe.to_string(), r#"{"column":0,"cell":15}"#).unwrap(),
    )
    .unwrap();
    recipe["numerics"]["tier"] = json!(1);
    let normal: Value =
        serde_json::from_str(&simulate_recipe_json(&recipe.to_string()).unwrap()).unwrap();
    assert_eq!(explore["build"]["spec"]["numerics"]["tier"], 1);
    assert_eq!(explore["result"]["summary"], normal["result"]["summary"]);
    assert_eq!(explore["result"]["series"], normal["result"]["series"]);
    assert_eq!(
        explore["result"]["diagnostics"],
        normal["result"]["diagnostics"]
    );
    assert_eq!(explore["taste"], normal["taste"]);
    assert_eq!(explore["result"]["spatial"]["micro"]["cell"], 15);
    assert_eq!(
        explore["result"]["spatial"]["micro"]["classes"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert!(
        normal["build"]["spec"]["numerics"]
            .get("explore_cell")
            .is_none()
    );
    assert!(normal["result"]["spatial"].get("micro").is_none());
    for snapshot in normal["result"]["spatial"]["snapshots"].as_array().unwrap() {
        assert!(snapshot.get("micro").is_none());
        assert!(snapshot.get("column_flow_m3_s").is_none());
        assert!(snapshot.get("bed_temperature_c").is_none());
    }
}

#[test]
fn high_api_refines_only_depth_by_five_and_checks_the_refined_index() {
    let recipe = recipe().to_string();
    let high: Value = serde_json::from_str(
        &simulate_explore_json(&recipe, r#"{"column":0,"cell":149,"resolution":"high"}"#).unwrap(),
    )
    .unwrap();
    assert_eq!(high["build"]["spec"]["numerics"]["depth_cells"], 150);
    assert_eq!(high["build"]["spec"]["numerics"]["tier"], 1);
    assert_eq!(
        high["result"]["spatial"]["depth_m"]
            .as_array()
            .unwrap()
            .len(),
        150
    );
    assert_eq!(high["result"]["spatial"]["micro"]["resolution"], "high");
    assert_eq!(high["result"]["spatial"]["micro"]["depth_cells"], 150);
    assert!(
        high["result"]["spatial"]["snapshots"]
            .as_array()
            .unwrap()
            .iter()
            .all(
                |snapshot| snapshot["local_ey"][0].as_array().unwrap().len() == 150
                    && snapshot.get("micro").is_some()
            )
    );
    assert!(
        simulate_explore_json(&recipe, r#"{"column":0,"cell":150,"resolution":"high"}"#)
            .unwrap_err()
            .to_string()
            .contains("explore_cell.cell")
    );
    assert!(
        simulate_explore_json(&recipe, r#"{"column":0,"cell":30}"#)
            .unwrap_err()
            .to_string()
            .contains("explore_cell.cell")
    );
}

#[test]
fn selection_json_is_strict_and_default_resolution_is_standard() {
    let default: ExploreRequest = serde_json::from_str(r#"{"column":0,"cell":0}"#).unwrap();
    assert_eq!(default.resolution, ExploreResolution::Standard);
    for request in [
        r#"{}"#,
        r#"{"column":-1,"cell":0}"#,
        r#"{"column":0.5,"cell":0}"#,
        r#"{"column":0,"cell":0,"resolution":"tier2"}"#,
        r#"{"column":0,"cell":0,"bogus":1}"#,
    ] {
        assert!(
            simulate_explore_json(&recipe().to_string(), request).is_err(),
            "{request}"
        );
    }
}

#[test]
fn full_default_standard_and_high_meshes_are_finite_bounded_and_conservative() {
    let mut recipe = recipe();
    recipe["numerics"]
        .as_object_mut()
        .unwrap()
        .remove("size_classes");
    recipe["stop"]["beverage_g"] = json!(36);
    for (resolution, cell) in [("standard", 15), ("high", 75)] {
        let start = std::time::Instant::now();
        let run: Value = serde_json::from_str(
            &simulate_explore_json(
                &recipe.to_string(),
                &json!({"column": 0, "cell": cell, "resolution": resolution}).to_string(),
            )
            .unwrap(),
        )
        .unwrap();
        println!(
            "default {resolution} Explore: {:.3}s, {} depth cells × {} classes",
            start.elapsed().as_secs_f64(),
            run["build"]["spec"]["numerics"]["depth_cells"],
            run["result"]["spatial"]["micro"]["classes"]
                .as_array()
                .unwrap()
                .len()
        );
        let result = &run["result"];
        assert!(
            result["diagnostics"]["mass_balance_error"]
                .as_f64()
                .unwrap()
                < 1e-9
        );
        assert!(
            result["diagnostics"]["hydraulic_volume_balance_error"]
                .as_f64()
                .unwrap()
                < 1e-9
        );
        assert!(
            result["diagnostics"]["min_concentration_kg_m3"]
                .as_f64()
                .unwrap()
                >= -1e-10
        );
        let classes = result["spatial"]["micro"]["classes"].as_array().unwrap();
        for snapshot in result["spatial"]["snapshots"].as_array().unwrap() {
            for (k, shells) in snapshot["micro"]["kernel_conc_kg_m3"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
            {
                let initial = classes[k]["initial_kernel_conc_kg_m3"].as_f64().unwrap();
                for u in shells.as_array().unwrap() {
                    let u = u.as_f64().unwrap();
                    assert!(u.is_finite() && u >= -1e-10 && u <= initial + 1e-8);
                }
            }
            for remaining in snapshot["micro"]["surface_remaining_fraction"]
                .as_array()
                .unwrap()
            {
                if let Some(fraction) = remaining.as_f64() {
                    assert!((-1e-12..=1.0 + 1e-10).contains(&fraction));
                }
            }
        }
    }
}
