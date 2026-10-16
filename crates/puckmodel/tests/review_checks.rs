// SPDX-License-Identifier: GPL-2.0-or-later
//! Checks from the M1 input-model review: the base permeability anchor,
//! plausibility bounds, no internal errors from user input, time caps, one
//! precedence rule with truthful provenance, the list of registry ids the
//! builder reads, the solver's own validation and the new solver fields.

mod common;

use std::collections::BTreeSet;

use common::*;
use serde_json::{Value, json};

fn with(mut v: Value, path: &str, value: Value) -> Value {
    set(&mut v, path, value);
    v
}

fn simulate(recipe: &Value) -> Value {
    let text = puckmodel::api::simulate_recipe_json(&recipe.to_string())
        .unwrap_or_else(|e| panic!("simulation failed: {e}"));
    serde_json::from_str(&text).unwrap()
}

// -- H1: the bare base permeability ------------------------------------------------------

#[test]
fn base_permeability_scales_the_reference_once() {
    // κ₀ = κ_ref (D32/D32_ref)² [KC(ε)/KC(ε_ref)]^α, KC(ε) = ε³/(1 − ε)², α the closure's
    // density exponent (V6; the form of python/puckworks_tools/cases/corrochano2017.py), with
    // the bare reference permeability and no compaction or swelling factor (the solver applies
    // those). Exact, whatever κ_ref and α the registry or the calibration holds.
    let registry: Value = serde_json::from_str(&puckmodel::api::registry_json()).unwrap();
    let default_of = |id: &str| {
        registry["parameters"]
            .as_array()
            .unwrap()
            .iter()
            .find(|p| p["id"] == id)
            .map(|p| num(p, "default"))
            .unwrap()
    };
    let kappa_ref = default_of("hydraulics.permeability.reference");
    let d32_ref = default_of("model.hydraulics.reference_sauter_diameter");
    let eps_ref = default_of("bed.porosity.intergranular");
    let kc = |e: f64| e * e * e / ((1.0 - e) * (1.0 - e));
    for (setting, eps, alpha) in [
        (190.0, None, None),
        (120.0, Some(0.25), None),
        (300.0, Some(0.12), None),
        (190.0, Some(0.25), Some(0.327)),
        (250.0, Some(0.12), Some(0.0)),
    ] {
        let mut r = with(generic_recipe(), "grinder.setting", json!(setting));
        let mut ov = serde_json::Map::new();
        if let Some(e) = eps {
            ov.insert("bed.porosity.intergranular".into(), json!(e));
        }
        if let Some(a) = alpha {
            ov.insert("hydraulics.kozeny_carman.density_exponent".into(), json!(a));
        }
        r["overrides"] = Value::Object(ov);
        let b = build_ok(&r);
        let d32 = num(&b, "derived.bed.sauter_diameter_um");
        let e = num(&b, "spec.bed.intergranular_porosity");
        let a = alpha.unwrap_or_else(|| default_of("hydraulics.kozeny_carman.density_exponent"));
        let want = kappa_ref * (d32 / d32_ref).powi(2) * (kc(e) / kc(eps_ref)).powf(a);
        let k0 = num(&b, "spec.hydraulics.permeability_m2");
        assert!((k0 / want - 1.0).abs() < 1e-12, "{setting}: {k0} vs {want}");
        let prov = b["derived"]["provenance"]["hydraulics.permeability_m2"]
            .as_str()
            .unwrap();
        assert!(prov.contains("hydraulics.permeability.reference") && !prov.contains("in_shot"));
        assert!(
            prov.contains("hydraulics.kozeny_carman.density_exponent"),
            "{prov}"
        );
    }
    // At the reference porosity α has no effect: κ₀ is bit-identical for any α.
    let k = |a: f64| {
        let mut r = generic_recipe();
        r["overrides"] = json!({"hydraulics.kozeny_carman.density_exponent": a});
        num(&build_ok(&r), "spec.hydraulics.permeability_m2")
    };
    assert_eq!(k(0.327), k(1.0));
    assert_eq!(k(0.0), k(1.0));
}

#[test]
fn legacy_permeability_does_not_apply_compaction_twice() {
    // Plausibility of the builder → solver chain, decoupled from the calibrated default:
    // κ_ref = 4e-14 m² is set explicitly. It is the bare reference permeability that gives
    // this generic recipe (flat traditional burrs at 190 µm, 58 mm precision 18 g basket,
    // flat 9 bar, 18 → 36 g) about 30 s with θ = 0 (solver of 2026-10-15). A builder that
    // applied compaction or swelling twice (v1's in-shot κ gave 96 s), or a unit slip, leaves
    // the 20–40 s band. Keep the legacy water capacity and no pore-air penalty:
    // this regression isolates the permeability conversion, not M1.1 startup
    // accuracy (which is scored on held-out data by the validation harness).
    let mut r = with(generic_recipe(), "numerics", json!({"tier": 1}));
    r["overrides"] = json!({
        "hydraulics.permeability.reference": 4e-14,
        "model.hydraulics.intraparticle_water_fraction": 0.5,
        "model.hydraulics.pore_air_amplitude": 0
    });
    let run = simulate(&r);
    let s = &run["result"]["summary"];
    assert_eq!(s["stop_reason"], "beverage_mass");
    let t = num(s, "shot_time_s");
    assert!((20.0..40.0).contains(&t), "shot time {t} s");
}

// -- M1: plausibility bounds ---------------------------------------------------------------

#[test]
fn implausible_recipe_values_are_errors_naming_the_field() {
    let generic = generic_recipe();
    let custom = with(
        generic.clone(),
        "basket",
        json!({"custom": {"profile_mm": [[0, 56], [22, 58]], "perforated_diameter_mm": 50}}),
    );
    let family = with(
        generic.clone(),
        "grinder",
        json!({"family": "conical", "gap_um": 200}),
    );
    let profile = with(
        generic.clone(),
        "machine",
        json!({"profile": [{"control": "pressure", "target": 9}]}),
    );
    let cases: Vec<(Value, &str, Value, &str)> = vec![
        (
            family.clone(),
            "grinder.gap_um",
            json!(5000),
            "grinder.gap_um",
        ),
        (
            family.clone(),
            "grinder.x50_gap_ratio",
            json!(9),
            "grinder.x50_gap_ratio",
        ),
        (
            family.clone(),
            "grinder.coarse_log_width",
            json!(3),
            "grinder.coarse_log_width",
        ),
        (
            family.clone(),
            "grinder.boulder_weight",
            json!(0.5),
            "grinder.boulder_weight",
        ),
        (family.clone(), "grinder.rpm", json!(1e6), "grinder.rpm"),
        (
            family.clone(),
            "grinder.burr_diameter_mm",
            json!(2),
            "grinder.burr_diameter_mm",
        ),
        (
            generic.clone(),
            "grinder",
            json!({"psd": {"diameter_um": [0.01, 100], "volume_fraction": [1, 1]}}),
            "grinder.psd.diameter_um[0]",
        ),
        (
            generic.clone(),
            "grinder",
            json!({"psd": {"diameter_um": [10, 9000], "volume_fraction": [1, 1]}}),
            "grinder.psd.diameter_um[1]",
        ),
        (
            custom.clone(),
            "basket.custom.profile_mm",
            json!([[0, 10], [22, 58]]),
            "diameter",
        ),
        (
            custom.clone(),
            "basket.custom.profile_mm",
            json!([[0, 56], [150, 58]]),
            "height",
        ),
        (
            custom.clone(),
            "basket.custom.pressurised_orifice_mm",
            json!(0.01),
            "pressurised_orifice_mm",
        ),
        (
            custom.clone(),
            "basket.custom.perforated_diameter_mm",
            json!(2),
            "perforated_diameter_mm",
        ),
        (generic.clone(), "prep.dose_g", json!(0.5), "prep.dose_g"),
        (generic.clone(), "prep.dose_g", json!(80), "prep.dose_g"),
        (
            generic.clone(),
            "prep.tamp_kgf",
            json!(500),
            "prep.tamp_kgf",
        ),
        (
            generic.clone(),
            "machine.temperature_c",
            json!(130),
            "machine.temperature_c",
        ),
        (
            generic.clone(),
            "machine.headspace_ml",
            json!(900),
            "machine.headspace_ml",
        ),
        (
            generic.clone(),
            "bean.bean_temp_c",
            json!(90),
            "bean.bean_temp_c",
        ),
        (
            profile.clone(),
            "machine.profile.0.target",
            json!(40),
            "machine.profile[0].target",
        ),
        (
            with(profile.clone(), "machine.profile.0.control", json!("flow")),
            "machine.profile.0.target",
            json!(50),
            "machine.profile[0].target",
        ),
        (
            profile.clone(),
            "machine.profile.0.limit",
            json!(100),
            "machine.profile[0].limit",
        ),
        (
            profile.clone(),
            "machine.pump",
            json!({"type": "vibratory", "free_flow_ml_s": 100}),
            "machine.pump.free_flow_ml_s",
        ),
        (
            profile.clone(),
            "machine.pump",
            json!({"type": "ideal", "max_pressure_bar": 90}),
            "machine.pump.max_pressure_bar",
        ),
    ];
    for (base, path, value, field) in cases {
        let err = build_err(&with(base, path, value.clone()));
        assert!(err.contains(field), "{path} = {value}: {err}");
        assert!(!err.contains("internal"), "{path} = {value}: {err}");
    }
}

// -- M2: no internal error from user input ------------------------------------------------

#[test]
fn every_registry_value_gives_a_spec_the_solver_accepts() {
    // The M2 principle: any value inside a registry record's range, with the rest at their
    // defaults, gives a spec the solver accepts and a shot that runs (shot-model.md §2.1).
    let registry: Value = serde_json::from_str(&puckmodel::api::registry_json()).unwrap();
    let ranges: std::collections::BTreeMap<String, Value> = registry["parameters"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| (p["id"].as_str().unwrap().to_string(), p["range"].clone()))
        .collect();
    let mut tried = 0;
    let mut failures = Vec::new();
    for id in puckmodel::registry_reads() {
        for bound in ["min", "max"] {
            let Some(v) = ranges[id][bound].as_f64() else {
                failures.push(format!("{id}: the registry range has no {bound}"));
                continue;
            };
            for base in [generic_recipe(), owner_recipe()] {
                let mut r = with(base, "numerics", json!({"tier": 0}));
                r["overrides"] = json!({ id.as_str(): v });
                tried += 1;
                if let Err(e) = puckmodel::api::simulate_recipe_json(&r.to_string()) {
                    failures.push(format!("{id} = {v}: {}", e.0));
                }
            }
        }
    }
    // Ranges of workstream C's records that are wider than the models can use, reported to C
    // as "<id> = <failing end>", or "<id>" when the range has no maximum.
    const C_RANGE_MISMATCHES: [&str; 1] = ["hydraulics.kozeny_carman.density_exponent"];
    let (known, unknown): (Vec<_>, Vec<_>) = failures.iter().partition(|f| {
        C_RANGE_MISMATCHES
            .iter()
            .any(|c| f.starts_with(&format!("{c}:")))
    });
    assert!(
        unknown.is_empty(),
        "{}",
        unknown
            .iter()
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    );
    for f in &known {
        eprintln!("C range mismatch: {f}");
    }
    assert!(tried > 200, "{tried}");
}

#[test]
fn huge_psd_values_are_normalised_without_overflow() {
    let r = with(
        generic_recipe(),
        "grinder",
        json!({"psd": {"diameter_um": [30, 300], "volume_fraction": [1e308, 1e308]}}),
    );
    let b = build_ok(&r);
    let classes = b["spec"]["bed"]["size_classes"].as_array().unwrap();
    assert_eq!(num(&classes[0], "volume_fraction"), 0.5);
}

// -- M3: time caps -------------------------------------------------------------------------

#[test]
fn stop_and_phase_times_are_capped() {
    for (path, value, field) in [
        ("stop.time_s", json!(9e4), "stop.time_s"),
        ("stop.time_s", json!(1e300), "stop.time_s"),
        ("stop.beverage_g", json!(5000), "stop.beverage_g"),
    ] {
        let err = build_err(&with(generic_recipe(), path, value));
        assert!(err.contains(field), "{err}");
    }
    let r = with(
        generic_recipe(),
        "machine",
        json!({"profile": [
            {"control": "flow", "target": 2, "until_time_s": 1e300},
            {"control": "pressure", "target": 9}
        ]}),
    );
    assert!(build_err(&r).contains("machine.profile[0].until_time_s"));
    // The longest allowed program still has a bounded hard stop.
    let r = with(
        generic_recipe(),
        "machine",
        json!({"profile": [
            {"control": "flow", "target": 2, "ramp_s": 600, "until_time_s": 600},
            {"control": "flow", "target": 2, "ramp_s": 600, "until_time_s": 600},
            {"control": "pressure", "target": 9}
        ]}),
    );
    let b = build_ok(&r);
    assert_eq!(num(&b, "spec.numerics.max_duration_s"), 1200.0);
    assert!(notes(&b).contains("stops at 1200 s at the latest"));
}

// -- M4: one precedence rule, truthful provenance ------------------------------------------

#[test]
fn overrides_beat_presets_and_tokens_name_the_source() {
    // shot.temperature: override beats the preset; an explicit recipe value beats the override.
    let r = with(owner_recipe(), "overrides", json!({"shot.temperature": 90}));
    let b = build_ok(&r);
    assert_eq!(num(&b, "spec.thermal.water_temp_c"), 90.0);
    assert_eq!(
        b["derived"]["provenance"]["thermal.water_temp_c"],
        "override:shot.temperature"
    );
    let b = build_ok(&with(r, "machine.temperature_c", json!(94)));
    assert_eq!(num(&b, "spec.thermal.water_temp_c"), 94.0);
    assert_eq!(
        b["derived"]["provenance"]["thermal.water_temp_c"],
        "recipe:machine.temperature_c"
    );
    assert!(notes(&b).contains("beats the override of shot.temperature"));
    // Basket open area and discharge coefficient: overrides beat preset and registry values.
    let r = with(
        with(
            owner_recipe(),
            "basket.preset",
            json!("58-pressurised-double"),
        ),
        "overrides",
        json!({"model.basket.open_area_fraction": 0.05, "model.basket.pressurised_discharge_coefficient": 0.65}),
    );
    let r = with(r, "prep.dose_g", json!(16));
    let b = build_ok(&r);
    assert_eq!(num(&b, "spec.basket.open_area_fraction"), 0.05);
    assert_eq!(num(&b, "spec.basket.outlet.discharge_coefficient"), 0.65);
    assert_eq!(
        b["derived"]["provenance"]["basket.open_area_fraction"],
        "override:model.basket.open_area_fraction"
    );
    // A preset drip time loses to an override, and the token says so.
    let r = with(
        with(generic_recipe(), "machine.preset", json!("e61-rotary")),
        "overrides",
        json!({"model.machine.drip_time_constant": 3.0}),
    );
    let b = build_ok(&r);
    assert_eq!(num(&b, "spec.machine.stop.drip_tau_s"), 3.0);
    assert_eq!(
        b["derived"]["provenance"]["machine.stop.drip_tau_s"],
        "override:model.machine.drip_time_constant"
    );
    // The default ramp: an override applies to phases without their own ramp, with a note for
    // the phases that state one; the token names the override.
    let r = with(
        with(
            generic_recipe(),
            "machine",
            json!({"profile": [{"control": "flow", "target": 4, "until_time_s": 5}, {"control": "pressure", "target": 9, "ramp_s": 3}]}),
        ),
        "overrides",
        json!({"model.machine.ramp_time": 0.5}),
    );
    let b = build_ok(&r);
    assert_eq!(num(&b, "spec.machine.phases.0.ramp_s"), 0.5);
    assert_eq!(num(&b, "spec.machine.phases.1.ramp_s"), 3.0);
    let prov = b["derived"]["provenance"]["machine.phases"]
        .as_str()
        .unwrap();
    assert!(prov.contains("override:model.machine.ramp_time"), "{prov}");
    assert!(notes(&b).contains("state their own ramp and keep it"));
    // The reference temperature cites the diffusivity's real source.
    let r = with(
        generic_recipe(),
        "overrides",
        json!({"extraction.diffusivity.lumped.corrochano_80c": 1e-10}),
    );
    let prov = build_ok(&r)["derived"]["provenance"]["solubles.reference_temp_c"]
        .as_str()
        .unwrap()
        .to_string();
    assert!(
        prov.contains("override:extraction.diffusivity.lumped.corrochano_80c"),
        "{prov}"
    );
}

// -- M5: the list of registry ids the builder reads ---------------------------------------

#[test]
fn registry_reads_list_is_exact() {
    let coverage = [
        generic_recipe(),
        owner_recipe(),
        json!({
            "schema": "puckworks.recipe/1",
            "bean": {"preset": "dark-80-20-blend", "bean_temp_c": -18},
            "grinder": {"preset": "bentwood-v63", "setting": 200},
            "basket": {"preset": "58-pressurised-double"},
            "prep": {"dose_g": 16, "distribution": "none", "puck_screen": true, "paper_bottom": true},
            "machine": {"preset": "vibratory-pump"},
            "stop": {}
        }),
    ];
    let mut used = BTreeSet::new();
    for r in &coverage {
        let recipe: puckmodel::Recipe = serde_json::from_value(r.clone()).unwrap();
        let (_, ids) = puckmodel::build_traced(&recipe).unwrap();
        used.extend(ids);
    }
    let listed = puckmodel::registry_reads();
    let missing: Vec<_> = used.difference(listed).collect();
    let unused: Vec<_> = listed.difference(&used).collect();
    assert!(missing.is_empty(), "read but not listed: {missing:?}");
    assert!(unused.is_empty(), "listed but never read: {unused:?}");
    let ids = registry_ids();
    for id in listed {
        assert!(ids.contains(id), "{id} is not in the registry");
    }
}

// -- M8: the solver's validation, mapped to recipe fields ---------------------------------

#[test]
fn solver_rejections_name_the_recipe_field_or_override() {
    let r = with(
        with(generic_recipe(), "bean.bean_temp_c", json!(-200)),
        "overrides",
        json!({"model.thermal.hardware_temperature": 0}),
    );
    let err = build_err(&r);
    assert!(err.contains("recipe field bean.bean_temp_c"), "{err}");
    assert!(
        err.contains("the override of model.thermal.hardware_temperature"),
        "{err}"
    );
    assert!(!err.contains("internal"), "{err}");
    // Every preset build passes the solver's own check.
    let built = build_ok(&owner_recipe());
    let spec: puckcore::shot::ShotSpec = serde_json::from_value(built["spec"].clone()).unwrap();
    puckcore::shot::validate_shot_spec(&spec).unwrap();
}

// -- M9: new solver fields ---------------------------------------------------------------

#[test]
fn new_solver_fields_are_set_with_provenance() {
    let b = build_ok(&generic_recipe());
    assert_eq!(num(&b, "spec.thermal.ambient_temp_c"), 20.0);
    assert_eq!(
        num(&b, "spec.solubles.solute_specific_volume_m3_kg"),
        1.0 / 1570.0
    );
    // θ from the registry record (mode 0), overridable in the sandbox.
    assert_eq!(num(&b, "spec.hydraulics.dissolution_porosity_share"), 0.0);
    assert_eq!(
        b["derived"]["provenance"]["hydraulics.dissolution_porosity_share"],
        "registry:hydraulics.dissolution_porosity_share"
    );
    let mut r = generic_recipe();
    r["overrides"] = json!({"hydraulics.dissolution_porosity_share": 0.5});
    assert_eq!(
        num(&build_ok(&r), "spec.hydraulics.dissolution_porosity_share"),
        0.5
    );
    assert_eq!(b["spec"]["solubles"]["kernel_loading_cap"], true);
    let prov = &b["derived"]["provenance"];
    assert_eq!(
        prov["thermal.ambient_temp_c"],
        "registry:model.thermal.room_temperature"
    );
    assert_eq!(
        prov["solubles.solute_specific_volume_m3_kg"],
        "registry:model.extraction.solute_apparent_density"
    );
    for field in [
        "hydraulics.dissolution_porosity_share",
        "numerics.kernel_shells",
        "numerics.depth_cells",
        "numerics.max_dt_s",
        "numerics.output_interval_s",
        "numerics.snapshot_count",
    ] {
        assert!(prov[field].is_string(), "{field}");
    }
}

// -- LOW ---------------------------------------------------------------------------------

#[test]
fn named_grinders_keep_the_family_flags_and_notes() {
    let b = build_ok(&with(
        generic_recipe(),
        "grinder",
        json!({"preset": "bentwood-v63", "setting": 190}),
    ));
    assert_eq!(b["derived"]["presets"]["grinder"], "bentwood-v63");
    assert_eq!(
        b["derived"]["presets"]["grinder_family"],
        "flat-traditional"
    );
    let flags: Vec<&str> = b["derived"]["flags"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f.as_str().unwrap())
        .collect();
    assert!(flags.contains(&"estimated"), "{flags:?}");
    assert!(notes(&b).contains("Flat burrs, traditional geometry: Family values are judgements"));
}

#[test]
fn coarse_width_and_boulder_weight_from_the_recipe() {
    let b = build_ok(&with(
        generic_recipe(),
        "grinder",
        json!({"family": "conical", "gap_um": 200, "coarse_log_width": 0.25, "boulder_weight": 0.02}),
    ));
    let mix = b["derived"]["psd"]["mixture"].as_array().unwrap();
    assert_eq!(num(&mix[1], "log_width"), 0.25);
    assert_eq!(num(&mix[2], "weight"), 0.02);
    let prov = b["derived"]["provenance"]["bed.size_classes"]
        .as_str()
        .unwrap();
    assert!(
        prov.contains("recipe:grinder.coarse_log_width")
            && prov.contains("recipe:grinder.boulder_weight")
    );
}

#[test]
fn degenerate_measured_psds_are_errors() {
    for (psd, msg) in [
        (
            json!({"diameter_um": [10, 50, 100], "volume_fraction": [0, 1, 0]}),
            "at least two bins",
        ),
        (
            json!({"diameter_um": [10, 50, 100, 300, 600], "volume_fraction": [0.1, 0.3, 0.6, 0.9, 1.0]}),
            "looks cumulative",
        ),
        (
            json!({"diameter_um": [10, 50, 100, 300, 600], "volume_fraction": [5, 20, 55, 90, 100]}),
            "looks cumulative",
        ),
    ] {
        let err = build_err(&with(generic_recipe(), "grinder", json!({"psd": psd})));
        assert!(err.contains(msg), "{msg}: {err}");
    }
}

#[test]
fn flow_targets_above_the_pump_get_a_note() {
    let r = with(
        generic_recipe(),
        "machine",
        json!({"profile": [{"control": "flow", "target": 12}], "pump": {"type": "ideal", "max_flow_ml_s": 6}}),
    );
    assert!(
        notes(&build_ok(&r)).contains("asks for 12 mL/s but the pump delivers at most 6.0 mL/s")
    );
}

#[test]
fn unit_conversions_keep_short_decimals() {
    // Exercise a known conversion independently of the fitted shell thickness.
    let mut recipe = generic_recipe();
    recipe["overrides"] = json!({"model.extraction.broken_shell_thickness": 25});
    let text = puckmodel::api::build_shot_spec_json(&recipe.to_string()).unwrap();
    assert!(
        text.contains("\"extra_headspace_m3\":5e-6"),
        "{}",
        &text[..300]
    );
    let b: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(num(&b, "spec.solubles.cell_size_m"), 2.5e-5);
    assert_eq!(num(&b, "spec.machine.pump.max_flow_m3_s"), 8e-6);
}

// -- Pump precedence and the three-way valve ------------------------------------------------

fn amzchef(machine: Value) -> Value {
    with(owner_recipe(), "machine", machine)
}

#[test]
fn a_recipe_pump_of_the_preset_type_keeps_the_preset_values_it_omits() {
    // Same type: per field recipe > preset > registry.
    let b = build_ok(&amzchef(json!({"preset": "amzchef-ultra",
        "pump": {"type": "vibratory", "free_flow_ml_s": 6}})));
    let pump = &b["spec"]["machine"]["pump"];
    assert_eq!(num(pump, "free_flow_m3_s"), 6.0 / 1e6);
    assert_eq!(num(pump, "stall_pressure_pa"), 17.0 * 1e5);
    let prov = b["derived"]["provenance"]["machine.pump"].as_str().unwrap();
    assert!(
        prov.contains("recipe:machine.pump.free_flow_ml_s")
            && prov.contains("preset:machine/amzchef-ultra"),
        "{prov}"
    );
    assert!(
        notes(&b).contains(
            "machine.pump gives no stall_pressure_bar; taken from the AMZCHEF Ultra pump"
        )
    );
    // Another type: the registry defaults, with a note.
    let b = build_ok(&amzchef(json!({"preset": "amzchef-ultra",
        "pump": {"type": "ideal", "max_pressure_bar": 9}})));
    let pump = &b["spec"]["machine"]["pump"];
    assert_eq!(num(pump, "max_pressure_pa"), 9.0 * 1e5);
    assert_eq!(num(pump, "max_flow_m3_s"), 8.0 / 1e6);
    let prov = b["derived"]["provenance"]["machine.pump"].as_str().unwrap();
    assert!(
        prov.contains("registry:model.machine.ideal_max_flow"),
        "{prov}"
    );
    assert!(notes(&b).contains("replaces the AMZCHEF Ultra vibratory pump"));
    // An override still beats the preset, and the recipe beats both.
    let mut r = amzchef(json!({"preset": "amzchef-ultra", "pump": {"type": "vibratory"}}));
    r["overrides"] = json!({"model.machine.vibratory_stall_pressure": 14});
    let b = build_ok(&r);
    assert_eq!(
        num(&b["spec"]["machine"]["pump"], "stall_pressure_pa"),
        14.0 * 1e5
    );
    assert_eq!(
        num(&b["spec"]["machine"]["pump"], "free_flow_m3_s"),
        8.0 / 1e6
    );
}

#[test]
fn vent_headspace_follows_recipe_then_preset_then_false() {
    let vent = |b: &Value| {
        b["spec"]["machine"]["stop"]["vent_headspace"]
            .as_bool()
            .unwrap()
    };
    let prov = |b: &Value| {
        b["derived"]["provenance"]["machine.stop.vent_headspace"]
            .as_str()
            .unwrap()
            .to_string()
    };
    let e61 = with(generic_recipe(), "machine", json!({"preset": "e61-rotary"}));
    let b = build_ok(&e61);
    assert!(vent(&b));
    assert_eq!(prov(&b), "preset:machine/e61-rotary");
    let b = build_ok(&with(e61, "machine.vent_headspace", json!(false)));
    assert!(!vent(&b));
    assert_eq!(prov(&b), "recipe:machine.vent_headspace");
    let b = build_ok(&amzchef(json!({"preset": "amzchef-ultra"})));
    assert!(!vent(&b));
    assert!(notes(&b).contains("UNVERIFIED: no three-way valve assumed"));
    // A preset that does not say: false, with a note.
    let b = build_ok(&generic_recipe());
    assert!(!vent(&b));
    assert_eq!(prov(&b), "model:no three-way valve assumed");
    assert!(notes(&b).contains("set machine.vent_headspace to true"));
    let b = build_ok(&with(
        generic_recipe(),
        "machine.vent_headspace",
        json!(true),
    ));
    assert!(vent(&b));
    // With the valve, the cup holds exactly the stop mass.
    let mut r = with(generic_recipe(), "machine.vent_headspace", json!(true));
    r["numerics"] = json!({"tier": 0});
    let run = simulate(&r);
    let m = num(&run["result"]["summary"], "beverage_mass_kg");
    assert!((m - 0.036).abs() < 2e-4, "{m}");
}

#[test]
fn the_solvers_water_check_names_the_overrides_behind_it() {
    // v̄·max(c_sat, K·s₀) ≥ 0.9 is the solver's check; its error names the inputs the user set.
    let mut r = generic_recipe();
    r["overrides"] = json!({
        "extraction.saturation.lumped": 1000,
        "model.extraction.solute_apparent_density": 800
    });
    let err = puckmodel::api::build_shot_spec_json(&r.to_string())
        .unwrap_err()
        .0;
    assert!(
        err.contains("the override of extraction.saturation.lumped")
            && err.contains("the override of model.extraction.solute_apparent_density")
            && !err.contains("internal"),
        "{err}"
    );
}
