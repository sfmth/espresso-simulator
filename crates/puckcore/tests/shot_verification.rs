// SPDX-License-Identifier: GPL-2.0-or-later
//! Verification of the shot solver against closed-form limits: Darcy flow in
//! straight and tapered baskets, a pressurised orifice, the vibratory pump
//! intersection, the wetting time, the perfect-sink sphere (M0 kernel), the
//! closed-system equilibrium, discrete conservation, species consistency,
//! tier agreement and determinism. Run with `--nocapture` for the measured
//! values quoted in `docs/model/shot-model.md` §8.

use std::f64::consts::PI;

use puckcore::crank_sphere_release_fraction;
use puckcore::shot::*;

/// Water viscosity (Kestin, Sokolov & Wakeham 1978), Pa s, written
/// independently of the solver.
fn mu_water(t: f64) -> f64 {
    let d = 20.0 - t;
    let log10 = d * (1.2378 - 1.303e-3 * d + 3.06e-6 * d * d + 2.55e-8 * d * d * d) / (96.0 + t);
    1.002e-3 * 10f64.powf(log10)
}

/// Water density (Kell 1975), kg/m³.
fn rho_water(t: f64) -> f64 {
    (999.83952 + 16.945176 * t - 7.9870401e-3 * t * t - 46.170461e-6 * t.powi(3)
        + 105.56302e-9 * t.powi(4)
        - 280.54253e-12 * t.powi(5))
        / (1.0 + 16.879850e-3 * t)
}

/// A bed of insoluble grounds at constant temperature, without compaction,
/// as one column: the hydraulics reduce to Darcy's law with water.
fn plain_bed() -> ShotSpec {
    let mut s = ShotSpec::default();
    s.solubles.extractable_fraction = 0.0;
    s.hydraulics.poroelastic_pc_pa = None;
    s.thermal.initial_bed_temp_c = s.thermal.water_temp_c;
    s.thermal.heat_loss_w_k = 0.0;
    s.bed.heterogeneity.columns = 1;
    s.bed.heterogeneity.edge_area_fraction = 0.0;
    s.machine.stop = StopRule {
        time_s: Some(20.0),
        beverage_mass_kg: None,
        drip_tau_s: 0.0,
        ..StopRule::default()
    };
    s.machine.phases = vec![Phase {
        control: Control::Pressure { target_pa: 9e5 },
        ramp_s: 0.0,
        limit: None,
        exit: PhaseExit::default(),
    }];
    s.machine.pump = Pump::Ideal {
        max_flow_m3_s: 1e-4,
        max_pressure_pa: 2e6,
    };
    s
}

fn bed_volume(s: &ShotSpec) -> f64 {
    let b = &s.bed;
    b.dose_kg
        / ((1.0 - b.intergranular_porosity)
            * (1.0 - b.intraparticle_porosity)
            * b.skeletal_density_kg_m3)
}

fn last(v: &[f64]) -> f64 {
    v[v.len() - 1]
}

fn run(s: &ShotSpec) -> ShotResult {
    simulate_shot(s).expect("valid spec")
}

/// Every output number is finite and concentrations stay non-negative.
fn check_sane(r: &ShotResult) {
    let s = &r.series;
    for v in [
        &s.t_s,
        &s.pressure_pa,
        &s.flow_in_m3_s,
        &s.flow_out_m3_s,
        &s.storage_volume_m3,
        &s.cumulative_inlet_volume_m3,
        &s.cumulative_outlet_volume_m3,
        &s.cumulative_vented_volume_m3,
        &s.retained_volume_m3,
        &s.beverage_mass_kg,
        &s.tds_cup,
        &s.tds_outlet,
        &s.ey,
        &s.outlet_temp_c,
        &s.wetted_fraction,
    ] {
        assert!(v.iter().all(|x| x.is_finite()));
        assert_eq!(v.len(), s.t_s.len());
    }
    for snap in &r.spatial.snapshots {
        for row in snap.local_ey.iter().chain(&snap.liquid_conc_kg_m3) {
            assert!(row.iter().all(|x| x.is_finite()));
        }
    }
    assert!(r.summary.tds.is_finite() && r.summary.ey.is_finite());
    assert!(
        r.diagnostics.min_concentration_kg_m3 >= 0.0,
        "min concentration {}",
        r.diagnostics.min_concentration_kg_m3
    );
    assert!(s.t_s.windows(2).all(|w| w[1] > w[0]), "times increase");
}

#[test]
fn darcy_flow_matches_the_analytic_straight_basket() {
    let s = plain_bed();
    let r = run(&s);
    check_sane(&r);
    let radius = s.basket.profile_m[0][1];
    let l = r.summary.bed_height_m;
    assert!((PI * radius * radius * l / bed_volume(&s) - 1.0).abs() < 1e-14);
    let integral = l / (PI * radius * radius);
    let q_want = 9e5 * s.hydraulics.permeability_m2 / (mu_water(s.thermal.water_temp_c) * integral);
    let q = last(&r.series.flow_out_m3_s);
    let err = (q / q_want - 1.0).abs();
    println!(
        "Darcy, straight basket: Q = {q:.6e} m³/s, analytic {q_want:.6e}, rel. error {err:.2e}"
    );
    assert!(err < 1e-12, "{err}");
}

#[test]
fn darcy_flow_matches_the_analytic_frustum() {
    let mut s = plain_bed();
    let (r0, r1, h) = (0.025, 0.030, 0.025);
    s.basket.profile_m = vec![[0.0, r0], [h, r1]];
    s.basket.perforated_radius_m = 0.024;
    let r = run(&s);
    check_sane(&r);
    let l = r.summary.bed_height_m;
    let rl = r0 + (r1 - r0) * l / h;
    // The fill: π L (r0² + r0 rL + rL²)/3 = bed volume.
    let v = PI * l * (r0 * r0 + r0 * rl + rl * rl) / 3.0;
    assert!((v / bed_volume(&s) - 1.0).abs() < 1e-13);
    // ∫ dz/A = L/(π r0 rL).
    let integral = l / (PI * r0 * rl);
    let q_want = 9e5 * s.hydraulics.permeability_m2 / (mu_water(s.thermal.water_temp_c) * integral);
    let q = last(&r.series.flow_out_m3_s);
    let err = (q / q_want - 1.0).abs();
    println!("Darcy, frustum: Q = {q:.6e} m³/s, analytic {q_want:.6e}, rel. error {err:.2e}");
    assert!(err < 1e-12, "{err}");
}

#[test]
fn heterogeneous_columns_add_their_conductances() {
    let mut s = plain_bed();
    s.bed.heterogeneity = Heterogeneity {
        columns: 8,
        sigma_ln_permeability: 0.5,
        edge_area_fraction: 0.25,
        edge_multiplier: 0.6,
        prewet_nonuniformity: 0.0,
    };
    let r = run(&s);
    let cols = &r.spatial.columns;
    assert_eq!(cols.len(), 8);
    let shares: f64 = cols.iter().map(|c| c.area_fraction).sum();
    assert!((shares - 1.0).abs() < 1e-15);
    let inner: f64 = cols[..7]
        .iter()
        .map(|c| c.permeability_multiplier)
        .sum::<f64>()
        / 7.0;
    assert!((inner - 1.0).abs() < 1e-14);
    assert_eq!(cols[7].permeability_multiplier, 0.6);
    let radius = s.basket.profile_m[0][1];
    let l = r.summary.bed_height_m;
    let g = 0.75 + 0.25 * 0.6;
    let q_want = 9e5 * s.hydraulics.permeability_m2 * g
        / (mu_water(s.thermal.water_temp_c) * l / (PI * radius * radius));
    let q = last(&r.series.flow_out_m3_s);
    let err = (q / q_want - 1.0).abs();
    println!("Darcy, 8 columns: rel. error {err:.2e}");
    assert!(err < 1e-12, "{err}");
    // The fastest column drips first, before the mean column would.
    let mut one = s.clone();
    one.bed.heterogeneity.columns = 1;
    one.bed.heterogeneity.edge_area_fraction = 0.0;
    let r1 = run(&one);
    assert!(r.summary.first_drops_s.unwrap() < r1.summary.first_drops_s.unwrap());
}

#[test]
fn pressurised_orifice_in_series() {
    let mut s = plain_bed();
    let (d, cd) = (0.4e-3, 0.7);
    s.basket.outlet = Outlet::Pressurised {
        orifice_diameter_m: d,
        discharge_coefficient: cd,
    };
    let r = run(&s);
    check_sane(&r);
    let t = s.thermal.water_temp_c;
    let radius = s.basket.profile_m[0][1];
    let res = mu_water(t) * r.summary.bed_height_m
        / (PI * radius * radius)
        / s.hydraulics.permeability_m2;
    let area = PI * d * d / 4.0;
    let a = rho_water(t) / (2.0 * cd * cd * area * area);
    let p = 9e5;
    let q_want = 2.0 * p / (res + (res * res + 4.0 * a * p).sqrt());
    let q = last(&r.series.flow_out_m3_s);
    let err = (q / q_want - 1.0).abs();
    println!(
        "Pressurised orifice: Q = {q:.6e} m³/s, analytic {q_want:.6e}, rel. error {err:.2e}; orifice drop {:.2} bar",
        a * q * q / 1e5
    );
    assert!(err < 1e-12, "{err}");
}

#[test]
fn vibratory_pump_meets_the_bed_curve() {
    let mut s = plain_bed();
    s.hydraulics.permeability_m2 = 1e-14;
    s.machine.pump = Pump::Vibratory {
        free_flow_m3_s: 6e-6,
        stall_pressure_pa: 1.5e6,
        opv_pa: None,
    };
    s.machine.phases[0].control = Control::PumpFull;
    let t = s.thermal.water_temp_c;
    let radius = s.basket.profile_m[0][1];
    let r = run(&s);
    let res = mu_water(t) * r.summary.bed_height_m / (PI * radius * radius) / 1e-14;
    let q_want = 6e-6 / (1.0 + 6e-6 * res / 1.5e6);
    let q = last(&r.series.flow_out_m3_s);
    let p = last(&r.series.pressure_pa);
    let err = (q / q_want - 1.0).abs();
    println!(
        "Vibratory pump: Q = {q:.6e} m³/s at {:.4} bar; analytic {q_want:.6e}; rel. error {err:.2e}",
        p / 1e5
    );
    assert!(err < 1e-12, "{err}");
    assert!((p / (q_want * res) - 1.0).abs() < 1e-12);
    // An over-pressure valve below the intersection caps the pressure.
    s.machine.pump = Pump::Vibratory {
        free_flow_m3_s: 6e-6,
        stall_pressure_pa: 1.5e6,
        opv_pa: Some(4e5),
    };
    let r = run(&s);
    let p = last(&r.series.pressure_pa);
    let q = last(&r.series.flow_out_m3_s);
    assert_eq!(p, 4e5);
    assert!((q / (4e5 / res) - 1.0).abs() < 1e-12);
}

#[test]
fn wetting_time_is_phi_t_v_over_q() {
    let mut s = plain_bed();
    s.hydraulics.permeability_m2 = 1e-13;
    let q = 2e-6;
    s.machine.phases[0].control = Control::Flow { target_m3_s: q };
    // The 35 mL headspace alone takes 17 s at 2 mL/s.
    s.machine.stop.time_s = Some(60.0);
    let r = run(&s);
    let b = &s.bed;
    let phi_t = b.intergranular_porosity
        + (1.0 - b.intergranular_porosity) * b.intraparticle_porosity * s.hydraulics.wetting_uptake;
    let want = (r.summary.headspace_m3 + phi_t * bed_volume(&s)) / q;
    let got = r.summary.first_drops_s.unwrap();
    let err = (got / want - 1.0).abs();
    println!(
        "Wetting: first drops {got:.9} s, (V_hs + φ_T V)/Q = {want:.9} s, rel. error {err:.2e}"
    );
    assert!(err < 1e-12, "{err}");
}

#[test]
fn pressure_driven_wetting_follows_washburn() {
    // Under constant pressure a straight bed wets as z dz/dt = κP/(μ φ_T):
    // after a short flow-limited start to depth z*, t = t* + μ φ_T (L² − z*²)/(2κP).
    let mut s = plain_bed();
    let kappa = 1e-14;
    s.hydraulics.permeability_m2 = kappa;
    let q_lim = 1e-4;
    s.machine.pump = Pump::Ideal {
        max_flow_m3_s: q_lim,
        max_pressure_pa: 2e6,
    };
    s.numerics.max_dt_s = 0.01;
    s.numerics.output_interval_s = 0.01;
    let t = s.thermal.water_temp_c;
    let mu = mu_water(t);
    let b = &s.bed;
    let phi_t = b.intergranular_porosity
        + (1.0 - b.intergranular_porosity) * b.intraparticle_porosity * s.hydraulics.wetting_uptake;
    let radius = s.basket.profile_m[0][1];
    let area = PI * radius * radius;
    let r = run(&s);
    let l = r.summary.bed_height_m;
    let p = 9e5;
    let z_star = p * kappa * area / (mu * q_lim);
    let t_fill = r.summary.headspace_m3 / q_lim;
    let t1 = phi_t * area * z_star / q_lim;
    let t2 = mu * phi_t * (l * l - z_star * z_star) / (2.0 * kappa * p);
    let want = t_fill + t1 + t2;
    let got = r.summary.first_drops_s.unwrap();
    let err = (got / want - 1.0).abs();
    println!(
        "Washburn wetting: first drops {got:.5} s, analytic {want:.5} s, rel. error {err:.2e}"
    );
    assert!(err < 2e-3, "{err}");
}

/// A single class without a surface pool, flushed by a large flow and with a
/// large partition coefficient, so the kernel boundary value c/(K·ε_p) stays
/// near zero: the kernel then releases into a perfect sink and must follow
/// the M0 sphere solution (Crank) along the whole curve.
fn perfect_sink(t_end: f64, shells: usize, dt: f64) -> (f64, f64, f64) {
    let mut s = ShotSpec::default();
    let a = 100e-6;
    let d = 1e-10;
    // A thin bed (1 g) wets within the first step: every cell then releases
    // from the start (cells activate for whole steps).
    s.bed.dose_kg = 1e-3;
    s.bed.size_classes = vec![SizeClass {
        radius_m: a,
        volume_fraction: 1.0,
    }];
    s.bed.heterogeneity.columns = 1;
    s.bed.heterogeneity.edge_area_fraction = 0.0;
    s.solubles.cell_size_m = 0.0;
    s.solubles.kernel_diffusivity_m2_s = d;
    s.solubles.partition_coefficient = 100.0;
    // Solutes without volume: the large K is then admissible (the liquid's
    // water content never limits it).
    s.solubles.solute_specific_volume_m3_kg = 0.0;
    s.solubles.reference_temp_c = s.thermal.water_temp_c;
    s.thermal.initial_bed_temp_c = s.thermal.water_temp_c;
    s.thermal.heat_loss_w_k = 0.0;
    s.hydraulics.permeability_m2 = 1e-10;
    s.hydraulics.poroelastic_pc_pa = None;
    s.hydraulics.dissolution_porosity_share = Some(0.0);
    // The Crank reference has no solute source from carried pore water.
    s.hydraulics.intraparticle_water_fraction = Some(0.0);
    s.numerics.kernel_shells = shells;
    s.numerics.depth_cells = 10;
    s.numerics.max_dt_s = dt;
    s.numerics.output_interval_s = 0.5;
    // No headspace: the basket is exactly as deep as the bed.
    let radius = 0.029;
    let l = bed_volume(&s) / (PI * radius * radius);
    s.basket.profile_m = vec![[0.0, radius], [l * (1.0 + 1e-9), radius]];
    s.basket.extra_headspace_m3 = 0.0;
    let q = 1e-4;
    s.machine.pump = Pump::Ideal {
        max_flow_m3_s: q,
        max_pressure_pa: 1e7,
    };
    s.machine.phases = vec![Phase {
        control: Control::Flow { target_m3_s: q },
        ramp_s: 0.0,
        limit: None,
        exit: PhaseExit::default(),
    }];
    s.machine.stop = StopRule {
        time_s: Some(t_end),
        beverage_mass_kg: None,
        drip_tau_s: 0.0,
        ..StopRule::default()
    };
    let r = run(&s);
    check_sane(&r);
    assert!(r.diagnostics.mass_balance_error < 1e-10);
    let wet = r.summary.first_drops_s.unwrap();
    let released = r.spatial.class_ey[0].ey / s.solubles.extractable_fraction;
    let want = crank_sphere_release_fraction(t_end - 0.5 * wet, a, d);
    (released, want, d * t_end / (a * a))
}

#[test]
fn perfect_sink_limit_matches_the_sphere_release() {
    let mut worst: f64 = 0.0;
    for t_end in [1.0, 3.0, 10.0, 30.0, 60.0] {
        let (got, want, tau) = perfect_sink(t_end, 32, 0.05);
        let err = got - want;
        println!(
            "Perfect sink, 32 shells: τ = {tau:.3}: released {got:.6}, Crank {want:.6}, error {err:+.2e}"
        );
        worst = worst.max(err.abs());
    }
    assert!(worst < 2e-3, "{worst}");
    // More shells shrink the early-time error (the initial layer): the
    // released fraction converges in the shell count (the residual against
    // Crank is the wetting-time offset, common to all grids).
    let (g16, _, _) = perfect_sink(3.0, 16, 0.05);
    let (g32, _, _) = perfect_sink(3.0, 32, 0.05);
    let (g64, _, _) = perfect_sink(3.0, 64, 0.05);
    println!(
        "Perfect sink at τ = 0.03: change {:+.2e} from 16 to 32 shells, {:+.2e} from 32 to 64",
        g32 - g16,
        g64 - g32
    );
    assert!((g64 - g32).abs() < 0.5 * (g32 - g16).abs());
}

/// After the bed wets, the flow stops: the closed bed must reach the discrete
/// equilibrium c = c_pool = K·ε_c·u when uncapped. The remaining solubles are
/// shared between mobile intergranular water and total particle pools/kernels.
/// The optional kernel boundary cap is u₀ + (β/ε_c)c, including carried water's
/// solute rather than limiting the total kernel loading to u₀.
fn closed_system(partition: f64, cap: bool) -> (f64, f64, bool) {
    let mut s = ShotSpec::default();
    // Keep the analytic equilibrium below pool saturation after removing
    // the duplicated intraparticle-water capacity from the mobile liquid.
    s.solubles.extractable_fraction = 0.14;
    s.bed.heterogeneity.columns = 1;
    s.bed.heterogeneity.edge_area_fraction = 0.0;
    s.solubles.kernel_diffusivity_m2_s = 1e-8;
    s.solubles.partition_coefficient = partition;
    s.solubles.kernel_loading_cap = cap;
    s.hydraulics.axial_dispersion_m2_s = 1e-4;
    s.hydraulics.permeability_m2 = 1e-13;
    s.machine.phases = vec![
        Phase {
            control: Control::Flow { target_m3_s: 4e-6 },
            ramp_s: 0.0,
            limit: None,
            exit: PhaseExit {
                beverage_mass_kg: Some(1e-6),
                ..PhaseExit::default()
            },
        },
        Phase {
            control: Control::Flow { target_m3_s: 0.0 },
            ramp_s: 0.0,
            limit: None,
            exit: PhaseExit::default(),
        },
    ];
    s.machine.stop = StopRule {
        time_s: Some(120.0),
        beverage_mass_kg: None,
        drip_tau_s: 0.0,
        ..StopRule::default()
    };
    s.numerics.max_dt_s = 0.1;
    let r = run(&s);
    check_sane(&r);
    assert_eq!(r.summary.stop_reason, "time");
    let b = &s.bed;
    let (eps, eps_p) = (b.intergranular_porosity, b.intraparticle_porosity);
    let u_w = s.hydraulics.wetting_uptake;
    let delta = s.solubles.cell_size_m;
    // ε_c = ε_p (1 − u_w) normalizes total particle loading; it does not
    // partition particle water into mobile and immobile solute inventories.
    let eps_c = eps_p * (1.0 - u_w);
    let u0 = s.solubles.extractable_fraction * b.skeletal_density_kg_m3 * (1.0 - eps_p) / eps_c;
    let k_p = partition * eps_c;
    // Per bed volume: mobile holdup ε; pool/kernel loading weights ε_c f φ
    // and ε_c (1 − f) φ. Kernel loading is c/K_p, or the affine cap below.
    let mut liquid = eps;
    let mut kernel_pores = 0.0;
    for c in &b.size_classes {
        let f = if c.radius_m <= delta {
            1.0
        } else {
            1.0 - ((c.radius_m - delta) / c.radius_m).powi(3)
        };
        let phi = (1.0 - eps) * c.volume_fraction;
        liquid += eps_c * f * phi;
        kernel_pores += eps_c * (1.0 - f) * phi;
    }
    let total = s.solubles.extractable_fraction * b.dose_kg;
    let remaining = (total - r.summary.ey * b.dose_kg) / bed_volume(&s);
    let mut c_eq = remaining / (liquid + kernel_pores / k_p);
    let water_ratio = eps_p * s.hydraulics.intraparticle_water_fraction.unwrap_or(u_w) / eps_c;
    let capped = cap && c_eq / k_p > u0 + water_ratio * c_eq;
    if capped {
        c_eq = (remaining - kernel_pores * u0) / (liquid + kernel_pores * water_ratio);
    }
    assert!(c_eq < s.solubles.saturation_kg_m3 && c_eq < u0);
    let snap = r.spatial.snapshots.last().unwrap();
    let mut worst: f64 = 0.0;
    for &c in &snap.liquid_conc_kg_m3[0] {
        worst = worst.max((c / c_eq - 1.0).abs());
    }
    println!(
        "Closed system, K = {partition}, cap {cap}: c_eq = {c_eq:.6} kg/m³ (capped: {capped}), \
         largest cell deviation {worst:.2e}; cup took {:.3} mg",
        r.summary.ey * b.dose_kg * 1e6
    );
    (c_eq, worst, capped)
}

#[test]
fn closed_system_reaches_the_partition_equilibrium() {
    // K = 1 leaves the affine loading cap inactive at equilibrium.
    let (_, worst, capped) = closed_system(1.0, true);
    assert!(!capped && worst < 1e-9, "{worst}");
    // At the default K = 0.61, the linear equilibrium exceeds the affine
    // cap. The cap reduces kernel uptake and raises mobile concentration.
    let (c_cap, worst, capped) = closed_system(0.61, true);
    assert!(capped && worst < 1e-9, "{worst}");
    let (c_lin, worst, capped) = closed_system(0.61, false);
    assert!(!capped && worst < 1e-9, "{worst}");
    assert!(c_lin < c_cap);
}

fn with_species(mut s: ShotSpec) -> ShotSpec {
    s.solubles.species = vec![
        SpeciesSpec {
            id: "caffeine".into(),
            mass_fraction: 0.012,
            kernel_diffusivity_m2_s: 1.9e-10,
            partition_coefficient: 1.0,
            surface_fraction_scale: 1.0,
        },
        SpeciesSpec {
            id: "trigonelline".into(),
            mass_fraction: 0.008,
            kernel_diffusivity_m2_s: 2.0e-10,
            partition_coefficient: 0.8,
            surface_fraction_scale: 1.2,
        },
        SpeciesSpec {
            id: "cqa5".into(),
            mass_fraction: 0.011,
            kernel_diffusivity_m2_s: 1.0e-10,
            partition_coefficient: 0.61,
            surface_fraction_scale: 0.8,
        },
    ];
    s
}

#[test]
fn soluble_mass_is_conserved() {
    let mut cases: Vec<(&str, ShotSpec)> = vec![("default", with_species(ShotSpec::default()))];
    let mut tier0 = with_species(ShotSpec::default());
    tier0.numerics.tier = 0;
    cases.push(("tier 0", tier0));
    let mut taper = with_species(ShotSpec::default());
    taper.basket.profile_m = vec![[0.0, 0.025], [0.004, 0.027], [0.025, 0.0295]];
    taper.basket.perforated_radius_m = 0.024;
    cases.push(("stepped taper", taper));
    let mut press = with_species(ShotSpec::default());
    press.basket.outlet = Outlet::Pressurised {
        orifice_diameter_m: 0.5e-3,
        discharge_coefficient: 0.7,
    };
    cases.push(("pressurised", press));
    let mut vib = with_species(ShotSpec::default());
    vib.machine.pump = Pump::Vibratory {
        free_flow_m3_s: 6e-6,
        stall_pressure_pa: 1.5e6,
        opv_pa: Some(1.0e6),
    };
    vib.machine.phases = vec![Phase {
        control: Control::PumpFull,
        ramp_s: 0.0,
        limit: None,
        exit: PhaseExit::default(),
    }];
    cases.push(("vibratory", vib));
    let mut effects = with_species(ShotSpec::default());
    effects.hydraulics.swelling.amplitude = 0.3;
    effects.hydraulics.gas.amplitude = 0.5;
    effects.hydraulics.fines_layer.amplitude = 0.4;
    effects.bed.heterogeneity.sigma_ln_permeability = 0.6;
    effects.bed.heterogeneity.prewet_nonuniformity = 0.3;
    cases.push(("swelling, gas, fines, σ = 0.6", effects));
    for (name, s) in &cases {
        let r = run(s);
        check_sane(&r);
        println!(
            "Conservation, {name}: mass balance {:.2e}, min concentration {:.3e} kg/m³, {} steps",
            r.diagnostics.mass_balance_error,
            r.diagnostics.min_concentration_kg_m3,
            r.diagnostics.steps
        );
        assert!(r.diagnostics.mass_balance_error < 1e-10, "{name}");
        // The cup inventory agrees with the series.
        assert!((last(&r.series.ey) - r.summary.ey).abs() < 1e-15);
    }
}

#[test]
fn a_species_identical_to_the_lumped_solubles_follows_them() {
    let mut s = ShotSpec::default();
    s.solubles.species = vec![SpeciesSpec {
        id: "copy".into(),
        mass_fraction: s.solubles.extractable_fraction,
        kernel_diffusivity_m2_s: s.solubles.kernel_diffusivity_m2_s,
        partition_coefficient: s.solubles.partition_coefficient,
        surface_fraction_scale: 1.0,
    }];
    let r = run(&s);
    let lumped = r.summary.ey * s.bed.dose_kg;
    let copy = r.summary.species[0].mass_kg;
    let err = (copy / lumped - 1.0).abs();
    println!("Species copy of the lumped solubles: rel. difference {err:.2e}");
    assert!(err < 1e-10, "{err}");
    assert!(
        (r.summary.species[0].extracted_fraction - r.summary.ey / s.solubles.extractable_fraction)
            .abs()
            < 1e-10
    );
}

#[test]
fn tier_0_agrees_with_tier_1() {
    // Stated tolerance: EY, TDS and beverage mass within 4%, shot time within 5%.
    for (name, mut s) in [
        ("default", ShotSpec::default()),
        ("homogeneous", {
            let mut s = ShotSpec::default();
            s.bed.heterogeneity.sigma_ln_permeability = 0.0;
            s
        }),
        ("flow control 2 mL/s", {
            let mut s = ShotSpec::default();
            s.machine.phases[0].control = Control::Flow { target_m3_s: 2e-6 };
            s.machine.phases[0].limit = Some(1.2e6);
            s
        }),
    ] {
        let r1 = run(&s);
        s.numerics.tier = 0;
        let r0 = run(&s);
        let rel = |a: f64, b: f64| (a / b - 1.0).abs();
        let (ey, tds) = (
            rel(r0.summary.ey, r1.summary.ey),
            rel(r0.summary.tds, r1.summary.tds),
        );
        let bev = rel(r0.summary.beverage_mass_kg, r1.summary.beverage_mass_kg);
        let time = rel(r0.summary.shot_time_s, r1.summary.shot_time_s);
        println!(
            "Tier 0 vs 1, {name}: EY {:.2}% vs {:.2}%, TDS {:.2}% vs {:.2}%, time {:.2} vs {:.2} s (rel. {ey:.3}, {tds:.3}, {time:.3}; mass {bev:.3})",
            r0.summary.ey * 100.0,
            r1.summary.ey * 100.0,
            r0.summary.tds * 100.0,
            r1.summary.tds * 100.0,
            r0.summary.shot_time_s,
            r1.summary.shot_time_s,
        );
        assert!(
            ey < 0.04 && tds < 0.04 && bev < 0.04 && time < 0.05,
            "{name}"
        );
        assert_eq!(r0.diagnostics.tier, 0);
        let strata = if s.bed.heterogeneity.sigma_ln_permeability > 0.0 {
            3
        } else {
            1
        };
        assert_eq!(r0.spatial.columns.len(), strata + 1);
        assert_eq!(r0.spatial.depth_m.len(), 8);
    }
}

#[test]
fn runs_are_bit_identical() {
    let s = with_species(ShotSpec::default());
    let a = format!("{:?}", run(&s));
    let b = format!("{:?}", run(&s));
    assert_eq!(a, b);
}

#[test]
fn outputs_have_the_documented_shape() {
    let s = with_species(ShotSpec::default());
    let r = run(&s);
    check_sane(&r);
    let n = &s.numerics;
    assert_eq!(r.schema, "puckworks.shot-result/1");
    assert_eq!(r.spatial.snapshots.len(), n.snapshot_count);
    assert_eq!(r.spatial.depth_m.len(), n.depth_cells);
    assert_eq!(r.spatial.class_ey.len(), s.bed.size_classes.len());
    for snap in &r.spatial.snapshots {
        assert_eq!(snap.local_ey.len(), s.bed.heterogeneity.columns);
        assert!(snap.local_ey.iter().all(|row| row.len() == n.depth_cells));
    }
    let snaps = &r.spatial.snapshots;
    assert!(snaps.windows(2).all(|w| w[1].t_s > w[0].t_s));
    assert_eq!(snaps.last().unwrap().t_s, last(&r.series.t_s));
    assert_eq!(r.series.species_cup_kg.len(), 3);
    assert_eq!(r.summary.species.len(), 3);
    // Series at the output interval, plus the stop and the end of the drip.
    let t = &r.series.t_s;
    assert_eq!(t[0], 0.0);
    let stop = r.summary.shot_time_s;
    assert!(t.contains(&stop));
    let regular = t
        .iter()
        .filter(|&&x| ((x / n.output_interval_s).round() * n.output_interval_s - x).abs() < 1e-9)
        .count();
    assert!(regular + 2 >= t.len());
    assert!(last(t) >= stop + 7.99 * s.machine.stop.drip_tau_s);
    assert!(r.summary.drip_mass_kg > 0.0);
    assert!((r.summary.beverage_mass_kg - last(&r.series.beverage_mass_kg)).abs() < 1e-15);
    assert_eq!(r.summary.stop_reason, "beverage_mass");
    assert!(r.summary.first_drops_s.unwrap() > 0.0);
    // The cup reached the stop mass at the stop.
    let i = t.iter().position(|&x| x == stop).unwrap();
    assert!((r.series.beverage_mass_kg[i] - 0.036).abs() < 2e-7);
    // Uniformity is consistent.
    let u = &r.summary.uniformity;
    assert!(u.ey_min <= u.ey_mean && u.ey_mean <= u.ey_max && u.ey_std >= 0.0);
    assert!(u.ey_mean >= r.summary.ey);
}

#[test]
fn a_choked_bed_stops_with_choked() {
    let mut s = ShotSpec::default();
    s.hydraulics.permeability_m2 = 1e-18;
    let r = run(&s);
    check_sane(&r);
    assert_eq!(r.summary.stop_reason, "choked");
    assert!(r.summary.first_drops_s.is_none());
    assert!(!r.diagnostics.warnings.is_empty());
}

#[test]
fn time_stop_and_phase_exits() {
    let mut s = ShotSpec::default();
    // Neither the phase exit nor the ramp end lies on this output grid.
    s.numerics.output_interval_s = 0.37;
    s.machine.phases = vec![
        Phase {
            control: Control::Flow { target_m3_s: 4e-6 },
            ramp_s: 0.0,
            limit: Some(3e5),
            exit: PhaseExit {
                time_s: Some(6.0),
                ..PhaseExit::default()
            },
        },
        Phase {
            control: Control::Pressure { target_pa: 6e5 },
            ramp_s: 3.0,
            limit: Some(4e-6),
            exit: PhaseExit::default(),
        },
    ];
    s.machine.stop = StopRule {
        time_s: Some(25.0),
        beverage_mass_kg: None,
        drip_tau_s: 0.5,
        ..StopRule::default()
    };
    let r = run(&s);
    check_sane(&r);
    assert_eq!(r.summary.stop_reason, "time");
    assert_eq!(r.summary.shot_time_s, 25.0);
    // Pressure limited to 3 bar in the first phase, at most 6 bar after.
    let t = &r.series.t_s;
    assert!(t.contains(&6.0), "retain the actual phase exit");
    assert!(t.contains(&9.0), "retain the actual ramp end");
    for (i, &ti) in t.iter().enumerate() {
        let p = r.series.pressure_pa[i];
        if ti < 6.0 - 1e-9 {
            assert!(p <= 3e5 * (1.0 + 1e-12), "{ti}: {p}");
        }
        assert!(p <= 6e5 * (1.0 + 1e-12));
    }
    assert!(r.summary.max_pressure_pa > 3e5);
}
