// SPDX-License-Identifier: GPL-2.0-or-later
//! Verification report for the particle kernel (sphere into a perfect sink).
//!
//! Prints the tables in `docs/model/particle-kernel.md`: the reference case,
//! the start-up ablation, observed convergence orders in space and time, mass
//! balance, positivity and timings.
//!
//! ```text
//! cargo run --release -p puckcore --example sphere_verification
//! ```

use std::time::Instant;

use puckcore::{
    Grid, Scheme, SolverOptions, SphereReleaseParams, crank_sphere_release_fraction,
    simulate_sphere_release_with,
};

const GRIDS: [Grid; 2] = [Grid::EqualVolume, Grid::UniformRadius];
const SCHEMES: [Scheme; 3] = [Scheme::BackwardEuler, Scheme::Bdf2, Scheme::CrankNicolson];

/// The M0 reference case: a = 150 µm, D = 1e-10 m²/s, 60 s (τ_end = 0.2667).
fn reference(grid: Grid, scheme: Scheme) -> SphereReleaseParams {
    SphereReleaseParams {
        radius_m: 150e-6,
        diffusivity_m2_s: 1e-10,
        n_shells: 64,
        t_end_s: 60.0,
        n_steps: 2000,
        grid,
        scheme,
    }
}

/// Dimensionless case on the unit sphere: t_end = τ_end.
fn unit(
    n_shells: usize,
    tau_end: f64,
    n_steps: usize,
    grid: Grid,
    scheme: Scheme,
) -> SphereReleaseParams {
    SphereReleaseParams {
        radius_m: 1.0,
        diffusivity_m2_s: 1.0,
        n_shells,
        t_end_s: tau_end,
        n_steps,
        grid,
        scheme,
    }
}

fn run(p: &SphereReleaseParams) -> (puckcore::SphereReleaseResult, puckcore::SolverDiagnostics) {
    simulate_sphere_release_with(p, &SolverOptions::DEFAULT).expect("valid parameters")
}

/// Final released fraction minus the analytic value at the end time.
fn end_error(p: &SphereReleaseParams) -> f64 {
    let (r, _) = run(p);
    r.released_fraction[p.n_steps] - crank_sphere_release_fraction(p.t_end_s, 1.0, 1.0)
}

fn order(coarse: f64, fine: f64) -> f64 {
    (coarse.abs() / fine.abs()).log2()
}

fn name(grid: Grid) -> &'static str {
    match grid {
        Grid::EqualVolume => "equal volume",
        Grid::UniformRadius => "uniform radius",
    }
}

fn scheme_name(s: Scheme) -> &'static str {
    match s {
        Scheme::BackwardEuler => "backward Euler",
        Scheme::Bdf2 => "BDF2",
        Scheme::CrankNicolson => "Crank–Nicolson",
    }
}

/// Median wall time of `reps` runs, in milliseconds.
fn time_ms(p: &SphereReleaseParams, reps: usize) -> f64 {
    let mut times: Vec<f64> = (0..reps)
        .map(|_| {
            let start = Instant::now();
            let r = run(p);
            std::hint::black_box(&r);
            start.elapsed().as_secs_f64() * 1e3
        })
        .collect();
    times.sort_by(f64::total_cmp);
    times[reps / 2]
}

fn main() {
    println!(
        "# Sphere-kernel verification (puckcore {})\n",
        puckcore::VERSION
    );

    println!(
        "## Reference case: a = 150 µm, D = 1e-10 m²/s, t_end = 60 s, 64 shells, 2000 steps\n"
    );
    println!(
        "| grid | scheme | max abs error | error at τ = 0.1 | mass balance | min c/c0 | solves |"
    );
    println!("|---|---|---|---|---|---|---|");
    for grid in GRIDS {
        for scheme in SCHEMES {
            let p = reference(grid, scheme);
            let (r, d) = run(&p);
            // τ = 0.1 is t = 22.5 s, output 750.
            let e01 = r.released_fraction[750] - r.analytic_fraction[750];
            println!(
                "| {} | {} | {:.3e} | {:+.2e} | {:.1e} | {:.3e} | {} |",
                name(grid),
                scheme_name(scheme),
                r.max_abs_error,
                e01,
                r.mass_balance_error,
                d.min_concentration,
                d.linear_solves
            );
        }
    }

    println!("\n## Start-up ablation (reference case, equal volume)\n");
    println!("| scheme | start-up | max abs error | where | error at τ = 0.1 |");
    println!("|---|---|---|---|---|");
    for scheme in SCHEMES {
        for (label, options) in [
            ("default (4 × 8 sub-steps)", SolverOptions::DEFAULT),
            (
                "none (constant steps)",
                SolverOptions {
                    startup_substeps: 1,
                    ..SolverOptions::DEFAULT
                },
            ),
        ] {
            let p = reference(Grid::EqualVolume, scheme);
            let (r, _) = simulate_sphere_release_with(&p, &options).unwrap();
            let (k, e) = r
                .released_fraction
                .iter()
                .zip(&r.analytic_fraction)
                .map(|(x, y)| (x - y).abs())
                .enumerate()
                .fold(
                    (0, 0.0),
                    |best, (k, e)| if e > best.1 { (k, e) } else { best },
                );
            let e01 = r.released_fraction[750] - r.analytic_fraction[750];
            println!(
                "| {} | {} | {:.3e} | t = {:.2} s (step {}) | {:+.2e} |",
                scheme_name(scheme),
                label,
                e,
                r.t_s[k],
                k,
                e01
            );
        }
    }

    println!("\n## Spatial convergence at τ = 0.1 (BDF2, 20 000 steps)\n");
    println!("| N | equal volume: error | order | uniform radius: error | order |");
    println!("|---|---|---|---|---|");
    let mut previous = [f64::NAN; 2];
    for n in [8, 16, 32, 64, 128, 256, 512, 1024] {
        let mut row = format!("| {n} |");
        for (i, grid) in GRIDS.into_iter().enumerate() {
            let e = end_error(&unit(n, 0.1, 20_000, grid, Scheme::Bdf2));
            let o = if previous[i].is_nan() {
                "–".to_string()
            } else {
                format!("{:.2}", order(previous[i], e))
            };
            row += &format!(" {e:+.3e} | {o} |");
            previous[i] = e;
        }
        println!("{row}");
    }

    println!("\n## Spatial convergence at τ = 0.3 (BDF2, 30 000 steps)\n");
    println!("| N | equal volume: error | order | uniform radius: error | order |");
    println!("|---|---|---|---|---|");
    let mut previous = [f64::NAN; 2];
    for n in [8, 16, 32, 64, 128, 256, 512, 1024] {
        let mut row = format!("| {n} |");
        for (i, grid) in GRIDS.into_iter().enumerate() {
            let e = end_error(&unit(n, 0.3, 30_000, grid, Scheme::Bdf2));
            let o = if previous[i].is_nan() {
                "–".to_string()
            } else {
                format!("{:.2}", order(previous[i], e))
            };
            row += &format!(" {e:+.3e} | {o} |");
            previous[i] = e;
        }
        println!("{row}");
    }

    println!("\n## Time convergence at τ = 0.1 (256 equal-volume shells)\n");
    println!("Errors against a reference with the same shells and 102 400 BDF2 steps.");
    println!("This isolates the time error. The max error column is over all outputs,");
    println!("against the analytic solution.\n");
    let n_shells = 256;
    let reference_value = {
        let p = unit(n_shells, 0.1, 102_400, Grid::EqualVolume, Scheme::Bdf2);
        run(&p).0.released_fraction[102_400]
    };
    let spatial = reference_value - crank_sphere_release_fraction(0.1, 1.0, 1.0);
    println!("Spatial error of the reference itself: {spatial:+.3e}.\n");
    println!(
        "| steps | Δτ | BE error | order | BDF2 error | order | CN error | order | max abs error BE / BDF2 / CN |"
    );
    println!("|---|---|---|---|---|---|---|---|---|");
    let mut previous = [f64::NAN; 3];
    for n_steps in [25, 50, 100, 200, 400, 800, 1600] {
        let mut row = format!("| {n_steps} | {:.2e} |", 0.1 / n_steps as f64);
        let mut maxes = Vec::new();
        for (i, scheme) in SCHEMES.into_iter().enumerate() {
            let p = unit(n_shells, 0.1, n_steps, Grid::EqualVolume, scheme);
            let (r, _) = run(&p);
            let e = r.released_fraction[n_steps] - reference_value;
            let o = if previous[i].is_nan() {
                "–".to_string()
            } else {
                format!("{:.2}", order(previous[i], e))
            };
            row += &format!(" {e:+.3e} | {o} |");
            previous[i] = e;
            maxes.push(format!("{:.2e}", r.max_abs_error));
        }
        row += &format!(" {} |", maxes.join(" / "));
        println!("{row}");
    }

    println!("\n## Mass balance (largest over the run)\n");
    println!("| case | BE | BDF2 | CN |");
    println!("|---|---|---|---|");
    let cases = [
        (
            "reference, equal volume",
            reference(Grid::EqualVolume, Scheme::Bdf2),
        ),
        (
            "reference, uniform radius",
            reference(Grid::UniformRadius, Scheme::Bdf2),
        ),
        (
            "2 shells, 1 step, τ_end = 5",
            unit(2, 5.0, 1, Grid::EqualVolume, Scheme::Bdf2),
        ),
        (
            "1000 shells, 100 000 steps, τ_end = 1",
            unit(1000, 1.0, 100_000, Grid::EqualVolume, Scheme::Bdf2),
        ),
        (
            "100 000 shells, 20 steps, τ_end = 0.1",
            unit(100_000, 0.1, 20, Grid::EqualVolume, Scheme::Bdf2),
        ),
    ];
    for (label, base) in &cases {
        let mut row = format!("| {label} |");
        for scheme in SCHEMES {
            let p = SphereReleaseParams {
                scheme,
                ..base.clone()
            };
            row += &format!(" {:.1e} |", run(&p).0.mass_balance_error);
        }
        println!("{row}");
    }

    println!("\n## Positivity: smallest c/c0 at any step\n");
    println!("| case | BE | BDF2 | CN |");
    println!("|---|---|---|---|");
    let cases = [
        (
            "reference, equal volume",
            reference(Grid::EqualVolume, Scheme::Bdf2),
        ),
        (
            "reference, uniform radius",
            reference(Grid::UniformRadius, Scheme::Bdf2),
        ),
        (
            "64 EV shells, τ_end = 0.267, 1 step",
            unit(64, 0.267, 1, Grid::EqualVolume, Scheme::Bdf2),
        ),
        (
            "64 EV shells, τ_end = 2.67, 2000 steps",
            unit(64, 2.67, 2000, Grid::EqualVolume, Scheme::Bdf2),
        ),
        (
            "256 EV shells, τ_end = 2.67, 2000 steps",
            unit(256, 2.67, 2000, Grid::EqualVolume, Scheme::Bdf2),
        ),
        (
            "64 EV shells, τ_end = 2.67, 20 steps (π²Δτ = 1.3)",
            unit(64, 2.67, 20, Grid::EqualVolume, Scheme::Bdf2),
        ),
        (
            "64 EV shells, τ_end = 2.67, 1 step",
            unit(64, 2.67, 1, Grid::EqualVolume, Scheme::Bdf2),
        ),
    ];
    for (label, base) in &cases {
        let mut row = format!("| {label} |");
        for scheme in SCHEMES {
            let p = SphereReleaseParams {
                scheme,
                ..base.clone()
            };
            row += &format!(" {:+.2e} |", run(&p).1.min_concentration);
        }
        println!("{row}");
    }

    println!("\n## Timings (release build, median wall time per call)\n");
    println!("| case | BE | BDF2 | CN |");
    println!("|---|---|---|---|");
    for (label, base, reps) in [
        (
            "64 shells × 2000 steps (reference)",
            reference(Grid::EqualVolume, Scheme::Bdf2),
            201,
        ),
        (
            "1024 shells × 20 000 steps",
            unit(1024, 0.1, 20_000, Grid::EqualVolume, Scheme::Bdf2),
            11,
        ),
    ] {
        let mut row = format!("| {label} |");
        for scheme in SCHEMES {
            let p = SphereReleaseParams {
                scheme,
                ..base.clone()
            };
            row += &format!(" {:.3} ms |", time_ms(&p, reps));
        }
        println!("{row}");
    }
}
