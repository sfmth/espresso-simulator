// SPDX-License-Identifier: GPL-2.0-or-later
//! Independent inventory limits: external liquid plus total particle solute,
//! an advancing wet/dry boundary, and solute carried by absorbed water.

use std::f64::consts::PI;

use puckcore::shot::*;

fn bed_volume(spec: &ShotSpec) -> f64 {
    let bed = &spec.bed;
    bed.dose_kg
        / ((1.0 - bed.intergranular_porosity)
            * (1.0 - bed.intraparticle_porosity)
            * bed.skeletal_density_kg_m3)
}

fn flow_phase(flow: f64, duration: Option<f64>) -> Phase {
    Phase {
        control: Control::Flow { target_m3_s: flow },
        ramp_s: 0.0,
        limit: Some(9e5),
        exit: PhaseExit {
            time_s: duration,
            ..PhaseExit::default()
        },
    }
}

fn controlled_bed() -> ShotSpec {
    let mut spec = ShotSpec::default();
    spec.bed.heterogeneity.columns = 1;
    spec.bed.heterogeneity.edge_area_fraction = 0.0;
    spec.bed.heterogeneity.sigma_ln_permeability = 0.0;
    spec.basket.extra_headspace_m3 = 0.0;
    let radius = 0.029;
    spec.basket.profile_m = vec![
        [0.0, radius],
        [bed_volume(&spec) / (PI * radius * radius) + 0.002, radius],
    ];
    spec.hydraulics.permeability_m2 = 1e-10;
    spec.hydraulics.poroelastic_pc_pa = None;
    spec.hydraulics.dissolution_porosity_share = Some(0.0);
    spec.hydraulics.intraparticle_water_fraction = Some(1.0);
    spec.thermal.initial_bed_temp_c = spec.thermal.water_temp_c;
    spec.thermal.heat_loss_w_k = 0.0;
    spec.machine.pump = Pump::Ideal {
        max_flow_m3_s: 10e-6,
        max_pressure_pa: 9e5,
    };
    spec.machine.stop = StopRule {
        time_s: Some(70.0),
        beverage_mass_kg: None,
        drip_tau_s: 0.0,
        ..StopRule::default()
    };
    spec.numerics.depth_cells = 8;
    spec.numerics.kernel_shells = 6;
    spec.numerics.max_dt_s = 0.1;
    spec.numerics.output_interval_s = 0.2;
    spec.numerics.snapshot_count = 8;
    spec
}

fn pure_kernels() -> ShotSpec {
    let mut spec = controlled_bed();
    spec.bed.size_classes = vec![SizeClass {
        radius_m: 100e-6,
        volume_fraction: 1.0,
    }];
    spec.solubles.cell_size_m = 0.0;
    spec.solubles.kernel_diffusivity_m2_s = 1e-8;
    spec.solubles.kernel_loading_cap = false;
    spec.hydraulics.axial_dispersion_m2_s = 1e-4;
    spec
}

fn run(spec: &ShotSpec) -> ShotResult {
    let result = simulate_shot(spec).expect("valid inventory limit");
    assert_eq!(result.summary.stop_reason, "time");
    assert!(
        result.diagnostics.mass_balance_error < 1e-9,
        "mass balance: {}",
        result.diagnostics.mass_balance_error
    );
    assert!(result.diagnostics.hydraulic_volume_balance_error < 2e-11);
    assert!(
        result.diagnostics.min_concentration_kg_m3 >= -1e-10,
        "minimum concentration: {}",
        result.diagnostics.min_concentration_kg_m3
    );
    for snapshot in &result.spatial.snapshots {
        for row in snapshot.local_ey.iter().chain(&snapshot.liquid_conc_kg_m3) {
            assert!(row.iter().all(|value| value.is_finite()));
        }
    }
    result
}

#[test]
fn closed_kernel_inventory_counts_absorbed_water_only_inside_particles() {
    // K is defined using total solute per particle envelope volume. Its
    // equilibrium capacity therefore does not depend on either the selected
    // startup-water fraction or the concentration-equivalent normalization.
    for (water_fraction, reference_uptake) in [(0.0, 0.2), (0.5, 0.5), (1.0, 0.8)] {
        let mut spec = pure_kernels();
        spec.hydraulics.intraparticle_water_fraction = Some(water_fraction);
        spec.hydraulics.wetting_uptake = reference_uptake;
        let mut fill = flow_phase(4e-6, None);
        fill.exit.beverage_mass_kg = Some(1e-6);
        spec.machine.phases = vec![fill, flow_phase(0.0, None)];
        let result = run(&spec);
        assert!(result.summary.first_drops_s.is_some());
        let eps = spec.bed.intergranular_porosity;
        let remaining = (spec.solubles.extractable_fraction - result.summary.ey) * spec.bed.dose_kg;
        let capacity =
            bed_volume(&spec) * (eps + (1.0 - eps) / spec.solubles.partition_coefficient);
        let expected = remaining / capacity;
        let snapshot = result.spatial.snapshots.last().unwrap();
        for &concentration in &snapshot.liquid_conc_kg_m3[0] {
            assert!(
                (concentration / expected - 1.0).abs() < 2e-8,
                "water={water_fraction}, normalization={reference_uptake}: \
                 got {concentration}, expected {expected}"
            );
        }
    }
}

#[test]
fn partially_wetted_closed_bed_never_extracts_its_dry_remainder() {
    // The fill stops inside a depth cell. After equilibration only f of the
    // original coffee has participated, including exactly the wet share of
    // that last cell. Two grids place the front at different cell fractions.
    let fraction = 0.28;
    for cells in [8, 17] {
        let mut spec = pure_kernels();
        spec.numerics.depth_cells = cells;
        let eps = spec.bed.intergranular_porosity;
        let phi_t = eps + (1.0 - eps) * spec.bed.intraparticle_porosity;
        let headspace = PI * 0.029_f64.powi(2) * 0.002;
        let flow = 2e-6;
        let fill_time = (headspace + phi_t * bed_volume(&spec) * fraction) / flow;
        spec.machine.phases = vec![flow_phase(flow, Some(fill_time)), flow_phase(0.0, None)];
        let result = run(&spec);
        assert_eq!(result.summary.first_drops_s, None);
        assert_eq!(result.summary.beverage_mass_kg, 0.0);
        assert!((result.series.wetted_fraction.last().unwrap() - fraction).abs() < 2e-12);

        let dry_density = spec.bed.dose_kg / bed_volume(&spec);
        let expected = spec.solubles.extractable_fraction * dry_density
            / (eps + (1.0 - eps) / spec.solubles.partition_coefficient);
        let wet_ey = spec.solubles.extractable_fraction
            - (1.0 - eps) * expected / (spec.solubles.partition_coefficient * dry_density);
        let snapshot = result.spatial.snapshots.last().unwrap();
        assert!(
            snapshot.wetted_fraction[0]
                .iter()
                .any(|&wet| wet > 0.0 && wet < 1.0)
        );
        for ((&wet, &concentration), &ey) in snapshot.wetted_fraction[0]
            .iter()
            .zip(&snapshot.liquid_conc_kg_m3[0])
            .zip(&snapshot.local_ey[0])
        {
            if wet == 0.0 {
                assert_eq!(concentration, 0.0);
                assert!(ey.abs() < 1e-13, "dry cell lost material: {ey}");
            } else {
                assert!(
                    (concentration / expected - 1.0).abs() < 2e-8,
                    "{cells} cells, wet={wet}: got {concentration}, expected {expected}"
                );
                assert!(
                    (ey - wet * wet_ey).abs() < 2e-9,
                    "{cells} cells, wet={wet}: EY={ey}, expected {}",
                    wet * wet_ey
                );
            }
        }
    }
}

#[test]
fn absorbed_water_can_carry_solute_into_a_boundary_capped_slow_kernel() {
    // Fast fines supply solute; large particles have negligible diffusive
    // exchange on this time scale. A boundary-loading cap must not discard
    // the solute carried into those particles by their newly absorbed water.
    let mut spec = controlled_bed();
    spec.bed.size_classes = vec![
        SizeClass {
            radius_m: 20e-6,
            volume_fraction: 0.5,
        },
        SizeClass {
            radius_m: 1e-3,
            volume_fraction: 0.5,
        },
    ];
    spec.solubles.kernel_diffusivity_m2_s = 1e-16;
    spec.solubles.kernel_loading_cap = true;
    spec.machine.phases = vec![flow_phase(2e-6, None)];
    spec.machine.stop.time_s = Some(10.0);
    let with_water = run(&spec);
    assert!(with_water.spatial.class_ey[1].ey < -1e-3);

    spec.hydraulics.intraparticle_water_fraction = Some(0.0);
    let without_water = run(&spec);
    assert!(without_water.spatial.class_ey[1].ey >= -1e-10);
}

#[test]
fn zero_surface_rate_disables_exchange_but_not_carried_solute() {
    let mut spec = controlled_bed();
    spec.solubles.surface_rate_m_s = 0.0;
    spec.solubles.kernel_diffusivity_m2_s = 1e-8;
    spec.solubles.kernel_loading_cap = false;
    spec.machine.phases = vec![flow_phase(2e-6, None)];
    spec.machine.stop.time_s = Some(10.0);
    let result = run(&spec);
    // The first class is entirely surface pool. Its exchange is disabled,
    // but water entering it carries solute released by the coarse kernels.
    assert!(spec.bed.size_classes[0].radius_m < spec.solubles.cell_size_m);
    assert!(result.spatial.class_ey[0].ey < -1e-3);
}

#[test]
fn species_follow_lumped_solute_through_front_transfer_and_caps() {
    for cap in [false, true] {
        let mut spec = controlled_bed();
        spec.solubles.kernel_loading_cap = cap;
        spec.machine.phases = vec![flow_phase(2e-6, None)];
        spec.machine.stop.time_s = Some(30.0);
        spec.solubles.species = [0.5, 0.25, 0.0]
            .iter()
            .enumerate()
            .map(|(index, &share)| SpeciesSpec {
                id: format!("copy-{index}"),
                mass_fraction: share * spec.solubles.extractable_fraction,
                kernel_diffusivity_m2_s: spec.solubles.kernel_diffusivity_m2_s,
                partition_coefficient: spec.solubles.partition_coefficient,
                surface_fraction_scale: 1.0,
            })
            .collect();
        let result = run(&spec);
        assert!(result.summary.ey > 0.0);
        for (species, share) in result.series.species_cup_kg.iter().zip([0.5, 0.25, 0.0]) {
            for (&mass, &ey) in species.values.iter().zip(&result.series.ey) {
                let expected = share * ey * spec.bed.dose_kg;
                assert!(
                    (mass - expected).abs() < 2e-11 * spec.bed.dose_kg,
                    "cap={cap}, share={share}: got {mass}, expected {expected}"
                );
            }
        }
    }
}
