// SPDX-License-Identifier: GPL-2.0-or-later
//! Material properties and closures of the shot model.
//!
//! Every function uses only IEEE-754 basic operations and [`crate::math`], so
//! the results are bit-identical on every target. The equations, their
//! sources and their spec fields are tabulated in `docs/model/shot-model.md`.

use crate::math::{self, fmax};

/// Specific heat of liquid water, J/(kg K): within 0.3% of IAPWS-95 between
/// 60 and 100 °C (4.18–4.22 kJ/(kg K)).
pub(crate) const WATER_HEAT_CAPACITY_J_KG_K: f64 = 4200.0;

/// 0 °C in kelvin.
pub(crate) const ZERO_CELSIUS_K: f64 = 273.15;

/// Discharge coefficient of the perforated floor's holes (sharp-edged
/// orifice).
pub(crate) const HOLE_DISCHARGE_COEFFICIENT: f64 = 0.61;

/// Dynamic viscosity of liquid water, Pa s, from Kestin, Sokolov & Wakeham
/// (1978), J. Phys. Chem. Ref. Data 7:941, valid −8 to 150 °C:
///
/// ```text
/// log10(μ/μ20) = (20 − t)(1.2378 − 1.303e-3 (20 − t) + 3.06e-6 (20 − t)² + 2.55e-8 (20 − t)³)/(96 + t),
/// μ20 = 1.002 mPa s.
/// ```
///
/// It gives 0.3551, 0.3151 and 0.2978 mPa s at 80, 90 and 95 °C: within 0.3%
/// of the registry's CRC values (0.354, 0.315, 0.298) and 0.2% of IAPWS 2008.
pub(crate) fn water_viscosity_pa_s(t_c: f64) -> f64 {
    let d = 20.0 - t_c;
    let poly = 1.2378 + d * (-1.303e-3 + d * (3.06e-6 + d * 2.55e-8));
    let log10_ratio = d * poly / (96.0 + t_c);
    1.002e-3 * math::exp(log10_ratio * std::f64::consts::LN_10)
}

/// Density of air-free water at atmospheric pressure, kg/m³, from Kell
/// (1975), J. Chem. Eng. Data 20:97, valid 0–150 °C: 999.97 at 4 °C, 998.20 at
/// 20 °C, 965.3 at 90 °C.
pub(crate) fn water_density_kg_m3(t_c: f64) -> f64 {
    let t = t_c;
    let num = 999.839_52
        + t * (16.945_176
            + t * (-7.987_040_1e-3
                + t * (-46.170_461e-6 + t * (105.563_02e-9 + t * (-280.542_53e-12)))));
    num / (1.0 + 16.879_850e-3 * t)
}

/// Stokes–Einstein temperature factor D(T)/D(T_ref) = (T/T_ref)·(μ_w(T_ref)/μ_w(T)),
/// with absolute temperatures and the water viscosity.
pub(crate) fn stokes_einstein_factor(t_c: f64, t_ref_c: f64) -> f64 {
    ((t_c + ZERO_CELSIUS_K) / (t_ref_c + ZERO_CELSIUS_K))
        * (water_viscosity_pa_s(t_ref_c) / water_viscosity_pa_s(t_c))
}

/// Properties of the extract (bed liquid) as a function of its solute
/// concentration c, kg/m³.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Liquid {
    /// Water density at the brew temperature, kg/m³.
    pub rho_water: f64,
    /// Apparent specific volume of the solutes, m³/kg.
    pub specific_volume: f64,
    /// ln μ_rel = γ (a1 w + a2 w²).
    pub a1: f64,
    pub a2: f64,
    pub gamma: f64,
}

impl Liquid {
    /// Water mass per unit liquid volume, kg/m³: ρ_w (1 − v̄ c), never below 0.
    pub fn water_mass_per_volume(&self, c: f64) -> f64 {
        self.rho_water * fmax(1.0 - self.specific_volume * c, 0.0)
    }

    /// Liquid density, kg/m³: ρ_w (1 − v̄ c) + c.
    pub fn density(&self, c: f64) -> f64 {
        self.water_mass_per_volume(c) + c
    }

    /// Solute mass fraction (TDS), c/ρ(c).
    pub fn mass_fraction(&self, c: f64) -> f64 {
        if c > 0.0 { c / self.density(c) } else { 0.0 }
    }

    /// Viscosity relative to water at the same temperature,
    /// exp(γ (a1 w + a2 w²)).
    pub fn relative_viscosity(&self, c: f64) -> f64 {
        let w = self.mass_fraction(c);
        math::exp(self.gamma * (self.a1 * w + self.a2 * w * w))
    }
}

/// Kozeny–Carman porosity function ε³/(1 − ε)².
pub(crate) fn kozeny_carman(eps: f64) -> f64 {
    let s = 1.0 - eps;
    eps * eps * eps / (s * s)
}

/// Poroelastic flow law of Waszkiewicz et al. (2026): the flow through a bed
/// with pressure drop ΔP is Φ(ΔP)/R, where R is the bed's Darcy resistance
/// and
///
/// ```text
/// Φ(ΔP) = ΔP·f(x),  x = ΔP/P_c,  f(x) = [1 − (1 − x)⁴]/(4x) = 1 − 3x/2 + x² − x³/4  (x < 1),
///                                f(x) = 1/(4x)                                   (x ≥ 1).
/// ```
///
/// So Q/Q_c = Φ/Φ(P_c) = 1 − (1 − x)⁴ with Q_c = P_c/(4R): their eq. 16. f is
/// the poroelastic permeability factor; f(0) = 1, and f and f′ are
/// continuous at x = 1. dΦ/dΔP = (1 − x)³ ≥ 0. Without P_c, Φ(ΔP) = ΔP.
#[derive(Clone, Copy, Debug)]
pub(crate) struct Poroelastic {
    pub pc: Option<f64>,
}

impl Poroelastic {
    /// The permeability factor f(ΔP/P_c).
    pub fn factor(&self, dp: f64) -> f64 {
        match self.pc {
            None => 1.0,
            Some(pc) => {
                let x = dp / pc;
                if x >= 1.0 {
                    0.25 / x
                } else {
                    1.0 - x * (1.5 - x * (1.0 - 0.25 * x))
                }
            }
        }
    }

    /// Φ(ΔP) = ΔP·f(ΔP/P_c), for ΔP ≥ 0.
    pub fn phi(&self, dp: f64) -> f64 {
        if dp <= 0.0 {
            return 0.0;
        }
        match self.pc {
            None => dp,
            Some(pc) => {
                if dp >= pc {
                    0.25 * pc
                } else {
                    dp * self.factor(dp)
                }
            }
        }
    }
}

/// Bernoulli function B(x) = x/(e^x − 1) for x ≥ 0 (B(0) = 1). It gives the
/// exponentially fitted (Scharfetter–Gummel / Il'in–Allen–Southwell)
/// advection–dispersion fluxes.
pub(crate) fn bernoulli(x: f64) -> f64 {
    if x <= 0.0 {
        1.0
    } else if x > 700.0 {
        0.0
    } else {
        x / math::expm1(x)
    }
}

/// Standard normal distribution function Φ(x), from erfc by Abramowitz &
/// Stegun 7.1.26 (absolute error below 1.5e-7; a public-domain formula),
/// with Φ(−∞) = 0 and Φ(∞) = 1 exactly. Used for the conditional means of
/// the permeability strata, which telescope to an exact unit mean whatever
/// its accuracy.
pub(crate) fn normal_cdf(x: f64) -> f64 {
    if x == f64::NEG_INFINITY {
        return 0.0;
    }
    if x == f64::INFINITY {
        return 1.0;
    }
    let z = x.abs() * std::f64::consts::FRAC_1_SQRT_2;
    let t = 1.0 / (1.0 + 0.327_591_1 * z);
    let poly = t
        * (0.254_829_592
            + t * (-0.284_496_736
                + t * (1.421_413_741 + t * (-1.453_152_027 + t * 1.061_405_429))));
    let erfc = poly * math::exp(-z * z);
    if x >= 0.0 {
        1.0 - 0.5 * erfc
    } else {
        0.5 * erfc
    }
}

/// Quantile of the standard normal distribution, by Acklam's rational
/// approximation (relative error below 1.2e-9), for 0 < p < 1. Only the
/// stratified permeability multipliers use it, and they are normalised
/// afterwards, so its accuracy is ample.
pub(crate) fn normal_quantile(p: f64) -> f64 {
    const A: [f64; 6] = [
        -3.969_683_028_665_376e1,
        2.209_460_984_245_205e2,
        -2.759_285_104_469_687e2,
        1.383_577_518_672_69e2,
        -3.066_479_806_614_716e1,
        2.506_628_277_459_239,
    ];
    const B: [f64; 5] = [
        -5.447_609_879_822_406e1,
        1.615_858_368_580_409e2,
        -1.556_989_798_598_866e2,
        6.680_131_188_771_972e1,
        -1.328_068_155_288_572e1,
    ];
    const C: [f64; 6] = [
        -7.784_894_002_430_293e-3,
        -3.223_964_580_411_365e-1,
        -2.400_758_277_161_838,
        -2.549_732_539_343_734,
        4.374_664_141_464_968,
        2.938_163_982_698_783,
    ];
    const D: [f64; 4] = [
        7.784_695_709_041_462e-3,
        3.224_671_290_700_398e-1,
        2.445_134_137_142_996,
        3.754_408_661_907_416,
    ];
    const P_LOW: f64 = 0.024_25;
    let tail = |q: f64| {
        (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5])
            / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1.0)
    };
    if p < P_LOW {
        tail((-2.0 * math::ln(p)).sqrt())
    } else if p > 1.0 - P_LOW {
        -tail((-2.0 * math::ln(1.0 - p)).sqrt())
    } else {
        let q = p - 0.5;
        let r = q * q;
        (((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q
            / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn water_viscosity_matches_the_registry_values() {
        // hydraulics.viscosity.water_80c / _90c / _95c (CRC), mPa s.
        // The registry rounds to three digits; IAPWS 2008 gives 0.3544,
        // 0.3147 and 0.2977 mPa s.
        for (t, want, iapws) in [
            (80.0, 0.354, 0.3544),
            (90.0, 0.315, 0.3147),
            (95.0, 0.298, 0.2977),
        ] {
            let got = water_viscosity_pa_s(t) * 1e3;
            assert!((got / want - 1.0).abs() < 4e-3, "{t} °C: {got} vs {want}");
            assert!(
                (got / iapws - 1.0).abs() < 2.5e-3,
                "{t} °C: {got} vs IAPWS {iapws}"
            );
        }
        assert!((water_viscosity_pa_s(20.0) - 1.002e-3).abs() < 1e-18);
        // Monotone over the valid range.
        let mut last = f64::INFINITY;
        for t in 0..=150 {
            let mu = water_viscosity_pa_s(f64::from(t));
            assert!(mu < last);
            last = mu;
        }
    }

    #[test]
    fn water_density_matches_reference_values() {
        for (t, want) in [(4.0, 999.97), (20.0, 998.20), (90.0, 965.3), (100.0, 958.4)] {
            let got = water_density_kg_m3(t);
            assert!((got - want).abs() < 0.06, "{t} °C: {got}");
        }
    }

    #[test]
    fn stokes_einstein_matches_the_registry_coefficient() {
        // extraction.diffusivity.temperature_coefficient: ×1.24 from 80 to 95 °C.
        let f = stokes_einstein_factor(95.0, 80.0);
        assert!((f - 1.24).abs() < 0.01, "{f}");
        assert_eq!(stokes_einstein_factor(80.0, 80.0), 1.0);
    }

    #[test]
    fn liquid_density_reproduces_note_01_conversion() {
        let liq = Liquid {
            rho_water: 1000.0,
            specific_volume: 6.4e-4,
            a1: 4.2,
            a2: 11.8,
            gamma: 0.45,
        };
        // 25% w/w at about 275 kg/m³ and density about 1.10.
        let w = liq.mass_fraction(275.0);
        assert!((w - 0.25).abs() < 0.003, "{w}");
        assert_eq!(liq.mass_fraction(0.0), 0.0);
        // Relative viscosity 2.24 at 25% w/w (registry centre 2.25).
        let c25 = 275.0;
        let mu = liq.relative_viscosity(c25);
        assert!((mu - 2.24).abs() < 0.03, "{mu}");
        assert_eq!(liq.relative_viscosity(0.0), 1.0);
    }

    #[test]
    fn poroelastic_law_reproduces_the_waszkiewicz_curve() {
        let p = Poroelastic { pc: Some(1.2e6) };
        let q_c = p.phi(1.2e6);
        assert_eq!(q_c, 0.3e6);
        for i in 0..=120 {
            let dp = 1e4 * f64::from(i);
            let x = dp / 1.2e6;
            let want = 1.0 - (1.0 - x).powi(4);
            let got = p.phi(dp) / q_c;
            assert!((got - want).abs() < 1e-14, "{x}: {got} vs {want}");
            // f is the stated factor [1 − (1 − x)⁴]/(4x).
            if i > 0 {
                assert!((p.factor(dp) - want / (4.0 * x)).abs() < 1e-13);
            }
        }
        // Saturated beyond P_c; continuous factor and slope at x = 1.
        assert_eq!(p.phi(2.4e6), q_c);
        assert_eq!(p.factor(2.4e6), 0.125);
        let below = p.factor(1.2e6 * (1.0 - 1e-9));
        assert!((below - 0.25).abs() < 1e-9);
        // Tiny pressures: f → 1 without cancellation.
        assert!((p.factor(1e-3) - 1.0).abs() < 1e-8);
        let none = Poroelastic { pc: None };
        assert_eq!(none.phi(5e5), 5e5);
        assert_eq!(none.factor(5e5), 1.0);
    }

    #[test]
    fn bernoulli_function() {
        assert_eq!(bernoulli(0.0), 1.0);
        for x in [1e-12_f64, 1e-6, 1e-4, 0.1, 0.4, 0.6, 1.0, 10.0, 100.0] {
            // Series near 0, where e^x − 1 cancels; the closed form above.
            let want = if x < 1e-3 {
                1.0 - x / 2.0 + x * x / 12.0
            } else {
                x / (x.exp() - 1.0)
            };
            let got = bernoulli(x);
            assert!((got / want - 1.0).abs() < 1e-14, "{x}: {got} {want}");
        }
        assert_eq!(bernoulli(800.0), 0.0);
    }

    #[test]
    fn normal_cdf_matches_reference_values() {
        for (x, want) in [
            (0.0, 0.5),
            (1.0, 0.841_344_746_068_542_9),
            (-1.0, 0.158_655_253_931_457_05),
            (2.5, 0.993_790_334_674_223_7),
            (-3.0, 0.001_349_898_031_630_094_6),
        ] {
            assert!(
                (normal_cdf(x) - want).abs() < 2e-7,
                "{x}: {}",
                normal_cdf(x)
            );
        }
        assert_eq!(normal_cdf(f64::NEG_INFINITY), 0.0);
        assert_eq!(normal_cdf(f64::INFINITY), 1.0);
        // Round trip with the quantile.
        for p in [0.01, 0.1, 0.3, 0.5, 0.9, 0.99] {
            assert!((normal_cdf(normal_quantile(p)) - p).abs() < 3e-7);
        }
    }

    #[test]
    fn normal_quantiles() {
        assert_eq!(normal_quantile(0.5), 0.0);
        for (p, z) in [
            (0.975, 1.959_963_984_540_054),
            (0.841_344_746_068_542_9, 1.0),
            (0.001, -3.090_232_306_167_813_6),
            (0.02, -2.053_748_910_631_823),
        ] {
            let got = normal_quantile(p);
            assert!((got - z).abs() < 2e-9 * z.abs().max(1.0), "{p}: {got}");
            assert!((normal_quantile(1.0 - p) + got).abs() < 1e-8);
        }
    }
}
