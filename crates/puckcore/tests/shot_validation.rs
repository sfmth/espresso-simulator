// SPDX-License-Identifier: GPL-2.0-or-later
//! Spec validation: every invalid input is rejected with an error naming the
//! field by its dotted path; edge cases that are valid run.

use puckcore::shot::*;

fn field_of(spec: &ShotSpec) -> Option<String> {
    match simulate_shot(spec) {
        Err(ShotError::InvalidSpec { field, .. }) => Some(field),
        Err(e) => panic!("unexpected error {e}"),
        Ok(_) => None,
    }
}

type Mutator = fn(&mut ShotSpec);

#[test]
fn invalid_fields_are_named() {
    let cases: Vec<(&str, Mutator)> = vec![
        ("schema", |s| s.schema = "puckworks.shot-spec/0".into()),
        ("basket.profile_m", |s| s.basket.profile_m.truncate(1)),
        ("basket.profile_m[0]", |s| s.basket.profile_m[0][0] = 0.001),
        ("basket.profile_m[0]", |s| {
            s.basket.profile_m[0][1] = f64::NAN
        }),
        ("basket.profile_m[1]", |s| s.basket.profile_m[1][1] = 0.0),
        ("basket.profile_m[1]", |s| {
            s.basket.profile_m = vec![[0.0, 0.029], [0.0, 0.029], [0.025, 0.029]]
        }),
        ("basket.perforated_radius_m", |s| {
            s.basket.perforated_radius_m = 0.03
        }),
        ("basket.perforated_radius_m", |s| {
            s.basket.perforated_radius_m = 0.0
        }),
        ("basket.open_area_fraction", |s| {
            s.basket.open_area_fraction = 0.0
        }),
        ("basket.open_area_fraction", |s| {
            s.basket.open_area_fraction = 1.5
        }),
        ("basket.outlet.orifice_diameter_m", |s| {
            s.basket.outlet = Outlet::Pressurised {
                orifice_diameter_m: 0.0,
                discharge_coefficient: 0.7,
            }
        }),
        ("basket.outlet.discharge_coefficient", |s| {
            s.basket.outlet = Outlet::Pressurised {
                orifice_diameter_m: 4e-4,
                discharge_coefficient: 1.5,
            }
        }),
        ("basket.extra_headspace_m3", |s| {
            s.basket.extra_headspace_m3 = -1e-6
        }),
        ("bed.dose_kg", |s| s.bed.dose_kg = 0.0),
        ("bed.dose_kg", |s| s.bed.dose_kg = f64::NAN),
        ("bed.dose_kg", |s| s.bed.dose_kg = 0.05),
        ("bed.intergranular_porosity", |s| {
            s.bed.intergranular_porosity = 1.0
        }),
        ("bed.intraparticle_porosity", |s| {
            s.bed.intraparticle_porosity = 0.0
        }),
        ("bed.skeletal_density_kg_m3", |s| {
            s.bed.skeletal_density_kg_m3 = f64::INFINITY
        }),
        ("bed.size_classes", |s| s.bed.size_classes.clear()),
        ("bed.size_classes[1].radius_m", |s| {
            s.bed.size_classes[1].radius_m = 0.0
        }),
        ("bed.size_classes[0].volume_fraction", |s| {
            s.bed.size_classes[0].volume_fraction = -0.1
        }),
        ("bed.size_classes", |s| {
            s.bed.size_classes[1].volume_fraction = 0.2
        }),
        ("bed.heterogeneity.columns", |s| {
            s.bed.heterogeneity.columns = 0
        }),
        ("bed.heterogeneity.columns", |s| {
            s.bed.heterogeneity.columns = 65
        }),
        ("bed.heterogeneity.sigma_ln_permeability", |s| {
            s.bed.heterogeneity.sigma_ln_permeability = -0.1
        }),
        ("bed.heterogeneity.edge_area_fraction", |s| {
            s.bed.heterogeneity.edge_area_fraction = 1.0
        }),
        ("bed.heterogeneity.edge_multiplier", |s| {
            s.bed.heterogeneity.edge_multiplier = 0.0
        }),
        ("bed.heterogeneity.prewet_nonuniformity", |s| {
            s.bed.heterogeneity.prewet_nonuniformity = 2.0
        }),
        ("solubles.extractable_fraction", |s| {
            s.solubles.extractable_fraction = 1.0
        }),
        ("solubles.cell_size_m", |s| s.solubles.cell_size_m = -1e-6),
        ("solubles.saturation_kg_m3", |s| {
            s.solubles.saturation_kg_m3 = 0.0
        }),
        ("solubles.partition_coefficient", |s| {
            s.solubles.partition_coefficient = 0.0
        }),
        ("solubles.kernel_diffusivity_m2_s", |s| {
            s.solubles.kernel_diffusivity_m2_s = 0.0
        }),
        ("solubles.surface_rate_m_s", |s| {
            s.solubles.surface_rate_m_s = f64::NAN
        }),
        ("solubles.reference_temp_c", |s| {
            s.solubles.reference_temp_c = 200.0
        }),
        ("solubles.solute_specific_volume_m3_kg", |s| {
            s.solubles.solute_specific_volume_m3_kg = 0.01
        }),
        ("solubles.species[0].id", |s| {
            s.solubles.species = vec![SpeciesSpec::default()];
        }),
        ("solubles.species[1].id", |s| {
            let sp = SpeciesSpec {
                id: "caffeine".into(),
                mass_fraction: 0.01,
                ..SpeciesSpec::default()
            };
            s.solubles.species = vec![sp.clone(), sp];
        }),
        ("solubles.species[0].kernel_diffusivity_m2_s", |s| {
            s.solubles.species = vec![SpeciesSpec {
                id: "x".into(),
                kernel_diffusivity_m2_s: -1.0,
                ..SpeciesSpec::default()
            }];
        }),
        ("hydraulics.permeability_m2", |s| {
            s.hydraulics.permeability_m2 = 0.0
        }),
        ("hydraulics.poroelastic_pc_pa", |s| {
            s.hydraulics.poroelastic_pc_pa = Some(0.0)
        }),
        ("hydraulics.swelling.amplitude", |s| {
            s.hydraulics.swelling.amplitude = 1.0
        }),
        ("hydraulics.gas.tau_s", |s| s.hydraulics.gas.tau_s = -1.0),
        ("hydraulics.fines_layer.amplitude", |s| {
            s.hydraulics.fines_layer.amplitude = -0.5
        }),
        ("hydraulics.axial_dispersion_m2_s", |s| {
            s.hydraulics.axial_dispersion_m2_s = -1.0
        }),
        ("hydraulics.viscosity.temperature_exponent", |s| {
            s.hydraulics.viscosity.temperature_exponent = 2.0
        }),
        ("hydraulics.wetting_uptake", |s| {
            s.hydraulics.wetting_uptake = 1.5
        }),
        ("hydraulics.dissolution_porosity_share", |s| {
            s.hydraulics.dissolution_porosity_share = Some(1.5)
        }),
        ("thermal.water_temp_c", |s| s.thermal.water_temp_c = 160.0),
        ("thermal.initial_bed_temp_c", |s| {
            s.thermal.initial_bed_temp_c = -5.0
        }),
        ("thermal.ambient_temp_c", |s| {
            s.thermal.ambient_temp_c = f64::NAN
        }),
        ("thermal.heat_capacity_j_k", |s| {
            s.thermal.heat_capacity_j_k = 0.0
        }),
        ("thermal.heat_loss_w_k", |s| s.thermal.heat_loss_w_k = -1.0),
        ("machine.phases", |s| s.machine.phases.clear()),
        ("machine.phases[0].control.target_pa", |s| {
            s.machine.phases[0].control = Control::Pressure { target_pa: -1.0 }
        }),
        ("machine.phases[0].control.target_m3_s", |s| {
            s.machine.phases[0].control = Control::Flow {
                target_m3_s: f64::NAN,
            }
        }),
        ("machine.phases[0].ramp_s", |s| {
            s.machine.phases[0].ramp_s = -1.0
        }),
        ("machine.phases[0].limit", |s| {
            s.machine.phases[0].limit = Some(0.0)
        }),
        ("machine.phases[0].exit.time_s", |s| {
            s.machine.phases[0].exit.time_s = Some(0.0)
        }),
        ("machine.phases[0].exit.beverage_mass_kg", |s| {
            s.machine.phases[0].exit.beverage_mass_kg = Some(-1.0)
        }),
        ("machine.phases[0].exit.pressure_pa", |s| {
            s.machine.phases[0].exit.pressure_pa = Some(f64::INFINITY)
        }),
        ("machine.pump.max_flow_m3_s", |s| {
            s.machine.pump = Pump::Ideal {
                max_flow_m3_s: 0.0,
                max_pressure_pa: 1e6,
            }
        }),
        ("machine.pump.stall_pressure_pa", |s| {
            s.machine.pump = Pump::Vibratory {
                free_flow_m3_s: 6e-6,
                stall_pressure_pa: 0.0,
                opv_pa: None,
            }
        }),
        ("machine.pump.opv_pa", |s| {
            s.machine.pump = Pump::Vibratory {
                free_flow_m3_s: 6e-6,
                stall_pressure_pa: 1.5e6,
                opv_pa: Some(-1.0),
            }
        }),
        ("machine.stop.time_s", |s| s.machine.stop.time_s = Some(0.0)),
        ("machine.stop.beverage_mass_kg", |s| {
            s.machine.stop.beverage_mass_kg = Some(f64::NAN)
        }),
        ("machine.stop.drip_tau_s", |s| {
            s.machine.stop.drip_tau_s = -1.0
        }),
        ("numerics.tier", |s| s.numerics.tier = 2),
        ("numerics.depth_cells", |s| s.numerics.depth_cells = 1),
        ("numerics.max_dt_s", |s| s.numerics.max_dt_s = 0.0),
        ("numerics.max_dt_s", |s| s.numerics.max_dt_s = 1e-6),
        ("numerics.max_duration_s", |s| {
            s.numerics.max_duration_s = f64::INFINITY
        }),
        ("numerics.output_interval_s", |s| {
            s.numerics.output_interval_s = f64::NAN
        }),
        ("numerics.snapshot_count", |s| {
            s.numerics.snapshot_count = 5000
        }),
        ("numerics.kernel_shells", |s| s.numerics.kernel_shells = 1),
    ];
    for (want, mutate) in cases {
        let mut spec = ShotSpec::default();
        mutate(&mut spec);
        let got = field_of(&spec);
        assert_eq!(
            got.as_deref(),
            Some(want),
            "expected an error naming {want}"
        );
    }
}

#[test]
fn errors_read_well() {
    let mut s = ShotSpec::default();
    s.bed.dose_kg = 0.05;
    let e = simulate_shot(&s).unwrap_err();
    let text = e.to_string();
    assert!(
        text.contains("bed.dose_kg") && text.contains("overfills"),
        "{text}"
    );
}

#[test]
fn edge_cases_that_are_valid_run() {
    let cases: Vec<Mutator> = vec![
        // One column, one class, no surface pool, no solubles.
        |s| {
            s.bed.heterogeneity.columns = 1;
            s.bed.size_classes = vec![SizeClass {
                radius_m: 1e-4,
                volume_fraction: 1.0,
            }];
            s.solubles.cell_size_m = 0.0;
        },
        |s| s.solubles.extractable_fraction = 0.0,
        // All fines (no kernels at all).
        |s| {
            s.bed.size_classes = vec![SizeClass {
                radius_m: 10e-6,
                volume_fraction: 1.0,
            }]
        },
        // No dispersion, no surface dissolution, no drip, no compaction.
        |s| {
            s.hydraulics.axial_dispersion_m2_s = 0.0;
            s.solubles.surface_rate_m_s = 0.0;
            s.machine.stop.drip_tau_s = 0.0;
            s.hydraulics.poroelastic_pc_pa = None;
        },
        // Relaxations with zero time constants.
        |s| {
            s.hydraulics.swelling = Relaxation {
                amplitude: 0.2,
                tau_s: 0.0,
            };
            s.hydraulics.gas = Relaxation {
                amplitude: 0.5,
                tau_s: 0.0,
            };
            s.hydraulics.fines_layer = Relaxation {
                amplitude: 1.0,
                tau_s: 0.0,
            };
        },
        // No stop rule: runs to max_duration.
        |s| {
            s.machine.stop.beverage_mass_kg = None;
            s.numerics.max_duration_s = 15.0;
        },
        // Fractions that need renormalising, 64 columns, two depth cells.
        |s| {
            s.bed.size_classes[0].volume_fraction += 5e-4;
            s.bed.heterogeneity.columns = 64;
            s.numerics.depth_cells = 2;
        },
        // A bed that fills the basket exactly (no headspace).
        |s| {
            s.basket.extra_headspace_m3 = 0.0;
            let b = &s.bed;
            let v = b.dose_kg
                / ((1.0 - b.intergranular_porosity)
                    * (1.0 - b.intraparticle_porosity)
                    * b.skeletal_density_kg_m3);
            let r = 0.029;
            let h = v / (std::f64::consts::PI * r * r) * (1.0 + 1e-12);
            s.basket.profile_m = vec![[0.0, r], [h, r]];
        },
        // Output coarser than the step, odd ratio; no snapshots.
        |s| {
            s.numerics.output_interval_s = 0.37;
            s.numerics.max_dt_s = 0.1;
            s.numerics.snapshot_count = 0;
        },
        // A zero-flow program (nothing happens).
        |s| {
            s.machine.phases[0].control = Control::Flow { target_m3_s: 0.0 };
            s.numerics.max_duration_s = 5.0;
        },
    ];
    for (i, mutate) in cases.into_iter().enumerate() {
        let mut spec = ShotSpec::default();
        mutate(&mut spec);
        let r = simulate_shot(&spec).unwrap_or_else(|e| panic!("case {i}: {e}"));
        assert!(r.summary.ey.is_finite() && r.summary.ey >= 0.0, "case {i}");
        assert!(
            r.diagnostics.mass_balance_error < 1e-10,
            "case {i}: {}",
            r.diagnostics.mass_balance_error
        );
        assert!(r.diagnostics.min_concentration_kg_m3 >= 0.0, "case {i}");
        assert_eq!(
            r.spatial.snapshots.len(),
            spec.numerics.snapshot_count,
            "case {i}"
        );
    }
}

#[test]
fn warnings_are_reported() {
    let mut s = ShotSpec::default();
    s.solubles.species = vec![SpeciesSpec {
        id: "too_much".into(),
        mass_fraction: 0.5,
        ..SpeciesSpec::default()
    }];
    s.bed.size_classes[0].volume_fraction += 5e-4;
    let r = simulate_shot(&s).unwrap();
    let w = &r.diagnostics.warnings;
    assert!(w.iter().any(|x| x.contains("tracked species")), "{w:?}");
    assert!(w.iter().any(|x| x.contains("renormalised")), "{w:?}");
    let mut s = ShotSpec::default();
    s.machine.stop.beverage_mass_kg = None;
    s.numerics.max_duration_s = 12.0;
    let r = simulate_shot(&s).unwrap();
    assert!(
        r.summary.stop_reason == "max_duration" || r.summary.stop_reason == "choked",
        "{}",
        r.summary.stop_reason
    );
    assert!(!r.diagnostics.warnings.is_empty());
}
