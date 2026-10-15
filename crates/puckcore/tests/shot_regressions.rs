// SPDX-License-Identifier: GPL-2.0-or-later
//! Regression tests for the independent review of the shot solver (H1–H2,
//! M1–M8, L1): each test pins the behaviour a finding asked for.

use puckcore::shot::*;

fn run(s: &ShotSpec) -> ShotResult {
    simulate_shot(s).unwrap_or_else(|e| panic!("valid spec: {e}"))
}

fn field_of(spec: &ShotSpec) -> String {
    match simulate_shot(spec) {
        Err(ShotError::InvalidSpec { field, .. }) => field,
        Err(e) => panic!("unexpected error {e}"),
        Ok(_) => panic!("expected an invalid spec"),
    }
}

/// Saturation as a mass fraction (TDS) at the brew water temperature.
fn saturation_tds(s: &ShotSpec) -> f64 {
    // Kell (1975) water density at the water temperature.
    let t = s.thermal.water_temp_c;
    let rho = (999.83952 + 16.945176 * t - 7.9870401e-3 * t * t - 46.170461e-6 * t * t * t
        + 105.56302e-9 * t.powi(4)
        - 280.54253e-12 * t.powi(5))
        / (1.0 + 16.879850e-3 * t);
    let c = s.solubles.saturation_kg_m3;
    c / (rho * (1.0 - s.solubles.solute_specific_volume_m3_kg * c) + c)
}

fn first_drop_tds(r: &ShotResult) -> f64 {
    let s = &r.series;
    let i = s.flow_out_m3_s.iter().position(|&q| q > 0.0).unwrap();
    s.tds_outlet[i]
}

fn extremes(r: &ShotResult) -> (f64, f64) {
    let snaps = &r.spatial.snapshots;
    let c_max = snaps
        .iter()
        .flat_map(|s| s.liquid_conc_kg_m3.iter().flatten())
        .fold(0.0_f64, |m, &c| m.max(c));
    let ey_min = snaps
        .iter()
        .flat_map(|s| s.local_ey.iter().flatten())
        .fold(f64::INFINITY, |m, &e| m.min(e));
    (c_max, ey_min)
}

/// H1: the wetting front no longer supersaturates. The liquid stays at or
/// below saturation, no cell's particles end up holding more than they
/// started with, and first-drop TDS and the local-EY extremes converge with
/// the grid.
#[test]
fn the_front_never_supersaturates_and_converges() {
    let mut results = Vec::new();
    for cells in [30, 120] {
        let mut s = ShotSpec::default();
        s.numerics.depth_cells = cells;
        s.numerics.snapshot_count = 200;
        let r = run(&s);
        let (c_max, ey_min) = extremes(&r);
        let sat = s.solubles.saturation_kg_m3;
        println!(
            "{cells} cells: EY {:.3}%, first-drop TDS {:.3}% (saturation {:.3}%), max c/c_sat {:.9}, min local EY {:.1e}",
            r.summary.ey * 100.0,
            first_drop_tds(&r) * 100.0,
            saturation_tds(&s) * 100.0,
            c_max / sat,
            ey_min
        );
        assert!(c_max <= sat * (1.0 + 1e-9), "{c_max}");
        assert!(ey_min >= -1e-12, "{ey_min}");
        assert!(first_drop_tds(&r) <= saturation_tds(&s) * (1.0 + 1e-6));
        results.push(r);
    }
    // Coarse steps: the front crosses several faces, and the floor, within
    // one step (each face carries flow only after the front passed it).
    for (cells, dt) in [(4, 0.5), (8, 0.5), (19, 0.21)] {
        let mut s = ShotSpec::default();
        s.numerics.depth_cells = cells;
        s.numerics.max_dt_s = dt;
        s.numerics.output_interval_s = dt;
        s.numerics.snapshot_count = 100;
        s.hydraulics.dissolution_porosity_share = Some(0.6);
        let r = run(&s);
        let (c_max, ey_min) = extremes(&r);
        assert!(
            c_max <= s.solubles.saturation_kg_m3 * (1.0 + 1e-9),
            "{cells}, {dt}: {c_max}"
        );
        assert!(ey_min >= -1e-12);
    }
    let (a, b) = (&results[0], &results[1]);
    assert!((a.summary.ey / b.summary.ey - 1.0).abs() < 2e-3);
    assert!((first_drop_tds(a) / first_drop_tds(b) - 1.0).abs() < 1e-4);
    let (ua, ub) = (&a.summary.uniformity, &b.summary.uniformity);
    assert!((ua.ey_min - ub.ey_min).abs() < 1e-3 && (ua.ey_max - ub.ey_max).abs() < 1e-3);
}

/// H2: inputs that used to crash or return garbage are rejected, naming the
/// field; the extremes the bounds allow run cleanly.
#[test]
fn implausible_inputs_are_rejected_and_extremes_run() {
    type Mutator = fn(&mut ShotSpec);
    let rejected: Vec<(&str, Mutator)> = vec![
        ("bed.dose_kg", |s| s.bed.dose_kg = 1e-13),
        ("hydraulics.axial_dispersion_m2_s", |s| {
            s.hydraulics.axial_dispersion_m2_s = 1e50
        }),
        ("hydraulics.fines_layer.amplitude", |s| {
            s.hydraulics.fines_layer.amplitude = 1e300
        }),
        ("solubles.surface_rate_m_s", |s| {
            s.solubles.surface_rate_m_s = 1e8
        }),
        ("bed.size_classes[1].radius_m", |s| {
            s.bed.size_classes[1].radius_m = 1e-15
        }),
        ("solubles.species[0].kernel_diffusivity_m2_s", |s| {
            s.solubles.species = vec![SpeciesSpec {
                id: "x".into(),
                kernel_diffusivity_m2_s: 1e300,
                ..SpeciesSpec::default()
            }]
        }),
        ("numerics.depth_cells", |s| {
            s.bed.heterogeneity.columns = 64;
            s.numerics.depth_cells = 1000;
            s.numerics.kernel_shells = 64;
            s.bed.size_classes = (0..200)
                .map(|i| SizeClass {
                    radius_m: 1e-5 + 1e-6 * i as f64,
                    volume_fraction: 1.0 / 200.0,
                })
                .collect();
        }),
        ("numerics.max_dt_s", |s| {
            s.numerics.max_dt_s = 100.0;
            s.numerics.output_interval_s = 100.0;
        }),
        ("machine.stop.drip_tau_s", |s| {
            s.machine.stop.drip_tau_s = 600.0
        }),
        // The step guard counts the 8τ drip.
        ("numerics.max_dt_s", |s| {
            s.machine.stop.drip_tau_s = 60.0;
            s.numerics.max_dt_s = 1e-3;
            s.numerics.output_interval_s = 1.0;
            s.numerics.max_duration_s = 1600.0;
        }),
    ];
    for (want, mutate) in rejected {
        let mut s = ShotSpec::default();
        mutate(&mut s);
        assert_eq!(field_of(&s), want);
    }
    // Stiff corners at the bounds: conservation stays near round-off and no
    // regime iteration hits its limit.
    type Corner = (&'static str, fn(&mut ShotSpec));
    let corners: Vec<Corner> = vec![
        ("k_s 1 m/s, fines 0.1 µm", |s| {
            s.solubles.surface_rate_m_s = 1.0;
            s.bed.size_classes[0].radius_m = 1e-7;
        }),
        ("D_ax 1e-3", |s| s.hydraulics.axial_dispersion_m2_s = 1e-3),
        ("D 1e-7, K 0.01", |s| {
            s.solubles.kernel_diffusivity_m2_s = 1e-7;
            s.solubles.partition_coefficient = 0.01;
        }),
        ("dose 1 g", |s| s.bed.dose_kg = 1e-3),
    ];
    for (name, mutate) in corners {
        let mut s = ShotSpec::default();
        mutate(&mut s);
        let r = run(&s);
        println!(
            "{name}: mass balance {:.1e}, min concentration {:.2e}",
            r.diagnostics.mass_balance_error, r.diagnostics.min_concentration_kg_m3
        );
        assert!(r.diagnostics.mass_balance_error < 1e-9, "{name}");
        assert!(r.diagnostics.min_concentration_kg_m3 >= 0.0, "{name}");
        assert!(
            r.diagnostics.warnings.is_empty(),
            "{name}: {:?}",
            r.diagnostics.warnings
        );
    }
}

/// M1: the drip drains the headspace water and no more; a venting machine
/// does not drip.
#[test]
fn the_drip_is_limited_to_the_headspace_water() {
    let mut s = ShotSpec::default();
    let b = &s.bed;
    let v = b.dose_kg
        / ((1.0 - b.intergranular_porosity)
            * (1.0 - b.intraparticle_porosity)
            * b.skeletal_density_kg_m3);
    let r0 = 0.029;
    let area = std::f64::consts::PI * r0 * r0;
    s.basket.extra_headspace_m3 = 0.0;
    s.basket.profile_m = vec![[0.0, r0], [(v + 1.06e-6) / area, r0]];
    let r = run(&s);
    // At most the headspace water (1 kg/L, plus its solute).
    let budget = r.summary.headspace_m3 * 1000.0 * 1.1;
    assert!(
        r.summary.drip_mass_kg <= budget,
        "{}",
        r.summary.drip_mass_kg
    );
    for tau in [10.0, 60.0] {
        let mut s = ShotSpec::default();
        s.machine.stop.drip_tau_s = tau;
        let r = run(&s);
        assert!(r.summary.drip_mass_kg <= r.summary.headspace_m3 * 1000.0 * 1.1);
        assert!(r.summary.drip_mass_kg > 0.5 * r.summary.headspace_m3 * 1000.0);
    }
    let mut s = ShotSpec::default();
    s.machine.stop.vent_headspace = true;
    let r = run(&s);
    assert_eq!(r.summary.drip_mass_kg, 0.0);
    assert!((r.summary.beverage_mass_kg - 0.036).abs() < 2e-7);
}

/// M4: conditional-mean strata converge in the column count, and a spread
/// that cannot be represented is reported.
#[test]
fn strata_converge_and_an_unrepresented_spread_warns() {
    let ey = |cols: usize| {
        let mut s = ShotSpec::default();
        s.bed.heterogeneity.sigma_ln_permeability = 0.7;
        s.bed.heterogeneity.columns = cols;
        run(&s)
    };
    let (e8, e64) = (ey(8).summary.ey, ey(64).summary.ey);
    assert!((e8 / e64 - 1.0).abs() < 5e-3, "{e8} {e64}");
    let r2 = ey(2);
    assert!(
        r2.diagnostics
            .warnings
            .iter()
            .any(|w| w.contains("permeability spread")),
        "{:?}",
        r2.diagnostics.warnings
    );
    assert!(ey(3).diagnostics.warnings.is_empty());
}

/// M5: positivity holds where BDF2 or the old c′ band failed: a tiny
/// partition coefficient (kernels absorbing under BDF2) and stiff pools.
#[test]
fn positivity_holds_for_absorbing_kernels_and_stiff_pools() {
    for mutate in [
        (|s: &mut ShotSpec| s.solubles.partition_coefficient = 0.01) as fn(&mut ShotSpec),
        |s: &mut ShotSpec| s.solubles.surface_rate_m_s = 1.0,
        |s: &mut ShotSpec| {
            s.solubles.partition_coefficient = 0.01;
            s.solubles.kernel_loading_cap = false;
        },
    ] {
        let mut s = ShotSpec::default();
        mutate(&mut s);
        let r = run(&s);
        assert!(
            r.diagnostics.min_concentration_kg_m3 >= 0.0,
            "{}",
            r.diagnostics.min_concentration_kg_m3
        );
        assert!(r.diagnostics.mass_balance_error < 1e-10);
    }
}

/// M6: with the largest step allowed the mass stop still lands on its target
/// (the step lands on each column's breakthrough).
#[test]
fn mass_events_land_with_the_largest_step() {
    let mut s = ShotSpec::default();
    s.numerics.max_dt_s = 0.5;
    s.numerics.output_interval_s = 0.5;
    let r = run(&s);
    let i = r
        .series
        .t_s
        .iter()
        .position(|&t| t == r.summary.shot_time_s)
        .unwrap();
    assert!((r.series.beverage_mass_kg[i] - 0.036).abs() < 2e-7);
    assert_eq!(r.summary.stop_reason, "beverage_mass");
}

/// M7: K is per particle envelope volume; with the loading cap kernels never
/// end above their initial content, without it they re-absorb and a warning
/// says so. Conservation holds either way.
#[test]
fn the_kernel_loading_cap_is_switchable() {
    let capped = run(&ShotSpec::default());
    let mut s = ShotSpec::default();
    s.solubles.kernel_loading_cap = false;
    let linear = run(&s);
    assert!(extremes(&capped).1 >= -1e-12);
    assert!(capped.diagnostics.warnings.is_empty());
    assert!(
        linear
            .diagnostics
            .warnings
            .iter()
            .any(|w| w.contains("kernel_loading_cap")),
        "{:?}",
        linear.diagnostics.warnings
    );
    assert!(linear.summary.ey < capped.summary.ey);
    for r in [&capped, &linear] {
        assert!(r.diagnostics.mass_balance_error < 1e-12);
    }
}

/// M8: species with identical transport parameters are solved once and
/// scaled; the result equals solving each alone.
#[test]
fn species_groups_equal_separate_solves() {
    let sp = |id: &str, w: f64| SpeciesSpec {
        id: id.into(),
        mass_fraction: w,
        kernel_diffusivity_m2_s: 1.9e-10,
        partition_coefficient: 1.0,
        surface_fraction_scale: 1.0,
    };
    let mut both = ShotSpec::default();
    both.solubles.species = vec![sp("a", 0.012), sp("b", 0.004)];
    let rb = run(&both);
    let mut alone = ShotSpec::default();
    alone.solubles.species = vec![sp("b", 0.004)];
    let ra = run(&alone);
    assert_eq!(
        rb.summary.species[1].extracted_fraction,
        ra.summary.species[0].extracted_fraction
    );
    assert_eq!(rb.summary.species[1].mass_kg, ra.summary.species[0].mass_kg);
    let ratio = rb.summary.species[0].mass_kg / rb.summary.species[1].mass_kg;
    assert!((ratio - 3.0).abs() < 1e-12, "{ratio}");
}

/// L1: a slow soak is not a choke: stalls are judged against the flow the
/// program asks for.
#[test]
fn a_slow_soak_is_not_a_choke() {
    let mut s = ShotSpec::default();
    s.machine.phases = vec![
        Phase {
            control: Control::Flow { target_m3_s: 5e-9 },
            ramp_s: 0.0,
            limit: Some(1.2e6),
            exit: PhaseExit {
                time_s: Some(15.0),
                ..PhaseExit::default()
            },
        },
        Phase::default(),
    ];
    let r = run(&s);
    assert_eq!(r.summary.stop_reason, "beverage_mass");
}

/// The independent outlet check: the cup's solute agrees with ∫ q·c dt to
/// first order in the step.
#[test]
fn the_cup_agrees_with_the_outlet_integral() {
    let err = |dt: f64| {
        let mut s = ShotSpec::default();
        s.numerics.max_dt_s = dt;
        run(&s).diagnostics.outflow_integral_error
    };
    let (coarse, fine) = (err(0.05), err(0.0125));
    println!("outflow integral check: {coarse:.2e} at 0.05 s, {fine:.2e} at 0.0125 s");
    assert!(coarse < 1e-2 && fine < 0.5 * coarse);
}

/// Web fields: depth edges and the wetted share of each cell.
#[test]
fn spatial_fields_for_the_web() {
    let mut s = ShotSpec::default();
    s.numerics.snapshot_count = 40;
    let r = run(&s);
    let edges = &r.spatial.depth_edges_m;
    assert_eq!(edges.len(), s.numerics.depth_cells + 1);
    assert_eq!(edges[0], 0.0);
    assert!((edges[edges.len() - 1] - r.summary.bed_height_m).abs() < 1e-15);
    for (c, w) in r.spatial.depth_m.iter().zip(edges.windows(2)) {
        assert!(w[0] < *c && *c < w[1]);
    }
    let mut partial = false;
    for snap in &r.spatial.snapshots {
        assert_eq!(snap.wetted_fraction.len(), r.spatial.columns.len());
        for row in &snap.wetted_fraction {
            assert_eq!(row.len(), s.numerics.depth_cells);
            assert!(row.iter().all(|&w| (0.0..=1.0).contains(&w)));
            // Wet from the top down.
            assert!(row.windows(2).all(|w| w[1] <= w[0]));
            partial |= row.iter().any(|&w| w > 0.0 && w < 1.0);
        }
    }
    assert!(partial, "no snapshot caught the front inside a cell");
    let last = r.spatial.snapshots.last().unwrap();
    assert!(last.wetted_fraction.iter().flatten().all(|&w| w == 1.0));
}

/// θ: null means 0, exactly as an explicit 0.
#[test]
fn null_porosity_share_means_zero() {
    let mut zero = ShotSpec::default();
    zero.hydraulics.dissolution_porosity_share = Some(0.0);
    assert_eq!(
        ShotSpec::default().hydraulics.dissolution_porosity_share,
        None
    );
    assert_eq!(
        format!("{:?}", run(&ShotSpec::default())),
        format!("{:?}", run(&zero))
    );
}

/// The builders' check reports exactly what the solver does.
#[test]
fn validate_shot_spec_matches_the_solver() {
    let mut s = ShotSpec::default();
    s.solubles.kernel_loading_cap = false;
    let warnings = validate_shot_spec(&s).unwrap();
    let r = run(&s);
    assert!(warnings.iter().all(|w| r.diagnostics.warnings.contains(w)));
    s.bed.dose_kg = 1e-13;
    assert!(matches!(
        validate_shot_spec(&s),
        Err(ShotError::InvalidSpec { .. })
    ));
}

// ----- Second review (verification of the fix batch) ---------------------------------

/// H: stiff pools on fine grids with coarse steps used to exhaust the regime
/// iteration and fail on a negative concentration. The solve limit now grows
/// with the cells, unconverged choices are never accepted (the step is
/// retried shorter), and the review's repros run cleanly.
#[test]
fn stiff_fine_coarse_specs_converge() {
    type Mutator = fn(&mut ShotSpec);
    let cases: Vec<(&str, Mutator)> = vec![
        ("k_s 1, D_ax 0, 1000 cells, Δt 0.5", |s| {
            s.solubles.surface_rate_m_s = 1.0;
            s.hydraulics.axial_dispersion_m2_s = 0.0;
            s.numerics.depth_cells = 1000;
        }),
        ("K 1, k_s 1, 1000 cells, Δt 0.5", |s| {
            s.solubles.partition_coefficient = 1.0;
            s.solubles.surface_rate_m_s = 1.0;
            s.numerics.depth_cells = 1000;
        }),
        ("K 1.471, k_s 0.1, D_ax 0, 300 cells, Δt 0.5", |s| {
            s.solubles.partition_coefficient = 1.471;
            s.solubles.surface_rate_m_s = 0.1;
            s.hydraulics.axial_dispersion_m2_s = 0.0;
            s.numerics.depth_cells = 300;
        }),
        ("one column, k_s 1, D_ax 0, 1000 cells, Δt 0.5", |s| {
            s.bed.heterogeneity.columns = 1;
            s.solubles.surface_rate_m_s = 1.0;
            s.hydraulics.axial_dispersion_m2_s = 0.0;
            s.numerics.depth_cells = 1000;
        }),
    ];
    for (name, mutate) in cases {
        let mut s = ShotSpec::default();
        s.numerics.max_dt_s = 0.5;
        s.numerics.output_interval_s = 0.5;
        s.numerics.snapshot_count = 4;
        mutate(&mut s);
        let r = run(&s);
        let d = &r.diagnostics;
        println!(
            "{name}: EY {:.2}%, mass balance {:.1e}, most regime solves in a step {}, rejected steps {}",
            r.summary.ey * 100.0,
            d.mass_balance_error,
            d.max_regime_solves,
            d.rejected_steps
        );
        assert!(d.mass_balance_error < 1e-9, "{name}");
        assert!(d.min_concentration_kg_m3 >= 0.0, "{name}");
        assert!(d.max_regime_solves >= 1);
    }
}

/// M-a: kernels whose equilibrium K·s₀ lies above saturation hold the
/// liquid above c_sat (warned, bounded by K·s₀, with the front cell's
/// particles exchanging only in proportion to its wetted share); a K that
/// would leave the liquid almost without water is rejected.
#[test]
fn kernels_above_saturation_are_bounded_and_reported() {
    let mut s = ShotSpec::default();
    s.solubles.partition_coefficient = 3.0;
    s.numerics.snapshot_count = 100;
    let r = run(&s);
    let b = &s.bed;
    let s0 = s.solubles.extractable_fraction
        * b.skeletal_density_kg_m3
        * (1.0 - b.intraparticle_porosity);
    let (c_max, _) = extremes(&r);
    assert!(c_max <= 3.0 * s0 * (1.0 + 1e-9), "{c_max}");
    assert!(c_max > s.solubles.saturation_kg_m3);
    // The front cell no longer concentrates the whole cell's release in its
    // wetted sliver (395 kg/m³ before).
    assert!(c_max < 300.0, "{c_max}");
    assert!(
        r.diagnostics
            .warnings
            .iter()
            .any(|w| w.contains("above c_sat")),
        "{:?}",
        r.diagnostics.warnings
    );
    s.solubles.partition_coefficient = 100.0;
    assert_eq!(field_of(&s), "solubles.partition_coefficient");
    // Without solute volume the water content never limits K.
    s.solubles.solute_specific_volume_m3_kg = 0.0;
    s.numerics.depth_cells = 10;
    assert!(simulate_shot(&s).is_ok());
}

/// M-b: mobile, pool and kernel liquid fill the total porosity, so the
/// results barely depend on the unconstrained wetting uptake, which now sets
/// mainly the wetting time; the H1 guarantees hold at every uptake.
#[test]
fn the_wetting_uptake_moves_little_but_the_wetting_time() {
    let mut eys = Vec::new();
    let mut drops = Vec::new();
    for u_w in [0.0, 0.5, 0.9] {
        let mut s = ShotSpec::default();
        s.hydraulics.wetting_uptake = u_w;
        s.numerics.snapshot_count = 100;
        let r = run(&s);
        let (c_max, ey_min) = extremes(&r);
        assert!(c_max <= s.solubles.saturation_kg_m3 * (1.0 + 1e-9));
        assert!(ey_min >= -1e-12);
        assert!(first_drop_tds(&r) <= saturation_tds(&s) * (1.0 + 1e-6));
        eys.push(r.summary.ey);
        drops.push(r.summary.first_drops_s.unwrap());
    }
    println!("uptake 0 / 0.5 / 0.9: EY {eys:?}, first drops {drops:?}");
    let spread = (eys[2] - eys[0]).abs() / eys[1];
    assert!(spread < 0.02, "{spread}");
    assert!(drops[0] < drops[1] && drops[1] < drops[2]);
    let mut s = ShotSpec::default();
    s.hydraulics.wetting_uptake = 0.95;
    assert_eq!(field_of(&s), "hydraulics.wetting_uptake");
}

/// M-c: the total work (steps × model size) is bounded, and large runs warn.
#[test]
fn the_total_work_is_bounded() {
    let mut s = ShotSpec::default();
    s.bed.heterogeneity.columns = 64;
    s.numerics.depth_cells = 600;
    s.numerics.kernel_shells = 16;
    s.bed.size_classes = (0..10)
        .map(|i| SizeClass {
            radius_m: 2e-5 + 3e-5 * i as f64,
            volume_fraction: 0.1,
        })
        .collect();
    s.numerics.max_duration_s = 3600.0;
    s.numerics.max_dt_s = 0.05;
    s.numerics.snapshot_count = 2;
    assert_eq!(field_of(&s), "numerics.max_duration_s");
    s.numerics.max_duration_s = 60.0;
    s.numerics.depth_cells = 100;
    let warnings = validate_shot_spec(&s).unwrap();
    assert!(
        warnings.iter().any(|w| w.contains("large run")),
        "{warnings:?}"
    );
    assert!(validate_shot_spec(&ShotSpec::default()).unwrap().is_empty());
}
