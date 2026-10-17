// SPDX-License-Identifier: GPL-2.0-or-later
//! Randomised robustness sweep: valid specs drawn over wide ranges (geometry,
//! size distribution, kinetics, hydraulics, programs, pumps, tiers) must all
//! run, with finite outputs, non-negative concentrations and the soluble
//! mass conserved. The seed is fixed, so the sweep is deterministic.
//! `PUCKWORKS_SWEEP=n` runs n cases instead of the CI-sized default, and
//! `PUCKWORKS_CASE=i` runs only case i of them (to reproduce a failure).

use puckcore::shot::*;

/// Deterministic pseudo-random numbers in [0, 1) (64-bit LCG).
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> f64 {
        self.0 = self
            .0
            .wrapping_mul(6_364_136_223_846_793_005)
            .wrapping_add(1_442_695_040_888_963_407);
        (self.0 >> 11) as f64 / (1_u64 << 53) as f64
    }
    fn range(&mut self, lo: f64, hi: f64) -> f64 {
        lo + (hi - lo) * self.next()
    }
    fn log_range(&mut self, lo: f64, hi: f64) -> f64 {
        (lo.ln() + (hi.ln() - lo.ln()) * self.next()).exp()
    }
    fn pick(&mut self, n: usize) -> usize {
        ((self.next() * n as f64) as usize).min(n - 1)
    }
}

fn random_spec(rng: &mut Lcg) -> ShotSpec {
    let mut s = ShotSpec::default();
    // Basket: straight, tapered or stepped.
    let r0 = rng.range(0.018, 0.03);
    let h = rng.range(0.018, 0.035);
    s.basket.profile_m = match rng.pick(3) {
        0 => vec![[0.0, r0], [h, r0]],
        1 => vec![[0.0, r0], [h, r0 * rng.range(1.0, 1.25)]],
        _ => vec![
            [0.0, r0],
            [0.3 * h, r0 * 1.05],
            [h, r0 * rng.range(1.05, 1.2)],
        ],
    };
    s.basket.perforated_radius_m = r0 * rng.range(0.7, 1.0);
    s.basket.open_area_fraction = if rng.next() < 0.3 {
        rng.range(0.001, 1.0)
    } else {
        1.0
    };
    if rng.next() < 0.25 {
        s.basket.outlet = Outlet::Pressurised {
            orifice_diameter_m: rng.range(0.2e-3, 1e-3),
            discharge_coefficient: rng.range(0.5, 0.9),
        };
    }
    s.basket.extra_headspace_m3 = rng.range(0.0, 10e-6);
    // Bed: dose up to what fits.
    s.bed.intergranular_porosity = rng.range(0.08, 0.4);
    s.bed.intraparticle_porosity = rng.range(0.3, 0.7);
    s.bed.skeletal_density_kg_m3 = rng.range(1250.0, 1450.0);
    let b = &s.bed;
    let per_kg = 1.0
        / ((1.0 - b.intergranular_porosity)
            * (1.0 - b.intraparticle_porosity)
            * b.skeletal_density_kg_m3);
    let basket_volume = {
        let p = &s.basket.profile_m;
        let mut v = 0.0;
        for w in p.windows(2) {
            let (ra, rb, dh) = (w[0][1], w[1][1], w[1][0] - w[0][0]);
            v += std::f64::consts::PI * dh * (ra * ra + ra * rb + rb * rb) / 3.0;
        }
        v
    };
    s.bed.dose_kg = basket_volume / per_kg * rng.range(0.2, 0.95);
    let n_classes = 1 + rng.pick(12);
    let mut classes: Vec<SizeClass> = (0..n_classes)
        .map(|_| SizeClass {
            radius_m: rng.log_range(2e-6, 600e-6),
            volume_fraction: rng.range(0.0, 1.0),
        })
        .collect();
    classes[0].volume_fraction += 0.01;
    let total: f64 = classes.iter().map(|c| c.volume_fraction).sum();
    for c in &mut classes {
        c.volume_fraction /= total;
    }
    s.bed.size_classes = classes;
    s.bed.heterogeneity = Heterogeneity {
        columns: 1 + rng.pick(10),
        sigma_ln_permeability: rng.range(0.0, 1.5),
        edge_area_fraction: if rng.next() < 0.3 {
            0.0
        } else {
            rng.range(0.05, 0.5)
        },
        edge_multiplier: rng.log_range(0.2, 3.0),
        prewet_nonuniformity: rng.range(0.0, 1.0),
    };
    // Solubles and species.
    s.solubles.extractable_fraction = rng.range(0.0, 0.4);
    s.solubles.cell_size_m = if rng.next() < 0.15 {
        0.0
    } else {
        rng.range(5e-6, 60e-6)
    };
    s.solubles.saturation_kg_m3 = rng.range(100.0, 400.0);
    s.solubles.partition_coefficient = rng.log_range(0.2, 2.0);
    s.solubles.kernel_diffusivity_m2_s = rng.log_range(1e-12, 1e-8);
    s.solubles.surface_rate_m_s = if rng.next() < 0.1 {
        0.0
    } else {
        // Up to the bound, 1 m/s: stiff pools.
        rng.log_range(1e-6, 1.0)
    };
    s.solubles.reference_temp_c = rng.range(20.0, 100.0);
    s.solubles.kernel_loading_cap = rng.next() < 0.8;
    let n_species = rng.pick(4);
    s.solubles.species = (0..n_species)
        .map(|i| SpeciesSpec {
            id: format!("s{i}"),
            mass_fraction: rng.range(0.0, 0.03),
            kernel_diffusivity_m2_s: rng.log_range(1e-12, 1e-8),
            partition_coefficient: rng.log_range(0.2, 2.0),
            surface_fraction_scale: rng.range(0.0, 3.0),
        })
        .collect();
    // Hydraulics.
    s.hydraulics.permeability_m2 = rng.log_range(1e-16, 1e-12);
    s.hydraulics.poroelastic_pc_pa = if rng.next() < 0.3 {
        None
    } else {
        Some(rng.range(3e5, 2e6))
    };
    s.hydraulics.dissolution_kozeny_carman = rng.next() < 0.8;
    s.hydraulics.swelling = Relaxation {
        amplitude: rng.range(0.0, 0.6),
        tau_s: rng.range(0.0, 40.0),
    };
    s.hydraulics.gas = Relaxation {
        amplitude: rng.range(0.0, 0.8),
        tau_s: rng.range(0.0, 10.0),
    };
    s.hydraulics.fines_layer = Relaxation {
        amplitude: rng.range(0.0, 2.0),
        tau_s: rng.range(0.0, 20.0),
    };
    s.hydraulics.axial_dispersion_m2_s = if rng.next() < 0.2 {
        0.0
    } else {
        rng.log_range(1e-9, 1e-4)
    };
    s.hydraulics.wetting_uptake = rng.range(0.0, 0.9);
    s.hydraulics.dissolution_porosity_share = if rng.next() < 0.5 {
        None
    } else {
        Some(rng.range(0.0, 1.0))
    };
    // Thermal.
    s.thermal.water_temp_c = rng.range(60.0, 100.0);
    s.thermal.initial_bed_temp_c = rng.range(20.0, 95.0);
    s.thermal.heat_capacity_j_k = rng.log_range(10.0, 1000.0);
    s.thermal.heat_loss_w_k = rng.range(0.0, 5.0);
    // Machine.
    let n_phases = 1 + rng.pick(3);
    s.machine.phases = (0..n_phases)
        .map(|_| {
            let control = match rng.pick(3) {
                0 => Control::Pressure {
                    target_pa: rng.range(0.0, 1.2e6),
                },
                1 => Control::Flow {
                    target_m3_s: rng.range(0.0, 8e-6),
                },
                _ => Control::PumpFull,
            };
            let limit = if rng.next() < 0.5 {
                Some(match control {
                    Control::Flow { .. } => rng.range(1e5, 1.2e6),
                    _ => rng.range(5e-7, 8e-6),
                })
            } else {
                None
            };
            Phase {
                control,
                ramp_s: rng.range(0.0, 5.0),
                limit,
                exit: PhaseExit {
                    time_s: if rng.next() < 0.6 {
                        Some(rng.range(1.0, 15.0))
                    } else {
                        None
                    },
                    beverage_mass_kg: if rng.next() < 0.3 {
                        Some(rng.range(0.001, 0.02))
                    } else {
                        None
                    },
                    pressure_pa: if rng.next() < 0.2 {
                        Some(rng.range(1e5, 9e5))
                    } else {
                        None
                    },
                },
            }
        })
        .collect();
    s.machine.pump = if rng.next() < 0.5 {
        Pump::Ideal {
            max_flow_m3_s: rng.range(2e-6, 1e-5),
            max_pressure_pa: rng.range(5e5, 1.5e6),
        }
    } else {
        Pump::Vibratory {
            free_flow_m3_s: rng.range(3e-6, 1e-5),
            stall_pressure_pa: rng.range(8e5, 2e6),
            opv_pa: if rng.next() < 0.5 {
                Some(rng.range(5e5, 1.2e6))
            } else {
                None
            },
        }
    };
    s.machine.stop = StopRule {
        time_s: if rng.next() < 0.5 {
            Some(rng.range(5.0, 50.0))
        } else {
            None
        },
        beverage_mass_kg: if rng.next() < 0.7 {
            Some(rng.range(0.01, 0.08))
        } else {
            None
        },
        drip_tau_s: rng.range(0.0, 3.0),
        vent_headspace: rng.next() < 0.2,
    };
    // Numerics (coarse, to keep the sweep quick).
    s.numerics.tier = if rng.next() < 0.3 { 0 } else { 1 };
    // Mostly coarse grids; one draw in eight fine (stiff pools on fine
    // grids need many regime solves per step).
    s.numerics.depth_cells = if rng.next() < 0.125 {
        100 + rng.pick(300)
    } else {
        2 + rng.pick(20)
    };
    s.numerics.kernel_shells = 2 + rng.pick(10);
    // Up to the largest step allowed.
    s.numerics.max_dt_s = rng.range(0.02, 0.5);
    s.numerics.output_interval_s = rng.range(0.05, 1.0);
    s.numerics.max_duration_s = rng.range(10.0, 60.0);
    s.numerics.snapshot_count = rng.pick(8);
    s
}

#[test]
fn random_valid_specs_run_cleanly() {
    let n: usize = std::env::var("PUCKWORKS_SWEEP")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(25);
    let mut rng = Lcg(20261014);
    let (mut worst_mass, mut worst_min) = (0.0_f64, f64::INFINITY);
    let (mut worst_solves, mut rejected) = (0_usize, 0_usize);
    let mut reasons = std::collections::BTreeMap::new();
    let only: Option<usize> = std::env::var("PUCKWORKS_CASE")
        .ok()
        .and_then(|v| v.parse().ok());
    for case in 0..n {
        let spec = random_spec(&mut rng);
        if only.is_some_and(|c| c != case) {
            continue;
        }
        let r = match simulate_shot(&spec) {
            Ok(r) => r,
            Err(e) => panic!("case {case}: {e}\n{spec:?}"),
        };
        let fail = |what: &str| panic!("case {case}: {what}\n{spec:?}");
        let ser = &r.series;
        for v in [
            &ser.pressure_pa,
            &ser.flow_in_m3_s,
            &ser.flow_out_m3_s,
            &ser.beverage_mass_kg,
            &ser.tds_cup,
            &ser.tds_outlet,
            &ser.ey,
            &ser.outlet_temp_c,
            &ser.wetted_fraction,
        ] {
            if !v.iter().all(|x| x.is_finite() && *x >= 0.0) {
                fail("a series is not finite and non-negative");
            }
        }
        if !ser.t_s.windows(2).all(|w| w[1] > w[0]) {
            fail("times do not increase");
        }
        // The liquid never exceeds the larger of saturation and the
        // kernels' equilibrium K·ε_p·u₀; with the loading cap, no cell's
        // particles hold more than they started with.
        let sol = &spec.solubles;
        let b = &spec.bed;
        let eps_p = b.intraparticle_porosity;
        let u0 = sol.extractable_fraction * b.skeletal_density_kg_m3 * (1.0 - eps_p) / eps_p;
        let c_max = sol
            .saturation_kg_m3
            .max(sol.partition_coefficient * eps_p * u0);
        for snap in &r.spatial.snapshots {
            if !snap
                .local_ey
                .iter()
                .chain(&snap.liquid_conc_kg_m3)
                .chain(&snap.wetted_fraction)
                .flatten()
                .all(|x| x.is_finite())
            {
                fail("a snapshot is not finite");
            }
            let c_top = snap
                .liquid_conc_kg_m3
                .iter()
                .flatten()
                .fold(0.0_f64, |m, &c| m.max(c));
            if c_top > c_max * (1.0 + 1e-9) {
                fail(&format!(
                    "the bed liquid exceeds saturation: {c_top} > {c_max} at {} s",
                    snap.t_s
                ));
            }
            if sol.kernel_loading_cap && snap.local_ey.iter().flatten().any(|&e| e < -1e-9) {
                fail("negative local EY with the loading cap");
            }
        }
        if !r.diagnostics.outflow_integral_error.is_finite() {
            fail("outflow integral check is not finite");
        }
        let s = &r.summary;
        if !(s.ey.is_finite() && s.tds.is_finite() && s.tds < 1.0 && s.beverage_mass_kg >= 0.0) {
            fail("summary out of range");
        }
        if s.ey > spec.solubles.extractable_fraction * (1.0 + 1e-9) + 1e-15 {
            fail("EY above the extractable fraction");
        }
        let d = &r.diagnostics;
        // Round-off grows with pool stiffness (k_s up to 1 m/s on micron
        // fines reaches about 1e-10); the solver warns above 1e-9.
        if d.mass_balance_error.is_nan() || d.mass_balance_error >= 1e-9 {
            fail(&format!("mass balance {}", d.mass_balance_error));
        }
        if d.min_concentration_kg_m3.is_nan() || d.min_concentration_kg_m3 < 0.0 {
            fail(&format!(
                "negative concentration {}",
                d.min_concentration_kg_m3
            ));
        }
        // A mass stop lands on its target (re-landed if overshot).
        if s.stop_reason == "beverage_mass" {
            let target = spec.machine.stop.beverage_mass_kg.unwrap();
            let i = ser.t_s.iter().position(|&t| t == s.shot_time_s).unwrap();
            if (ser.beverage_mass_kg[i] - target).abs() > 2e-7 {
                fail(&format!(
                    "the mass stop missed its target by {:.3e} kg",
                    ser.beverage_mass_kg[i] - target
                ));
            }
        }
        worst_solves = worst_solves.max(d.max_regime_solves);
        rejected += d.rejected_steps;
        if d.warnings.iter().any(|w| w.contains("regime iteration")) {
            fail("the regime iteration hit its limit");
        }
        worst_mass = worst_mass.max(d.mass_balance_error);
        worst_min = worst_min.min(d.min_concentration_kg_m3);
        *reasons.entry(s.stop_reason.clone()).or_insert(0) += 1;
    }
    println!(
        "{n} random specs: worst mass balance {worst_mass:.2e}, smallest concentration {worst_min:.2e}; \
         most regime solves in a step {worst_solves}, rejected steps {rejected}; stop reasons {reasons:?}"
    );
}

#[test]
fn optional_pressure_storage_stays_conservative_across_random_valid_specs() {
    let mut rng = Lcg(20261014);
    for case in 0..25 {
        let mut spec = random_spec(&mut rng);
        spec.machine.hydraulic_compliance_m3_pa = [1e-24, 1e-12, 5e-12, 2e-11, 1e-10][case % 5];
        let r = simulate_shot(&spec).unwrap_or_else(|e| panic!("case {case}: {e}\n{spec:?}"));
        assert!(
            r.diagnostics.hydraulic_volume_balance_error < 1e-10,
            "case {case}: {:?}",
            r.diagnostics
        );
        assert!(
            r.diagnostics.mass_balance_error < 1e-9,
            "case {case}: {:?}",
            r.diagnostics
        );
        assert!(r.diagnostics.min_concentration_kg_m3 >= 0.0);
        let a = &r.series;
        for i in 0..a.t_s.len() {
            assert_eq!(
                a.storage_volume_m3[i],
                spec.machine.hydraulic_compliance_m3_pa * a.pressure_pa[i]
            );
            let residual = a.cumulative_inlet_volume_m3[i]
                - a.cumulative_outlet_volume_m3[i]
                - a.cumulative_vented_volume_m3[i]
                - a.retained_volume_m3[i];
            assert!(
                residual.abs() < 1e-10 * a.cumulative_inlet_volume_m3[i].max(1e-9),
                "case {case} at {}: {residual:e}",
                a.t_s[i]
            );
        }
    }
}
