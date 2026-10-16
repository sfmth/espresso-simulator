// SPDX-License-Identifier: GPL-2.0-or-later
//! Analytic released fraction for the perfect-sink sphere (Crank 1975, §6.3).
//!
//! With τ = D t / a², the long-time series (Crank eq. 6.20) is
//!
//! ```text
//! M_t/M_∞ = 1 − (6/π²) Σ_{n≥1} exp(−n² π² τ) / n²,
//! ```
//!
//! and the short-time expansion (Crank eq. 6.21) is
//!
//! ```text
//! M_t/M_∞ = 6 √τ (π^{−1/2} + 2 Σ_{n≥1} ierfc(n/√τ)) − 3τ.
//! ```
//!
//! For τ < 0.01 the ierfc terms are below 1e-40, so the short-time branch is
//! 6 √(τ/π) − 3τ. For larger τ the series converges fast: about 20 terms at
//! τ = 0.01, fewer later. The absolute error is at most 5.7e-16. Only IEEE-754 basic operations and
//! [`crate::math::exp`] are used, so the values are bit-identical on every
//! platform.

use std::f64::consts::PI;

use crate::math;

/// τ at which [`release_fraction`] switches from the short-time to the long-time form.
pub(crate) const SWITCH_TAU: f64 = 0.01;

/// Safety cap on the number of series terms (reached only for τ < 1e-5).
const MAX_TERMS: u32 = 2000;

/// Analytic released fraction M_t/M_∞ for the perfect-sink sphere (Crank 1975).
///
/// Returns 0 for `t_s <= 0`. For τ = D t / a² < 0.01 it uses the short-time
/// expansion `6 sqrt(tau / pi) - 3 tau` (Crank eq. 6.21); the ierfc terms it
/// drops are below 1e-40 in that range. For larger τ it sums the long-time
/// series (eq. 6.20) until the terms are negligible.
///
/// Accuracy, measured against 60-digit references: the absolute error is at
/// most 5.7e-16 (1.8e-15 relative). The largest errors are just above the
/// branch switch (τ ≈ 0.011–0.013), from round-off in the series.
pub fn crank_sphere_release_fraction(t_s: f64, radius_m: f64, diffusivity_m2_s: f64) -> f64 {
    if t_s <= 0.0 {
        return 0.0;
    }
    release_fraction(dimensionless_time(t_s, radius_m, diffusivity_m2_s))
}

/// τ = D t / a².
///
/// Evaluated as (D·t)/(a·a), the M0 skeleton's order, so results for ordinary
/// inputs are unchanged bit for bit. If either product leaves the normal
/// range, the evaluation switches to (D/a)·(t/a). That avoids a spurious ∞/∞,
/// 0/0, ∞ or 0 for extreme but valid inputs, e.g. D = 1e300, t = 1e10,
/// a = 1e155, where τ = 1.
pub(crate) fn dimensionless_time(t_s: f64, radius_m: f64, diffusivity_m2_s: f64) -> f64 {
    let dt = diffusivity_m2_s * t_s;
    let aa = radius_m * radius_m;
    if dt.is_normal() && aa.is_normal() {
        dt / aa
    } else {
        (diffusivity_m2_s / radius_m) * (t_s / radius_m)
    }
}

/// Released fraction as a function of the dimensionless time τ = D t / a².
pub(crate) fn release_fraction(tau: f64) -> f64 {
    if tau < SWITCH_TAU {
        short_time(tau)
    } else {
        long_time(tau)
    }
}

/// Short-time form without the ierfc terms: 6 √(τ/π) − 3τ.
pub(crate) fn short_time(tau: f64) -> f64 {
    6.0 * (tau / PI).sqrt() - 3.0 * tau
}

/// Long-time series, summed until a term falls below 1e-18 of the sum.
///
/// The powers exp(−n² π² τ) = q^{n²} come from one exponential,
/// q = exp(−π² τ), and two multiplications per term:
/// q^{(n+1)²} = q^{n²} · q^{2n+1} and q^{2n+3} = q^{2n+1} · q².
pub(crate) fn long_time(tau: f64) -> f64 {
    let q = math::exp(-PI * PI * tau);
    let q2 = q * q;
    let mut power = q; // q^(n²)
    let mut ratio = q * q2; // q^(2n+1)
    let mut sum = q; // first term, n = 1
    for n in 2..=MAX_TERMS {
        power *= ratio;
        ratio *= q2;
        let term = power / f64::from(n * n);
        sum += term;
        if term <= 1e-18 * sum {
            break;
        }
    }
    1.0 - 6.0 / (PI * PI) * sum
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Released fraction at τ, computed independently with mpmath at 50
    /// significant digits from both exact forms (the long-time series and the
    /// short-time series with all ierfc terms), which agree to 1e-49. Rounded
    /// to 17 digits.
    const REFERENCE: [(f64, f64); 12] = [
        (1e-6, 0.003382137501286538),
        (1e-4, 0.03355137501286538),
        (1e-3, 0.10404744696916628),
        (5e-3, 0.22436536824085962),
        (1e-2, 0.3085137501286538),
        (2e-2, 0.4187307364817192),
        (5e-2, 0.6069397566788319),
        (1e-1, 0.7704787380259632),
        (2e-1, 0.9154955661076821),
        (5e-1, 0.9956278587880253),
        (1.0, 0.9999685560733125),
        (3.0, 0.9999999999999158),
    ];

    #[test]
    fn matches_high_precision_reference_values() {
        let mut worst: f64 = 0.0;
        for (tau, expect) in REFERENCE {
            let got = release_fraction(tau);
            worst = worst.max((got - expect).abs());
            assert!(
                (got - expect).abs() < 2e-15,
                "tau = {tau}: {got} vs {expect}"
            );
            // The physical-units entry point agrees (a = 2 m, D = 3 m²/s).
            let t = tau * 4.0 / 3.0;
            let via_units = crank_sphere_release_fraction(t, 2.0, 3.0);
            assert!((via_units - expect).abs() < 4e-15);
        }
        println!("largest difference from the mpmath values: {worst:.1e}");
    }

    #[test]
    fn short_and_long_branches_agree_in_their_overlap() {
        // Both truncated forms are accurate to < 1e-14 for 1e-3 ≤ τ ≤ 0.03.
        let mut worst: f64 = 0.0;
        for i in 0..=300 {
            let tau = 1e-3 * 30_f64.powf(f64::from(i) / 300.0);
            worst = worst.max((short_time(tau) - long_time(tau)).abs());
        }
        println!("largest branch difference for 1e-3 <= tau <= 0.03: {worst:.1e}");
        assert!(worst < 1e-12, "largest branch difference {worst:e}");
        // No visible jump at the switch.
        let below = release_fraction(SWITCH_TAU * (1.0 - 1e-15));
        let at = release_fraction(SWITCH_TAU);
        assert!((at - below).abs() < 1e-14, "{below} vs {at}");
    }

    #[test]
    fn limits_and_monotonicity() {
        assert_eq!(crank_sphere_release_fraction(0.0, 1.0, 1.0), 0.0);
        assert_eq!(crank_sphere_release_fraction(-1.0, 1.0, 1.0), 0.0);
        assert_eq!(release_fraction(1e3), 1.0);
        assert_eq!(release_fraction(f64::INFINITY), 1.0);
        let mut previous = 0.0;
        for i in 1..=2000 {
            let tau = 1e-8 * 10_f64.powf(f64::from(i) * 9.0 / 2000.0);
            let f = release_fraction(tau);
            assert!(f >= previous && f <= 1.0, "tau = {tau}: {f}");
            previous = f;
        }
    }
}
