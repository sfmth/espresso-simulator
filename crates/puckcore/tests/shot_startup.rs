// SPDX-License-Identifier: GPL-2.0-or-later
//! M1.1 startup verification. These are conservation/limiting-case tests,
//! not fits to the held-out espresso timing observations.

use puckcore::shot::*;

fn run(spec: &ShotSpec) -> ShotResult {
    let result = simulate_shot(spec).expect("valid startup spec");
    assert!(result.diagnostics.hydraulic_volume_balance_error < 2e-11);
    assert!(result.diagnostics.mass_balance_error < 1e-9);
    assert!(result.diagnostics.min_concentration_kg_m3 >= -1e-10);
    result
}

fn inert() -> ShotSpec {
    let mut spec = ShotSpec::default();
    spec.solubles.extractable_fraction = 0.0;
    spec.bed.heterogeneity.columns = 1;
    spec.bed.heterogeneity.edge_area_fraction = 0.0;
    spec.bed.heterogeneity.sigma_ln_permeability = 0.0;
    spec.thermal.initial_bed_temp_c = spec.thermal.water_temp_c;
    spec.thermal.heat_loss_w_k = 0.0;
    spec.machine.stop.drip_tau_s = 0.0;
    spec.hydraulics.intraparticle_water_fraction = Some(1.0);
    spec
}

fn pore_volume(spec: &ShotSpec, fraction: f64) -> f64 {
    let b = &spec.bed;
    let volume = b.dose_kg
        / ((1.0 - b.intergranular_porosity)
            * (1.0 - b.intraparticle_porosity)
            * b.skeletal_density_kg_m3);
    volume
        * (b.intergranular_porosity
            + (1.0 - b.intergranular_porosity) * b.intraparticle_porosity * fraction)
}

fn pressure_phase(target_pa: f64) -> Phase {
    Phase {
        control: Control::Pressure { target_pa },
        ramp_s: 0.0,
        limit: Some(8e-6),
        exit: PhaseExit::default(),
    }
}

#[test]
fn the_full_dry_pore_volume_must_be_supplied_before_breakthrough() {
    let mut spec = inert();
    spec.hydraulics.permeability_m2 = 1e-10;
    spec.hydraulics.poroelastic_pc_pa = None;
    let q = 2e-6;
    spec.machine.phases = vec![Phase {
        control: Control::Flow { target_m3_s: q },
        ramp_s: 0.0,
        limit: Some(9e5),
        exit: PhaseExit::default(),
    }];
    // Include non-integral fill times to catch silently discarded water at
    // the transition from headspace filling to pore filling.
    for dt in [0.5, 0.07, 0.025] {
        spec.numerics.max_dt_s = dt;
        spec.numerics.output_interval_s = dt;
        let result = run(&spec);
        let expected = (result.summary.headspace_m3 + pore_volume(&spec, 1.0)) / q;
        assert!((result.summary.first_drops_s.unwrap() - expected).abs() < 2e-9);
    }
}

#[test]
fn a_capped_flow_ramp_counts_its_fill_before_and_after_the_kink() {
    let mut spec = inert();
    spec.hydraulics.permeability_m2 = 1e-10;
    spec.hydraulics.poroelastic_pc_pa = None;
    spec.machine.pump = Pump::Ideal {
        max_flow_m3_s: 2e-6,
        max_pressure_pa: 9e5,
    };
    spec.machine.phases = vec![Phase {
        control: Control::Flow { target_m3_s: 4e-6 },
        ramp_s: 3.7,
        limit: Some(9e5),
        exit: PhaseExit::default(),
    }];
    // The cap is reached after 1.85 s, on neither output grid. From then
    // on ∫q dt = q_cap (t - 1.85/2), a reference independent of the solver.
    for dt in [0.5, 0.07] {
        spec.numerics.max_dt_s = dt;
        spec.numerics.output_interval_s = dt;
        let result = run(&spec);
        let expected = (result.summary.headspace_m3 + pore_volume(&spec, 1.0)) / 2e-6 + 1.85 / 2.0;
        assert!((result.summary.first_drops_s.unwrap() - expected).abs() < 2e-9);
    }
}

#[test]
fn legacy_defaults_and_explicit_legacy_water_fraction_agree_exactly() {
    let legacy = ShotSpec::default();
    let result = run(&legacy);
    let mut explicit = legacy.clone();
    explicit.hydraulics.intraparticle_water_fraction = Some(legacy.hydraulics.wetting_uptake);
    // An unused exponent cannot change a disabled air effect.
    explicit.hydraulics.pore_air_permeability_exponent = 3.0;
    assert_eq!(result, run(&explicit));

    explicit.hydraulics.pore_air = Relaxation {
        amplitude: 0.9,
        tau_s: 0.0,
    };
    // Zero relaxation time means instantaneous equilibration.
    assert_eq!(result, run(&explicit));
}

#[test]
fn zero_pressure_or_zero_flow_cannot_fill_the_headspace() {
    let mut spec = inert();
    spec.machine.stop.time_s = Some(4.0);
    spec.machine.stop.beverage_mass_kg = None;
    let cases = [
        pressure_phase(0.0),
        Phase {
            control: Control::Flow { target_m3_s: 0.0 },
            ramp_s: 0.0,
            limit: Some(9e5),
            exit: PhaseExit::default(),
        },
    ];
    for phase in cases {
        spec.machine.phases = vec![phase];
        let result = run(&spec);
        assert_eq!(result.summary.first_drops_s, None);
        assert_eq!(result.summary.beverage_mass_kg, 0.0);
        assert!(result.series.flow_in_m3_s.iter().all(|&q| q == 0.0));
        assert!(result.series.wetted_fraction.iter().all(|&w| w == 0.0));
    }
}

#[test]
fn dry_waiting_does_not_relax_the_pore_air_penalty() {
    let mut spec = inert();
    spec.hydraulics.pore_air = Relaxation {
        amplitude: 0.5,
        tau_s: 10.0,
    };
    spec.hydraulics.pore_air_permeability_exponent = 3.0;
    spec.machine.phases = vec![pressure_phase(9e5)];
    let direct = run(&spec);
    let mut wait = pressure_phase(0.0);
    wait.exit.time_s = Some(10.0);
    spec.machine.phases.insert(0, wait);
    let delayed = run(&spec);
    let shift = delayed.summary.first_drops_s.unwrap() - direct.summary.first_drops_s.unwrap();
    assert!((shift - 10.0).abs() < 1e-7, "{shift}");
    assert!((delayed.summary.shot_time_s - direct.summary.shot_time_s - 10.0).abs() < 1e-7);
}

#[test]
fn pore_air_slows_startup_and_recovers_the_same_late_flow() {
    let mut spec = inert();
    spec.machine.phases = vec![pressure_phase(9e5)];
    spec.machine.stop.time_s = Some(150.0);
    spec.machine.stop.beverage_mass_kg = None;
    spec.numerics.max_duration_s = 160.0;
    let clean = run(&spec);
    spec.hydraulics.pore_air = Relaxation {
        amplitude: 0.5,
        tau_s: 10.0,
    };
    spec.hydraulics.pore_air_permeability_exponent = 3.0;
    let air = run(&spec);
    assert!(air.summary.first_drops_s.unwrap() > clean.summary.first_drops_s.unwrap());
    let q_clean = clean.series.flow_out_m3_s.last().unwrap();
    let q_air = air.series.flow_out_m3_s.last().unwrap();
    assert!(
        (q_air / q_clean - 1.0).abs() < 1e-5,
        "{q_air} / {q_clean}; stops {} {}",
        air.summary.shot_time_s,
        clean.summary.shot_time_s
    );
}

#[test]
fn startup_converges_with_the_timestep_without_breaking_solute_bounds() {
    let mut spec = ShotSpec::default();
    spec.hydraulics.intraparticle_water_fraction = Some(1.0);
    spec.hydraulics.pore_air = Relaxation {
        amplitude: 0.5,
        tau_s: 10.0,
    };
    spec.hydraulics.pore_air_permeability_exponent = 3.0;
    let mut results = Vec::new();
    for dt in [0.1, 0.05, 0.025] {
        spec.numerics.max_dt_s = dt;
        spec.numerics.output_interval_s = dt;
        let result = run(&spec);
        let max_concentration = result
            .spatial
            .snapshots
            .iter()
            .flat_map(|s| s.liquid_conc_kg_m3.iter().flatten())
            .copied()
            .fold(0.0, f64::max);
        assert!(max_concentration <= spec.solubles.saturation_kg_m3 * (1.0 + 1e-9));
        println!(
            "dt {dt}: first drops {:?}, shot {}, EY {}",
            result.summary.first_drops_s, result.summary.shot_time_s, result.summary.ey
        );
        results.push(result);
    }
    let fine = &results[2].summary;
    let medium = &results[1].summary;
    assert!((medium.first_drops_s.unwrap() - fine.first_drops_s.unwrap()).abs() < 0.04);
    assert!((medium.shot_time_s - fine.shot_time_s).abs() < 0.04);
    assert!((medium.ey - fine.ey).abs() < 3e-4);
}

#[test]
fn carrier_volume_is_conserved_through_partial_wetting_stop_drip_and_vent() {
    for stop_time in [1.1, 4.1, 13.1, 43.1] {
        for vent in [false, true] {
            let mut spec = inert();
            spec.hydraulics.pore_air = Relaxation {
                amplitude: 0.5,
                tau_s: 10.0,
            };
            spec.hydraulics.pore_air_permeability_exponent = 3.0;
            spec.machine.stop.time_s = Some(stop_time);
            spec.machine.stop.beverage_mass_kg = None;
            spec.machine.stop.drip_tau_s = 10.0;
            spec.machine.stop.vent_headspace = vent;
            spec.numerics.max_dt_s = 0.5;
            spec.numerics.output_interval_s = 0.5;
            let result = run(&spec);
            if vent {
                assert_eq!(result.summary.drip_mass_kg, 0.0);
            }
        }
    }
}
