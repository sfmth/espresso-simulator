// SPDX-License-Identifier: GPL-2.0-or-later
//! Read-only Explore projection: it must expose, never reconstruct, the coupled state.
use super::*;

fn spec() -> ShotSpec {
    let mut spec = ShotSpec::default();
    spec.bed.heterogeneity.columns = 2;
    spec.numerics.depth_cells = 6;
    spec.numerics.kernel_shells = 4;
    spec.numerics.snapshot_count = 5;
    spec.solubles.species.clear();
    spec.machine.stop.time_s = Some(18.0);
    spec.machine.stop.beverage_mass_kg = None;
    spec.machine.stop.drip_tau_s = 0.0;
    spec
}

fn request() -> ExploreRequest {
    ExploreRequest {
        column: 1,
        cell: 3,
        ..ExploreRequest::default()
    }
}

#[test]
fn m5_export_leaves_every_original_result_value_unchanged() {
    let mut spec = spec();
    let normal = run(&spec).unwrap();
    assert!(normal.spatial.micro.is_none());
    assert!(normal.spatial.snapshots.iter().all(|s| s.micro.is_none()
        && s.column_flow_m3_s.is_none()
        && s.bed_temperature_c.is_none()));
    spec.numerics.explore_cell = Some(request());
    let mut explore = run(&spec).unwrap();
    let metadata = explore.spatial.micro.take().unwrap();
    assert_eq!(metadata.column, 1);
    assert_eq!(metadata.cell, 3);
    assert_eq!(metadata.depth_cells, 6);
    for snapshot in &mut explore.spatial.snapshots {
        let particle = snapshot.micro.take().unwrap();
        let weighted: f64 = particle
            .class_ey
            .iter()
            .zip(&metadata.classes)
            .map(|(ey, class)| ey * class.volume_fraction)
            .sum();
        assert!((weighted - snapshot.local_ey[metadata.column][metadata.cell]).abs() < 1e-12);
        assert_eq!(
            snapshot.column_flow_m3_s.take().unwrap().len(),
            spec.bed.heterogeneity.columns
        );
        assert!(snapshot.bed_temperature_c.take().unwrap().is_finite());
    }
    assert_eq!(
        normal, explore,
        "opt-in observation changed existing physical outputs"
    );
}

#[test]
fn m5_radial_values_are_exact_read_only_copies_of_selected_cell_state() {
    let mut spec = spec();
    spec.numerics.explore_cell = Some(request());
    let mut warnings = validate::validate(&spec).unwrap();
    let model = Model::new(&spec, &mut warnings);
    let mut sim = Sim::new(&spec, &model, warnings);
    sim.run().unwrap();
    let before = (sim.state.u.clone(), sim.state.pool.clone(), sim.state.t);
    let snapshot = sim.snapshot();
    let exported = snapshot.micro.unwrap();
    for (k, class) in model.classes.iter().enumerate() {
        for l in 0..class.shells() {
            let actual = sim.state.u[kernel_index(&model, 1, class.offset + l, 3)];
            assert_eq!(exported.kernel_conc_kg_m3[k][l].to_bits(), actual.to_bits());
        }
    }
    assert_eq!(
        before,
        (sim.state.u.clone(), sim.state.pool.clone(), sim.state.t)
    );
}

#[test]
fn m5_dry_and_all_surface_classes_have_honest_profiles() {
    let mut spec = spec();
    spec.numerics.explore_cell = Some(request());
    let mut warnings = validate::validate(&spec).unwrap();
    let model = Model::new(&spec, &mut warnings);
    let sim = Sim::new(&spec, &model, warnings);
    let snapshot = sim.snapshot();
    let exported = snapshot.micro.unwrap();
    let metadata = sim.micro_metadata(request());
    assert_eq!(snapshot.wetted_fraction[1][3], 0.0);
    assert!(exported.class_ey.iter().all(|ey| ey.abs() < 1e-12));
    assert_eq!(metadata.classes[0].kernel_radius_m, 0.0);
    assert!(metadata.classes[0].shell_outer_radii_m.is_empty());
    assert!(exported.kernel_conc_kg_m3[0].is_empty());
    assert_eq!(
        exported.surface_remaining_fraction,
        vec![Some(1.0), Some(1.0)]
    );
    assert!(exported.kernel_conc_kg_m3[1].iter().all(|u| *u == model.u0));
    assert_eq!(
        metadata.classes[1].shell_outer_radii_m.last(),
        Some(&model.classes[1].kernel_radius)
    );
    spec.solubles.cell_size_m = 0.0;
    let mut warnings = validate::validate(&spec).unwrap();
    let model = Model::new(&spec, &mut warnings);
    let sim = Sim::new(&spec, &model, warnings);
    assert!(
        sim.micro_snapshot(request())
            .surface_remaining_fraction
            .iter()
            .all(Option::is_none)
    );
}

#[test]
fn m5_selection_and_memory_bounds_are_checked_before_solving() {
    let mut spec = spec();
    spec.numerics.explore_cell = Some(ExploreRequest {
        column: 2,
        cell: 0,
        ..ExploreRequest::default()
    });
    assert!(
        validate::validate(&spec)
            .unwrap_err()
            .to_string()
            .contains("explore_cell.column")
    );
    spec.numerics.explore_cell = Some(ExploreRequest {
        column: 0,
        cell: 6,
        ..ExploreRequest::default()
    });
    assert!(
        validate::validate(&spec)
            .unwrap_err()
            .to_string()
            .contains("explore_cell.cell")
    );
    spec.numerics.explore_cell = Some(request());
    spec.numerics.tier = 0;
    assert!(
        validate::validate(&spec)
            .unwrap_err()
            .to_string()
            .contains("requires tier 1")
    );
    spec.numerics.tier = 1;
    spec.numerics.snapshot_count = 0;
    assert!(
        validate::validate(&spec)
            .unwrap_err()
            .to_string()
            .contains("at least one spatial snapshot")
    );
    spec.numerics.snapshot_count = 1000;
    spec.numerics.kernel_shells = 64;
    spec.bed.size_classes = vec![
        SizeClass {
            radius_m: 175e-6,
            volume_fraction: 0.005
        };
        200
    ];
    assert!(
        validate::validate(&spec)
            .unwrap_err()
            .to_string()
            .contains("memory budget")
    );
}

#[test]
fn m5_refined_1d_exports_are_deterministic_and_stable_under_step_refinement() {
    // The refinement changes depth resolution only, not a new set of equations.
    let mut spec = spec();
    spec.bed.heterogeneity.columns = 1;
    spec.numerics.depth_cells = 30;
    spec.numerics.explore_cell = Some(ExploreRequest {
        column: 0,
        cell: 15,
        ..ExploreRequest::default()
    });
    spec.numerics.output_interval_s = 0.1;
    for cells in [30, 150] {
        spec.numerics.depth_cells = cells;
        spec.numerics.explore_cell = Some(ExploreRequest {
            column: 0,
            cell: cells / 2,
            resolution: if cells == 150 {
                ExploreResolution::High
            } else {
                ExploreResolution::Standard
            },
        });
        spec.numerics.max_dt_s = 0.05;
        let coarse = run(&spec).unwrap();
        assert_eq!(coarse, run(&spec).unwrap());
        spec.numerics.max_dt_s = 0.025;
        let fine = run(&spec).unwrap();
        assert!(fine.summary.ey > 0.01, "test must exercise extraction");
        assert!((fine.summary.ey - coarse.summary.ey).abs() < 0.002);
        assert!((fine.summary.beverage_mass_kg - coarse.summary.beverage_mass_kg).abs() < 0.001);
        assert_eq!(fine.spatial.depth_m.len(), cells);
        assert!(
            fine.spatial
                .snapshots
                .iter()
                .all(|snapshot| snapshot.local_ey[0].len() == cells && snapshot.micro.is_some())
        );
    }
}
