// SPDX-License-Identifier: GPL-2.0-or-later
//! Observed convergence orders of the sphere kernel, measured at τ = 0.1, away
//! from the initial layer. Run with `--nocapture` to see the tables;
//! `docs/model/particle-kernel.md` lists finer ones, produced by
//! `cargo run --release -p puckcore --example sphere_verification`.

use puckcore::{
    Grid, Scheme, SolverOptions, SphereReleaseParams, crank_sphere_release_fraction,
    simulate_sphere_release, simulate_sphere_release_with,
};

/// The unit sphere up to τ = 0.1 (t_end equals τ_end).
fn unit(n_shells: usize, n_steps: usize, grid: Grid, scheme: Scheme) -> SphereReleaseParams {
    SphereReleaseParams {
        radius_m: 1.0,
        diffusivity_m2_s: 1.0,
        n_shells,
        t_end_s: 0.1,
        n_steps,
        grid,
        scheme,
    }
}

fn released_at_end(p: &SphereReleaseParams) -> f64 {
    simulate_sphere_release(p).unwrap().released_fraction[p.n_steps]
}

fn order(coarse: f64, fine: f64) -> f64 {
    (coarse.abs() / fine.abs()).log2()
}

#[test]
fn second_order_in_space_on_both_grids() {
    // 4000 BDF2 steps: the time error (8.2e-9 at 256 shells) is far below
    // the spatial error (3.5e-7 there).
    let exact = crank_sphere_release_fraction(0.1, 1.0, 1.0);
    for grid in [Grid::EqualVolume, Grid::UniformRadius] {
        let sizes = [16, 32, 64, 128, 256];
        let errors: Vec<f64> = sizes
            .iter()
            .map(|&n| released_at_end(&unit(n, 4000, grid, Scheme::Bdf2)) - exact)
            .collect();
        println!("space, {}:", grid.as_str());
        for (i, (&n, e)) in sizes.iter().zip(&errors).enumerate() {
            let o = if i > 0 {
                order(errors[i - 1], *e)
            } else {
                f64::NAN
            };
            println!("  N = {n:4}: error {e:+.3e}, order {o:.2}");
        }
        for w in errors.windows(2).skip(1) {
            let o = order(w[0], w[1]);
            assert!((1.8..2.2).contains(&o), "{grid:?}: order {o}");
        }
        // Second order with a small constant: 256 shells are within 3e-6.
        assert!(errors[4].abs() < 3e-6);
    }
}

#[test]
fn time_orders_match_the_schemes() {
    // 128 equal-volume shells. The reference is the same discretisation with
    // 10 240 BDF2 steps, so the differences are pure time error.
    let n_shells = 128;
    let reference = released_at_end(&unit(n_shells, 10_240, Grid::EqualVolume, Scheme::Bdf2));
    let steps = [20, 40, 80, 160, 320];
    for (scheme, expected) in [
        (Scheme::BackwardEuler, 1.0),
        (Scheme::Bdf2, 2.0),
        (Scheme::CrankNicolson, 2.0),
    ] {
        let mut errors = Vec::new();
        println!("time, {}:", scheme.as_str());
        for &n in &steps {
            let p = unit(n_shells, n, Grid::EqualVolume, scheme);
            let r = simulate_sphere_release(&p).unwrap();
            let e = r.released_fraction[n] - reference;
            let o = errors.last().map_or(f64::NAN, |&prev| order(prev, e));
            println!(
                "  {n:4} steps: error {e:+.3e}, order {o:.2}, max abs error vs analytic {:.2e}",
                r.max_abs_error
            );
            errors.push(e);
        }
        for w in errors.windows(2).skip(2) {
            let o = order(w[0], w[1]);
            assert!((o - expected).abs() < 0.15, "{scheme:?}: order {o}");
        }
    }
}

#[test]
fn start_up_refinement_resolves_the_initial_layer() {
    // Reference case with and without the start-up sub-grid.
    let p = SphereReleaseParams {
        radius_m: 150e-6,
        diffusivity_m2_s: 1e-10,
        n_shells: 64,
        t_end_s: 60.0,
        n_steps: 2000,
        grid: Grid::EqualVolume,
        scheme: Scheme::Bdf2,
    };
    let plain = SolverOptions {
        startup_substeps: 1,
        ..SolverOptions::DEFAULT
    };
    let (with, _) = simulate_sphere_release_with(&p, &SolverOptions::DEFAULT).unwrap();
    let (without, _) = simulate_sphere_release_with(&p, &plain).unwrap();
    println!(
        "max abs error: {:.3e} with start-up, {:.3e} without",
        with.max_abs_error, without.max_abs_error
    );
    // Without it, the first step alone misses about 13% of the release at t = Δt.
    assert!(without.max_abs_error > 5e-3);
    assert!(with.max_abs_error < 1e-3);
    // Away from the initial layer the two agree closely.
    let gap = (with.released_fraction[750] - without.released_fraction[750]).abs();
    assert!(gap < 1e-6, "{gap}");
}
