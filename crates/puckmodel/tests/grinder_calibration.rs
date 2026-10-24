// SPDX-License-Identifier: GPL-2.0-or-later
//! Dial coordinates must not alter the underlying physical grinder model.
mod common;
use common::*;
use serde_json::json;

#[test]
fn explicit_existing_references_preserve_every_preset_spec() {
    for id in preset_ids("grinders") {
        let mut recipe = generic_recipe();
        recipe["grinder"] = json!({"preset": id});
        let before = build_ok(&recipe);
        recipe["grinder"]["setting_ref"] = preset("grinders", &id)["dial"]["ref"].clone();
        let after = build_ok(&recipe);
        assert_eq!(before["spec"], after["spec"], "{id}");
        assert_eq!(before["derived"]["psd"], after["derived"]["psd"], "{id}");
    }
}

#[test]
fn arbitrary_anchors_and_reverse_numbers_resolve_the_same_physics() {
    for slope in [10.0, -10.0] {
        let mut recipe = generic_recipe();
        recipe["grinder"] = json!({"family":"flat-traditional", "setting":12.5 + 20.0 / slope,
            "setting_ref":12.5, "gap_at_ref_um":190, "gap_per_unit_um":slope});
        let mapped = build_ok(&recipe);
        assert_eq!(num(&mapped, "derived.psd.gap_um"), 210.0);
        recipe["grinder"] = json!({"family":"flat-traditional", "gap_um":210});
        assert_eq!(mapped["spec"], build_ok(&recipe)["spec"]);
    }
}

#[test]
fn explicit_reference_overrides_a_named_dial_reference() {
    let mut recipe = generic_recipe();
    recipe["grinder"] = json!({"preset":"mahlkoenig-e65s", "setting":1.7,
        "setting_ref":1.7, "gap_at_ref_um":200, "gap_per_unit_um":-25});
    assert_eq!(num(&build_ok(&recipe), "derived.psd.gap_um"), 200.0);
    recipe["grinder"]["setting"] = json!(2.1);
    assert!((num(&build_ok(&recipe), "derived.psd.gap_um") - 190.0).abs() < 1e-9);
}

#[test]
fn zero_and_excessive_sensitivity_are_rejected() {
    for slope in [0.0, -1000.01, 1000.01] {
        let mut recipe = generic_recipe();
        recipe["grinder"]["gap_per_unit_um"] = json!(slope);
        assert!(build_err(&recipe).contains("gap_per_unit_um"));
    }
}
