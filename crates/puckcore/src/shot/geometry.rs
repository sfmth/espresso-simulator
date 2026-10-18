// SPDX-License-Identifier: GPL-2.0-or-later
//! Axisymmetric basket geometry: exact volumes and Darcy integrals of a
//! piecewise-linear wall profile.
//!
//! Heights h are measured up from the basket floor. Between profile points
//! the radius is linear, so each segment is a frustum with
//!
//! ```text
//! V = π Δh (r_a² + r_a r_b + r_b²)/3,      ∫ dh / (π r²) = Δh / (π r_a r_b),
//! ```
//!
//! both exact (the second for any linear r, including r_a = r_b). The bed
//! fills the basket from the floor; depth z is measured down from the bed
//! top, z = L − h.

use std::f64::consts::PI;

/// A validated wall profile: heights from 0, strictly increasing; radii > 0.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Profile {
    h: Vec<f64>,
    r: Vec<f64>,
}

/// Volume of a frustum of height `dh` between radii `ra` and `rb`.
fn frustum_volume(ra: f64, rb: f64, dh: f64) -> f64 {
    PI * dh * (ra * ra + ra * rb + rb * rb) / 3.0
}

impl Profile {
    /// Builds the profile from `[height, radius]` points (already validated).
    pub fn new(points: &[[f64; 2]]) -> Self {
        Self {
            h: points.iter().map(|p| p[0]).collect(),
            r: points.iter().map(|p| p[1]).collect(),
        }
    }

    /// Height of the basket rim (the last point).
    pub fn top(&self) -> f64 {
        self.h[self.h.len() - 1]
    }

    /// Floor radius.
    pub fn floor_radius(&self) -> f64 {
        self.r[0]
    }

    /// Radius at height `h` (clamped to the profile).
    pub fn radius_at(&self, h: f64) -> f64 {
        if h <= self.h[0] {
            return self.r[0];
        }
        for s in 0..self.h.len() - 1 {
            let (h0, h1) = (self.h[s], self.h[s + 1]);
            if h <= h1 {
                return self.r[s] + (self.r[s + 1] - self.r[s]) * ((h - h0) / (h1 - h0));
            }
        }
        self.r[self.r.len() - 1]
    }

    /// Cross-section area at height `h`.
    pub fn area_at(&self, h: f64) -> f64 {
        let r = self.radius_at(h);
        PI * r * r
    }

    /// Calls `f(r_lo, r_hi, dh)` for each piece of [lo, hi] inside one segment.
    fn for_pieces(&self, lo: f64, hi: f64, mut f: impl FnMut(f64, f64, f64)) {
        if hi <= lo {
            return;
        }
        for s in 0..self.h.len() - 1 {
            let (h0, h1) = (self.h[s], self.h[s + 1]);
            if h1 <= lo {
                continue;
            }
            if h0 >= hi {
                break;
            }
            let a = if lo > h0 { lo } else { h0 };
            let b = if hi < h1 { hi } else { h1 };
            if b > a {
                let slope = (self.r[s + 1] - self.r[s]) / (h1 - h0);
                let ra = if a == h0 {
                    self.r[s]
                } else {
                    self.r[s] + slope * (a - h0)
                };
                let rb = if b == h1 {
                    self.r[s + 1]
                } else {
                    self.r[s] + slope * (b - h0)
                };
                f(ra, rb, b - a);
            }
        }
    }

    /// Volume between heights `lo` and `hi`, m³.
    pub fn volume(&self, lo: f64, hi: f64) -> f64 {
        let mut v = 0.0;
        self.for_pieces(lo, hi, |ra, rb, dh| v += frustum_volume(ra, rb, dh));
        v
    }

    /// ∫ dh / A(h) between heights `lo` and `hi`, 1/m.
    pub fn inverse_area_integral(&self, lo: f64, hi: f64) -> f64 {
        let mut g = 0.0;
        self.for_pieces(lo, hi, |ra, rb, dh| g += dh / (PI * ra * rb));
        g
    }

    /// Positive three-point quadrature for the resistance-weighted mean of
    /// a field. Each pair is (volume fraction from the top, weight). Weights
    /// sum to one: multiply the mean by the exact Darcy integral separately.
    pub fn resistance_quadrature(&self, lo: f64, hi: f64) -> [(f64, f64); 3] {
        let offset = (3.0_f64 / 5.0).sqrt() / 2.0;
        let nodes = [
            (0.5 - offset, 5.0 / 18.0),
            (0.5, 4.0 / 9.0),
            (0.5 + offset, 5.0 / 18.0),
        ];
        let volume = self.volume(lo, hi);
        if volume <= 0.0 {
            return [(0.5, 1.0), (0.5, 0.0), (0.5, 0.0)];
        }
        let mut out = [(0.0, 0.0); 3];
        let mut total = 0.0;
        for (i, (position, weight)) in nodes.into_iter().enumerate() {
            let height = hi - position * (hi - lo);
            let w = weight / self.area_at(height);
            out[i] = (self.volume(height, hi) / volume, w);
            total += w;
        }
        for (_, weight) in &mut out {
            *weight /= total;
        }
        out
    }

    /// Total volume of the basket.
    pub fn total_volume(&self) -> f64 {
        self.volume(0.0, self.top())
    }

    /// The height h with volume(0, h) = `v`, for 0 ≤ v ≤ total volume.
    pub fn height_for_volume(&self, v: f64) -> f64 {
        self.height_above(0.0, v)
    }

    /// The height h ≥ `base` with volume(base, h) = `v` (capped at the rim).
    /// Bisection on the monotone volume, to the last bit.
    pub fn height_above(&self, base: f64, v: f64) -> f64 {
        if v <= 0.0 {
            return base;
        }
        let top = self.top();
        if self.volume(base, top) <= v {
            return top;
        }
        let (mut lo, mut hi) = (base, top);
        for _ in 0..200 {
            let mid = 0.5 * (lo + hi);
            if mid <= lo || mid >= hi {
                break;
            }
            if self.volume(base, mid) < v {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        hi
    }

    /// The height h ≤ `ceiling` with volume(h, ceiling) = `v` (floored at 0).
    pub fn height_below(&self, ceiling: f64, v: f64) -> f64 {
        if v <= 0.0 {
            return ceiling;
        }
        if self.volume(0.0, ceiling) <= v {
            return 0.0;
        }
        let (mut lo, mut hi) = (0.0, ceiling);
        for _ in 0..200 {
            let mid = 0.5 * (lo + hi);
            if mid <= lo || mid >= hi {
                break;
            }
            if self.volume(mid, ceiling) > v {
                lo = mid;
            } else {
                hi = mid;
            }
        }
        lo
    }
}

/// One depth cell of the bed (whole cross-section; a column takes its area
/// share of the volume and of the face areas).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct Cell {
    /// Height of the cell's top and bottom faces above the floor, m.
    pub h_top: f64,
    pub h_bottom: f64,
    /// Depth of the cell centre below the bed top, m.
    pub depth_centre: f64,
    /// Thickness, m.
    pub dz: f64,
    /// Volume, m³.
    pub volume: f64,
    /// ∫ dz / A(z) over the cell, 1/m.
    pub inverse_area: f64,
    /// Volume coordinates and normalized positive Darcy weights.
    pub resistance_quadrature: [(f64, f64); 3],
    /// Cross-section area of the bottom face, m².
    pub bottom_area: f64,
}

/// Splits a bed of height `bed_height` into `n` cells of equal thickness.
pub(crate) fn cells(profile: &Profile, bed_height: f64, n: usize) -> Vec<Cell> {
    let nf = n as f64;
    (0..n)
        .map(|j| {
            // Heights as exact fractions of L, so the last bottom is exactly 0.
            let h_top = bed_height * ((n - j) as f64 / nf);
            let h_bottom = bed_height * ((n - j - 1) as f64 / nf);
            Cell {
                h_top,
                h_bottom,
                depth_centre: bed_height * ((j as f64 + 0.5) / nf),
                dz: h_top - h_bottom,
                volume: profile.volume(h_bottom, h_top),
                inverse_area: profile.inverse_area_integral(h_bottom, h_top),
                resistance_quadrature: profile.resistance_quadrature(h_bottom, h_top),
                bottom_area: profile.area_at(h_bottom),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn straight() -> Profile {
        Profile::new(&[[0.0, 0.029], [0.025, 0.029]])
    }

    fn frustum() -> Profile {
        Profile::new(&[[0.0, 0.025], [0.02, 0.03]])
    }

    #[test]
    fn straight_basket_volumes_and_integrals() {
        let p = straight();
        let a = PI * 0.029 * 0.029;
        assert!((p.total_volume() - a * 0.025).abs() < 1e-18);
        assert!((p.inverse_area_integral(0.0, 0.014) - 0.014 / a).abs() < 1e-12);
        let h = p.height_for_volume(a * 0.014);
        assert!((h - 0.014).abs() < 1e-17, "{h}");
        let h = p.height_above(0.003, a * 0.002);
        assert!((h - 0.005).abs() < 1e-17);
        let h = p.height_below(0.010, a * 0.004);
        assert!((h - 0.006).abs() < 1e-17);
        assert_eq!(p.radius_at(0.01), 0.029);
    }

    #[test]
    fn frustum_volumes_and_integrals_are_exact() {
        let p = frustum();
        let (r0, r1, l) = (0.025, 0.03, 0.02);
        let v = PI * l * (r0 * r0 + r0 * r1 + r1 * r1) / 3.0;
        assert!((p.total_volume() / v - 1.0).abs() < 1e-15);
        // ∫ dz/A = L/(π r0 r1), the analytic value for a frustum.
        let g = p.inverse_area_integral(0.0, l);
        assert!((g / (l / (PI * r0 * r1)) - 1.0).abs() < 1e-15);
        // Summing cells reproduces the totals.
        let cs = cells(&p, 0.012, 7);
        let r_l = p.radius_at(0.012);
        let gsum: f64 = cs.iter().map(|c| c.inverse_area).sum();
        assert!((gsum / (0.012 / (PI * r0 * r_l)) - 1.0).abs() < 1e-14);
        let vsum: f64 = cs.iter().map(|c| c.volume).sum();
        assert!((vsum / p.volume(0.0, 0.012) - 1.0).abs() < 1e-14);
        assert_eq!(cs[6].h_bottom, 0.0);
        assert_eq!(cs[0].h_top, 0.012);
        // Volume inversion.
        let h = p.height_for_volume(p.volume(0.0, 0.0137));
        assert!((h - 0.0137).abs() < 1e-17);
    }

    #[test]
    fn stepped_profile_splits_at_the_kink() {
        let p = Profile::new(&[[0.0, 0.02], [0.01, 0.02], [0.01 + 1e-9, 0.03], [0.03, 0.03]]);
        let v = p.volume(0.005, 0.02);
        let want = PI * 0.02 * 0.02 * 0.005
            + frustum_volume(0.02, 0.03, 1e-9)
            + PI * 0.03 * 0.03 * (0.01 - 1e-9);
        assert!((v / want - 1.0).abs() < 1e-12);
        let g = p.inverse_area_integral(0.0, 0.03);
        assert!(g > 0.0 && g.is_finite());
    }
}
