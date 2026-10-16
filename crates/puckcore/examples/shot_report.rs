// SPDX-License-Identifier: GPL-2.0-or-later
//! Report for the shot solver: the plausibility table, the flow-rise
//! decomposition, the wetting-front checks, kernel re-uptake, tier 0 against
//! tier 1, discretisation convergence and timings of
//! `docs/model/shot-model.md` §8–§10. The closed-form verification cases are
//! in `tests/shot_verification.rs`, the review regressions in
//! `tests/shot_regressions.rs`.
//!
//! ```text
//! cargo run --release -p puckcore --example shot_report
//! ```

use std::time::Instant;

use puckcore::shot::*;

fn run(s: &ShotSpec) -> ShotResult {
    simulate_shot(s).expect("valid spec")
}

/// A 30-class bimodal log-normal size distribution (fines mode 40 µm, coarse
/// mode 350 µm diameter) and four species: the size of what the input
/// models produce.
pub fn realistic() -> ShotSpec {
    let mut s = ShotSpec::default();
    let n = 30;
    let (dmin, dmax) = (5e-6_f64, 1000e-6_f64);
    let mut classes = Vec::new();
    let mut total = 0.0;
    for i in 0..n {
        let d = dmin * (dmax / dmin).powf((i as f64 + 0.5) / n as f64);
        let lnd = d.ln();
        let mode = |mu: f64, sig: f64| (-(lnd - mu.ln()).powi(2) / (2.0 * sig * sig)).exp() / sig;
        let w = 0.25 * mode(40e-6, 0.5) + 0.75 * mode(350e-6, 0.4);
        total += w;
        classes.push(SizeClass {
            radius_m: d / 2.0,
            volume_fraction: w,
        });
    }
    for c in &mut classes {
        c.volume_fraction /= total;
    }
    s.bed.size_classes = classes;
    let sp = |id: &str, w: f64, d: f64, k: f64| SpeciesSpec {
        id: id.into(),
        mass_fraction: w,
        kernel_diffusivity_m2_s: d,
        partition_coefficient: k,
        surface_fraction_scale: 1.0,
    };
    s.solubles.species = vec![
        sp("caffeine", 0.012, 1.9e-10, 1.0),
        sp("trigonelline", 0.008, 2.0e-10, 0.61),
        sp("cqa5", 0.011, 1.5e-10, 0.61),
        sp("acids", 0.016, 2.5e-10, 0.61),
    ];
    s
}

fn time_ms(s: &ShotSpec, reps: usize) -> f64 {
    let mut t: Vec<f64> = (0..reps)
        .map(|_| {
            let t0 = Instant::now();
            let _ = run(s);
            t0.elapsed().as_secs_f64() * 1e3
        })
        .collect();
    t.sort_by(|a, b| a.partial_cmp(b).unwrap());
    t[t.len() / 2]
}

fn headline(r: &ShotResult) -> (f64, f64, f64, f64) {
    let s = &r.summary;
    (
        s.ey * 100.0,
        s.tds * 100.0,
        s.shot_time_s,
        s.first_drops_s.unwrap_or(f64::NAN),
    )
}

fn convergence() {
    println!("\n## Convergence (default spec; changes relative to the finest run)\n");
    let base = ShotSpec::default();
    let report = |label: &str, specs: Vec<(String, ShotSpec)>| {
        let results: Vec<(String, (f64, f64, f64, f64))> = specs
            .iter()
            .map(|(n, s)| (n.clone(), headline(&run(s))))
            .collect();
        let fine = results.last().unwrap().1;
        println!("| {label} | EY % | TDS % | shot time s | first drops s | ΔEY | Δtime |");
        println!("|---|---|---|---|---|---|---|");
        for (n, (ey, tds, t, fd)) in &results {
            println!(
                "| {n} | {ey:.3} | {tds:.3} | {t:.3} | {fd:.3} | {:+.3} | {:+.3} |",
                ey - fine.0,
                t - fine.2
            );
        }
        println!();
    };
    report(
        "max_dt_s",
        [0.2, 0.1, 0.05, 0.025, 0.0125]
            .iter()
            .map(|&dt| {
                let mut s = base.clone();
                s.numerics.max_dt_s = dt;
                s.numerics.output_interval_s = 0.2;
                (format!("{dt}"), s)
            })
            .collect(),
    );
    report(
        "depth_cells",
        [10, 15, 30, 60, 120]
            .iter()
            .map(|&n| {
                let mut s = base.clone();
                s.numerics.depth_cells = n;
                (format!("{n}"), s)
            })
            .collect(),
    );
    report(
        "kernel_shells",
        [4, 8, 16, 32]
            .iter()
            .map(|&n| {
                let mut s = base.clone();
                s.numerics.kernel_shells = n;
                (format!("{n}"), s)
            })
            .collect(),
    );
    for sigma in [0.2, 0.7] {
        report(
            &format!("columns (σ = {sigma})"),
            [3, 4, 8, 16, 64]
                .iter()
                .map(|&n| {
                    let mut s = base.clone();
                    s.bed.heterogeneity.columns = n;
                    s.bed.heterogeneity.sigma_ln_permeability = sigma;
                    (format!("{n}"), s)
                })
                .collect(),
        );
    }
}

/// Outlet TDS of the first sample with outflow.
fn first_drop_tds(r: &ShotResult) -> f64 {
    let s = &r.series;
    let i = s.flow_out_m3_s.iter().position(|&q| q > 0.0).unwrap_or(0);
    s.tds_outlet[i]
}

fn front() {
    println!("\n## Wetting front (default spec, 200 snapshots)\n");
    println!(
        "| depth cells | max_dt s | EY % | first-drop TDS % | max c/c_sat | min local EY | final local EY % |"
    );
    println!("|---|---|---|---|---|---|---|");
    for (cells, dt) in [
        (15, 0.05),
        (30, 0.05),
        (120, 0.05),
        (30, 0.0125),
        (120, 0.0125),
    ] {
        let mut s = ShotSpec::default();
        s.numerics.depth_cells = cells;
        s.numerics.max_dt_s = dt;
        s.numerics.snapshot_count = 200;
        let r = run(&s);
        let snaps = &r.spatial.snapshots;
        let c_max = snaps
            .iter()
            .flat_map(|x| x.liquid_conc_kg_m3.iter().flatten())
            .fold(0.0_f64, |m, &c| m.max(c));
        let ey_min = snaps
            .iter()
            .flat_map(|x| x.local_ey.iter().flatten())
            .fold(f64::INFINITY, |m, &e| m.min(e));
        let u = &r.summary.uniformity;
        println!(
            "| {cells} | {dt} | {:.3} | {:.3} | {:.9} | {ey_min:.1e} | {:.2}–{:.2} |",
            r.summary.ey * 100.0,
            first_drop_tds(&r) * 100.0,
            c_max / s.solubles.saturation_kg_m3,
            u.ey_min * 100.0,
            u.ey_max * 100.0
        );
    }
}

fn flow_rise() {
    println!("\n## Flow rise at 9 bar: outflow at the stop over outflow at first drops + 2 s\n");
    let rise = |s: &ShotSpec| {
        let r = run(s);
        let ser = &r.series;
        let fd = r.summary.first_drops_s.unwrap();
        let i0 = ser.t_s.iter().position(|&x| x >= fd + 2.0).unwrap();
        let i1 = ser
            .t_s
            .iter()
            .position(|&x| x == r.summary.shot_time_s)
            .unwrap();
        (
            ser.flow_out_m3_s[i1] / ser.flow_out_m3_s[i0],
            r.summary.shot_time_s,
        )
    };
    let base = ShotSpec::default();
    let isothermal = |s: &mut ShotSpec| {
        s.thermal.initial_bed_temp_c = s.thermal.water_temp_c;
        s.thermal.ambient_temp_c = s.thermal.water_temp_c;
        s.thermal.heat_loss_w_k = 0.0;
    };
    let mut cases: Vec<(&str, ShotSpec)> = vec![("default (θ = 0)", base.clone())];
    let mut s = base.clone();
    s.hydraulics.viscosity.temperature_exponent = 0.0;
    cases.push(("water viscosity (γ = 0)", s));
    let mut s = base.clone();
    isothermal(&mut s);
    cases.push(("isothermal (bed starts at 92 °C)", s));
    let mut s = base.clone();
    s.hydraulics.viscosity.temperature_exponent = 0.0;
    isothermal(&mut s);
    cases.push(("γ = 0 and isothermal", s));
    let mut s = base.clone();
    s.bed.heterogeneity.columns = 1;
    cases.push(("one column", s));
    for theta in [0.1, 0.27] {
        let mut s = base.clone();
        s.hydraulics.dissolution_porosity_share = Some(theta);
        cases.push((
            if theta < 0.2 {
                "θ = 0.1"
            } else {
                "θ = 0.27 (the old proportional rule)"
            },
            s,
        ));
    }
    println!("| case | rise | shot time s |");
    println!("|---|---|---|");
    for (name, s) in cases {
        let (x, t) = rise(&s);
        println!("| {name} | ×{x:.2} | {t:.1} |");
    }
}

fn reuptake() {
    println!("\n## Kernel loading cap (default spec)\n");
    println!("| partition | EY % | TDS % | outlet TDS at 8/10/12/15 s % | min local EY % |");
    println!("|---|---|---|---|---|");
    for cap in [true, false] {
        let mut s = ShotSpec::default();
        s.solubles.kernel_loading_cap = cap;
        let r = run(&s);
        let ser = &r.series;
        let at = |t: f64| {
            let i = ser.t_s.iter().position(|&x| x >= t - 1e-9).unwrap_or(0);
            ser.tds_outlet[i] * 100.0
        };
        println!(
            "| {} | {:.2} | {:.2} | {:.2} / {:.2} / {:.2} / {:.2} | {:.2} |",
            if cap { "capped at u₀" } else { "linear" },
            r.summary.ey * 100.0,
            r.summary.tds * 100.0,
            at(8.0),
            at(10.0),
            at(12.0),
            at(15.0),
            r.summary.uniformity.ey_min * 100.0
        );
    }
}

/// The review's cases for tier 0 against tier 1.
fn tier_agreement() {
    println!("\n## Tier 0 against tier 1 (relative differences)\n");
    let base = ShotSpec::default();
    let mut cases: Vec<(&str, ShotSpec)> = vec![("default", base.clone())];
    let mut s = base.clone();
    s.bed.heterogeneity.columns = 1;
    cases.push(("1 column", s));
    for (name, q) in [("flow 2 mL/s", 2e-6), ("flow 1.2 mL/s", 1.2e-6)] {
        let mut s = base.clone();
        s.machine.phases[0].control = Control::Flow { target_m3_s: q };
        s.machine.phases[0].limit = Some(1.2e6);
        cases.push((name, s));
    }
    for (name, p) in [("3 bar", 3e5), ("6 bar", 6e5)] {
        let mut s = base.clone();
        s.machine.phases[0].control = Control::Pressure { target_pa: p };
        cases.push((name, s));
    }
    for (name, f) in [
        ("grind ×0.6", 0.6),
        ("grind ×0.75", 0.75),
        ("grind ×1.33", 4.0 / 3.0),
    ] {
        let mut s = base.clone();
        for c in &mut s.bed.size_classes {
            c.radius_m *= f;
        }
        cases.push((name, s));
    }
    let mut s = base.clone();
    s.bed.heterogeneity.sigma_ln_permeability = 0.7;
    cases.push(("σ = 0.7", s));
    let mut s = realistic();
    s.solubles.species.clear();
    cases.push(("30 classes", s));
    let mut s = base.clone();
    s.machine.stop.beverage_mass_kg = None;
    s.machine.stop.time_s = Some(25.0);
    cases.push(("time stop 25 s", s));
    println!("| case | EY | TDS | shot time | beverage |");
    println!("|---|---|---|---|---|");
    for (name, s) in cases {
        let r1 = run(&s);
        let mut s0 = s.clone();
        s0.numerics.tier = 0;
        let r0 = run(&s0);
        let rel = |a: f64, b: f64| 100.0 * (a / b - 1.0);
        println!(
            "| {name} | {:+.1}% | {:+.1}% | {:+.2}% | {:+.2}% |",
            rel(r0.summary.ey, r1.summary.ey),
            rel(r0.summary.tds, r1.summary.tds),
            rel(r0.summary.shot_time_s, r1.summary.shot_time_s),
            rel(r0.summary.beverage_mass_kg, r1.summary.beverage_mass_kg)
        );
    }
}

fn timings() {
    println!("\n## Timings (native, median wall time per shot)\n");
    let realistic = realistic();
    let mut r0 = realistic.clone();
    r0.numerics.tier = 0;
    let mut d0 = ShotSpec::default();
    d0.numerics.tier = 0;
    println!("| case | tier | ms |");
    println!("|---|---|---|");
    println!(
        "| default (2 classes) | 1 | {:.2} |",
        time_ms(&ShotSpec::default(), 11)
    );
    println!(
        "| 30 classes + 4 species | 1 | {:.2} |",
        time_ms(&realistic, 5)
    );
    println!("| default (2 classes) | 0 | {:.3} |", time_ms(&d0, 101));
    println!("| 30 classes + 4 species | 0 | {:.3} |", time_ms(&r0, 101));
    // Species: each group of identical transport parameters costs about
    // one lumped solve.
    let species = |n: usize| -> Vec<SpeciesSpec> {
        (0..n)
            .map(|i| SpeciesSpec {
                id: format!("s{i}"),
                mass_fraction: 0.001,
                kernel_diffusivity_m2_s: 1e-10 * (1.0 + 0.03 * i as f64),
                partition_coefficient: 0.5 + 0.01 * i as f64,
                surface_fraction_scale: 1.0,
            })
            .collect()
    };
    for (tier, n) in [(1, 16), (1, 55), (0, 16), (0, 55)] {
        let mut s = ShotSpec::default();
        s.numerics.tier = tier;
        s.solubles.species = species(n);
        println!(
            "| default + {n} distinct species | {tier} | {:.2} |",
            time_ms(&s, if tier == 0 { 21 } else { 5 })
        );
    }
    let mut s = ShotSpec::default();
    s.solubles.species = species(55);
    for sp in &mut s.solubles.species {
        sp.kernel_diffusivity_m2_s = 1e-10;
        sp.partition_coefficient = 0.61;
    }
    println!(
        "| default + 55 species in one group | 1 | {:.2} |",
        time_ms(&s, 5)
    );
}

fn plausibility() {
    println!("\n## Plausibility (tier 1)\n");
    let base = ShotSpec::default();
    let scale = |f: f64| {
        let mut s = base.clone();
        for c in &mut s.bed.size_classes {
            c.radius_m *= f;
        }
        // Relative Kozeny–Carman: κ₀ ∝ d².
        s.hydraulics.permeability_m2 *= f * f;
        s
    };
    let mut six = base.clone();
    six.machine.phases[0].control = Control::Pressure { target_pa: 6e5 };
    let mut flow = base.clone();
    flow.machine.phases[0].control = Control::Flow { target_m3_s: 2e-6 };
    flow.machine.phases[0].limit = Some(1.2e6);
    let mut taper = base.clone();
    taper.basket.profile_m = vec![[0.0, 0.025], [0.025, 0.0295]];
    taper.basket.perforated_radius_m = 0.024;
    let mut press = base.clone();
    press.basket.outlet = Outlet::Pressurised {
        orifice_diameter_m: 0.4e-3,
        discharge_coefficient: 0.7,
    };
    let mut vib = base.clone();
    vib.machine.pump = Pump::Vibratory {
        free_flow_m3_s: 7e-6,
        stall_pressure_pa: 1.5e6,
        opv_pa: Some(1.0e6),
    };
    vib.machine.phases = vec![Phase {
        control: Control::PumpFull,
        ramp_s: 0.0,
        limit: None,
        exit: PhaseExit::default(),
    }];
    let cases: Vec<(&str, ShotSpec)> = vec![
        ("default: 18 g, 9 bar, stop at 36 g", base.clone()),
        ("finer (radii ×0.75, κ₀ ×0.56)", scale(0.75)),
        ("coarser (radii ×1.33, κ₀ ×1.78)", scale(4.0 / 3.0)),
        ("6 bar", six),
        ("flow control 2 mL/s (12 bar limit)", flow),
        ("tapered basket (r 25 → 29.5 mm)", taper),
        ("pressurised basket (0.4 mm orifice)", press),
        ("vibratory pump (7 mL/s free, OPV 10 bar)", vib),
        ("30 classes + 4 species", realistic()),
    ];
    println!(
        "| case | shot time s | first drops s | beverage g (drip) | TDS % | EY % | max P bar | flow mL/s: drops+2 s → mid → stop | mass balance |"
    );
    println!("|---|---|---|---|---|---|---|---|---|");
    for (name, s) in cases {
        let r = run(&s);
        let m = &r.summary;
        let ser = &r.series;
        let at = |t: f64| {
            let i = ser
                .t_s
                .iter()
                .position(|&x| x >= t)
                .unwrap_or(ser.t_s.len() - 1);
            ser.flow_out_m3_s[i] * 1e6
        };
        let fd = m.first_drops_s.unwrap_or(f64::NAN);
        let i_stop = ser.t_s.iter().position(|&x| x == m.shot_time_s).unwrap();
        println!(
            "| {name} | {:.1} | {fd:.1} | {:.1} ({:.1}) | {:.2} | {:.2} | {:.2} | {:.2} → {:.2} → {:.2} | {:.1e} |",
            m.shot_time_s,
            m.beverage_mass_kg * 1e3,
            m.drip_mass_kg * 1e3,
            m.tds * 100.0,
            m.ey * 100.0,
            m.max_pressure_pa / 1e5,
            at(fd + 2.0),
            at(0.5 * (fd + m.shot_time_s)),
            ser.flow_out_m3_s[i_stop] * 1e6,
            r.diagnostics.mass_balance_error,
        );
    }
}

fn main() {
    println!("# Shot solver report (puckcore {})", puckcore::VERSION);
    plausibility();
    flow_rise();
    front();
    reuptake();
    tier_agreement();
    convergence();
    timings();
}
