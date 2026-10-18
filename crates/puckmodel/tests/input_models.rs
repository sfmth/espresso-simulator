// SPDX-License-Identifier: GPL-2.0-or-later
//! The input models against their anchors (research notes 02 and 03), the
//! from-scratch paths (custom basket, family + gap, measured PSD), overrides
//! and provenance (docs/model/input-models.md).

mod common;

use std::collections::BTreeSet;

use common::*;
use serde_json::{Value, json};

fn with(mut v: Value, path: &str, value: Value) -> Value {
    set(&mut v, path, value);
    v
}

fn bentwood(spacing: f64) -> Value {
    with(
        generic_recipe(),
        "grinder",
        json!({"preset": "bentwood-v63", "setting": spacing}),
    )
}

// -- Grinder → PSD anchors ------------------------------------------------------------

/// Smrke 2024 Fig. 2, digitized in note 03 §2.2: (spacing µm, X50 µm, Q100 %).
const BENTWOOD: [(f64, f64, f64); 6] = [
    (160.0, 232.0, 25.6),
    (170.0, 245.0, 23.9),
    (180.0, 257.0, 22.4),
    (190.0, 267.0, 21.7),
    (210.0, 295.0, 18.8),
    (250.0, 352.0, 15.0),
];

#[test]
fn bentwood_x50_is_1_4_times_the_spacing() {
    for (spacing, x50_data, q100_data) in BENTWOOD {
        let b = build_ok(&bentwood(spacing));
        let x50 = num(&b, "derived.psd.x50_um");
        assert!(
            (x50 / spacing - 1.4).abs() < 1e-9,
            "X50/spacing = {}",
            x50 / spacing
        );
        assert!(
            (x50 / x50_data - 1.0).abs() < 0.04,
            "{spacing}: model {x50:.0} vs data {x50_data}"
        );
        let q100 = 100.0 * num(&b, "derived.psd.fines_fraction");
        assert!(
            (q100 - q100_data).abs() < 1.5,
            "{spacing}: model {q100:.1}% vs data {q100_data}%"
        );
        // The 30 solver classes reproduce the median and the fines.
        let classes = b["spec"]["bed"]["size_classes"].as_array().unwrap();
        assert_eq!(classes.len(), 30);
        let below = |d_um: f64| -> f64 {
            classes
                .iter()
                .filter(|c| num(c, "radius_m") * 2e6 < d_um)
                .map(|c| num(c, "volume_fraction"))
                .sum()
        };
        // Classes are about 17% wide in diameter: the classes' median lies within one class of X50.
        assert!(
            below(x50 * 1.2) > 0.5 && below(x50 / 1.2) < 0.5,
            "{spacing}"
        );
    }
}

fn family_gap(family: &str, gap_um: f64, fines_at_340: Option<f64>) -> Value {
    let mut g = json!({"family": family, "gap_um": gap_um});
    if let Some(u) = fines_at_340 {
        g["fines_at_340_pct"] = json!(u);
    }
    with(generic_recipe(), "grinder", g)
}

/// (fines weight, ln of the coarse mode) of a built PSD.
fn fines_and_coarse(b: &Value) -> (f64, f64) {
    let mix = b["derived"]["psd"]["mixture"].as_array().unwrap();
    (num(&mix[0], "weight"), num(&mix[1], "mode_um").ln())
}

#[test]
fn fines_follow_the_coarse_mode_relation() {
    // Anchor: a 340 µm median has exactly u_G below 100 µm (flat-traditional: 16%).
    let b = build_ok(&family_gap("flat-traditional", 340.0 / 1.4, None));
    assert!((num(&b, "derived.psd.x50_um") - 340.0).abs() < 1e-9);
    assert!((num(&b, "derived.psd.fines_fraction") - 0.16).abs() < 1e-9);
    // logit w_f falls by γ = 2 per unit of ln μ_c (model.psd.fines_weight_slope).
    let logit = |w: f64| (w / (1.0 - w)).ln();
    let (wa, la) = fines_and_coarse(&build_ok(&family_gap("flat-traditional", 60.0, None)));
    let (wb, lb) = fines_and_coarse(&build_ok(&family_gap("flat-traditional", 400.0, None)));
    let slope = -(logit(wb) - logit(wa)) / (lb - la);
    assert!((slope - 2.0).abs() < 1e-6, "{slope}");
    // Finer grinds have more fines, without clamps, from Turkish-like to filter grinds.
    let q = |g: f64| {
        num(
            &build_ok(&family_gap("flat-traditional", g, None)),
            "derived.psd.fines_fraction",
        )
    };
    let qs: Vec<f64> = [40.0, 60.0, 100.0, 190.0, 300.0, 600.0]
        .iter()
        .map(|g| q(*g))
        .collect();
    assert!(qs.windows(2).all(|w| w[1] < w[0]), "{qs:?}");
    assert!(qs[0] > 0.6 && qs[5] > 0.02, "{qs:?}");
}

/// Corrochano 2017 Table 4.1 (dry laser diffraction), grinds ΨA–ΨE: (X50, Q100 %, D32).
const CORROCHANO_DRY: [(f64, f64, f64); 5] = [
    (61.1, 65.7, 48.1),
    (189.6, 35.9, 79.7),
    (265.1, 26.6, 101.6),
    (336.1, 20.1, 112.9),
    (383.0, 16.7, 131.4),
];

#[test]
fn psd_model_reproduces_measured_distributions() {
    // One u_G (19.9%) reproduces Corrochano's disc grinder from a Turkish-like to a coarse
    // espresso grind; the Sauter diameter is within 12% (low by up to 10% mid-range).
    for (x50, q100, d32) in CORROCHANO_DRY {
        let b = build_ok(&family_gap("flat-traditional", x50 / 1.4, Some(19.9)));
        let q = 100.0 * num(&b, "derived.psd.fines_fraction");
        assert!((q - q100).abs() < 1.0, "X50 {x50}: Q100 {q:.1} vs {q100}");
        let d = num(&b, "derived.psd.d32_um");
        assert!(
            (d / d32 - 1.0).abs() < 0.12,
            "X50 {x50}: D32 {d:.1} vs {d32}"
        );
    }
    // Waszkiewicz 2026, Fiorenzato F64 EVO at 1.9 (laser diffraction, three samples):
    // X50 61–64 µm, 65–67% below 100 µm, D32 47–50 µm.
    let b = build_ok(&family_gap("flat-traditional", 62.5 / 1.4, Some(18.4)));
    let q = 100.0 * num(&b, "derived.psd.fines_fraction");
    assert!((64.9..=67.2).contains(&q), "{q}");
    let d = num(&b, "derived.psd.d32_um");
    assert!((d / 48.5 - 1.0).abs() < 0.1, "{d}");
    // Cameron 2020 Fig. 2B, EK43 (laser diffraction): (setting, X50, Q100 %).
    for (gs, x50, q100) in [
        (1.0, 205.3, 28.4),
        (1.5, 250.3, 23.2),
        (2.0, 282.1, 21.3),
        (2.5, 360.4, 15.9),
    ] {
        let r = with(
            generic_recipe(),
            "grinder",
            json!({"preset": "mahlkoenig-ek43", "setting": gs}),
        );
        let x = num(&build_ok(&r), "derived.psd.x50_um");
        assert!((x / x50 - 1.0).abs() < 0.07, "GS {gs}: X50 {x:.0} vs {x50}");
        // The fines relation at the measured median (the EK43's u_G, 16.1%).
        let b = build_ok(&family_gap("flat-traditional", x50 / 1.4, Some(16.1)));
        let q = 100.0 * num(&b, "derived.psd.fines_fraction");
        assert!((q - q100).abs() < 1.2, "GS {gs}: Q100 {q:.1} vs {q100}");
    }
}

#[test]
fn fine_settings_reach_espresso_fine_distributions() {
    // The bottom of the Bentwood dial (50 µm) gives a Turkish-like grind like
    // Waszkiewicz's, with notes on the extrapolation.
    let b = build_ok(&bentwood(50.0));
    assert!((num(&b, "derived.psd.x50_um") - 70.0).abs() < 1e-9);
    let q = num(&b, "derived.psd.fines_fraction");
    assert!((0.6..0.66).contains(&q), "{q}");
    let d32 = num(&b, "derived.psd.d32_um");
    assert!((45.0..52.0).contains(&d32), "{d32}");
    let n = notes(&b);
    assert!(n.contains("outside the settings where the Bentwood Vertical 63 was measured"));
    assert!(n.contains("finer than any measured X50/gap pair"));
    // The Sauter diameter keeps falling down the dial, unlike v1's (stuck near 70 µm).
    let d = |s: f64| num(&build_ok(&bentwood(s)), "derived.psd.d32_um");
    assert!(d(50.0) < d(100.0) && d(100.0) < d(160.0) && d(160.0) < d(250.0));
    // EK43 at 0 (burrs chirping): X50 ≈ 100 µm.
    let r = with(
        generic_recipe(),
        "grinder",
        json!({"preset": "mahlkoenig-ek43", "setting": 0}),
    );
    let b = build_ok(&r);
    assert!((num(&b, "derived.psd.x50_um") - 100.8).abs() < 1e-9);
    assert!(notes(&b).contains("outside the settings where the Mahlkönig EK43"));
}

#[test]
fn e65s_reproduces_the_measured_volume_mean() {
    // Schmieder 2023: wet D43 273 ± 7.6, 277 ± 17 and 295 ± 18 µm at GL 1.4, 1.7 and 2.0.
    for (gl, d43, sd) in [(1.4, 273.0, 7.6), (1.7, 277.0, 17.0), (2.0, 295.0, 18.0)] {
        let r = with(
            generic_recipe(),
            "grinder",
            json!({"preset": "mahlkoenig-e65s", "setting": gl}),
        );
        let b = build_ok(&r);
        let model = num(&b, "derived.psd.d43_um");
        assert!(
            (model - d43).abs() < sd,
            "GL {gl}: model {model:.0} vs {d43} ± {sd}"
        );
    }
    let b = build_ok(&with(
        generic_recipe(),
        "grinder",
        json!({"preset": "mahlkoenig-e65s"}),
    ));
    assert!(notes(&b).contains("Disputed dial scale"));
    assert!(
        b["derived"]["flags"]
            .as_array()
            .unwrap()
            .contains(&json!("disputed"))
    );
}

#[test]
fn ek43_dark_roast_at_2_3_matches_light_at_2_0() {
    // Méndez Harper 2024 (03 §2.2): light at 2.0 matched dark at 2.3.
    let r = |setting: f64, roast: f64| {
        let v = with(
            generic_recipe(),
            "grinder",
            json!({"preset": "mahlkoenig-ek43", "setting": setting}),
        );
        with(v, "bean", json!({"roast_level": roast}))
    };
    let light = num(&build_ok(&r(2.0, 0.25)), "derived.psd.x50_um");
    let dark = num(&build_ok(&r(2.3, 0.85)), "derived.psd.x50_um");
    assert!(
        (dark / light - 1.0).abs() < 0.03,
        "light {light:.0} vs dark {dark:.0}"
    );
    let dark_same = num(&build_ok(&r(2.0, 0.85)), "derived.psd.x50_um");
    assert!(
        dark_same < light,
        "a dark roast grinds finer at the same setting"
    );
}

#[test]
fn every_dial_setting_builds() {
    // Each grinder preset across its whole dial, for light to dark and frozen beans:
    // the PSD solve never fails and the Sauter diameter falls monotonically down the dial.
    for gid in preset_ids("grinders") {
        let dial = preset("grinders", &gid)["dial"].clone();
        let (lo, hi) = (num(&dial, "min"), num(&dial, "max"));
        for bean in [
            json!({"roast_level": 0.0}),
            json!({"roast_level": 1.0, "bean_temp_c": -19}),
        ] {
            let mut last = 0.0;
            for i in 0..=40 {
                let s = lo + (hi - lo) * i as f64 / 40.0;
                let r = with(
                    with(
                        generic_recipe(),
                        "grinder",
                        json!({"preset": gid, "setting": s}),
                    ),
                    "bean",
                    bean.clone(),
                );
                let b = build_ok(&r);
                let d32 = num(&b, "derived.psd.d32_um");
                assert!(d32 >= last - 1e-9, "{gid} at {s}: D32 {d32} after {last}");
                last = d32;
            }
        }
    }
}

#[test]
fn colder_beans_grind_finer() {
    let warm = num(&build_ok(&bentwood(190.0)), "derived.psd.x50_um");
    let frozen = num(
        &build_ok(&with(bentwood(190.0), "bean.bean_temp_c", json!(-19))),
        "derived.psd.x50_um",
    );
    assert!((frozen / warm - 0.9).abs() < 1e-9, "{frozen} vs {warm}");
}

#[test]
fn psd_curve_and_classes() {
    let b = build_ok(&generic_recipe());
    let curve = &b["derived"]["psd_curve"];
    let d = curve["diameter_um"].as_array().unwrap();
    assert_eq!(d.len(), 200);
    assert!(d.windows(2).all(|w| w[1].as_f64() > w[0].as_f64()));
    let classes = b["spec"]["bed"]["size_classes"].as_array().unwrap();
    let total: f64 = classes.iter().map(|c| num(c, "volume_fraction")).sum();
    assert!((total - 1.0).abs() < 1e-12);
    let mix = b["derived"]["psd"]["mixture"].as_array().unwrap();
    assert_eq!(mix.len(), 3);
    assert_eq!(num(&mix[0], "mode_um"), 40.0);
    // Fewer classes on request.
    let b = build_ok(&with(
        generic_recipe(),
        "numerics",
        json!({"size_classes": 8}),
    ));
    assert_eq!(
        b["spec"]["bed"]["size_classes"].as_array().unwrap().len(),
        8
    );
}

#[test]
fn finer_grinds_lower_the_base_permeability() {
    // With κ_ref fixed by an override (independent of the calibrated default), κ₀ falls with
    // the square of the Sauter diameter (review_checks.rs checks the exact formula).
    let k = |s: f64| {
        let mut r = bentwood(s);
        r["overrides"] = json!({"hydraulics.permeability.reference": 2.4e-14});
        num(&build_ok(&r), "spec.hydraulics.permeability_m2")
    };
    assert!(k(50.0) < k(160.0) && k(160.0) < k(190.0) && k(190.0) < k(250.0));
    let b = build_ok(&bentwood(190.0));
    let d32 = num(&b, "derived.bed.sauter_diameter_um");
    assert_eq!(
        num(&b, "derived.psd.d32_um"),
        d32,
        "one Sauter diameter: the classes'"
    );
    assert!((k(190.0) / (2.4e-14 * (d32 / 165.0).powi(2)) - 1.0).abs() < 1e-12);
}

#[test]
fn extreme_settings_are_clamped_with_notes() {
    let b = build_ok(&with(
        generic_recipe(),
        "grinder",
        json!({"preset": "amzchef-single-dose", "setting": 99}),
    ));
    assert_eq!(num(&b, "derived.psd.setting"), 75.0);
    assert!(notes(&b).contains("clamped to 75"));
    let b = build_ok(&with(
        generic_recipe(),
        "grinder",
        json!({"family": "conical", "gap_um": 20}),
    ));
    assert!(notes(&b).contains("finer than the model covers"));
    let b = build_ok(&with(
        generic_recipe(),
        "grinder",
        json!({"family": "flat-unimodal", "gap_um": 1000}),
    ));
    assert!(
        notes(&b).contains("coarser than the PSD data"),
        "{}",
        notes(&b)
    );
    let q = num(&b, "derived.psd.fines_fraction");
    assert!(q > 0.0 && q < 0.02, "{q}");
}

// -- From-scratch descriptions ------------------------------------------------------------

#[test]
fn custom_grinder_from_family_and_gap() {
    let b = build_ok(&with(
        generic_recipe(),
        "grinder",
        json!({"family": "conical", "gap_um": 200}),
    ));
    assert_eq!(num(&b, "derived.psd.x50_um"), 280.0);
    // u_G = 20% at 340 µm for conicals, γ = 2 (checked against an independent Python solve).
    assert!((100.0 * num(&b, "derived.psd.fines_fraction") - 25.00).abs() < 0.01);
    assert_eq!(b["derived"]["presets"]["grinder_family"], "conical");
    // Family plus a dial calibrated from scratch, and recipe refinements.
    let r = with(
        generic_recipe(),
        "grinder",
        json!({"family": "flat-unimodal", "setting": 12, "gap_at_ref_um": 40, "gap_per_unit_um": 12,
               "x50_gap_ratio": 1.5, "fines_at_340_pct": 9, "burr_diameter_mm": 83, "rpm": 1000}),
    );
    let b = build_ok(&r);
    assert_eq!(num(&b, "derived.psd.gap_um"), 184.0);
    assert!((num(&b, "derived.psd.x50_um") - 276.0).abs() < 1e-9);
    assert!(notes(&b).contains("burr diameter and rpm are recorded"));
    let prov = b["derived"]["provenance"]["bed.size_classes"]
        .as_str()
        .unwrap();
    assert!(
        prov.contains("recipe:grinder.x50_gap_ratio")
            && prov.contains("recipe:grinder.fines_at_340_pct")
    );
    // Calibrating the owner's grinder.
    let r = with(
        generic_recipe(),
        "grinder",
        json!({"preset": "amzchef-single-dose", "setting": 10, "gap_at_ref_um": 80, "gap_per_unit_um": 10}),
    );
    assert_eq!(num(&build_ok(&r), "derived.psd.gap_um"), 180.0);
    // Errors.
    let err = build_err(&with(
        generic_recipe(),
        "grinder",
        json!({"family": "conical"}),
    ));
    assert!(err.contains("with a family, give gap_um"));
    let err = build_err(&with(
        generic_recipe(),
        "grinder",
        json!({"family": "spiral"}),
    ));
    assert!(err.contains("spiral") && err.contains("conical"));
}

fn lognormal_psd(n: usize) -> Value {
    let mut d = Vec::new();
    let mut f = Vec::new();
    for i in 0..n {
        let x = 5.0 * (2000.0f64 / 5.0).powf(i as f64 / (n - 1) as f64);
        let z = (x / 300.0).ln() / 0.5;
        d.push(x);
        f.push((-0.5 * z * z).exp() + 0.3 * (-0.5 * ((x / 40.0).ln() / 0.6).powi(2)).exp());
    }
    json!({"diameter_um": d, "volume_fraction": f, "method": "dry_laser"})
}

#[test]
fn measured_psd_is_used_and_rebinned() {
    let b = build_ok(&with(
        generic_recipe(),
        "grinder",
        json!({"psd": lognormal_psd(80)}),
    ));
    assert_eq!(b["derived"]["psd"]["source"], "measured");
    let classes = b["spec"]["bed"]["size_classes"].as_array().unwrap();
    assert!(
        classes.len() <= 30 && classes.len() >= 25,
        "{}",
        classes.len()
    );
    let total: f64 = classes.iter().map(|c| num(c, "volume_fraction")).sum();
    assert!((total - 1.0).abs() < 1e-12);
    assert!(notes(&b).contains("rebinned onto"));
    assert_eq!(
        b["derived"]["psd_curve"]["diameter_um"]
            .as_array()
            .unwrap()
            .len(),
        80
    );
    assert_eq!(
        b["derived"]["provenance"]["bed.size_classes"],
        "recipe:grinder.psd, model:log-spaced size classes"
    );
    // The median of the input survives rebinning.
    let x50 = num(&b, "derived.psd.x50_um");
    assert!((150.0..350.0).contains(&x50), "{x50}");
}

#[test]
fn short_measured_psds_are_used_as_given() {
    // The 2-class literature mode (Grudeva 2026: 3.65 and 229 µm radii).
    let psd = json!({"diameter_um": [7.3, 458.0], "volume_fraction": [0.18, 0.82]});
    let b = build_ok(&with(generic_recipe(), "grinder", json!({"psd": psd})));
    let classes = b["spec"]["bed"]["size_classes"].as_array().unwrap();
    assert_eq!(classes.len(), 2);
    assert!((num(&classes[0], "radius_m") - 3.65e-6).abs() < 1e-15);
    assert!((num(&classes[1], "radius_m") - 229e-6).abs() < 1e-15);
    assert!((num(&classes[1], "volume_fraction") - 0.82).abs() < 1e-15);
    // Errors.
    for (psd, msg) in [
        (
            json!({"diameter_um": [10, 5], "volume_fraction": [1, 1]}),
            "strictly increasing",
        ),
        (
            json!({"diameter_um": [10, 50], "volume_fraction": [1]}),
            "same length",
        ),
        (
            json!({"diameter_um": [10, 50], "volume_fraction": [0, 0]}),
            "all zero",
        ),
        (
            json!({"diameter_um": [10, 50], "volume_fraction": [1, -1]}),
            "≥ 0",
        ),
        (
            json!({"diameter_um": [10, 50], "volume_fraction": [1, 1], "method": "guess"}),
            "method",
        ),
    ] {
        let err = build_err(&with(generic_recipe(), "grinder", json!({"psd": psd})));
        assert!(err.contains(msg), "{msg}: {err}");
    }
}

#[test]
fn startup_timescale_uses_measured_particles_and_is_independent_of_solver_tier() {
    let recipe = |scale: f64, tier: u8| {
        let r = with(
            generic_recipe(),
            "grinder",
            json!({"psd": {
                "diameter_um": [40.0 * scale, 160.0 * scale],
                "volume_fraction": [0.5, 0.5]
            }}),
        );
        with(r, "numerics", json!({"tier": tier}))
    };
    let fine = build_ok(&recipe(1.0, 1));
    let coarse = build_ok(&recipe(2.0, 1));
    let preview = build_ok(&recipe(1.0, 0));
    let time = |b: &Value| num(b, "spec.hydraulics.pore_air.tau_s");
    // Diffusive times change as length squared; tier reduction must not
    // silently change the physical input inferred from the measured PSD.
    assert!((time(&coarse) / time(&fine) - 4.0).abs() < 1e-12);
    assert_eq!(time(&fine), time(&preview));
    let faster = build_ok(&with(
        recipe(1.0, 1),
        "overrides",
        json!({"model.hydraulics.moisture_diffusivity": 5e-11}),
    ));
    assert!((time(&faster) / time(&fine) - 0.5).abs() < 1e-12);
    assert!(
        fine["derived"]["provenance"]["hydraulics.pore_air.tau_s"]
            .as_str()
            .unwrap()
            .contains("recipe:grinder.psd")
    );
}

#[test]
fn pore_air_is_separate_from_roast_gas_and_can_be_disabled() {
    let fresh = build_ok(&with(generic_recipe(), "bean.days_off_roast", json!(1)));
    let old = build_ok(&with(generic_recipe(), "bean.days_off_roast", json!(60)));
    assert!(
        num(&fresh, "spec.hydraulics.gas.amplitude") > num(&old, "spec.hydraulics.gas.amplitude")
    );
    assert_eq!(
        fresh["spec"]["hydraulics"]["pore_air"],
        old["spec"]["hydraulics"]["pore_air"]
    );
    let disabled = build_ok(&with(
        generic_recipe(),
        "overrides",
        json!({"model.hydraulics.pore_air_amplitude": 0}),
    ));
    assert_eq!(num(&disabled, "spec.hydraulics.pore_air.amplitude"), 0.0);
    assert!(!notes(&disabled).contains("trapped pore air reduces early permeability"));
    assert_eq!(
        num(&disabled, "spec.hydraulics.intraparticle_water_fraction"),
        1.0
    );
}

#[test]
fn custom_baskets_of_any_shape() {
    let shapes = [
        (
            "straight",
            json!({"profile_mm": [[0, 58], [22, 58]], "perforated_diameter_mm": 52}),
        ),
        (
            "tapered",
            json!({"profile_mm": [[0, 44], [24, 58]], "perforated_diameter_mm": 38}),
        ),
        (
            "stepped",
            json!({"profile_mm": [[0, 40], [6, 40], [6.5, 56], [24, 58]], "perforated_diameter_mm": 36}),
        ),
        (
            "pressurised",
            json!({"profile_mm": [[0, 46], [24, 58]], "perforated_diameter_mm": 40, "pressurised_orifice_mm": 0.35}),
        ),
        (
            "49 mm",
            json!({"profile_mm": [[0, 44], [18, 49]], "perforated_diameter_mm": 38}),
        ),
    ];
    for (name, custom) in &shapes {
        let r = with(generic_recipe(), "basket", json!({"custom": custom}));
        let r = with(r, "prep.dose_g", json!(14));
        let b = build_ok(&r);
        let profile = b["spec"]["basket"]["profile_m"].as_array().unwrap();
        let given = custom["profile_mm"].as_array().unwrap();
        assert_eq!(profile.len(), given.len(), "{name}");
        for (p, g) in profile.iter().zip(given) {
            assert!((num(p, "0") - num(g, "0") / 1000.0).abs() < 1e-15);
            assert!(
                (num(p, "1") - num(g, "1") / 2000.0).abs() < 1e-15,
                "{name}: radius from diameter"
            );
        }
        assert_eq!(
            b["derived"]["provenance"]["basket.profile_m"],
            "recipe:basket.custom"
        );
        puckmodel::api::simulate_recipe_json(&r.to_string()).unwrap();
    }
    let r = with(
        generic_recipe(),
        "basket",
        json!({"custom": shapes[3].1.clone()}),
    );
    let outlet = &build_ok(&r)["spec"]["basket"]["outlet"];
    assert_eq!(outlet["type"], "pressurised");
    assert!((num(outlet, "orifice_diameter_m") - 0.35e-3).abs() < 1e-18);
    assert_eq!(num(outlet, "discharge_coefficient"), 0.7);
}

#[test]
fn custom_basket_validation() {
    for (custom, msg) in [
        (
            json!({"profile_mm": [[1, 58], [22, 58]], "perforated_diameter_mm": 50}),
            "height 0",
        ),
        (
            json!({"profile_mm": [[0, 58], [0, 58]], "perforated_diameter_mm": 50}),
            "strictly increase",
        ),
        (
            json!({"profile_mm": [[0, 58]], "perforated_diameter_mm": 50}),
            "at least two",
        ),
        (
            json!({"profile_mm": [[0, 50], [22, 58]], "perforated_diameter_mm": 52}),
            "floor diameter",
        ),
        (
            json!({"profile_mm": [[0, 58], [22, 58]], "perforated_diameter_mm": 50, "open_area_fraction": 2}),
            "open_area",
        ),
        (
            json!({"profile_mm": [[0, 58], [22, 58]], "perforated_diameter_mm": 50, "pressurised_orifice_mm": 0}),
            "orifice",
        ),
    ] {
        let err = build_err(&with(generic_recipe(), "basket", json!({"custom": custom})));
        assert!(err.contains(msg), "{msg}: {err}");
    }
}

#[test]
fn edge_multiplier_follows_the_perforated_field_and_taper() {
    let build = |profile: Value, perf: f64| {
        let custom = json!({"profile_mm": profile, "perforated_diameter_mm": perf});
        build_ok(&with(generic_recipe(), "basket", json!({"custom": custom})))
    };
    let edge = |b: &Value| num(b, "spec.bed.heterogeneity.edge_multiplier");
    let straight = |perf: f64| build(json!([[0, 56], [22, 58]]), perf);
    assert!(edge(&straight(40.0)) < edge(&straight(48.0)));
    // ((r_p/r_bed)/0.87)² × 0.35 for the default preparation, with r_bed the bed's
    // volume-equivalent radius √(V/(πL)).
    let b = straight(48.0);
    let volume = 0.018 / num(&b, "derived.bed.bulk_density_kg_m3");
    let r_bed = (volume / (std::f64::consts::PI * num(&b, "derived.bed.height_mm") / 1e3)).sqrt();
    let want = 0.35 * (0.024 / r_bed / 0.87f64).powi(2);
    assert!((edge(&b) - want).abs() < 1e-9, "{} vs {want}", edge(&b));
    // A strongly tapered basket with the same floor and perforated field has a wider bed above
    // the floor, so its edge funnels more: a smaller multiplier.
    let tapered = build(json!([[0, 46], [24, 64]]), 40.0);
    let near_straight = build(json!([[0, 46], [24, 48]]), 40.0);
    assert!(
        edge(&tapered) < edge(&near_straight),
        "{} vs {}",
        edge(&tapered),
        edge(&near_straight)
    );
}

// -- Bean, puck preparation, machine -------------------------------------------------------

fn species(b: &Value, id: &str) -> f64 {
    let list = b["spec"]["solubles"]["species"].as_array().unwrap();
    num(
        list.iter().find(|s| s["id"] == id).unwrap(),
        "mass_fraction",
    )
}

#[test]
fn bean_model_composition() {
    let bean = |v: Value| build_ok(&with(generic_recipe(), "bean", v));
    let arabica = bean(json!({"arabica_fraction": 1.0}));
    let robusta = bean(json!({"arabica_fraction": 0.0}));
    let blend = bean(json!({"arabica_fraction": 0.8}));
    assert!((species(&arabica, "caffeine") - 0.012).abs() < 1e-15);
    assert!((species(&robusta, "caffeine") - 0.026).abs() < 1e-12);
    assert!((species(&blend, "caffeine") - (0.8 * 0.012 + 0.2 * 0.026)).abs() < 1e-12);
    assert!(
        num(&robusta, "spec.solubles.extractable_fraction")
            > num(&arabica, "spec.solubles.extractable_fraction")
    );
    let light = bean(json!({"roast_level": 0.0}));
    let dark = bean(json!({"roast_level": 1.0}));
    assert!((species(&light, "trigonelline") - 0.012).abs() < 1e-12);
    assert!((species(&dark, "trigonelline") - 0.002).abs() < 1e-12);
    assert!(species(&light, "cqa5") > species(&dark, "cqa5"));
    assert_eq!(species(&light, "caffeine"), species(&dark, "caffeine"));
    assert!(
        num(&dark, "spec.bed.intraparticle_porosity")
            > num(&light, "spec.bed.intraparticle_porosity")
    );
    assert_eq!(num(&arabica, "spec.solubles.reference_temp_c"), 80.0);
}

#[test]
fn co2_and_gas_follow_roast_and_age() {
    let gas = |roast: f64, days: f64| {
        let b = build_ok(&with(
            generic_recipe(),
            "bean",
            json!({"roast_level": roast, "days_off_roast": days}),
        ));
        (
            num(&b, "spec.hydraulics.gas.amplitude"),
            num(&b, "derived.bean.co2_puck_mg_g"),
        )
    };
    assert!(
        gas(0.8, 5.0).0 > gas(0.3, 5.0).0,
        "darker roasts hold more CO₂"
    );
    assert!(gas(0.5, 3.0).0 > gas(0.5, 30.0).0, "CO₂ degasses with age");
    let (a, c) = gas(0.5, 0.0);
    assert!(a > 0.0 && a < 0.5 && c > 0.0);
    // Fresh grounds hold the measured residual (bean.co2.ground_residual, 4.5–12 mg/g).
    let (_, fresh) = gas(0.59, 0.0);
    assert!((fresh - 8.25).abs() < 1e-9, "{fresh}");
    assert!((4.5..12.0).contains(&c), "{c}");
    // Smrke's medium roast (101 Pt = roast level 0.59) keeps e^-1 of its CO₂ after 230 h.
    let (_, c) = gas(0.59, 230.0 / 24.0);
    assert!((c - 8.25 * (-1.0f64).exp()).abs() < 1e-9, "{c}");
    // A medium roast ten days off roast: on the residual's scale, not a fraction of it.
    let b = build_ok(&generic_recipe());
    let puck = num(&b, "derived.bean.co2_puck_mg_g");
    assert!((2.0..5.0).contains(&puck), "{puck}");
    let beans = num(&b, "derived.bean.co2_beans_mg_g");
    assert!(
        (beans - 2.0 * puck).abs() < 1e-12,
        "grinding loses half (model.bean.co2_grinding_loss)"
    );
}

#[test]
fn bean_defaults_process_and_validation() {
    let b = build_ok(&generic_recipe());
    assert_eq!(b["derived"]["bean"]["preset"], "medium-washed-arabica");
    assert!(notes(&b).contains("not given; taken from Medium-roast washed Arabica"));
    let washed = build_ok(&with(
        generic_recipe(),
        "bean",
        json!({"process": "washed"}),
    ));
    let natural = build_ok(&with(
        generic_recipe(),
        "bean",
        json!({"process": "natural"}),
    ));
    assert_eq!(
        washed["spec"], natural["spec"],
        "washed/natural labels have no universal correction for tracked roasted compounds"
    );
    assert!(
        notes(&natural).contains("no quantitative correction is applied to the tracked compounds")
    );
    for (bean, msg) in [
        (json!({"roast_level": 1.5}), "roast_level"),
        (json!({"arabica_fraction": -0.1}), "arabica_fraction"),
        (json!({"days_off_roast": -1}), "days_off_roast"),
        (json!({"process": "wet-hulled"}), "process"),
        (json!({"preset": "kopi-luwak"}), "kopi-luwak"),
    ] {
        let err = build_err(&with(generic_recipe(), "bean", bean));
        assert!(err.contains(msg), "{msg}: {err}");
    }
}

#[test]
fn puck_preparation() {
    let prep = |v: Value| build_ok(&with(generic_recipe(), "prep", v));
    let none = prep(json!({"dose_g": 18, "distribution": "none"}));
    let wdt = prep(json!({"dose_g": 18, "distribution": "wdt"}));
    let s = |b: &Value| num(b, "spec.bed.heterogeneity.sigma_ln_permeability");
    assert!(s(&wdt) < s(&none));
    let paper = prep(json!({"dose_g": 18, "paper_bottom": true}));
    let screen = prep(json!({"dose_g": 18, "puck_screen": true}));
    let plain = prep(json!({"dose_g": 18}));
    let e = |b: &Value| num(b, "spec.bed.heterogeneity.edge_multiplier");
    assert!(e(&paper) > e(&plain) && e(&screen) > e(&plain));
    let u = |b: &Value| num(b, "spec.bed.heterogeneity.prewet_nonuniformity");
    assert!(u(&screen) < u(&plain));
    // Tamp and a top paper change nothing but the notes.
    let light = prep(json!({"dose_g": 18, "tamp_kgf": 3}));
    let firm = prep(json!({"dose_g": 18, "tamp_kgf": 20, "paper_top": true}));
    assert_eq!(light["spec"], plain["spec"]);
    assert_eq!(firm["spec"], plain["spec"]);
    assert!(notes(&light).contains("loose bed"));
    assert!(notes(&firm).contains("no measurable effect above about 10 kgf"));
    assert!(notes(&firm).contains("top paper"));
    // More headspace (a smaller dose in the same basket) → more pre-wetting non-uniformity.
    let small = prep(json!({"dose_g": 14}));
    assert!(u(&small) > u(&plain));
    let err = build_err(&with(
        generic_recipe(),
        "prep",
        json!({"dose_g": 18, "distribution": "spin"}),
    ));
    assert!(err.contains("prep.distribution"));
}

#[test]
fn custom_program_and_pump() {
    let r = with(
        generic_recipe(),
        "machine",
        json!({
            "profile": [
                {"control": "flow", "target": 4, "limit": 3, "until_pressure_bar": 2.5, "until_time_s": 10},
                {"control": "pressure", "target": 6, "ramp_s": 1, "limit": 2.5, "until_beverage_g": 20},
                {"control": "pump"}
            ],
            "pump": {"type": "vibratory", "free_flow_ml_s": 7, "stall_pressure_bar": 14, "opv_bar": 10},
            "temperature_c": 91,
            "headspace_ml": 3
        }),
    );
    let b = build_ok(&r);
    let ph = &b["spec"]["machine"]["phases"];
    assert_eq!(
        ph[0]["control"],
        json!({"type": "flow", "target_m3_s": 4e-6})
    );
    assert_eq!(num(ph, "0.limit"), 3e5);
    assert_eq!(num(ph, "0.exit.pressure_pa"), 2.5e5);
    assert_eq!(num(ph, "0.exit.time_s"), 10.0);
    assert_eq!(num(ph, "0.ramp_s"), 2.0, "registry default ramp");
    assert_eq!(
        ph[1]["control"],
        json!({"type": "pressure", "target_pa": 6e5})
    );
    assert!((num(ph, "1.limit") - 2.5e-6).abs() < 1e-18);
    assert_eq!(num(ph, "1.exit.beverage_mass_kg"), 0.02);
    assert_eq!(ph[2]["control"], json!({"type": "pump_full"}));
    let pump = &b["spec"]["machine"]["pump"];
    assert_eq!(pump["type"], "vibratory");
    assert!((num(pump, "free_flow_m3_s") - 7e-6).abs() < 1e-18);
    assert_eq!(num(pump, "stall_pressure_pa"), 1.4e6);
    assert_eq!(num(pump, "opv_pa"), 1e6);
    assert_eq!(num(&b, "spec.thermal.water_temp_c"), 91.0);
    assert!((num(&b, "spec.basket.extra_headspace_m3") - 3e-6).abs() < 1e-18);
    puckmodel::api::simulate_recipe_json(&r.to_string()).unwrap();
    // A profile without a pump gets an ideal pump from the registry.
    let r = with(
        generic_recipe(),
        "machine",
        json!({"profile": [{"control": "pressure", "target": 9}]}),
    );
    let pump = &build_ok(&r)["spec"]["machine"]["pump"];
    assert_eq!(pump["type"], "ideal");
    assert!((num(pump, "max_flow_m3_s") - 8e-6).abs() < 1e-18);
    // A preset with its own program replaced.
    let r = with(
        generic_recipe(),
        "machine",
        json!({"preset": "amzchef-ultra", "profile": [{"control": "flow", "target": 2}]}),
    );
    let b = build_ok(&r);
    assert_eq!(b["spec"]["machine"]["pump"]["type"], "vibratory");
    assert_eq!(b["spec"]["machine"]["phases"][0]["control"]["type"], "flow");
}

#[test]
fn program_validation() {
    for (profile, msg) in [
        (json!([{"control": "pressure"}]), "needs a target"),
        (
            json!([{"control": "flow", "target": 4}, {"control": "pressure", "target": 9}]),
            "only the last phase",
        ),
        (
            json!([{"control": "lever", "target": 9}]),
            "must be \"pressure\"",
        ),
        (json!([]), "at least one phase"),
        (
            json!([{"control": "pressure", "target": 9, "ramp_s": -1}]),
            "ramp_s",
        ),
    ] {
        let err = build_err(&with(
            generic_recipe(),
            "machine",
            json!({"profile": profile}),
        ));
        assert!(err.contains(msg), "{msg}: {err}");
    }
}

#[test]
fn machine_defaults_and_ranges() {
    // The machine's default basket when the recipe has none.
    let r = with(
        with(owner_recipe(), "basket", json!({})),
        "prep.dose_g",
        json!(16),
    );
    let b = build_ok(&r);
    assert_eq!(b["derived"]["presets"]["basket"], "58-stock-double");
    assert!(notes(&b).contains("using the machine's default basket"));
    // Outside the AMZCHEF Ultra's PID range.
    let b = build_ok(&with(owner_recipe(), "machine.temperature_c", json!(98)));
    assert!(notes(&b).contains("outside the AMZCHEF Ultra temperature range"));
    // A 54 mm basket on a 58 mm machine.
    let r = with(
        with(owner_recipe(), "basket", json!({"preset": "54-double"})),
        "prep.dose_g",
        json!(18),
    );
    assert!(notes(&build_ok(&r)).contains("does not match the machine's 58 mm portafilter"));
    // Default stop rule.
    let b = build_ok(&with(generic_recipe(), "stop", json!({})));
    assert_eq!(num(&b, "spec.machine.stop.beverage_mass_kg"), 0.036);
    assert!(notes(&b).contains("stopping at 2× the dose"));
    // Thermal node: preheated portafilter, room-temperature grounds.
    let t0 = num(&b, "spec.thermal.initial_bed_temp_c");
    assert!((20.0..85.0).contains(&t0), "{t0}");
}

// -- Overrides ---------------------------------------------------------------------------

#[test]
fn overrides_follow_the_precedence() {
    let base = build_ok(&generic_recipe());
    // Half the current default, whether it comes from the registry or from the
    // calibration, so the test does not depend on the calibrated value.
    let registry: Value = serde_json::from_str(&puckmodel::api::registry_json()).unwrap();
    let kappa_ref = registry["parameters"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["id"] == "hydraulics.permeability.reference")
        .and_then(|p| p["default"].as_f64())
        .unwrap();
    let r = with(
        generic_recipe(),
        "overrides",
        json!({"hydraulics.permeability.reference": kappa_ref / 2.0}),
    );
    let b = build_ok(&r);
    let ratio =
        num(&b, "spec.hydraulics.permeability_m2") / num(&base, "spec.hydraulics.permeability_m2");
    assert!(
        (ratio - 0.5).abs() < 1e-12,
        "κ₀ scales with the override: {ratio}"
    );
    assert!(
        b["derived"]["provenance"]["hydraulics.permeability_m2"]
            .as_str()
            .unwrap()
            .contains("override:hydraulics.permeability.reference")
    );
    // Overrides beat the bean model and presets ...
    let r = with(
        bentwood(200.0),
        "overrides",
        json!({"bed.porosity.intraparticle": 0.5, "psd.x50_gap_ratio": 1.2, "bean.composition.arabica.caffeine": 1.5}),
    );
    let b = build_ok(&r);
    assert_eq!(num(&b, "spec.bed.intraparticle_porosity"), 0.5);
    assert!((num(&b, "derived.psd.x50_um") - 240.0).abs() < 1e-9);
    assert!((species(&b, "caffeine") - 0.015).abs() < 1e-15);
    assert_eq!(
        b["derived"]["provenance"]["bed.intraparticle_porosity"],
        "override:bed.porosity.intraparticle"
    );
    // ... but an explicit recipe field beats an override of the same quantity, with a note.
    let b = build_ok(&with(r, "grinder.x50_gap_ratio", json!(1.6)));
    assert!((num(&b, "derived.psd.x50_um") - 320.0).abs() < 1e-9);
    assert!(
        notes(&b)
            .contains("recipe field grinder.x50_gap_ratio beats the override of psd.x50_gap_ratio")
    );
}

#[test]
fn unknown_or_out_of_range_overrides_are_errors() {
    let err = build_err(&with(
        generic_recipe(),
        "overrides",
        json!({"hydraulics.permeabilty.in_shot": 1e-15}),
    ));
    assert!(err.contains("\"hydraulics.permeabilty.in_shot\""), "{err}");
    let err = build_err(&with(
        generic_recipe(),
        "overrides",
        json!({"bed.porosity.intergranular": 1.5}),
    ));
    assert!(
        err.contains("bed.porosity.intergranular") && err.contains("outside its range"),
        "{err}"
    );
}

#[test]
fn unused_overrides_get_a_note() {
    let b = build_ok(&with(
        generic_recipe(),
        "overrides",
        json!({"kinetics.schmieder2023.lambda.caffeine": 20}),
    ));
    assert!(notes(&b).contains("Override kinetics.schmieder2023.lambda.caffeine has no effect"));
}

// -- Provenance --------------------------------------------------------------------------

/// Checks one provenance token; returns a problem or None.
fn token_problem(token: &str, ids: &BTreeSet<String>) -> Option<String> {
    let (kind, rest) = token.split_once(':')?;
    match kind {
        "registry" | "calibration" | "override" => {
            (!ids.contains(rest)).then(|| format!("unknown registry id in {token}"))
        }
        "preset" => {
            let (list, id) = rest.split_once('/').unwrap_or(("", ""));
            let list = match list {
                "grinder" => "grinders",
                "grinder_family" => "grinder_families",
                "basket" => "baskets",
                "machine" => "machines",
                "bean" => "beans",
                _ => return Some(format!("unknown preset kind in {token}")),
            };
            (!preset_ids(list).contains(&id.to_string()))
                .then(|| format!("unknown preset in {token}"))
        }
        "recipe" => {
            let top = rest.split('.').next().unwrap();
            (![
                "bean", "grinder", "basket", "prep", "machine", "stop", "numerics",
            ]
            .contains(&top))
            .then(|| format!("bad recipe path in {token}"))
        }
        "model" => None,
        _ => Some(format!("unknown token kind in {token}")),
    }
}

#[test]
fn provenance_is_filled_and_every_token_resolves() {
    let ids = registry_ids();
    let required = [
        "basket.profile_m",
        "basket.perforated_radius_m",
        "basket.open_area_fraction",
        "basket.outlet",
        "basket.extra_headspace_m3",
        "bed.dose_kg",
        "bed.intergranular_porosity",
        "bed.intraparticle_porosity",
        "bed.skeletal_density_kg_m3",
        "bed.size_classes",
        "bed.heterogeneity.sigma_ln_permeability",
        "bed.heterogeneity.edge_area_fraction",
        "bed.heterogeneity.edge_multiplier",
        "bed.heterogeneity.prewet_nonuniformity",
        "solubles.extractable_fraction",
        "solubles.cell_size_m",
        "solubles.saturation_kg_m3",
        "solubles.partition_coefficient",
        "solubles.kernel_diffusivity_m2_s",
        "solubles.surface_rate_m_s",
        "solubles.reference_temp_c",
        "solubles.species[3].kernel_diffusivity_m2_s",
        "hydraulics.permeability_m2",
        "hydraulics.poroelastic_pc_pa",
        "hydraulics.swelling.amplitude",
        "hydraulics.gas.amplitude",
        "hydraulics.fines_layer.amplitude",
        "hydraulics.axial_dispersion_m2_s",
        "hydraulics.viscosity",
        "hydraulics.wetting_uptake",
        "hydraulics.intraparticle_water_fraction",
        "hydraulics.pore_air.amplitude",
        "hydraulics.pore_air.tau_s",
        "hydraulics.pore_air_permeability_exponent",
        "thermal.water_temp_c",
        "thermal.initial_bed_temp_c",
        "thermal.heat_capacity_j_k",
        "thermal.heat_loss_w_k",
        "machine.phases",
        "machine.pump",
        "machine.hydraulic_compliance_m3_pa",
        "machine.stop.beverage_mass_kg",
        "machine.stop.drip_tau_s",
        "numerics.tier",
    ];
    let recipes = [
        owner_recipe(),
        generic_recipe(),
        with(
            generic_recipe(),
            "grinder",
            json!({"psd": lognormal_psd(40)}),
        ),
        with(generic_recipe(), "overrides", json!({"psd.fines_mode": 35})),
        with(
            generic_recipe(),
            "basket",
            json!({"preset": "51-pressurised-double"}),
        ),
    ];
    for r in &recipes {
        let r = with(r.clone(), "prep.dose_g", json!(14));
        let b = build_ok(&r);
        let prov = b["derived"]["provenance"].as_object().unwrap();
        for path in required {
            let src = prov
                .get(path)
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("no provenance for {path}"));
            assert!(!src.is_empty(), "{path}");
        }
        for (path, src) in prov {
            for token in src.as_str().unwrap().split(", ") {
                if let Some(problem) = token_problem(token, &ids) {
                    panic!("{path}: {problem}");
                }
                assert!(token.contains(':'), "{path}: token {token:?} has no kind");
            }
        }
    }
}
