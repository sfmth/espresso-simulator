// SPDX-License-Identifier: GPL-2.0-or-later
//! Hydraulics: the bed's flow law at one instant, and the operating point of
//! pump, program and bed.
//!
//! **Bed.** Column i has the Darcy series resistance
//! R_i = ∫ μ(z) dz / (κ_i(z) A_i(z)) over its wetted depth, plus a fines layer
//! once it drips. With the poroelastic law Φ (see [`Poroelastic`]) its flow is
//! Φ(ΔP_i)/R_i. Columns still wetting drain into the dry bed at atmospheric
//! pressure, so ΔP_i = P_in. Columns that drip share the floor pressure
//! P_floor = a Q_out² of the outlet (holes and pressurised orifice in
//! series), so ΔP = P_in − P_floor and Q_out = G_t Φ(P_in − a Q_out²) with
//! G_t = Σ 1/R_i over them. The bed flow Q_bed(P_in) increases monotonically.
//!
//! **Supply.** The program and the pump deliver at most S(P) (non-increasing
//! in P), up to a pressure cap. The operating point is the intersection of
//! Q_bed with S below the cap, or the cap itself.

use super::props::Poroelastic;
use crate::math::fmin;

/// The bed's flow law at one instant.
#[derive(Clone, Debug, Default)]
pub(crate) struct BedCurve {
    /// Resistance of each column, Pa s/m³.
    pub resistance: Vec<f64>,
    /// Whether each column drips (its wetting front reached the floor).
    pub through: Vec<bool>,
    /// Σ 1/R over wetting and over dripping columns.
    pub g_wetting: f64,
    pub g_through: f64,
    /// Outlet coefficient a in ΔP = a Q².
    pub outlet: f64,
    pub poro: Option<f64>,
}

impl BedCurve {
    fn poro(&self) -> Poroelastic {
        Poroelastic { pc: self.poro }
    }

    /// Sums the conductances after `resistance` and `through` are filled.
    pub fn finish(&mut self) {
        self.g_wetting = 0.0;
        self.g_through = 0.0;
        for (r, &t) in self.resistance.iter().zip(&self.through) {
            if t {
                self.g_through += 1.0 / r;
            } else {
                self.g_wetting += 1.0 / r;
            }
        }
    }

    /// Flow through the dripping columns at inlet pressure `p`: the root of
    /// y = G_t Φ(p − a y²).
    pub fn through_flow(&self, p: f64) -> f64 {
        let g = self.g_through;
        if g == 0.0 || p <= 0.0 {
            return 0.0;
        }
        let poro = self.poro();
        let a = self.outlet;
        if a == 0.0 {
            return g * poro.phi(p);
        }
        if poro.pc.is_none() {
            // y = g (p − a y²): the positive root, without cancellation.
            return 2.0 * g * p / (1.0 + (1.0 + 4.0 * a * g * g * p).sqrt());
        }
        // Monotone root in [0, g Φ(p)].
        let hi = g * poro.phi(p);
        solve_increasing(|y| y - g * poro.phi(p - a * y * y), 0.0, hi)
    }

    /// Total bed flow at inlet pressure `p`.
    pub fn flow(&self, p: f64) -> f64 {
        if p <= 0.0 {
            return 0.0;
        }
        self.g_wetting * self.poro().phi(p) + self.through_flow(p)
    }

    /// Column flows at inlet pressure `p`; returns the floor pressure.
    pub fn column_flows(&self, p: f64, out: &mut [f64]) -> f64 {
        let poro = self.poro();
        let y = self.through_flow(p);
        let floor = self.outlet * y * y;
        let phi_wet = poro.phi(p);
        let phi_through = poro.phi(p - floor);
        for ((q, r), &t) in out.iter_mut().zip(&self.resistance).zip(&self.through) {
            *q = if p <= 0.0 {
                0.0
            } else if t {
                phi_through / r
            } else {
                phi_wet / r
            };
        }
        floor
    }
}

/// What the program and the pump can deliver.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Supply {
    /// Constant flow cap, m³/s (∞ for none).
    pub flow_cap: f64,
    /// Vibratory pump curve (free flow, stall pressure): Q ≤ Q_free(1 − P/P_stall).
    pub pump: Option<(f64, f64)>,
    /// Pressure cap, Pa (∞ for none).
    pub pressure_cap: f64,
}

impl Supply {
    /// S(P), the deliverable flow at inlet pressure `p`.
    pub fn at(&self, p: f64) -> f64 {
        match self.pump {
            None => self.flow_cap,
            Some((free, stall)) => {
                let curve = free * (1.0 - p / stall);
                fmin(self.flow_cap, if curve > 0.0 { curve } else { 0.0 })
            }
        }
    }
}

/// The operating point (P_in, Q) of the bed under a supply.
pub(crate) fn operating_point(bed: &BedCurve, supply: &Supply) -> (f64, f64) {
    let cap = supply.pressure_cap;
    if cap.is_nan() || cap <= 0.0 {
        return (0.0, 0.0);
    }
    if supply.at(0.0) <= 0.0 {
        return (0.0, 0.0);
    }
    let f = |p: f64| bed.flow(p) - supply.at(p);
    let p_hi = if cap.is_finite() {
        cap
    } else {
        // Without a cap the supply must be bounded (a pump curve or a flow
        // cap); find a pressure where the bed takes more than it.
        let mut p = 1e5;
        let mut n = 0;
        while f(p) < 0.0 && n < 200 {
            p *= 2.0;
            n += 1;
        }
        if f(p) < 0.0 {
            // The bed saturates below the supply: report the last pressure.
            return (p, bed.flow(p));
        }
        p
    };
    if cap.is_finite() && f(p_hi) <= 0.0 {
        return (p_hi, bed.flow(p_hi));
    }
    let p = solve_increasing(f, 0.0, p_hi);
    (p, bed.flow(p))
}

/// Root of an increasing function on [lo, hi] with f(lo) ≤ 0 ≤ f(hi), by the
/// Illinois variant of regula falsi with a bisection safeguard. Deterministic;
/// converges to a few ulps of the bracket.
pub(crate) fn solve_increasing(f: impl Fn(f64) -> f64, lo: f64, hi: f64) -> f64 {
    let (mut a, mut b) = (lo, hi);
    let (mut fa, mut fb) = (f(a), f(b));
    if fa >= 0.0 {
        return a;
    }
    if fb <= 0.0 {
        return b;
    }
    let mut side = 0_i8;
    for _ in 0..200 {
        let mut x = b - fb * (b - a) / (fb - fa);
        if !(x > a && x < b) {
            x = 0.5 * (a + b);
        }
        let fx = f(x);
        if fx == 0.0 {
            return x;
        }
        if fx < 0.0 {
            a = x;
            fa = fx;
            if side == -1 {
                fb *= 0.5;
            }
            side = -1;
        } else {
            b = x;
            fb = fx;
            if side == 1 {
                fa *= 0.5;
            }
            side = 1;
        }
        let mid = 0.5 * (a + b);
        if mid <= a || mid >= b || b - a <= 4.0 * f64::EPSILON * b.abs() {
            break;
        }
    }
    // The end with the smaller residual.
    if -fa < fb { a } else { b }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bed(r: &[f64], through: &[bool], outlet: f64, pc: Option<f64>) -> BedCurve {
        let mut b = BedCurve {
            resistance: r.to_vec(),
            through: through.to_vec(),
            outlet,
            poro: pc,
            ..BedCurve::default()
        };
        b.finish();
        b
    }

    #[test]
    fn darcy_columns_in_parallel() {
        let b = bed(&[2e11, 4e11], &[true, true], 0.0, None);
        let q = b.flow(9e5);
        assert!((q - 9e5 * (1.0 / 2e11 + 1.0 / 4e11)).abs() < 1e-20);
        let mut out = [0.0; 2];
        b.column_flows(9e5, &mut out);
        assert!((out[0] - 4.5e-6).abs() < 1e-20 && (out[1] - 2.25e-6).abs() < 1e-20);
    }

    #[test]
    fn orifice_in_series_matches_the_quadratic() {
        let r = 3e11;
        let a = 1e17;
        let b = bed(&[r], &[true], a, None);
        let p = 9e5;
        let q = b.flow(p);
        // p = R q + a q².
        assert!(((r * q + a * q * q) / p - 1.0).abs() < 1e-14);
        // The same through the iterative branch, with an inert P_c.
        let b2 = bed(&[r], &[true], a, Some(1e30));
        assert!((b2.flow(p) / q - 1.0).abs() < 1e-12);
    }

    #[test]
    fn vibratory_intersection() {
        let r = 3e11;
        let b = bed(&[r], &[true], 0.0, None);
        let s = Supply {
            flow_cap: f64::INFINITY,
            pump: Some((6e-6, 1.5e6)),
            pressure_cap: 1.5e6,
        };
        let (p, q) = operating_point(&b, &s);
        let q_want = 6e-6 / (1.0 + 6e-6 * r / 1.5e6);
        assert!((q / q_want - 1.0).abs() < 1e-13, "{q} {q_want}");
        assert!((p / (q_want * r) - 1.0).abs() < 1e-13);
        // An over-pressure valve below the intersection (8.2 bar) caps the
        // pressure.
        let s = Supply {
            pressure_cap: 7.0e5,
            ..s
        };
        let (p, q) = operating_point(&b, &s);
        assert_eq!(p, 7.0e5);
        assert!((q - 7.0e5 / r).abs() < 1e-20);
    }

    #[test]
    fn caps_and_limits() {
        let b = bed(&[1e11], &[false], 0.0, Some(1.2e6));
        // Pressure control, not flow-limited: the cap wins.
        let s = Supply {
            flow_cap: 1e-3,
            pump: None,
            pressure_cap: 9e5,
        };
        let (p, q) = operating_point(&b, &s);
        assert_eq!(p, 9e5);
        assert_eq!(q, b.flow(9e5));
        // Flow-limited: the bed would take more, so the pressure drops.
        let s = Supply {
            flow_cap: 1e-6,
            ..s
        };
        let (p, q) = operating_point(&b, &s);
        assert!((q - 1e-6).abs() < 1e-18);
        assert!(p < 9e5 && p > 0.0);
        // No pressure, no flow.
        let s = Supply {
            pressure_cap: 0.0,
            ..s
        };
        assert_eq!(operating_point(&b, &s), (0.0, 0.0));
    }
}
