// SPDX-License-Identifier: GPL-2.0-or-later
mod common;
use puckcore::shot::*;

#[test]
fn chemistry_is_optional_and_never_changes_the_physical_shot() {
    let mut spec = ShotSpec::default();
    spec.numerics.tier = 0;
    spec.solubles.species.push(SpeciesSpec {
        id: "caffeine".into(),
        mass_fraction: 0.012,
        ..Default::default()
    });
    let baseline = simulate_shot(&spec).unwrap();
    assert_eq!(baseline.chemistry, None);
    spec.chemistry = Some(common::chemistry_spec());
    let mut with_chemistry = simulate_shot(&spec).unwrap();
    let c = with_chemistry.chemistry.take().unwrap();
    assert!(c.acidity.ph.is_some());
    assert!(c.texture.crema_volume_proxy_m3 > 0.0);
    assert_eq!(c.refractometer.coffee_true_tds, baseline.summary.tds);
    // The expected extra diagnostics describe chemistry assumptions only.
    with_chemistry.diagnostics.warnings = baseline.diagnostics.warnings.clone();
    assert_eq!(with_chemistry, baseline);
    for phase in c.phases {
        assert!(
            (phase.available_mass_kg - phase.cup_mass_kg - phase.retained_mass_kg).abs() < 1e-18
        );
    }
}

#[test]
fn invalid_chemistry_inputs_fail_before_the_shot_runs_with_a_field_path() {
    let mut spec = ShotSpec {
        chemistry: Some(common::chemistry_spec()),
        ..Default::default()
    };
    spec.chemistry.as_mut().unwrap().water.alkalinity_mg_l_caco3 = f64::NAN;
    assert!(
        matches!(validate_shot_spec(&spec), Err(ShotError::InvalidSpec { field, .. }) if field == "chemistry.water.alkalinity_mg_l_caco3")
    );
    spec.chemistry = Some(common::chemistry_spec());
    spec.chemistry.as_mut().unwrap().compounds[3].counts_toward_tds = true;
    assert!(
        matches!(validate_shot_spec(&spec), Err(ShotError::InvalidSpec { field, .. }) if field == "chemistry.compounds[3].counts_toward_tds")
    );
    spec.chemistry = Some(common::chemistry_spec());
    spec.solubles.species.push(SpeciesSpec {
        id: "co2".into(),
        mass_fraction: 0.001,
        ..Default::default()
    });
    assert!(
        matches!(validate_shot_spec(&spec), Err(ShotError::InvalidSpec { field, .. }) if field == "chemistry.phase_inventories[0].id")
    );
}

#[test]
fn diagnostic_aggregate_does_not_double_count_the_m2_initial_inventory_budget() {
    let mut spec = ShotSpec {
        chemistry: Some(common::chemistry_spec()),
        ..Default::default()
    };
    spec.solubles.species = vec![
        SpeciesSpec {
            id: "caffeine".into(),
            mass_fraction: 0.2,
            ..Default::default()
        },
        SpeciesSpec {
            id: "acids".into(),
            mass_fraction: 0.2,
            ..Default::default()
        },
    ];
    spec.chemistry
        .as_mut()
        .unwrap()
        .compounds
        .push(CompoundChemistrySpec {
            id: "acids".into(),
            phase: "diagnostic".into(),
            ..Default::default()
        });
    let warnings = validate_shot_spec(&spec).unwrap();
    assert!(
        !warnings
            .iter()
            .any(|warning| warning.contains("tracked species add up"))
    );
    // Actual named-stock overassignment remains visible.
    spec.solubles.species[0].mass_fraction = 0.4;
    let warnings = validate_shot_spec(&spec).unwrap();
    assert!(
        warnings
            .iter()
            .any(|warning| warning.contains("tracked species add up to 0.4000"))
    );
    // Raw M1 specs retain the original conservative passenger-budget check.
    spec.solubles.species[0].mass_fraction = 0.2;
    spec.chemistry = None;
    let warnings = validate_shot_spec(&spec).unwrap();
    assert!(
        warnings
            .iter()
            .any(|warning| warning.contains("tracked species add up to 0.4000"))
    );
}

#[test]
fn finite_subnormal_physical_inputs_are_rejected_before_they_can_overflow_outputs() {
    let tiny = f64::from_bits(1);
    let mut spec = ShotSpec {
        chemistry: Some(common::chemistry_spec()),
        ..Default::default()
    };
    spec.chemistry.as_mut().unwrap().compounds[2].aroma_threshold_ug_l = Some(tiny);
    assert!(
        matches!(validate_shot_spec(&spec), Err(ShotError::InvalidSpec { field, .. }) if field == "chemistry.compounds[2].aroma_threshold_ug_l")
    );
    spec.chemistry = Some(common::chemistry_spec());
    spec.chemistry.as_mut().unwrap().compounds[1].molecular_weight_g_mol = Some(tiny);
    assert!(
        matches!(validate_shot_spec(&spec), Err(ShotError::InvalidSpec { field, .. }) if field == "chemistry.compounds[1].molecular_weight_g_mol")
    );
    spec.chemistry = Some(common::chemistry_spec());
    spec.chemistry
        .as_mut()
        .unwrap()
        .crema
        .bubble_gas_density_kg_m3 = tiny;
    assert!(
        matches!(validate_shot_spec(&spec), Err(ShotError::InvalidSpec { field, .. }) if field == "chemistry.crema.bubble_gas_density_kg_m3")
    );
}
