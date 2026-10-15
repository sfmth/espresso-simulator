// SPDX-License-Identifier: GPL-2.0-or-later
//! End-to-end checks of the sphere kernel through the public API: the M0
//! reference case, discrete conservation, positivity, determinism, scaling
//! invariance and parameter validation. Run with `--nocapture` to see the
//! measured values.

use puckcore::{
    Grid, KernelError, Scheme, SolverOptions, SphereReleaseParams, simulate_sphere_release,
    simulate_sphere_release_with,
};

const GRIDS: [Grid; 2] = [Grid::EqualVolume, Grid::UniformRadius];
const SCHEMES: [Scheme; 3] = [Scheme::BackwardEuler, Scheme::Bdf2, Scheme::CrankNicolson];

/// The M0 reference case: a = 150 µm, D = 1e-10 m²/s, t_end = 60 s
/// (τ_end = 0.267), 64 equal-volume shells, 2000 BDF2 steps.
fn reference() -> SphereReleaseParams {
    SphereReleaseParams {
        radius_m: 150e-6,
        diffusivity_m2_s: 1e-10,
        n_shells: 64,
        t_end_s: 60.0,
        n_steps: 2000,
        grid: Grid::EqualVolume,
        scheme: Scheme::Bdf2,
    }
}

/// A case on the unit sphere, where t_end equals τ_end.
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

/// A sweep over sizes, end times, step counts, grids and schemes.
fn sweep() -> Vec<SphereReleaseParams> {
    let mut cases = Vec::new();
    for grid in GRIDS {
        for scheme in SCHEMES {
            for n_shells in [2, 7, 64, 300] {
                for tau_end in [1e-3, 0.03, 0.267, 1.0, 5.0] {
                    for n_steps in [1, 3, 50, 2000] {
                        cases.push(unit(n_shells, tau_end, n_steps, grid, scheme));
                    }
                }
            }
        }
    }
    cases
}

#[test]
fn reference_case_meets_the_accuracy_target() {
    let p = reference();
    let (r, d) = simulate_sphere_release_with(&p, &SolverOptions::DEFAULT).unwrap();
    // τ = 0.1 is t = 22.5 s, output 750.
    let at_tau_01 = r.released_fraction[750] - r.analytic_fraction[750];
    println!(
        "reference case: max abs error {:.3e}, error at tau = 0.1 {:+.2e}, mass balance {:.1e}",
        r.max_abs_error, at_tau_01, r.mass_balance_error
    );
    assert!(r.max_abs_error < 1e-3, "max abs error {}", r.max_abs_error);
    assert!(at_tau_01.abs() < 1e-5, "error at tau = 0.1: {at_tau_01}");
    assert!(r.mass_balance_error <= mass_balance_bound(&p, d.linear_solves));
}

#[test]
fn every_grid_and_scheme_tracks_the_analytic_solution() {
    for grid in GRIDS {
        for scheme in SCHEMES {
            let p = SphereReleaseParams {
                grid,
                scheme,
                ..reference()
            };
            let r = simulate_sphere_release(&p).unwrap();
            let at_tau_01 = (r.released_fraction[750] - r.analytic_fraction[750]).abs();
            println!(
                "{:>14} {:>14}: max abs error {:.3e}, |error| at tau = 0.1 {:.2e}",
                grid.as_str(),
                scheme.as_str(),
                r.max_abs_error,
                at_tau_01
            );
            // The maximum sits at the first output, where 64 uniform shells do
            // not resolve the initial boundary layer (docs/model/particle-kernel.md).
            let max_bound = match grid {
                Grid::EqualVolume => 1.5e-3,
                Grid::UniformRadius => 7e-3,
            };
            let tau_bound = match scheme {
                Scheme::BackwardEuler => 2.5e-4,
                _ => 5e-5,
            };
            assert!(r.max_abs_error < max_bound, "{grid:?} {scheme:?}");
            assert!(at_tau_01 < tau_bound, "{grid:?} {scheme:?}");
        }
    }
}

/// Bound on the mass-balance error (docs/model/particle-kernel.md §6.6).
///
/// Conservation is exact in exact arithmetic. What remains is the backward
/// error of the solves: about ε (1 + h ΣG/M0) per solve with |c| ≤ 1, where
/// ΣG/M0 grows like N². Summed over the run, that gives
/// 4 ε · solves · (1 + Δτ N²). Over 1080 runs with N = 2–5000, the measured
/// error stays below 34% of it.
fn mass_balance_bound(p: &SphereReleaseParams, linear_solves: usize) -> f64 {
    let tau_end = p.diffusivity_m2_s * p.t_end_s / (p.radius_m * p.radius_m);
    let dtau = tau_end / p.n_steps as f64;
    let n = p.n_shells as f64;
    4.0 * f64::EPSILON * linear_solves as f64 * (1.0 + dtau * n * n)
}

#[test]
fn mass_balance_is_at_round_off_for_every_grid_and_scheme() {
    let mut cases = Vec::new();
    for grid in GRIDS {
        for scheme in SCHEMES {
            cases.push(SphereReleaseParams {
                grid,
                scheme,
                ..reference()
            });
        }
    }
    cases.extend(sweep());
    // Larger grids, where the error grows with N × stiffness.
    for n_shells in [600, 2000] {
        for tau_end in [0.267, 1.0] {
            for n_steps in [3, 2000] {
                for scheme in [Scheme::BackwardEuler, Scheme::CrankNicolson] {
                    cases.push(unit(n_shells, tau_end, n_steps, Grid::EqualVolume, scheme));
                }
            }
        }
    }
    let (mut worst, mut worst_ratio): (f64, f64) = (0.0, 0.0);
    for (i, p) in cases.iter().enumerate() {
        let (r, d) = simulate_sphere_release_with(p, &SolverOptions::DEFAULT).unwrap();
        let mb = r.mass_balance_error;
        let bound = mass_balance_bound(p, d.linear_solves);
        if i < 6 {
            println!(
                "reference {:>14} {:>14}: mass balance {mb:.1e} (bound {bound:.1e})",
                p.grid.as_str(),
                p.scheme.as_str()
            );
        }
        assert!(mb <= bound, "{p:?}: {mb:e} > {bound:e}");
        worst = worst.max(mb);
        worst_ratio = worst_ratio.max(mb / bound);
    }
    println!(
        "{} runs: largest mass-balance error {worst:.1e}, at most {:.0}% of the bound",
        cases.len(),
        100.0 * worst_ratio
    );
}

#[test]
fn concentrations_stay_non_negative() {
    // Reference case: report the minimum per scheme.
    for scheme in SCHEMES {
        let p = SphereReleaseParams {
            scheme,
            ..reference()
        };
        let (_, d) = simulate_sphere_release_with(&p, &SolverOptions::DEFAULT).unwrap();
        println!(
            "reference, {:>14}: min c/c0 = {:.3e}",
            scheme.as_str(),
            d.min_concentration
        );
        assert!(d.min_concentration >= 0.0);
    }
    // Sweep (docs/model/particle-kernel.md, "Positivity").
    // - Backward Euler is positive by construction, also in floating point:
    //   Thomas elimination of an M-matrix with non-negative data never subtracts.
    // - BDF2 stays above −1e-10 whenever the step resolves the slowest decay
    //   (Δτ ≤ 0.04, i.e. π²Δτ ≤ 0.4), at any τ: its roots for the slow mode
    //   stay real and positive below π²Δτ = 1/2. Longer steps damp that mode
    //   with oscillation.
    // - Crank–Nicolson also needs τ ≤ 1. It is not L-stable, and the stiff
    //   residual of about 1e-8 c0 left after the Rannacher steps appears as
    //   small negative values once the solution has decayed below it.
    let mut worst_resolved: f64 = 1.0;
    // Smallest value seen outside the conditions, per scheme (BE never is).
    let mut worst_other = [1.0_f64; 3];
    for p in sweep() {
        let (_, d) = simulate_sphere_release_with(&p, &SolverOptions::DEFAULT).unwrap();
        let resolved = p.t_end_s / p.n_steps as f64 <= 0.04;
        let m = d.min_concentration;
        let covered = match p.scheme {
            Scheme::BackwardEuler => {
                assert!(m >= 0.0, "{p:?}: {m:e}");
                true
            }
            Scheme::Bdf2 => resolved,
            Scheme::CrankNicolson => resolved && p.t_end_s <= 1.0,
        };
        if covered {
            assert!(m >= -1e-10, "{p:?}: {m:e}");
            worst_resolved = worst_resolved.min(m);
        } else {
            let i = SCHEMES.iter().position(|&s| s == p.scheme).unwrap();
            worst_other[i] = worst_other[i].min(m);
        }
    }
    // Long BDF2 runs with resolved steps stay positive.
    for grid in GRIDS {
        for n_shells in [2, 7, 64] {
            for n_steps in [500, 2000] {
                let p = unit(n_shells, 20.0, n_steps, grid, Scheme::Bdf2);
                let (_, d) = simulate_sphere_release_with(&p, &SolverOptions::DEFAULT).unwrap();
                assert!(
                    d.min_concentration >= -1e-10,
                    "{p:?}: {:e}",
                    d.min_concentration
                );
                worst_resolved = worst_resolved.min(d.min_concentration);
            }
        }
    }
    println!("smallest c/c0 where the conditions hold (all schemes): {worst_resolved:.2e}");
    println!(
        "smallest c/c0 outside the conditions: BDF2 {:.2e}, CN {:.2e}",
        worst_other[1], worst_other[2]
    );
}

#[test]
fn reruns_are_bit_identical() {
    for scheme in SCHEMES {
        let p = SphereReleaseParams {
            scheme,
            ..reference()
        };
        let a = simulate_sphere_release(&p).unwrap();
        let b = simulate_sphere_release(&p).unwrap();
        let bits = |v: &[f64]| v.iter().map(|x| x.to_bits()).collect::<Vec<_>>();
        assert_eq!(bits(&a.released_fraction), bits(&b.released_fraction));
        assert_eq!(bits(&a.final_profile), bits(&b.final_profile));
        assert_eq!(a.max_abs_error.to_bits(), b.max_abs_error.to_bits());
        assert_eq!(
            a.mass_balance_error.to_bits(),
            b.mass_balance_error.to_bits()
        );
    }
}

#[test]
fn results_depend_only_on_the_dimensionless_time() {
    let base = reference();
    let base_r = simulate_sphere_release(&base).unwrap();
    // Power-of-two rescalings give the same τ bit for bit, so the results are
    // bit-identical too.
    let exact = [
        SphereReleaseParams {
            radius_m: base.radius_m * 2.0,
            t_end_s: base.t_end_s * 4.0,
            ..base.clone()
        },
        SphereReleaseParams {
            diffusivity_m2_s: base.diffusivity_m2_s * 8.0,
            t_end_s: base.t_end_s / 8.0,
            ..base.clone()
        },
    ];
    for p in &exact {
        let r = simulate_sphere_release(p).unwrap();
        assert_eq!(r.released_fraction, base_r.released_fraction);
        assert_eq!(r.final_profile, base_r.final_profile);
        assert_eq!(r.analytic_fraction, base_r.analytic_fraction);
    }
    // Other rescalings change τ only by rounding.
    let near = [
        SphereReleaseParams {
            radius_m: base.radius_m * 3.0,
            t_end_s: base.t_end_s * 9.0,
            ..base.clone()
        },
        SphereReleaseParams {
            diffusivity_m2_s: base.diffusivity_m2_s * 7.0,
            t_end_s: base.t_end_s / 7.0,
            ..base.clone()
        },
        unit(
            64,
            1e-10 * 60.0 / (150e-6 * 150e-6),
            2000,
            Grid::EqualVolume,
            Scheme::Bdf2,
        ),
    ];
    for p in &near {
        let r = simulate_sphere_release(p).unwrap();
        let diff = |a: &[f64], b: &[f64]| {
            a.iter()
                .zip(b)
                .map(|(x, y)| (x - y).abs())
                .fold(0.0, f64::max)
        };
        assert!(diff(&r.released_fraction, &base_r.released_fraction) < 1e-13);
        assert!(diff(&r.final_profile, &base_r.final_profile) < 1e-13);
        assert!(diff(&r.analytic_fraction, &base_r.analytic_fraction) < 1e-14);
        // Shell radii scale with the radius.
        let scale = p.radius_m / base.radius_m;
        for (x, y) in r
            .shell_outer_radii_m
            .iter()
            .zip(&base_r.shell_outer_radii_m)
        {
            assert!((x / (y * scale) - 1.0).abs() < 1e-15);
        }
    }
}

#[test]
fn outputs_have_the_documented_shape() {
    for grid in GRIDS {
        for n_steps in [1, 2, 3, 4, 5, 37] {
            let p = SphereReleaseParams {
                n_shells: 9,
                n_steps,
                t_end_s: 7.5,
                grid,
                ..reference()
            };
            let r = simulate_sphere_release(&p).unwrap();
            assert_eq!(r.t_s.len(), n_steps + 1);
            assert_eq!(r.released_fraction.len(), n_steps + 1);
            assert_eq!(r.analytic_fraction.len(), n_steps + 1);
            assert_eq!(r.t_s[0], 0.0);
            assert_eq!(r.t_s[n_steps], 7.5);
            assert!(r.t_s.windows(2).all(|w| w[1] > w[0]));
            assert_eq!(r.released_fraction[0], 0.0);
            assert_eq!(r.analytic_fraction[0], 0.0);
            assert_eq!(r.shell_outer_radii_m.len(), 9);
            assert_eq!(r.shell_outer_radii_m[8], p.radius_m);
            assert!(r.shell_outer_radii_m.windows(2).all(|w| w[1] > w[0]));
            assert_eq!(r.final_profile.len(), 9);
        }
    }
}

#[test]
fn backward_euler_release_is_monotone_and_bounded() {
    for p in sweep()
        .into_iter()
        .filter(|p| p.scheme == Scheme::BackwardEuler)
    {
        let r = simulate_sphere_release(&p).unwrap();
        // Exact arithmetic gives 0 ≤ c ≤ 1. In floating point, shells that
        // barely change pick up the same rounding every step and can drift
        // above 1 by ~n_steps·ε. The released fraction exceeds 1 by at most
        // the mass-balance error.
        assert!(
            r.released_fraction.windows(2).all(|w| w[1] >= w[0]),
            "{p:?}"
        );
        assert!(
            r.released_fraction
                .iter()
                .all(|&f| (0.0..=1.0 + 1e-12).contains(&f))
        );
        assert!(
            r.final_profile
                .iter()
                .all(|&c| (0.0..=1.0 + 1e-12).contains(&c))
        );
    }
}

#[test]
fn invalid_parameters_are_rejected() {
    let base = reference();
    let name_of = |p: SphereReleaseParams| match simulate_sphere_release(&p) {
        Err(KernelError::InvalidParameter { name, .. }) => name,
        Ok(_) => panic!("accepted {p:?}"),
    };
    for bad in [0.0, -1.0, f64::NAN, f64::INFINITY] {
        assert_eq!(
            name_of(SphereReleaseParams {
                radius_m: bad,
                ..base.clone()
            }),
            "radius_m"
        );
        assert_eq!(
            name_of(SphereReleaseParams {
                diffusivity_m2_s: bad,
                ..base.clone()
            }),
            "diffusivity_m2_s"
        );
        assert_eq!(
            name_of(SphereReleaseParams {
                t_end_s: bad,
                ..base.clone()
            }),
            "t_end_s"
        );
    }
    for bad in [0, 1, 100_001] {
        assert_eq!(
            name_of(SphereReleaseParams {
                n_shells: bad,
                ..base.clone()
            }),
            "n_shells"
        );
    }
    for bad in [0, 10_000_001] {
        assert_eq!(
            name_of(SphereReleaseParams {
                n_steps: bad,
                ..base.clone()
            }),
            "n_steps"
        );
    }
    // D t / a² overflowing to infinity.
    assert_eq!(
        name_of(SphereReleaseParams {
            diffusivity_m2_s: 1e300,
            t_end_s: 1e300,
            ..base.clone()
        }),
        "t_end_s"
    );
    // The limits themselves are accepted.
    for (n_shells, n_steps) in [(2, 1), (100_000, 1)] {
        let p = SphereReleaseParams {
            n_shells,
            n_steps,
            ..base.clone()
        };
        assert!(simulate_sphere_release(&p).is_ok());
    }
    let message = simulate_sphere_release(&SphereReleaseParams {
        n_shells: 1,
        ..base
    })
    .unwrap_err()
    .to_string();
    assert_eq!(
        message,
        "invalid parameter `n_shells`: must be between 2 and 100000"
    );
    assert!(Grid::parse("equal_volume").is_ok() && Grid::parse("Equal_Volume").is_err());
    assert!(Scheme::parse("crank_nicolson").is_ok() && Scheme::parse("rk4").is_err());
    for grid in GRIDS {
        assert_eq!(Grid::parse(grid.as_str()), Ok(grid));
    }
    for scheme in SCHEMES {
        assert_eq!(Scheme::parse(scheme.as_str()), Ok(scheme));
    }
}
