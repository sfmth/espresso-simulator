// SPDX-License-Identifier: GPL-2.0-or-later
//! Focused native benchmark for repeated physical shots. Build once and run
//! the executable several times on an otherwise idle machine:
//!
//! ```text
//! cargo build --release -p puckcore --example shot_benchmark
//! target/release/examples/shot_benchmark 11
//! ```
//!
//! The optional argument is the repetition count (default 11). Timings include
//! validation, model construction, complete time series and spatial outputs.
//! The result fingerprint excludes the version and guards against accidental
//! numerical changes when comparing binaries built from different revisions.

use std::hint::black_box;
use std::time::Instant;

use puckcore::shot::{ShotResult, simulate_shot};

#[path = "support/benchmark_cases.rs"]
mod cases;

fn fingerprint(result: &ShotResult) -> u64 {
    let mut result = result.clone();
    result.core_version.clear();
    // FNV-1a over the complete deterministic Debug representation. The hash
    // is a revision-comparison aid, not a stable serialized output contract.
    format!("{result:?}")
        .bytes()
        .fold(0xcbf29ce484222325, |h, b| {
            (h ^ u64::from(b)).wrapping_mul(0x100000001b3)
        })
}

fn main() {
    let reps = std::env::args()
        .nth(1)
        .map(|s| s.parse::<usize>().expect("repetitions must be an integer"))
        .unwrap_or(11);
    assert!(reps > 0, "repetitions must be positive");
    println!("case,median_ms,min_ms,repetitions,fingerprint");
    for (name, spec) in cases::workloads() {
        let expected = simulate_shot(black_box(&spec)).expect("valid benchmark shot");
        let mut timings = Vec::with_capacity(reps);
        for _ in 0..reps {
            let start = Instant::now();
            let result = black_box(simulate_shot(black_box(&spec)).expect("valid benchmark shot"));
            timings.push(start.elapsed().as_secs_f64() * 1e3);
            assert_eq!(result, expected, "repeated shot changed: {name}");
        }
        timings.sort_by(f64::total_cmp);
        println!(
            "{name},{:.4},{:.4},{reps},{:016x}",
            timings[reps / 2],
            timings[0],
            fingerprint(&expected)
        );
    }
}
