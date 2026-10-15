// SPDX-License-Identifier: GPL-2.0-or-later
//! Every preset combination builds a valid spec, and simulates without
//! error.
//!
//! Building is cheap, so every combination of grinder (each preset at its
//! default setting, plus each family at a 200 µm gap), basket (at its nominal
//! dose), machine and bean is built and checked. Simulating costs whatever
//! the solver costs, so by default a covering set is simulated at tier 0:
//! every basket × machine pair and every grinder × bean pair, with the other
//! two kinds cycling. The full product is simulated by the ignored test
//! (`cargo test -p puckmodel --release -- --ignored`).

mod common;

use common::*;
use puckmodel::Recipe;
use serde_json::{Value, json};

/// A grinder description for each preset and each family.
fn grinder_options() -> Vec<Value> {
    let mut out: Vec<Value> = preset_ids("grinders")
        .into_iter()
        .map(|id| json!({"preset": id}))
        .collect();
    out.extend(
        preset_ids("grinder_families")
            .into_iter()
            .map(|id| json!({"family": id, "gap_um": 200})),
    );
    out
}

/// Nominal dose of a basket preset, g.
fn dose(basket: &str) -> f64 {
    thread_local! {
        static DOSES: std::collections::BTreeMap<String, f64> = presets()["baskets"]
            .as_array()
            .unwrap()
            .iter()
            .map(|p| (p["id"].as_str().unwrap().to_string(), p["nominal_dose_g"].as_f64().unwrap()))
            .collect();
    }
    DOSES.with(|d| d[basket])
}

fn recipe(grinder: &Value, basket: &str, machine: &str, bean: &str, tier: u8) -> Value {
    let dose = dose(basket);
    json!({
        "schema": "puckworks.recipe/1",
        "bean": {"preset": bean},
        "grinder": grinder,
        "basket": {"preset": basket},
        "prep": {"dose_g": dose},
        "machine": {"preset": machine},
        "stop": {"beverage_g": 2.0 * dose},
        "numerics": {"tier": tier}
    })
}

#[test]
fn every_preset_combination_builds_a_valid_spec() {
    let (grinders, baskets, machines, beans) = (
        grinder_options(),
        preset_ids("baskets"),
        preset_ids("machines"),
        preset_ids("beans"),
    );
    let mut count = 0;
    for g in &grinders {
        for b in &baskets {
            for m in &machines {
                for bean in &beans {
                    let r: Recipe = serde_json::from_value(recipe(g, b, m, bean, 1)).unwrap();
                    let built =
                        puckmodel::build(&r).unwrap_or_else(|e| panic!("{g} {b} {m} {bean}: {e}"));
                    puckmodel::validate::check_spec(&built.spec)
                        .unwrap_or_else(|e| panic!("{g} {b} {m} {bean}: {e}"));
                    assert_eq!(
                        built.derived.psd_curve.diameter_um.len(),
                        built.derived.psd_curve.volume_density.len()
                    );
                    count += 1;
                }
            }
        }
    }
    assert_eq!(
        count,
        grinders.len() * baskets.len() * machines.len() * beans.len()
    );
}

fn simulate(r: &Value) {
    puckmodel::api::simulate_recipe_json(&r.to_string())
        .unwrap_or_else(|e| panic!("simulation failed: {e}\n{r}"));
}

#[test]
fn preset_combinations_simulate_covering_set() {
    let (grinders, baskets, machines, beans) = (
        grinder_options(),
        preset_ids("baskets"),
        preset_ids("machines"),
        preset_ids("beans"),
    );
    let mut n = 0;
    for (i, b) in baskets.iter().enumerate() {
        for (j, m) in machines.iter().enumerate() {
            simulate(&recipe(
                &grinders[(i + j) % grinders.len()],
                b,
                m,
                &beans[(i + 2 * j) % beans.len()],
                0,
            ));
            n += 1;
        }
    }
    for (i, g) in grinders.iter().enumerate() {
        for (j, bean) in beans.iter().enumerate() {
            simulate(&recipe(
                g,
                &baskets[(i + j) % baskets.len()],
                &machines[(2 * i + j) % machines.len()],
                bean,
                0,
            ));
            n += 1;
        }
    }
    assert_eq!(
        n,
        baskets.len() * machines.len() + grinders.len() * beans.len()
    );
}

#[test]
#[ignore = "simulates the full product of presets; run with --ignored (preferably --release)"]
fn every_preset_combination_simulates() {
    for g in &grinder_options() {
        for b in &preset_ids("baskets") {
            for m in &preset_ids("machines") {
                for bean in &preset_ids("beans") {
                    simulate(&recipe(g, b, m, bean, 0));
                }
            }
        }
    }
}

#[test]
fn every_basket_holds_its_dose_range_for_every_bean() {
    for b in preset_ids("baskets") {
        let p = preset("baskets", &b);
        let hi = num(&p, "dose_range_g.1");
        for bean in preset_ids("beans") {
            let mut r = recipe(
                &json!({"preset": "generic-conical-50"}),
                &b,
                "flat-9-bar",
                &bean,
                1,
            );
            r["prep"]["dose_g"] = json!(hi);
            build_ok(&r);
        }
    }
}

#[test]
fn every_machine_default_basket_exists() {
    for m in preset_ids("machines") {
        if let Some(b) = preset("machines", &m)["default_basket"].as_str() {
            assert!(preset_ids("baskets").contains(&b.to_string()), "{m}: {b}");
        }
    }
}
