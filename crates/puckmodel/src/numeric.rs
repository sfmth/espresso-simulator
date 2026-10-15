// SPDX-License-Identifier: GPL-2.0-or-later
//! Deterministic elementary functions for the input models.
//!
//! Native and WebAssembly builds must give bit-identical results for the same
//! recipe (contract §2, ADR 0002, ADR 0005). The platform maths library
//! (`f64::ln`, `f64::powf`, `f64::exp`) can round the last bit differently on
//! each target, so the models use only:
//! - IEEE-754 basic operations and `sqrt`, which every target rounds
//!   identically;
//! - [`puckcore::math::exp`], the core's deterministic exponential;
//! - the functions here, built from those two.
//!
//! The goal is determinism with accuracy far beyond what the models need
//! (a few ulp for [`ln`], about 1e-15 absolute for [`erfc`]), not correct
//! rounding.

use puckcore::math::exp;

/// ln 2, split for exact multiplication by small integers: `LN2_HI` ends in
/// 21 zero bits, so `k * LN2_HI` is exact for |k| < 2^21.
const LN2_HI: f64 = f64::from_bits(0x3fe6_2e42_fee0_0000);
/// ln 2 − `LN2_HI`.
const LN2_LO: f64 = f64::from_bits(0x3dea_39ef_3579_3c76);
/// 2^54, to lift subnormal arguments into the normal range.
const TWO_POW_54: f64 = f64::from_bits(0x4350_0000_0000_0000);
/// 1/√π.
const FRAC_1_SQRT_PI: f64 = std::f64::consts::FRAC_2_SQRT_PI * 0.5;
/// 1/√(2π).
const FRAC_1_SQRT_2PI: f64 = FRAC_1_SQRT_PI * std::f64::consts::FRAC_1_SQRT_2;

/// Natural logarithm, bit-identical on every target.
///
/// x = m·2^k with m in [√½, √2]; ln m = 2 atanh((m − 1)/(m + 1)) from its
/// series, whose 12 terms reach below 1e-17. Returns NaN for negative or NaN
/// arguments, −∞ for 0 and +∞ for +∞.
pub fn ln(x: f64) -> f64 {
    if x.is_nan() || x < 0.0 {
        return f64::NAN;
    }
    if x == 0.0 {
        return f64::NEG_INFINITY;
    }
    if x.is_infinite() {
        return x;
    }
    let (mut bits, mut k) = (x.to_bits(), 0_i64);
    if bits >> 52 == 0 {
        bits = (x * TWO_POW_54).to_bits();
        k = -54;
    }
    k += ((bits >> 52) & 0x7ff) as i64 - 1023;
    let mut m = f64::from_bits((bits & 0x000f_ffff_ffff_ffff) | 0x3ff0_0000_0000_0000);
    if m > std::f64::consts::SQRT_2 {
        m *= 0.5;
        k += 1;
    }
    let s = (m - 1.0) / (m + 1.0);
    let s2 = s * s;
    // 1 + s²/3 + s⁴/5 + … + s²²/23 by Horner's rule.
    let mut poly = 1.0 / 23.0;
    let mut j = 21.0;
    while j >= 1.0 {
        poly = poly * s2 + 1.0 / j;
        j -= 2.0;
    }
    let kf = k as f64;
    kf * LN2_HI + (kf * LN2_LO + 2.0 * s * poly)
}

/// x^y for x > 0, as e^(y ln x). Returns NaN for x ≤ 0 (except 0^y = 0 for y > 0).
pub fn pow(x: f64, y: f64) -> f64 {
    if x == 0.0 && y > 0.0 {
        return 0.0;
    }
    if x.is_nan() || y.is_nan() || x <= 0.0 {
        return f64::NAN;
    }
    exp(y * ln(x))
}

/// Complementary error function, bit-identical on every target, with an
/// absolute error of about 1e-15.
///
/// For 0 ≤ x < 2.5 it uses erf(x) = (2/√π) e^(−x²) Σ 2ⁿ x^(2n+1)/(2n+1)!!,
/// whose terms are all positive; above that, Laplace's continued fraction,
/// evaluated by the modified Lentz method. erfc(−x) = 2 − erfc(x).
pub fn erfc(x: f64) -> f64 {
    if x.is_nan() {
        return x;
    }
    if x < 0.0 {
        return 2.0 - erfc(-x);
    }
    let x2 = x * x;
    if x < 2.5 {
        let mut term = x;
        let mut sum = x;
        let mut n = 0.0_f64;
        loop {
            n += 1.0;
            term *= 2.0 * x2 / (2.0 * n + 1.0);
            sum += term;
            if term <= sum * 1e-17 || n >= 300.0 {
                break;
            }
        }
        return 1.0 - std::f64::consts::FRAC_2_SQRT_PI * exp(-x2) * sum;
    }
    if x > 27.0 {
        return 0.0; // e^(−x²) underflows
    }
    // f = x + (1/2)/(x + 1/(x + (3/2)/(x + …))), erfc = e^(−x²)/(√π f).
    const TINY: f64 = 1e-300;
    let mut f = x;
    let mut c = x;
    let mut d = 0.0_f64;
    let mut n = 1.0_f64;
    while n <= 500.0 {
        let a = 0.5 * n;
        d = x + a * d;
        if d.abs() < TINY {
            d = TINY;
        }
        d = 1.0 / d;
        c = x + a / c;
        if c.abs() < TINY {
            c = TINY;
        }
        let delta = c * d;
        f *= delta;
        if (delta - 1.0).abs() < 1e-16 {
            break;
        }
        n += 1.0;
    }
    exp(-x2) * FRAC_1_SQRT_PI / f
}

/// Standard normal cumulative distribution function Φ(z).
pub fn norm_cdf(z: f64) -> f64 {
    0.5 * erfc(-z * std::f64::consts::FRAC_1_SQRT_2)
}

/// Standard normal density φ(z).
pub fn norm_pdf(z: f64) -> f64 {
    FRAC_1_SQRT_2PI * exp(-0.5 * z * z)
}

/// Root of a function that changes sign on [lo, hi], by bisection (fixed
/// iteration budget, so the result is deterministic). Returns None when
/// f(lo) and f(hi) have the same sign or either is not finite.
pub fn bisect(mut lo: f64, mut hi: f64, f: impl Fn(f64) -> f64) -> Option<f64> {
    let mut f_lo = f(lo);
    let f_hi = f(hi);
    if !f_lo.is_finite() || !f_hi.is_finite() || f_lo * f_hi > 0.0 {
        return None;
    }
    if f_lo == 0.0 {
        return Some(lo);
    }
    if f_hi == 0.0 {
        return Some(hi);
    }
    for _ in 0..200 {
        let mid = 0.5 * (lo + hi);
        if mid <= lo || mid >= hi {
            break;
        }
        let f_mid = f(mid);
        if f_mid == 0.0 {
            return Some(mid);
        }
        if (f_mid < 0.0) == (f_lo < 0.0) {
            lo = mid;
            f_lo = f_mid;
        } else {
            hi = mid;
        }
    }
    Some(0.5 * (lo + hi))
}

/// Linear interpolation in `xs` (strictly increasing) with constant
/// extrapolation outside; returns (value, extrapolated).
pub fn interp_clamped(x: f64, xs: &[f64], ys: &[f64]) -> (f64, bool) {
    debug_assert!(!xs.is_empty() && xs.len() == ys.len());
    if x <= xs[0] {
        return (ys[0], x < xs[0]);
    }
    let last = xs.len() - 1;
    if x >= xs[last] {
        return (ys[last], x > xs[last]);
    }
    let i = xs.windows(2).position(|w| x <= w[1]).unwrap_or(last - 1);
    let t = (x - xs[i]) / (xs[i + 1] - xs[i]);
    (ys[i] + t * (ys[i + 1] - ys[i]), false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rel(a: f64, b: f64) -> f64 {
        ((a - b) / b).abs()
    }

    #[test]
    fn ln_matches_known_values() {
        assert_eq!(ln(1.0), 0.0);
        assert!(rel(ln(2.0), std::f64::consts::LN_2) < 2e-16);
        assert!(rel(ln(10.0), std::f64::consts::LN_10) < 2e-16);
        assert!(rel(ln(std::f64::consts::E), 1.0) < 2e-16);
        // Exact references from mpmath (50 digits).
        assert!(rel(ln(1e-15), -34.538_776_394_910_684) < 2e-16);
        assert!(rel(ln(123_456.789), 11.723_646_487_185_881) < 2e-16);
        assert!(rel(ln(5e-324), -744.440_071_921_381_3) < 2e-16);
        assert!(ln(-1.0).is_nan() && ln(f64::NAN).is_nan());
        assert_eq!(ln(0.0), f64::NEG_INFINITY);
    }

    #[test]
    fn ln_is_close_to_the_platform_over_a_sweep() {
        let mut x = 1e-12_f64;
        while x < 1e12 {
            let ours = ln(x);
            let theirs = x.ln();
            assert!(
                (ours - theirs).abs() <= 4.0 * f64::EPSILON * theirs.abs().max(1.0),
                "{x}"
            );
            x *= 1.137;
        }
    }

    #[test]
    fn pow_and_erfc_match_known_values() {
        assert!(rel(pow(2.0, 10.0), 1024.0) < 1e-14);
        assert!(rel(pow(9.0, 0.5), 3.0) < 1e-15);
        assert_eq!(pow(0.0, 2.0), 0.0);
        // erfc references (mpmath).
        let cases = [
            (0.0, 1.0),
            (0.1, 0.887_537_083_981_715_2),
            (0.5, 0.479_500_122_186_953_5),
            (1.0, 0.157_299_207_050_285_16),
            (2.0, 0.004_677_734_981_047_266),
            (2.4999, 0.000_407_169_900_333_451_2),
            (2.5, 0.000_406_952_017_444_958_86),
            (3.0, 2.209_049_699_858_544_5e-5),
            (5.0, 1.537_459_794_428_034_7e-12),
            (10.0, 2.088_487_583_762_544_6e-45),
        ];
        for (x, want) in cases {
            let got = erfc(x);
            assert!(
                (got - want).abs() <= 2e-15 && rel(got, want) < 5e-12,
                "erfc({x}) = {got}, want {want}"
            );
            assert!((erfc(-x) - (2.0 - want)).abs() <= 2e-15);
        }
        assert!((norm_cdf(1.959_963_984_540_054) - 0.975).abs() < 1e-15);
        assert!((norm_pdf(0.0) - 0.398_942_280_401_432_7).abs() < 1e-16);
    }

    #[test]
    fn bisect_and_interp() {
        let root = bisect(0.0, 2.0, |x| x * x - 2.0).unwrap();
        assert!((root - std::f64::consts::SQRT_2).abs() < 1e-15);
        assert!(bisect(0.0, 1.0, |x| x + 1.0).is_none());
        let xs = [0.0, 1.0, 3.0];
        let ys = [10.0, 20.0, 40.0];
        assert_eq!(interp_clamped(2.0, &xs, &ys), (30.0, false));
        assert_eq!(interp_clamped(-1.0, &xs, &ys), (10.0, true));
        assert_eq!(interp_clamped(5.0, &xs, &ys), (40.0, true));
    }
}
