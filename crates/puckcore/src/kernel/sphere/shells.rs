// SPDX-License-Identifier: GPL-2.0-or-later
//! Shell geometry and face conductances for the unit sphere.
//!
//! Everything here is dimensionless: radius 1, diffusivity 1, and volumes,
//! areas and conductances divided by 4π. In these units the semi-discrete
//! system for the shell-averaged concentrations c_j is
//!
//! ```text
//! V_j dc_j/dτ = G_{j−1/2} (c_{j−1} − c_j) − G_{j+1/2} (c_j − c_{j+1}),
//! ```
//!
//! with τ = D t / a², G_{−1/2} = 0 at the centre, and c_N = 0 at the surface.
//!
//! **Conductances.** The face between shells j and j+1, at radius q, gets
//!
//! ```text
//! G = 2 q³ / (μ_{j+1} − μ_j),   μ_j = (3/5) (r_{j+1}⁵ − r_j⁵) / (r_{j+1}³ − r_j³),
//! ```
//!
//! where μ_j is the volume average of r² over shell j. The surface face uses
//! the same formula with the surface as a node of zero concentration and
//! "μ = 1". With this choice the semi-discrete flux is exact for every
//! profile c = A + B r², taking shell averages as the unknowns. That covers
//! the uniform state, the parabolic profile of uniform depletion (the basis of
//! the linear-driving-force approximation) and the smooth even behaviour
//! near the centre. On the equal-volume grid this restores second-order
//! convergence. The plain volume-coordinate form (face coefficient u^{4/3})
//! loses it because the cells near the centre are coarse; it converges at
//! order ≈ 5/3 (docs/model/particle-kernel.md).
//!
//! **Round-off.** The differences of powers above cancel badly for thin
//! shells. They are therefore rewritten as products of positive terms, so
//! nothing cancels. With p = r_j, q = r_{j+1}, s = r_{j+2} and
//! S2(x, y) = x² + xy + y²:
//!
//! ```text
//! μ_{j+1} − μ_j = (3/5) (s − p) P / (S2(p,q) S2(q,s)),
//! P = q³ S2(p,s) + q² (p+s) S2(p,s) + q p s (p+s)² + p² s² (p+s),
//! 1 − μ_{N−1}  = (1 − p) (2 + 4p + 6p² + 3p³) / (5 S2(p,1)),   p = r_{N−1}.
//! ```
//!
//! The shell widths come from formulas without cancellation too (see
//! [`Shells::new`]).

use super::Grid;
use crate::linalg::TridiagonalLu;
use crate::math;

/// Finite-volume discretisation of the unit sphere.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Shells {
    /// Face radii: `faces[0] = 0 < faces[1] < … < faces[n] = 1`.
    pub faces: Vec<f64>,
    /// Shell volumes / 4π (`n` values; they sum to 1/3).
    pub volume: Vec<f64>,
    /// Conductance / 4π of the face between shells j and j + 1 (`n − 1` values).
    pub conductance: Vec<f64>,
    /// Conductance / 4π between the outer shell and the surface.
    pub surface_conductance: f64,
}

fn s2(x: f64, y: f64) -> f64 {
    x * x + x * y + y * y
}

impl Shells {
    /// Builds `n ≥ 2` shells on the requested grid.
    ///
    /// Uniform radius: r_j = j/n, widths 1/n, volumes (3j² + 3j + 1)/(3n³).
    /// Equal volume: r_j = (j/n)^{1/3}, volumes 1/(3n), and widths
    /// r_{j+1} − r_j = (1/n) / S2(r_j, r_{j+1}), which follows from
    /// r_{j+1}³ − r_j³ = 1/n.
    pub fn new(grid: Grid, n: usize) -> Self {
        assert!(n >= 2, "need at least two shells");
        let nf = n as f64;
        let (faces, width, volume): (Vec<f64>, Vec<f64>, Vec<f64>) = match grid {
            Grid::UniformRadius => {
                let faces = (0..=n).map(|j| j as f64 / nf).collect();
                let width = vec![1.0 / nf; n];
                // Integers below 2^53 for n ≤ 100 000, so only the division rounds.
                let n3 = 3 * (n as u64).pow(3);
                let volume = (0..n as u64)
                    .map(|j| (3 * j * (j + 1) + 1) as f64 / n3 as f64)
                    .collect();
                (faces, width, volume)
            }
            Grid::EqualVolume => {
                let mut faces: Vec<f64> = (0..=n).map(|j| math::cbrt(j as f64 / nf)).collect();
                faces[n] = 1.0;
                let width = faces
                    .windows(2)
                    .map(|w| (1.0 / nf) / s2(w[0], w[1]))
                    .collect();
                let volume = vec![1.0 / (3.0 * nf); n];
                (faces, width, volume)
            }
        };
        let conductance = (0..n - 1)
            .map(|j| {
                let (p, q, s) = (faces[j], faces[j + 1], faces[j + 2]);
                let sps = s2(p, s);
                let big_p = q * q * q * sps
                    + q * q * (p + s) * sps
                    + q * p * s * (p + s) * (p + s)
                    + p * p * s * s * (p + s);
                (10.0 / 3.0) * q * q * q * s2(p, q) * s2(q, s) / ((width[j] + width[j + 1]) * big_p)
            })
            .collect();
        let p = faces[n - 1];
        let surface_conductance =
            10.0 * s2(p, 1.0) / (width[n - 1] * (2.0 + 4.0 * p + 6.0 * p * p + 3.0 * p * p * p));
        Self {
            faces,
            volume,
            conductance,
            surface_conductance,
        }
    }

    /// Number of shells.
    pub fn len(&self) -> usize {
        self.volume.len()
    }

    /// Factorises `mass · V + stiffness · K`, where V is the diagonal of shell
    /// volumes and K the (symmetric, positive definite) conductance matrix.
    ///
    /// The matrix is a strictly diagonally dominant M-matrix for
    /// `mass > 0` and finite `stiffness ≥ 0`, so the factorisation cannot fail.
    pub fn factor(&self, mass: f64, stiffness: f64) -> TridiagonalLu {
        let n = self.len();
        let off: Vec<f64> = self.conductance.iter().map(|g| -stiffness * g).collect();
        let diag: Vec<f64> = (0..n)
            .map(|j| {
                let inner = if j > 0 { self.conductance[j - 1] } else { 0.0 };
                let outer = if j + 1 < n {
                    self.conductance[j]
                } else {
                    self.surface_conductance
                };
                mass * self.volume[j] + stiffness * (inner + outer)
            })
            .collect();
        TridiagonalLu::new(&off, &diag, &off)
            .expect("shell matrices are diagonally dominant with finite entries")
    }

    /// The semi-discrete rate V⁻¹(−K c), i.e. dc/dτ, for tests.
    #[cfg(test)]
    pub fn rate(&self, c: &[f64]) -> Vec<f64> {
        let n = self.len();
        (0..n)
            .map(|j| {
                let inflow = if j > 0 {
                    self.conductance[j - 1] * (c[j - 1] - c[j])
                } else {
                    0.0
                };
                let outflow = if j + 1 < n {
                    self.conductance[j] * (c[j] - c[j + 1])
                } else {
                    self.surface_conductance * c[j]
                };
                (inflow - outflow) / self.volume[j]
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn both_grids() -> [Grid; 2] {
        [Grid::UniformRadius, Grid::EqualVolume]
    }

    #[test]
    fn geometry_is_consistent() {
        for grid in both_grids() {
            for n in [2, 3, 10, 64, 1000, 100_000] {
                let s = Shells::new(grid, n);
                assert_eq!(s.faces.len(), n + 1);
                assert_eq!(s.faces[0], 0.0);
                assert_eq!(s.faces[n], 1.0);
                assert!(s.faces.windows(2).all(|w| w[1] > w[0]));
                // Volumes match the face radii and sum to 1/3. The direct
                // formula (q³ − p³)/3 loses up to ~11 digits for the thinnest
                // shells, hence the loose tolerance.
                let total: f64 = s.volume.iter().sum();
                let tol = 1e-15 + 4e-16 * n as f64; // naive summation round-off
                assert!((total - 1.0 / 3.0).abs() < tol, "{grid:?} {n}: {total}");
                for j in 0..n {
                    let (p, q) = (s.faces[j], s.faces[j + 1]);
                    let v = (q * q * q - p * p * p) / 3.0;
                    assert!((s.volume[j] - v).abs() <= 1e-9 * v, "{grid:?} {n} {j}");
                }
                assert!(s.conductance.iter().all(|&g| g > 0.0 && g.is_finite()));
                assert!(s.surface_conductance > 0.0 && s.surface_conductance.is_finite());
            }
        }
    }

    #[test]
    fn equal_volume_shells_have_equal_volumes() {
        let s = Shells::new(Grid::EqualVolume, 64);
        assert!(s.volume.iter().all(|&v| v == 1.0 / 192.0));
        assert!((s.faces[1] - 0.25).abs() < 1e-16);
    }

    /// Volume average of r^k over the shell [p, q].
    fn shell_mean_power(p: f64, q: f64, k: i32) -> f64 {
        3.0 / f64::from(k + 3) * (q.powi(k + 3) - p.powi(k + 3)) / (q.powi(3) - p.powi(3))
    }

    /// Volume average of r² over the shell [p, q], without cancellation:
    /// (3/5)(q⁴ + q³p + q²p² + qp³ + p⁴)/(q² + qp + p²).
    fn shell_mean_square(p: f64, q: f64) -> f64 {
        0.6 * (q * q * q * q + q * q * q * p + q * q * p * p + q * p * p * p + p * p * p * p)
            / s2(p, q)
    }

    #[test]
    fn flux_is_exact_for_parabolic_profiles() {
        // c = A + B r² has dc/dt = 6 B everywhere; with c = 0 at the surface
        // that means A = −B. What remains is round-off: neighbouring shell
        // averages differ by O(1/n), and inflow and outflow cancel to
        // O(1/n), so the rate carries a relative error of order ε n².
        let mut worst: f64 = 0.0;
        for grid in both_grids() {
            for n in [2, 5, 64, 300, 2000] {
                let s = Shells::new(grid, n);
                let (a, b) = (-0.7, 0.7);
                let c: Vec<f64> = (0..n)
                    .map(|j| a + b * shell_mean_square(s.faces[j], s.faces[j + 1]))
                    .collect();
                for (j, rate) in s.rate(&c).iter().enumerate() {
                    let rel = (rate / (6.0 * b) - 1.0).abs() / (f64::EPSILON * (n * n) as f64);
                    worst = worst.max(rel);
                    assert!(rel < 16.0, "{grid:?} n={n} shell {j}: {rate}");
                }
            }
        }
        println!("parabolic profiles: largest rate error {worst:.3} ε n²");
    }

    #[test]
    fn conductances_have_no_cancellation_for_thin_shells() {
        // Compare with a direct high-cancellation evaluation on a coarse grid,
        // where the direct formula is still accurate.
        for grid in both_grids() {
            let s = Shells::new(grid, 8);
            let mu = |j: usize| shell_mean_power(s.faces[j], s.faces[j + 1], 2);
            for j in 0..7 {
                let direct = 2.0 * s.faces[j + 1].powi(3) / (mu(j + 1) - mu(j));
                assert!((s.conductance[j] / direct - 1.0).abs() < 1e-13);
            }
            let direct = 2.0 / (1.0 - mu(7));
            assert!((s.surface_conductance / direct - 1.0).abs() < 1e-13);
        }
        // On a uniform grid of 100 000 shells, where the direct formula would
        // lose up to 10 digits, compare with the definition evaluated exactly.
        // With Δr = 1 the face radii are integers, so G = 2q³/(μ_{j+1} − μ_j)
        // is a ratio of integers; lengths, and hence G, scale by 1/n.
        let n = 100_000_usize;
        let s = Shells::new(Grid::UniformRadius, n);
        let exact_face = |j: i128| {
            let (p, q, r) = (j, j + 1, j + 2);
            let num = 10 * q.pow(3) * (r.pow(3) - q.pow(3)) * (q.pow(3) - p.pow(3));
            let den = 3
                * ((r.pow(5) - q.pow(5)) * (q.pow(3) - p.pow(3))
                    - (q.pow(5) - p.pow(5)) * (r.pow(3) - q.pow(3)));
            num as f64 / den as f64 / n as f64
        };
        let mut worst: f64 = 0.0;
        for j in [0, 1, 2, 3, 10, 100, 1000, 50_000, n - 3, n - 2] {
            let rel = (s.conductance[j] / exact_face(j as i128) - 1.0).abs();
            worst = worst.max(rel);
            assert!(rel < 4e-15, "face {j}: relative error {rel:e}");
        }
        // Surface: G_s = 2a³ / (a² − μ_{N−1}) with a = n, p = n − 1.
        let (a, p) = (n as i128, n as i128 - 1);
        let num = 10 * a.pow(3) * (a.pow(3) - p.pow(3));
        let den = 5 * a.pow(2) * (a.pow(3) - p.pow(3)) - 3 * (a.pow(5) - p.pow(5));
        let exact_surface = num as f64 / den as f64 / n as f64;
        let rel = (s.surface_conductance / exact_surface - 1.0).abs();
        assert!(rel < 4e-15, "surface: relative error {rel:e}");
        println!(
            "uniform grid, n = 1e5: largest conductance error {:.1e}",
            worst.max(rel)
        );
    }

    #[test]
    fn factorised_system_matches_assembly() {
        let s = Shells::new(Grid::EqualVolume, 6);
        let lu = s.factor(3.0, 0.25);
        // Solve with a known solution and compare.
        let x: Vec<f64> = (0..6).map(|j| 1.0 + j as f64).collect();
        let kx: Vec<f64> = s
            .rate(&x)
            .iter()
            .zip(&s.volume)
            .map(|(r, v)| -r * v)
            .collect();
        let mut b: Vec<f64> = (0..6)
            .map(|j| 3.0 * s.volume[j] * x[j] + 0.25 * kx[j])
            .collect();
        lu.solve_in_place(&mut b);
        for (got, want) in b.iter().zip(&x) {
            assert!((got - want).abs() < 1e-12, "{got} vs {want}");
        }
    }
}
