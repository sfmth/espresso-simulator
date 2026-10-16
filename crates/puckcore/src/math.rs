// SPDX-License-Identifier: GPL-2.0-or-later
//! Deterministic elementary functions.
//!
//! The kernel needs `exp` (the analytic solution) and `cbrt` (the
//! equal-volume grid). The shot solver (M1) adds [`ln`] (water viscosity,
//! the normal quantiles of the permeability strata), [`expm1`] (the
//! exponentially fitted advection–dispersion fluxes) and [`fmin`]/[`fmax`],
//! whose results do not depend on how a platform orders ±0.
//!
//! - **`f64::exp`** calls the platform's maths library: glibc in native Linux
//!   builds (`exp@GLIBC_2.29` with Rust 1.99) and a musl-derived port in
//!   `wasm32-unknown-unknown` builds. The two can round the last bit
//!   differently. That would break bit-for-bit agreement between the browser
//!   and the Python tools (docs/PLAN.md §10).
//! - **`f64::cbrt`** comes from Rust's own compiler-builtins on both targets
//!   with Rust 1.99, so it would agree today. That is a toolchain detail which
//!   could change, so the core does not rely on it either (defence in depth).
//!
//! The functions here use only the IEEE-754 basic operations (+, −, ×, ÷ and
//! square root), which every platform rounds identically, plus bit
//! manipulation. Rust never fuses or reorders floating-point operations by
//! itself, so these functions return identical bits on every target.
//!
//! The goal is determinism, not correct rounding. Measured against mpmath:
//! - [`exp`]: the largest error found is 1.16 ulp (1.15 ulp over 10⁶ random
//!   arguments). About 90% of results are correctly rounded, so it differs
//!   from glibc's `exp` in the last bit for about 10% of arguments (10.5% of
//!   those the analytic solution uses).
//! - [`cbrt`]: the largest error found is 0.73 ulp, and about 91% of results
//!   are correctly rounded.
//!
//! The tests check both against exact references: correctly rounded values for
//! `exp`, and exact integer residuals for `cbrt`. They never compare with the
//! standard library, whose accuracy varies by platform (glibc's own `cbrt`
//! errs by up to about 3 ulp).

/// ln 2, split for Cody–Waite range reduction. `LN2_HI` ends in 21 zero bits,
/// so `k * LN2_HI` is exact for every |k| < 2^21.
const LN2_HI: f64 = f64::from_bits(0x3fe6_2e42_fee0_0000);
/// ln 2 − `LN2_HI`.
const LN2_LO: f64 = f64::from_bits(0x3dea_39ef_3579_3c76);
/// 1 / ln 2.
const INV_LN2: f64 = f64::from_bits(0x3ff7_1547_652b_82fe);
/// ln(`f64::MAX`): the largest argument with a finite result.
const EXP_OVERFLOW: f64 = f64::from_bits(0x4086_2e42_fefa_39ef);
/// ln(2^-1075): below this, e^x rounds to zero.
const EXP_UNDERFLOW: f64 = -745.133_219_101_941_2;
/// Taylor coefficients 1/j! for j = 0..=13. After range reduction |r| ≤ 0.35,
/// where the first omitted term, r^14/14!, is below 5e-18.
const EXP_TAYLOR: [f64; 14] = [
    1.0,
    1.0,
    1.0 / 2.0,
    1.0 / 6.0,
    1.0 / 24.0,
    1.0 / 120.0,
    1.0 / 720.0,
    1.0 / 5_040.0,
    1.0 / 40_320.0,
    1.0 / 362_880.0,
    1.0 / 3_628_800.0,
    1.0 / 39_916_800.0,
    1.0 / 479_001_600.0,
    1.0 / 6_227_020_800.0,
];

/// 2^54, to lift subnormal arguments of [`cbrt`] into the normal range.
const TWO_POW_54: f64 = f64::from_bits(0x4350_0000_0000_0000);
/// 2^-18 = cbrt(2^-54), to undo that scaling.
const TWO_POW_MINUS_18: f64 = f64::from_bits(0x3ed0_0000_0000_0000);
/// Added to `bits / 3` to give a first estimate of the cube root: (2/3)·1023
/// in the exponent field. The estimate is within 6% for every normal input.
const CBRT_BIAS: u64 = 0x2aa0_0000_0000_0000;

/// e^x, bit-identical on every platform, with an error below 1.2 ulp (see
/// the module documentation).
///
/// The argument is reduced to x = k ln 2 + r with |r| ≤ ln 2 / 2. Then e^r
/// comes from its Taylor polynomial and is scaled by 2^k.
pub fn exp(x: f64) -> f64 {
    if x.is_nan() {
        return x;
    }
    if x > EXP_OVERFLOW {
        return f64::INFINITY;
    }
    if x < EXP_UNDERFLOW {
        return 0.0;
    }
    let k = (x * INV_LN2).round();
    let r = (x - k * LN2_HI) - k * LN2_LO;
    let mut p = EXP_TAYLOR[13];
    for &c in EXP_TAYLOR[..13].iter().rev() {
        p = p * r + c;
    }
    // |k| ≤ 1075 here, so the conversion is exact.
    scale_by_pow2(p, k as i32)
}

/// Cube root, bit-identical on every platform, with an error below 0.75 ulp
/// (see the module documentation).
///
/// A first estimate from the exponent bits is refined by five Newton steps in
/// correction form, y ← y + (x/y² − y)/3. Perfect cubes of small integers come
/// out exact.
pub fn cbrt(x: f64) -> f64 {
    if x == 0.0 || !x.is_finite() {
        return x; // ±0, ±∞ and NaN map to themselves.
    }
    let (ax, rescale) = if x.abs() < f64::MIN_POSITIVE {
        (x.abs() * TWO_POW_54, TWO_POW_MINUS_18)
    } else {
        (x.abs(), 1.0)
    };
    let mut y = f64::from_bits(ax.to_bits() / 3 + CBRT_BIAS);
    for _ in 0..5 {
        y += (ax / (y * y) - y) / 3.0;
    }
    (y * rescale).copysign(x)
}

/// Natural logarithm, bit-identical on every platform.
///
/// x = 2^k · m with m ∈ [√½, √2), f = m − 1 (exact), s = f/(2 + f), and
/// ln(1 + f) = f − f²/2 + s(f²/2 + R) with R = 2 Σ_{j=1}^{10} s^{2j}/(2j + 1),
/// the atanh series (the arrangement of fdlibm's `log`). |s| ≤ 0.172, so the
/// first omitted term is below 1e-18. Measured against correctly rounded
/// references the error stays below one ulp.
pub fn ln(x: f64) -> f64 {
    if x.is_nan() || x < 0.0 {
        return f64::NAN;
    }
    if x == 0.0 {
        return f64::NEG_INFINITY;
    }
    if x == f64::INFINITY {
        return x;
    }
    let (bits, mut k) = if x < f64::MIN_POSITIVE {
        ((x * TWO_POW_54).to_bits(), -54)
    } else {
        (x.to_bits(), 0)
    };
    k += ((bits >> 52) as i32) - 1023;
    let mut m = f64::from_bits((bits & 0x000f_ffff_ffff_ffff) | 0x3ff0_0000_0000_0000);
    if m > std::f64::consts::SQRT_2 {
        m *= 0.5;
        k += 1;
    }
    let f = m - 1.0;
    let s = f / (2.0 + f);
    let z = s * s;
    let mut r = LN_SERIES[9];
    for &c in LN_SERIES[..9].iter().rev() {
        r = r * z + c;
    }
    let r = r * z;
    let hfsq = 0.5 * f * f;
    let kf = f64::from(k);
    kf * LN2_HI - ((hfsq - (s * (hfsq + r) + kf * LN2_LO)) - f)
}

/// 2/(2j + 1) for j = 1..=10: the atanh series of [`ln`].
const LN_SERIES: [f64; 10] = [
    2.0 / 3.0,
    2.0 / 5.0,
    2.0 / 7.0,
    2.0 / 9.0,
    2.0 / 11.0,
    2.0 / 13.0,
    2.0 / 15.0,
    2.0 / 17.0,
    2.0 / 19.0,
    2.0 / 21.0,
];

/// e^x − 1 without cancellation near 0, bit-identical on every platform.
///
/// For |x| < 1/2 a degree-18 Taylor polynomial (first omitted term below
/// 4e-20 relative); otherwise [`exp`]`(x) − 1`, which loses nothing there.
pub fn expm1(x: f64) -> f64 {
    if x.is_nan() {
        return x;
    }
    if x.abs() < 0.5 {
        let mut p = 1.0 / 6_402_373_705_728_000.0; // 1/18!
        let mut d = 6_402_373_705_728_000.0;
        for j in (2..=18_u32).rev() {
            d /= f64::from(j);
            p = p * x + 1.0 / d;
        }
        // p = Σ_{j=1}^{18} x^{j−1}/j!, so x·p = e^x − 1.
        return x * p;
    }
    if x < -40.0 {
        return -1.0;
    }
    exp(x) - 1.0
}

/// The smaller of two numbers, decided by `<` alone, so ±0 and the operand
/// order give the same bits on every target (`f64::min` may return either
/// zero). NaN is never passed in by the solvers.
#[inline]
pub fn fmin(a: f64, b: f64) -> f64 {
    if b < a { b } else { a }
}

/// The larger of two numbers, decided by `>` alone (see [`fmin`]).
#[inline]
pub fn fmax(a: f64, b: f64) -> f64 {
    if b > a { b } else { a }
}

/// 2^n for n in −1022..=1023, built from its bits.
fn pow2(n: i32) -> f64 {
    debug_assert!((-1022..=1023).contains(&n));
    f64::from_bits(((n + 1023) as u64) << 52)
}

/// x · 2^k for x near 1, rounding at most once (also into the subnormal range).
fn scale_by_pow2(x: f64, k: i32) -> f64 {
    if k > 1023 {
        x * pow2(1023) * pow2(k - 1023)
    } else if k < -1022 {
        x * pow2(k + 64) * pow2(-64)
    } else {
        x * pow2(k)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Distance between two finite doubles in units in the last place.
    fn ulps(a: f64, b: f64) -> u64 {
        assert!(a.is_finite() && b.is_finite(), "{a} vs {b}");
        if a == b {
            return 0;
        }
        // Map the bit patterns onto a monotone integer line.
        let key = |v: f64| {
            let bits = v.to_bits() as i64;
            if bits < 0 { i64::MIN - bits } else { bits }
        };
        key(a).abs_diff(key(b))
    }

    /// Deterministic pseudo-random numbers in [0, 1) (64-bit LCG).
    struct Lcg(u64);
    impl Lcg {
        fn next(&mut self) -> f64 {
            self.0 = self
                .0
                .wrapping_mul(6_364_136_223_846_793_005)
                .wrapping_add(1_442_695_040_888_963_407);
            (self.0 >> 11) as f64 / (1_u64 << 53) as f64
        }
    }

    /// `(x, e^x)` as bit patterns, with e^x correctly rounded (also in the
    /// subnormal range), computed with mpmath at 60 digits. The arguments are:
    /// - 32 that the analytic solution uses: −π²τ, τ log-spaced on [0.01, 75];
    /// - 32 uniform on [−708, 709.78];
    /// - 16 uniform on [−0.35, 0.35];
    /// - edge cases: the overflow threshold, ±ln 2 / 2, and subnormal results.
    const EXP_REFERENCE: [(u64, u64); 106] = [
        (0xbfb94424d9457827, 0x3fecfe1993e65d9d),
        (0xbfc0d8b9522d56ce, 0x3fec0dc202a9bb44),
        (0xbfc67722ccaa878f, 0x3fead9520eaa8e1d),
        (0xbfcdf54c45018f39, 0x3fe95285b1b2a580),
        (0xbfd3f99c1ef71d43, 0x3fe76bbbb6a9bc6c),
        (0xbfdaa323acee9cdc, 0x3fe51afb20a1c24d),
        (0xbfe1c2c143257cd7, 0x3fe25eb024be8cd5),
        (0xbfe7af390551cd9b, 0x3fde87f1ac598778),
        (0xbfef95796928b842, 0x3fd7da39d0385924),
        (0xbff50f19e44eac67, 0x3fd129774e9ff628),
        (0xbffc152e7f1c780d, 0x3fc620daa4281019),
        (0xc002b97c56fac7a3, 0x3fb8a555fb17b690),
        (0xc008f83eb8ba67c5, 0x3fa694bff71c85e2),
        (0xc010a61e043e7d35, 0x3f8fe4ad889067e7),
        (0xc01633a68b74c2b7, 0x3f6fd50099585cf6),
        (0xc01d9b4de8a57483, 0x3f43ff085c8a300b),
        (0xc023bd9afa24fb88, 0x3f0b192e80818095),
        (0xc02a531f2af3abb9, 0x3ec01ea04925d377),
        (0xc0318d66ef6242cc, 0x3e599622927e8788),
        (0xc0376813440ef3ab, 0x3dd2c8e9b4bcbaa4),
        (0xc03f3698de218cf4, 0x3d1f5092e159c685),
        (0xc044cfd72bf8425f, 0x3c2ee6d8e21bcc83),
        (0xc04bc0d264574983, 0x3aee4c599846a631),
        (0xc052813cd7103b72, 0x39428a902f11c611),
        (0xc058ad3c97c1180b, 0x37082fda67038f03),
        (0xc060741abbb0c590, 0x341127ae1c12bd27),
        (0xc065f0f503a44aa4, 0x301b2b2c71aa0bf1),
        (0xc06d425de2e41161, 0x2ad3bc10cab009f5),
        (0xc073824e15c758b0, 0x23c97af1495bb778),
        (0xc07a040b07df1494, 0x1a663a5beba6c8d5),
        (0xc08158ace0dc9e4c, 0x0de2283e26d61eff),
        (0xc08721c33c6af9e0, 0x0000000000000044),
        (0x40743720ed679b6c, 0x5d18d13b61c39428),
        (0xc07cc1c208f2ae7c, 0x167266d7eb3aee21),
        (0x4077d1e3834a4844, 0x624c95642eea8d60),
        (0x407b4a526de6fc0c, 0x674ed1b44dbeaba5),
        (0x40603ecf6514a6a4, 0x4ba6936dce582d0f),
        (0xc06de27ae846cf88, 0x2a60f5c82bf6394b),
        (0xc069113c63008294, 0x2dd9b43e756a4dba),
        (0x40430ca42cd1d6b0, 0x435f3b0e5c9da864),
        (0x407a58a2e8633a18, 0x65f1cb53eff72516),
        (0x40834364828980b0, 0x7783dcbe31064a71),
        (0xc0566bd307bdb6c8, 0x37d8754ed4272f29),
        (0xc070bbc11ad66e4a, 0x27cabbad153172bc),
        (0xc054048a05aaef10, 0x38b6591774688822),
        (0xc0744bb5f7476e54, 0x22a6cc6517c7888b),
        (0xc083781f59e82b9a, 0x07c21cc5205c8e83),
        (0x407e3b8965a2f7bc, 0x6b8d1475f3319075),
        (0x40723afc9dede560, 0x5a3c25ad28038e06),
        (0x408514ee82faeb62, 0x7cc33cb539951a75),
        (0x4015f1ba20d07e80, 0x406e29c25887fe7b),
        (0x40664a09f54d2124, 0x50030ecf0b8104f7),
        (0x40668612f9b73120, 0x502f1a37849f035f),
        (0xc0706175e7891bb4, 0x284d7db1b62f2f8a),
        (0xc074e43317d6f33e, 0x21cb1e3eb00be222),
        (0xc05b6e43c0d7d158, 0x360a0d61e5d71bc4),
        (0xc07a7510bdf2c261, 0x19c378969a7242f2),
        (0xc082d42007619f3b, 0x099afa32073adb9f),
        (0xc06d040d638986b0, 0x2b014ad27dfe7cc9),
        (0xc08135d272d4f328, 0x0e4620bdf2026239),
        (0xc081cb6955e8c0ef, 0x0c967dd36002487b),
        (0x407f62af4999b570, 0x6d363d0e026f912c),
        (0xc083fef63e2c377c, 0x063d16b13d2eca5f),
        (0xc073b5a7ba430ea4, 0x2380767dcdc7731a),
        (0x3fd33910cd79b372, 0x3ff59b0060aba261),
        (0x3fd1cae5a4d54d58, 0x3ff520c2648f5ead),
        (0x3fd515f99488ce04, 0x3ff63e5d80051cb3),
        (0xbfd25f5f74dbcf19, 0x3fe803c145cc7e39),
        (0x3fd451905f5f718a, 0x3ff5fa82459afc40),
        (0xbfcffd84d9ec73bc, 0x3fe8ec6b49bfeb6f),
        (0x3fcb87c8aaf6f8d4, 0x3ff3d6e31f77124f),
        (0x3fd5be8f85c33ce6, 0x3ff67942c254cb69),
        (0x3fc47ea810857b9c, 0x3ff2c74128e5a44f),
        (0x3fcc9224b1738ab8, 0x3ff4005705473402),
        (0xbfb8a54cf51f847c, 0x3fed101c70d43593),
        (0xbfb67412c37a1fec, 0x3fed501964bf1d3e),
        (0x3fc121cd915baa9e, 0x3ff24a9b5a50788e),
        (0xbfd066ff13add21e, 0x3fe8c3f4797e43c7),
        (0xbfca87fd564d174f, 0x3fea026cd7b728f8),
        (0x3fd40fd3b9a90316, 0x3ff5e3faa49458ea),
        (0x40862e42fefa39ef, 0x7fefffffffffff2a),
        (0x4086280000000000, 0x7fdd422d2be5dc9b),
        (0x4085e00000000000, 0x7f0d945df4f8ec8e),
        (0x3ff0000000000000, 0x4005bf0a8b145769),
        (0xbff0000000000000, 0x3fd78b56362cef38),
        (0x3fe0000000000000, 0x3ffa61298e1e069c),
        (0xbfe0000000000000, 0x3fe368b2fc6f960a),
        (0x3fd62e42fefa39ef, 0x3ff6a09e667f3bcc),
        (0xbfd62e42fefa39ef, 0x3fe6a09e667f3bcd),
        (0x3fd62e42fefa39f0, 0x3ff6a09e667f3bcd),
        (0x3ddb7cdfd9d7bdbb, 0x3ff000000006df38),
        (0xbddb7cdfd9d7bdbb, 0x3feffffffff24190),
        (0x3e10000000000000, 0x3ff0000000400000),
        (0x01a56e1fc2f8f359, 0x3ff0000000000000),
        (0xc086232bdd7abcd2, 0x001000000000007c),
        (0xc086240000000000, 0x000e6cf6d08897ac),
        (0xc086300000000000, 0x00033802fd28b3c3),
        (0xc086800000000000, 0x0000000993b4dc95),
        (0xc087200000000000, 0x0000000000000055),
        (0xc087400000000000, 0x0000000000000002),
        (0xc087480000000000, 0x0000000000000001),
        (0xc087490a3d70a3d7, 0x0000000000000001),
        (0x4024000000000000, 0x40d5829dcf950560),
        (0xc024000000000000, 0x3f07cd79b5647c9b),
        (0x4059000000000000, 0x48f3494a9b171bf5),
        (0xc059000000000000, 0x36ea8c1f14e2af5d),
    ];

    #[test]
    fn constants() {
        // The split constants sum to ln 2 to well below one ulp.
        assert_eq!(LN2_HI + LN2_LO, std::f64::consts::LN_2);
        assert_eq!(INV_LN2, std::f64::consts::LOG2_E);
        // ln(f64::MAX) = 709.78271289338399673…; this is the nearest double.
        assert_eq!(EXP_OVERFLOW, 709.782_712_893_384);
    }

    #[test]
    fn exp_is_within_one_ulp_of_the_correctly_rounded_value() {
        // With an error below 1.5 ulp, the result can be at most one double
        // away from the correctly rounded one.
        let mut exact = 0;
        for (x, want) in EXP_REFERENCE {
            let (x, want) = (f64::from_bits(x), f64::from_bits(want));
            let got = exp(x);
            assert!(
                ulps(got, want) <= 1,
                "exp({x:e}) = {got:e}, correctly rounded {want:e}"
            );
            exact += usize::from(got == want);
        }
        println!(
            "exp: {exact} of {} reference values correctly rounded",
            EXP_REFERENCE.len()
        );
    }

    #[test]
    fn exp_special_values() {
        assert_eq!(exp(0.0), 1.0);
        assert_eq!(exp(-0.0), 1.0);
        assert_eq!(exp(f64::INFINITY), f64::INFINITY);
        assert_eq!(exp(f64::NEG_INFINITY), 0.0);
        assert!(exp(f64::NAN).is_nan());
        assert_eq!(exp(710.0), f64::INFINITY);
        assert!(exp(EXP_OVERFLOW).is_finite());
        assert_eq!(exp(-746.0), 0.0);
    }

    /// Error of `y` as the cube root of `x`, for 1 ≤ x < 8, in units of 2^-52
    /// (one ulp of y ∈ [1, 2)), computed exactly with integer arithmetic:
    /// with x = X·2^-52 and y = M·2^-52, the residual X·2^104 − M³ equals
    /// 3M²·error to first order. Positive means the true root is above y.
    fn cbrt_error_ulps(x: f64, y: f64) -> f64 {
        assert!(
            (1.0..8.0).contains(&x) && (1.0..=2.0).contains(&y),
            "{x} {y}"
        );
        const TWO_52: f64 = 4_503_599_627_370_496.0;
        let big_x = (x * TWO_52) as u128; // integer below 2^55, exact
        let m = (y * TWO_52) as u128; // integer up to 2^53, exact
        // M³ = hi·2^64 + lo, assembled from M² < 2^106.
        let m2 = m * m;
        let lo = (m2 & u128::from(u64::MAX)) * m;
        let hi = (m2 >> 64) * m + (lo >> 64);
        let lo = lo & u128::from(u64::MAX);
        // X·2^104 = (X·2^40)·2^64.
        let dh = i128::try_from(big_x << 40).unwrap() - i128::try_from(hi).unwrap();
        let residual = dh
            .checked_mul(1_i128 << 64)
            .and_then(|v| v.checked_sub(i128::try_from(lo).unwrap()));
        residual.map_or(f64::INFINITY, |d| d as f64 / (3.0 * m2 as f64))
    }

    /// x = s·8^k with s ∈ [1, 8); exact for positive normal x.
    fn into_one_to_eight(x: f64) -> (f64, i32) {
        let (mut s, mut k) = (x, 0);
        while s >= 8.0 {
            s /= 8.0;
            k += 1;
        }
        while s < 1.0 {
            s *= 8.0;
            k -= 1;
        }
        (s, k)
    }

    #[test]
    fn cbrt_residuals_are_below_three_quarters_of_an_ulp() {
        let mut worst: f64 = 0.0;
        let mut check = |x: f64| worst = worst.max(cbrt_error_ulps(x, cbrt(x)).abs());
        let mut rng = Lcg(11);
        for _ in 0..100_000 {
            check(1.0 + 7.0 * rng.next());
        }
        // The equal-volume grid's arguments j/n, scaled exactly into [1, 8).
        for n in [7_u32, 64, 1000, 100_000] {
            for j in 1..=n {
                check(into_one_to_eight(f64::from(j) / f64::from(n)).0);
            }
        }
        println!("cbrt: largest error {worst:.3} ulp");
        assert!(worst < 0.75, "cbrt error {worst} ulp");
    }

    #[test]
    fn cbrt_scales_exactly_by_powers_of_eight() {
        // cbrt(x·8^k) = cbrt(x)·2^k bit for bit, so [1, 8) covers every
        // normal argument; the sign is symmetric.
        let mut rng = Lcg(5);
        for _ in 0..20_000 {
            let x = 1.0 + 7.0 * rng.next();
            let y = cbrt(x);
            for k in [-340, -100, -7, -1, 1, 3, 50, 340] {
                assert_eq!(cbrt(x * pow2(3 * k)), y * pow2(k), "x = {x}, k = {k}");
                assert_eq!(cbrt(-x * pow2(3 * k)), -y * pow2(k), "x = {x}, k = {k}");
            }
        }
    }

    #[test]
    fn cbrt_extremes_are_accurate() {
        // Subnormal arguments: cbrt(x) = cbrt(x·2^54)·2^-18 = cbrt(s)·2^(k−18)
        // with x·2^54 = s·8^k, so y·2^(18−k) must be an accurate cube root of s.
        for x in [
            5e-324,
            1e-320,
            1e-310,
            f64::MIN_POSITIVE / 3.0,
            f64::MIN_POSITIVE * 0.999,
        ] {
            let y = cbrt(x);
            let (s, k) = into_one_to_eight(x * TWO_POW_54);
            let e = cbrt_error_ulps(s, y * pow2(18 - k));
            assert!(e.abs() < 0.75, "x = {x:e}: {e} ulp");
        }
        for x in [f64::MIN_POSITIVE, f64::MAX] {
            let (s, k) = into_one_to_eight(x);
            let e = cbrt_error_ulps(s, cbrt(x) * pow2(-k));
            assert!(e.abs() < 0.75, "x = {x:e}: {e} ulp");
        }
    }

    /// `(x, ln x)` as bit patterns, ln x correctly rounded (Python `decimal`
    /// at 60 digits): edge cases, 20 uniform on (0, 1) and 10 log-uniform
    /// over 1e±300.
    const LN_REFERENCE: [(u64, u64); 50] = [
        (0x3ff0000000000000, 0x0000000000000000),
        (0x4000000000000000, 0x3fe62e42fefa39ef),
        (0x3fe0000000000000, 0xbfe62e42fefa39ef),
        (0x4024000000000000, 0x40026bb1bbb55516),
        (0x3fb999999999999a, 0xc0026bb1bbb55515),
        (0x01a56e1fc2f8f359, 0xc085963447f87fb5),
        (0x0000000000000001, 0xc0874385446d71c3),
        (0x7fefffffffffffff, 0x40862e42fefa39ef),
        (0x3ff0000000000001, 0x3cafffffffffffff),
        (0x3fefffffffffffff, 0xbca0000000000000),
        (0x3ff6a09e667f3bcd, 0x3fd62e42fefa39f0),
        (0x3fe6a09e667f3bcd, 0xbfd62e42fefa39ee),
        (0x4008000000000000, 0x3ff193ea7aad030b),
        (0x401c000000000000, 0x3fff2272ae325a57),
        (0x3ee4f8b588e368f1, 0xc027069e2aa2aa5b),
        (0x3f98d4fdf3b645a2, 0xc00dc134a0d28448),
        (0x3fef395810624dd3, 0xbf992356f9678df9),
        (0x40fe240c9fbe76c9, 0x40277281cad8a844),
        (0x0010000000000000, 0xc086232bdd7abcd2),
        (0x000012688b70e62b, 0xc0864e69394d9508),
        (0x3fd4b9ad0f953a6e, 0xbff20a5adb6d4b80),
        (0x3fc34f0696513270, 0xbffe437b11a3e0da),
        (0x3fe4d474883171ff, 0xbfdb7a68e4cfdc68),
        (0x3fb28b2f3a47e100, 0xc00500191e1d2c0c),
        (0x3fe125f2046063a0, 0xbfe3f681febe4ac7),
        (0x3fd767727ca98cc2, 0xbff018765e8c378b),
        (0x3fadb208fa389760, 0xc006c7555fc6cbda),
        (0x3fe03ce9dcdbd9d7, 0xbfe5b554e67c0358),
        (0x3fa332a1858028d0, 0xc00a44ab718b63dd),
        (0x3fdbc0d9d3586aa4, 0xbfeabca41db8fc57),
        (0x3fb1e20b87b382e0, 0xc0054a661942e2f6),
        (0x3fb738f7d1a22dd8, 0xc003334fc013983d),
        (0x3fdb2b5288790eec, 0xbfeb6ae3c951e880),
        (0x3fea75929643064b, 0xbfc856291574fdec),
        (0x3fbfb17c3e518208, 0xc000b66b6be1abc3),
        (0x3fcc93182a170b30, 0xbff7fe00cf536a24),
        (0x3fe413eed654fd23, 0xbfddd4e0ba00f4aa),
        (0x3fee53a1b43f58c3, 0xbfab7f98494f7293),
        (0x3fe277a09a57982b, 0xbfe1976d084e3c56),
        (0x3fd9633680658f14, 0xbfed96856e893cde),
        (0x7b430ace920badc8, 0x40848fc41568d385),
        (0x077344b250c1abe5, 0xc083935a791bd0b8),
        (0x6c96603436a4edfd, 0x407ef3e130aedde1),
        (0x25b9406ce4e353d1, 0xc0722aa5f089c807),
        (0x139ecb475cc77337, 0xc07eb7ad1e41559e),
        (0x105260ff9edba096, 0xc0808050f8c88409),
        (0x28135981b59d1d98, 0xc070897965d13b3a),
        (0x675105e8b08ef408, 0x407b4bea5001ec59),
        (0x1828e448c4a7690d, 0xc07b917c23179a8b),
        (0x4a18f77122bce963, 0x405c2f06d61ea1bc),
    ];

    /// `(x, e^x − 1)` as bit patterns, correctly rounded (Python `decimal`).
    const EXPM1_REFERENCE: [(u64, u64); 27] = [
        (0x3bc79ca10c924223, 0x3bc79ca10c924223),
        (0xbbc79ca10c924223, 0xbbc79ca10c924223),
        (0x3ddb7cdfd9d7bdbb, 0x3ddb7cdfd9dda4e3),
        (0xbddb7cdfd9d7bdbb, 0xbddb7cdfd9d1d693),
        (0x3ee4f8b588e368f1, 0x3ee4f8bc681cdfb6),
        (0xbee4f8b588e368f1, 0xbee4f8aea9acf2c9),
        (0x3f847ae147ae147b, 0x3f84952e9791133f),
        (0xbf847ae147ae147b, 0xbf8460c0b518c09f),
        (0x3fb999999999999a, 0x3fbaec7b35a00d3a),
        (0xbfb999999999999a, 0xbfb85c933156a62c),
        (0x3fd3333333333333, 0x3fd6641632306a56),
        (0xbfd3333333333333, 0xbfd0966f2c7907f6),
        (0x3fdf5c28f5c28f5c, 0x3fe43bef39ae09cb),
        (0xbfdf5c28f5c28f5c, 0xbfd8cabaaa13f015),
        (0x3fe0000000000000, 0x3fe4c2531c3c0d38),
        (0xbfe0000000000000, 0xbfd92e9a0720d3ec),
        (0x3fe6666666666666, 0x3ff03854c24d130d),
        (0xbfe6666666666666, 0xbfe01bf92311555f),
        (0x3ff0000000000000, 0x3ffb7e151628aed3),
        (0xbff0000000000000, 0xbfe43a54e4e98864),
        (0x4014000000000000, 0x40626d389970338f),
        (0xc014000000000000, 0xbfefc8cd803fe559),
        (0x4034000000000000, 0x41bceb088a68e804),
        (0xc034000000000000, 0xbfeffffffee4b79b),
        (0x4044000000000000, 0x438a220d397972eb),
        (0xc044000000000000, 0xbff0000000000000),
        (0x4085e00000000000, 0x7f0d945df4f8ec8e),
    ];

    #[test]
    fn ln_is_within_one_ulp_of_the_correctly_rounded_value() {
        let mut exact = 0;
        for (x, want) in LN_REFERENCE {
            let (x, want) = (f64::from_bits(x), f64::from_bits(want));
            let got = ln(x);
            assert!(
                ulps(got, want) <= 1,
                "ln({x:e}) = {got:e}, correctly rounded {want:e}"
            );
            exact += usize::from(got == want);
        }
        println!(
            "ln: {exact} of {} reference values correctly rounded",
            LN_REFERENCE.len()
        );
        // ln(e^x) ≈ x over the shot solver's range.
        let mut rng = Lcg(3);
        for _ in 0..10_000 {
            let x = 40.0 * rng.next() - 20.0;
            assert!((ln(exp(x)) - x).abs() <= 4e-16 * x.abs().max(1.0), "{x}");
        }
    }

    #[test]
    fn ln_special_values() {
        assert_eq!(ln(1.0).to_bits(), 0.0_f64.to_bits());
        assert_eq!(ln(0.0), f64::NEG_INFINITY);
        assert_eq!(ln(f64::INFINITY), f64::INFINITY);
        assert!(ln(-1.0).is_nan());
        assert!(ln(f64::NAN).is_nan());
    }

    #[test]
    fn expm1_is_within_one_ulp_of_the_correctly_rounded_value() {
        for (x, want) in EXPM1_REFERENCE {
            let (x, want) = (f64::from_bits(x), f64::from_bits(want));
            let got = expm1(x);
            assert!(
                ulps(got, want) <= 1,
                "expm1({x:e}) = {got:e}, correctly rounded {want:e}"
            );
        }
        assert_eq!(expm1(0.0), 0.0);
        assert_eq!(expm1(-50.0), -1.0);
        assert!(expm1(f64::NAN).is_nan());
    }

    #[test]
    fn fmin_and_fmax_are_order_independent_for_zeros() {
        assert_eq!(fmin(0.0, -0.0).to_bits(), fmin(0.0, -0.0).to_bits());
        assert_eq!(fmin(1.0, 2.0), 1.0);
        assert_eq!(fmax(1.0, 2.0), 2.0);
        assert_eq!(fmin(-3.0, 2.0), -3.0);
        assert_eq!(fmax(-3.0, -2.0), -2.0);
    }

    #[test]
    fn cbrt_special_values() {
        for k in 1..=50_i32 {
            let k = f64::from(k);
            assert_eq!(cbrt(k * k * k), k);
            assert_eq!(cbrt(-(k * k * k)), -k);
        }
        assert_eq!(cbrt(0.125), 0.5);
        assert_eq!(cbrt(0.0).to_bits(), 0.0_f64.to_bits());
        assert_eq!(cbrt(-0.0).to_bits(), (-0.0_f64).to_bits());
        assert_eq!(cbrt(f64::INFINITY), f64::INFINITY);
        assert_eq!(cbrt(f64::NEG_INFINITY), f64::NEG_INFINITY);
        assert!(cbrt(f64::NAN).is_nan());
    }
}
