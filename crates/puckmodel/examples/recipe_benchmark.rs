// SPDX-License-Identifier: GPL-2.0-or-later
//! Benchmarks the full browser-default recipe, including all M2 passengers.
//!
//! ```text
//! cargo build --release -p puckmodel --example recipe_benchmark
//! target/release/examples/recipe_benchmark 11
//! ```
//!
//! Validation, model construction and all physical-shot outputs are timed;
//! recipe construction and the output fingerprint are outside the timer.

use std::hint::black_box;
use std::time::Instant;

use puckcore::shot::simulate_shot;
use puckmodel::{Recipe, build};
use serde_json::json;

fn main() {
    let reps = std::env::args()
        .nth(1)
        .map(|s| s.parse::<usize>().expect("repetitions must be an integer"))
        .unwrap_or(11);
    assert!(reps > 0, "repetitions must be positive");
    let recipe: Recipe = serde_json::from_value(json!({
        "schema": "puckworks.recipe/1",
        "bean": {"preset": "medium-washed-arabica"},
        "grinder": {"preset": "generic-flat-traditional-64", "setting": 190},
        "basket": {"preset": "58-precision-18g"},
        "prep": {"dose_g": 18, "distribution": "wdt"},
        "machine": {"preset": "flat-9-bar"},
        "stop": {"beverage_g": 36}
    }))
    .expect("browser-default recipe");
    println!("case,classes,species,median_ms,min_ms,repetitions,fingerprint");
    for tier in [1, 0] {
        let mut spec = build(&recipe).expect("valid recipe").spec;
        spec.numerics.tier = tier;
        let expected = simulate_shot(black_box(&spec)).expect("valid shot");
        let mut timings = Vec::with_capacity(reps);
        for _ in 0..reps {
            let start = Instant::now();
            let result = black_box(simulate_shot(black_box(&spec)).expect("valid shot"));
            timings.push(start.elapsed().as_secs_f64() * 1e3);
            assert_eq!(result, expected, "repeated shot changed");
        }
        timings.sort_by(f64::total_cmp);
        let mut expected = expected;
        expected.core_version.clear();
        let fingerprint = format!("{expected:?}")
            .bytes()
            .fold(0xcbf29ce484222325_u64, |h, b| {
                (h ^ u64::from(b)).wrapping_mul(0x100000001b3)
            });
        println!(
            "browser-default-tier{tier},{},{},{:.4},{:.4},{reps},{fingerprint:016x}",
            spec.bed.size_classes.len(),
            spec.solubles.species.len(),
            timings[reps / 2],
            timings[0],
        );
    }
}
