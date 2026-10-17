// SPDX-License-Identifier: GPL-2.0-or-later
//! Structural verification of optional upstream pressure storage. These
//! coefficients are test inputs, not fits to community-shot observations.

use puckcore::shot::*;

fn phase(flow: f64, duration: f64) -> Phase {
    Phase {
        control: Control::Flow { target_m3_s: flow },
        ramp_s: 0.0,
        limit: Some(9e5),
        exit: PhaseExit {
            time_s: Some(duration),
            ..PhaseExit::default()
        },
    }
}

fn spec() -> ShotSpec {
    let mut s = ShotSpec::default();
    s.machine.hydraulic_compliance_m3_pa = 1e-11;
    s.machine.phases = vec![phase(3e-6, 30.0), phase(0.0, 8.0), phase(3e-6, 12.0)];
    s.machine.stop.time_s = Some(50.0);
    s.machine.stop.beverage_mass_kg = None;
    s.machine.stop.drip_tau_s = 0.0;
    s.numerics.output_interval_s = 0.1;
    s.numerics.max_dt_s = 0.05;
    s.solubles.extractable_fraction = 0.0;
    s.bed.heterogeneity.columns = 1;
    s.bed.heterogeneity.edge_area_fraction = 0.0;
    s.bed.heterogeneity.sigma_ln_permeability = 0.0;
    s.hydraulics.poroelastic_pc_pa = None;
    s.hydraulics.dissolution_kozeny_carman = false;
    s.hydraulics.intraparticle_water_fraction = Some(1.0);
    s.thermal.initial_bed_temp_c = s.thermal.water_temp_c;
    s.thermal.heat_loss_w_k = 0.0;
    s
}

fn run(s: &ShotSpec) -> ShotResult {
    let r = simulate_shot(s).expect("compliance case must complete");
    assert!(
        r.diagnostics.hydraulic_volume_balance_error < 3e-11,
        "{:?}",
        r.diagnostics
    );
    assert!(r.diagnostics.mass_balance_error < 1e-9);
    assert!(r.diagnostics.min_concentration_kg_m3 >= -1e-10);
    let a = &r.series;
    for i in 0..a.t_s.len() {
        let input = a.cumulative_inlet_volume_m3[i];
        let residual = input
            - a.cumulative_outlet_volume_m3[i]
            - a.cumulative_vented_volume_m3[i]
            - a.retained_volume_m3[i];
        assert!(
            residual.abs() < 3e-11 * input.max(1e-9),
            "at {}: {residual:e}",
            a.t_s[i]
        );
        assert!(a.storage_volume_m3[i] >= 0.0);
        assert_eq!(
            a.storage_volume_m3[i],
            s.machine.hydraulic_compliance_m3_pa * a.pressure_pa[i]
        );
        assert!(a.flow_in_m3_s[i] >= 0.0 && a.flow_out_m3_s[i] >= 0.0);
    }
    r
}

fn at(r: &ShotResult, time: f64) -> usize {
    r.series
        .t_s
        .iter()
        .position(|&t| (t - time).abs() < 1e-8)
        .unwrap()
}

#[test]
fn pause_releases_charged_volume_without_virtual_inlet_and_resume_recharges() {
    let r = run(&spec());
    let a = &r.series;
    let (start, end, resumed) = (at(&r, 30.0), at(&r, 38.0), at(&r, 42.0));
    assert_eq!(a.wetted_fraction[start], 1.0);
    assert_eq!(
        a.cumulative_inlet_volume_m3[end],
        a.cumulative_inlet_volume_m3[start]
    );
    let released = a.cumulative_outlet_volume_m3[end] - a.cumulative_outlet_volume_m3[start];
    let depleted = a.storage_volume_m3[start] - a.storage_volume_m3[end];
    assert!(released > 1e-7);
    assert!((released - depleted).abs() < 2e-17);
    assert!(a.pressure_pa[end] > 0.0 && a.pressure_pa[end] < a.pressure_pa[start]);
    assert!(a.storage_volume_m3[resumed] > a.storage_volume_m3[end]);
    assert_eq!(a.flow_in_m3_s[at(&r, 34.0)], 0.0);
    assert_eq!(r.summary.drip_mass_kg, 0.0);
}

#[test]
fn a_positive_bloom_floor_can_deliver_less_than_the_basket_releases() {
    let mut s = spec();
    s.machine.phases[1].control = Control::Flow {
        target_m3_s: 0.1e-6,
    };
    let r = run(&s);
    let a = &r.series;
    let (start, end) = (at(&r, 30.0), at(&r, 38.0));
    let input = a.cumulative_inlet_volume_m3[end] - a.cumulative_inlet_volume_m3[start];
    let output = a.cumulative_outlet_volume_m3[end] - a.cumulative_outlet_volume_m3[start];
    assert!((input - 8.0 * 0.1e-6).abs() < 1e-17);
    assert!(output > input);
    assert!((output - input - a.storage_volume_m3[start] + a.storage_volume_m3[end]).abs() < 2e-17);
}

#[test]
fn dry_wait_and_disabled_compliance_keep_their_exact_limits() {
    let mut dry = spec();
    dry.machine.phases = vec![phase(0.0, 4.0)];
    dry.machine.stop.time_s = Some(4.0);
    let r = run(&dry);
    assert_eq!(r.summary.first_drops_s, None);
    assert!(r.series.storage_volume_m3.iter().all(|&v| v == 0.0));
    assert!(
        r.series
            .cumulative_inlet_volume_m3
            .iter()
            .all(|&v| v == 0.0)
    );

    assert_eq!(ShotSpec::default().machine.hydraulic_compliance_m3_pa, 0.0);

    let direct = run(&spec());
    let mut delayed = spec();
    delayed.machine.phases.insert(0, phase(0.0, 10.0));
    delayed.machine.stop.time_s = Some(60.0);
    let delayed = run(&delayed);
    assert!(
        (delayed.summary.first_drops_s.unwrap() - direct.summary.first_drops_s.unwrap() - 10.0)
            .abs()
            < 1e-8
    );
    assert_eq!(
        delayed.series.cumulative_inlet_volume_m3[at(&delayed, 10.0)],
        0.0
    );
    assert!(
        (delayed.series.storage_volume_m3[at(&delayed, 40.0)]
            - direct.series.storage_volume_m3[at(&direct, 30.0)])
        .abs()
            < 1e-16
    );

    let mut disabled = spec();
    disabled.machine.hydraulic_compliance_m3_pa = 0.0;
    let r = run(&disabled);
    assert_eq!(
        r.series.cumulative_outlet_volume_m3[at(&r, 30.0)],
        r.series.cumulative_outlet_volume_m3[at(&r, 38.0)]
    );
}

#[test]
fn stop_tail_and_vent_account_for_charged_storage_even_during_partial_wetting() {
    for stop in [0.2, 4.2, 8.2, 20.2] {
        for vent in [false, true] {
            let mut s = spec();
            s.machine.stop.time_s = Some(stop);
            s.machine.stop.drip_tau_s = 1.0;
            s.machine.stop.vent_headspace = vent;
            let r = run(&s);
            let a = &r.series;
            let first = at(&r, stop);
            let last = a.t_s.len() - 1;
            if vent {
                assert_eq!(r.summary.drip_mass_kg, 0.0);
                assert_eq!(a.storage_volume_m3[last], 0.0);
                assert!(a.cumulative_vented_volume_m3[last] > 0.0);
            } else {
                assert_eq!(
                    a.cumulative_inlet_volume_m3[first],
                    a.cumulative_inlet_volume_m3[last]
                );
                assert_eq!(a.cumulative_vented_volume_m3[last], 0.0);
                let out =
                    a.cumulative_outlet_volume_m3[last] - a.cumulative_outlet_volume_m3[first];
                assert!(out <= a.storage_volume_m3[first] + 1e-18);
            }
        }
    }
}

#[test]
fn stored_pressure_survives_a_lowered_command_cap() {
    let mut s = spec();
    s.machine.hydraulic_compliance_m3_pa = 5e-11;
    s.machine.phases[1] = Phase {
        control: Control::Pressure { target_pa: 1e4 },
        limit: Some(3e-6),
        ramp_s: 0.0,
        exit: PhaseExit {
            time_s: Some(8.0),
            ..PhaseExit::default()
        },
    };
    let r = run(&s);
    assert_eq!(r.summary.stop_reason, "time");
    assert_eq!(r.summary.shot_time_s, 50.0);
    let i = at(&r, 30.1);
    assert!(r.series.pressure_pa[i] > 1e4);
    assert_eq!(r.series.flow_in_m3_s[i], 0.0);
    assert_eq!(r.series.flow_in_m3_s[at(&r, 35.1)], 0.0);
    assert!(r.series.flow_out_m3_s[at(&r, 35.1)] > 1e-8);
}

#[test]
fn inlet_flow_includes_storage_charging_while_tracking_pressure_ramps() {
    for (target_pa, pump_cap) in [(5e5, 1.2e6), (1e5, 1.2e6), (5e5, 3e5)] {
        let mut s = spec();
        s.machine.pump = Pump::Ideal {
            max_flow_m3_s: 8e-6,
            max_pressure_pa: pump_cap,
        };
        s.machine.phases = vec![
            phase(3e-6, 30.0),
            Phase {
                control: Control::Pressure { target_pa },
                limit: Some(8e-6),
                ramp_s: 4.0,
                exit: PhaseExit::default(),
            },
        ];
        s.machine.stop.time_s = Some(36.0);
        let r = run(&s);
        let a = &r.series;
        let (start, during) = (at(&r, 30.0), at(&r, 32.0));
        let mut pressure_rate = (target_pa - a.pressure_pa[start]) / 4.0;
        let commanded = a.pressure_pa[start] + 2.0 * pressure_rate;
        assert!((a.pressure_pa[during] - commanded.min(pump_cap)).abs() < 1e-8);
        if commanded >= pump_cap {
            pressure_rate = 0.0;
        }
        let expected_flow =
            a.flow_out_m3_s[during] + s.machine.hydraulic_compliance_m3_pa * pressure_rate;
        assert!((a.flow_in_m3_s[during] - expected_flow).abs() < 1e-16);
        let steady = at(&r, 35.0);
        assert!((a.flow_in_m3_s[steady] - a.flow_out_m3_s[steady]).abs() < 1e-20);
    }
}

#[test]
fn pump_delivery_into_storage_is_not_reported_as_a_choke() {
    let mut s = spec();
    s.machine.hydraulic_compliance_m3_pa = 1e-10;
    s.hydraulics.permeability_m2 = 1e-18;
    s.machine.phases = vec![phase(0.5e-6, 100.0)];
    s.machine.stop.time_s = Some(100.0);
    let r = run(&s);
    assert_eq!(r.summary.stop_reason, "time");
    assert_eq!(r.summary.shot_time_s, 100.0);
    let i = at(&r, 90.0);
    assert_eq!(r.series.flow_in_m3_s[i], 0.5e-6);
    assert!(r.series.storage_volume_m3[i] > r.series.storage_volume_m3[at(&r, 80.0)]);
    assert!(r.series.pressure_pa[i] < 9e5);
}

#[test]
fn pressure_storage_converges_with_time_refinement_with_solute_and_mass_events() {
    let mut s = spec();
    s.solubles.extractable_fraction = 0.28;
    s.machine.stop.time_s = None;
    s.machine.stop.beverage_mass_kg = Some(0.036);
    let mut results = Vec::new();
    for dt in [0.1, 0.05, 0.025] {
        s.numerics.max_dt_s = dt;
        let r = run(&s);
        assert_eq!(r.summary.stop_reason, "beverage_mass");
        assert!((r.summary.beverage_mass_kg - 0.036).abs() < 1.01e-7);
        results.push(r);
    }
    let coarse = &results[0].summary;
    let medium = &results[1].summary;
    let fine = &results[2].summary;
    assert!(
        (medium.shot_time_s - fine.shot_time_s).abs()
            < (coarse.shot_time_s - medium.shot_time_s).abs()
    );
    assert!((medium.shot_time_s - fine.shot_time_s).abs() < 0.1);
    assert!((medium.ey - fine.ey).abs() < 0.001);
}

#[test]
fn compliance_validation_names_the_field_and_rejects_nonfinite_values() {
    for value in [-1e-12, 1.01e-10, f64::NAN, f64::INFINITY] {
        let mut s = spec();
        s.machine.hydraulic_compliance_m3_pa = value;
        let error = simulate_shot(&s).unwrap_err().to_string();
        assert!(
            error.contains("machine.hydraulic_compliance_m3_pa"),
            "{error}"
        );
    }
}

#[test]
fn pressure_exit_crosses_its_threshold_and_then_discharge_continues() {
    for dt in [0.1, 0.05, 0.025] {
        let mut s = spec();
        s.numerics.max_dt_s = dt;
        s.numerics.output_interval_s = 0.13;
        let threshold = 1e5;
        s.machine.phases = vec![phase(3e-6, 30.0), phase(0.0, 30.0)];
        s.machine.phases[0].exit = PhaseExit {
            pressure_pa: Some(threshold),
            ..PhaseExit::default()
        };
        s.machine.stop.time_s = Some(20.0);
        let r = run(&s);
        // The actual crossing is retained between regular output times.
        assert!(r.summary.max_pressure_pa >= threshold);
        assert!(r.summary.max_pressure_pa <= threshold + 0.01);
        let peak = r
            .series
            .pressure_pa
            .iter()
            .position(|&p| p == r.summary.max_pressure_pa)
            .unwrap();
        assert!(peak + 2 < r.series.t_s.len());
        assert!(r.series.pressure_pa[peak + 1] < r.series.pressure_pa[peak]);
        assert_eq!(r.series.flow_in_m3_s[peak + 1], 0.0);
        assert_eq!(
            r.series.cumulative_inlet_volume_m3[peak],
            *r.series.cumulative_inlet_volume_m3.last().unwrap()
        );
    }
}

#[test]
fn a_stiff_pressure_crossing_is_localized_in_time() {
    // With vanishing storage and a nearly impermeable dry bed, pressure
    // rises beyond the threshold immediately after headspace fill. The
    // charging timescale is below the clock's resolution: locate the time
    // instead of demanding an unattainable pressure residual.
    let mut s = spec();
    let q = 3e-6;
    s.machine.hydraulic_compliance_m3_pa = 1e-24;
    s.hydraulics.permeability_m2 = 1e-18;
    s.machine.phases = vec![phase(q, 30.0), phase(0.0, 30.0)];
    s.machine.phases[0].exit = PhaseExit {
        pressure_pa: Some(100.0),
        ..PhaseExit::default()
    };
    s.machine.stop.time_s = Some(20.0);
    let r = run(&s);
    let crossing = r
        .series
        .pressure_pa
        .iter()
        .position(|&p| p >= 100.0)
        .unwrap();
    let expected = r.summary.headspace_m3 / q;
    assert!((r.series.t_s[crossing] - expected).abs() < 1e-8);
    assert_eq!(r.summary.first_drops_s, None);
    assert_eq!(r.series.flow_in_m3_s[crossing + 1], 0.0);
}
