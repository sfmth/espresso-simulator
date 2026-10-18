// SPDX-License-Identifier: GPL-2.0-or-later

use puckcore::shot::{ShotSpec, SizeClass, SpeciesSpec};

/// Matches the existing shot report's bimodal 30-class physical workload.
fn realistic() -> ShotSpec {
    let mut spec = ShotSpec::default();
    let (dmin, dmax) = (5e-6_f64, 1000e-6_f64);
    let mut classes = Vec::new();
    let mut total = 0.0;
    for i in 0..30 {
        let d = dmin * (dmax / dmin).powf((i as f64 + 0.5) / 30.0);
        let lnd = d.ln();
        let mode = |mu: f64, sig: f64| (-(lnd - mu.ln()).powi(2) / (2.0 * sig * sig)).exp() / sig;
        let w = 0.25 * mode(40e-6, 0.5) + 0.75 * mode(350e-6, 0.4);
        total += w;
        classes.push(SizeClass {
            radius_m: d / 2.0,
            volume_fraction: w,
        });
    }
    for class in &mut classes {
        class.volume_fraction /= total;
    }
    spec.bed.size_classes = classes;
    spec.solubles.species = [
        ("caffeine", 0.012, 1.9e-10, 1.0),
        ("trigonelline", 0.008, 2.0e-10, 0.61),
        ("cqa5", 0.011, 1.5e-10, 0.61),
        ("acids", 0.016, 2.5e-10, 0.61),
    ]
    .into_iter()
    .map(
        |(id, mass_fraction, kernel_diffusivity_m2_s, partition_coefficient)| SpeciesSpec {
            id: id.into(),
            mass_fraction,
            kernel_diffusivity_m2_s,
            partition_coefficient,
            surface_fraction_scale: 1.0,
        },
    )
    .collect();
    spec
}

pub fn workloads() -> Vec<(&'static str, ShotSpec)> {
    let default = ShotSpec::default();
    let mut tier0 = default.clone();
    tier0.numerics.tier = 0;
    let realistic = realistic();
    let mut realistic0 = realistic.clone();
    realistic0.numerics.tier = 0;
    let mut isothermal = realistic.clone();
    isothermal.thermal.initial_bed_temp_c = isothermal.thermal.water_temp_c;
    isothermal.thermal.ambient_temp_c = isothermal.thermal.water_temp_c;
    isothermal.thermal.heat_loss_w_k = 0.0;
    vec![
        ("default-tier1", default),
        ("default-tier0", tier0),
        ("30-classes-4-species-tier1", realistic),
        ("30-classes-4-species-tier0", realistic0),
        ("30-classes-4-species-isothermal", isothermal),
    ]
}
