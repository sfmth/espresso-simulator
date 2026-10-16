// SPDX-License-Identifier: GPL-2.0-or-later
//! Tridiagonal linear systems, solved with the Thomas algorithm.
//!
//! Implicit time stepping with a constant matrix factorises once and then
//! solves one system per step. [`TridiagonalLu`] stores the factors, and
//! [`TridiagonalLu::solve_in_place`] solves without allocating. The particle
//! kernel uses it now; the M1 bed solver will reuse it.
//!
//! The algorithm does not pivot. It is stable for matrices that are diagonally
//! dominant by rows or columns, or symmetric positive definite, which covers
//! implicit discretisations of diffusion and upwinded advection. For a
//! strictly row-diagonally-dominant M-matrix (positive diagonal, non-positive
//! off-diagonals) with a non-negative right-hand side, every operation acts on
//! non-negative numbers, so the computed solution is non-negative even in
//! floating point.
//!
//! A system of size n is given by three slices: `diag` (n entries),
//! `lower` (n − 1 entries, `lower[i]` = `A[i+1][i]`) and `upper`
//! (n − 1 entries, `upper[i]` = `A[i][i+1]`).

use std::fmt;

/// Why a tridiagonal factorisation failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TridiagonalError {
    /// `lower` or `upper` does not have `diag.len() - 1` entries.
    DimensionMismatch,
    /// A pivot is zero or not finite: the matrix is singular, needs pivoting,
    /// or holds non-finite entries.
    BadPivot {
        /// Row at which elimination broke down.
        row: usize,
    },
}

impl fmt::Display for TridiagonalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DimensionMismatch => {
                write!(
                    f,
                    "off-diagonals must have one entry fewer than the diagonal"
                )
            }
            Self::BadPivot { row } => write!(f, "zero or non-finite pivot at row {row}"),
        }
    }
}

impl std::error::Error for TridiagonalError {}

/// LU factors of a tridiagonal matrix (Thomas algorithm, no pivoting).
///
/// A = L U, where L is unit lower bidiagonal and U is upper bidiagonal. The
/// factors are stored as the sub-diagonal of A, the reciprocal pivots, and the
/// scaled super-diagonal.
#[derive(Clone, Debug, PartialEq)]
pub struct TridiagonalLu {
    /// `A[i+1][i]`, unchanged from the input.
    lower: Vec<f64>,
    /// 1 / pivot for each row.
    inv_pivot: Vec<f64>,
    /// `A[i][i+1] / pivot_i`.
    upper_scaled: Vec<f64>,
}

impl TridiagonalLu {
    /// Factorises the matrix. Allocates storage for the factors.
    pub fn new(lower: &[f64], diag: &[f64], upper: &[f64]) -> Result<Self, TridiagonalError> {
        let mut lu = Self {
            lower: Vec::new(),
            inv_pivot: Vec::new(),
            upper_scaled: Vec::new(),
        };
        lu.refactor(lower, diag, upper)?;
        Ok(lu)
    }

    /// Factorises a new matrix into the existing storage. It does not allocate
    /// when the size is unchanged. On error the stored factors are invalid
    /// until the next successful call.
    pub fn refactor(
        &mut self,
        lower: &[f64],
        diag: &[f64],
        upper: &[f64],
    ) -> Result<(), TridiagonalError> {
        let n = diag.len();
        let n_off = n.saturating_sub(1);
        if lower.len() != n_off || upper.len() != n_off {
            return Err(TridiagonalError::DimensionMismatch);
        }
        self.lower.clear();
        self.lower.extend_from_slice(lower);
        self.inv_pivot.resize(n, 0.0);
        self.upper_scaled.resize(n_off, 0.0);
        let mut previous_upper_scaled = 0.0;
        for i in 0..n {
            let mut pivot = diag[i];
            if i > 0 {
                pivot -= lower[i - 1] * previous_upper_scaled;
            }
            if pivot == 0.0 || !pivot.is_finite() {
                return Err(TridiagonalError::BadPivot { row: i });
            }
            let inv = 1.0 / pivot;
            self.inv_pivot[i] = inv;
            if i < n_off {
                previous_upper_scaled = upper[i] * inv;
                self.upper_scaled[i] = previous_upper_scaled;
            }
        }
        Ok(())
    }

    /// Size of the system.
    pub fn len(&self) -> usize {
        self.inv_pivot.len()
    }

    /// True for an empty (0 × 0) system.
    pub fn is_empty(&self) -> bool {
        self.inv_pivot.is_empty()
    }

    /// Whether every pivot is positive (and finite). An M-matrix factorised
    /// without pivoting has positive pivots, so callers that rely on that
    /// structure (for positivity of the solution) can check it here.
    pub fn pivots_positive(&self) -> bool {
        self.inv_pivot.iter().all(|&x| x > 0.0 && x.is_finite())
    }

    /// Solves A x = b in place: `rhs` holds b on entry and x on return.
    /// Does not allocate.
    ///
    /// # Panics
    /// If `rhs.len()` differs from the size of the system.
    pub fn solve_in_place(&self, rhs: &mut [f64]) {
        let n = self.len();
        assert_eq!(rhs.len(), n, "right-hand side has the wrong length");
        if n == 0 {
            return;
        }
        // Forward substitution: L y = b, with the pivots folded in.
        let mut previous = rhs[0] * self.inv_pivot[0];
        rhs[0] = previous;
        for ((r, l), inv) in rhs[1..]
            .iter_mut()
            .zip(&self.lower)
            .zip(&self.inv_pivot[1..])
        {
            previous = (*r - l * previous) * inv;
            *r = previous;
        }
        // Back substitution: U x = y.
        let mut next = rhs[n - 1];
        for (r, u) in rhs[..n - 1].iter_mut().zip(&self.upper_scaled).rev() {
            next = *r - u * next;
            *r = next;
        }
    }

    /// Solves A x = b for many right-hand sides at once, in place. Row `i` of
    /// system `j` is `data[i * stride + j]`, for the systems `j` in `systems`;
    /// rows are contiguous across systems, so the loops run in lockstep and
    /// vectorise. Each system gets exactly the operations of
    /// [`solve_in_place`](Self::solve_in_place), so the results are
    /// bit-identical to solving them one by one. Does not allocate.
    ///
    /// # Panics
    /// If `data` is too short for the rows, or `systems.end > stride`.
    pub fn solve_many_in_place(
        &self,
        data: &mut [f64],
        stride: usize,
        systems: std::ops::Range<usize>,
    ) {
        let n = self.len();
        if n == 0 || systems.is_empty() {
            return;
        }
        assert!(systems.end <= stride, "systems exceed the row stride");
        assert!(
            data.len() >= (n - 1) * stride + systems.end,
            "data too short for the rows"
        );
        let (j0, j1) = (systems.start, systems.end);
        let inv0 = self.inv_pivot[0];
        for x in &mut data[j0..j1] {
            *x *= inv0;
        }
        for i in 1..n {
            let (head, tail) = data.split_at_mut(i * stride);
            let prev = &head[(i - 1) * stride + j0..(i - 1) * stride + j1];
            let cur = &mut tail[j0..j1];
            let (l, inv) = (self.lower[i - 1], self.inv_pivot[i]);
            for (x, p) in cur.iter_mut().zip(prev) {
                *x = (*x - l * p) * inv;
            }
        }
        for i in (0..n - 1).rev() {
            let (head, tail) = data.split_at_mut((i + 1) * stride);
            let next = &tail[j0..j1];
            let cur = &mut head[i * stride + j0..i * stride + j1];
            let u = self.upper_scaled[i];
            for (x, nx) in cur.iter_mut().zip(next) {
                *x -= u * nx;
            }
        }
    }
}

/// Computes y = A x for the tridiagonal matrix A, without allocating.
///
/// # Panics
/// If the slice lengths are inconsistent.
pub fn tridiagonal_mul(lower: &[f64], diag: &[f64], upper: &[f64], x: &[f64], y: &mut [f64]) {
    let n = diag.len();
    let n_off = n.saturating_sub(1);
    assert!(
        lower.len() == n_off && upper.len() == n_off && x.len() == n && y.len() == n,
        "inconsistent tridiagonal dimensions"
    );
    for i in 0..n {
        let mut v = diag[i] * x[i];
        if i > 0 {
            v += lower[i - 1] * x[i - 1];
        }
        if i < n_off {
            v += upper[i] * x[i + 1];
        }
        y[i] = v;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic pseudo-random numbers in [0, 1).
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

    /// A random strictly diagonally dominant system of size n.
    fn random_system(n: usize, seed: u64) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
        let mut rng = Lcg(seed);
        let lower: Vec<f64> = (0..n.saturating_sub(1)).map(|_| rng.next() - 0.5).collect();
        let upper: Vec<f64> = (0..n.saturating_sub(1)).map(|_| rng.next() - 0.5).collect();
        let diag = (0..n)
            .map(|i| {
                let l = if i > 0 { lower[i - 1].abs() } else { 0.0 };
                let u = if i + 1 < n { upper[i].abs() } else { 0.0 };
                (l + u + 0.1 + rng.next()) * if i % 3 == 0 { -1.0 } else { 1.0 }
            })
            .collect();
        (lower, diag, upper)
    }

    #[test]
    fn pivot_signs_are_reported() {
        let lu = TridiagonalLu::new(&[-1.0; 3], &[2.0; 4], &[-1.0; 3]).unwrap();
        assert!(lu.pivots_positive());
        let lu = TridiagonalLu::new(&[1.0], &[-1.0, 2.0], &[1.0]).unwrap();
        assert!(!lu.pivots_positive());
    }

    #[test]
    fn batched_solves_are_bit_identical_to_single_solves() {
        for (n, seed) in [(1, 7), (2, 8), (5, 9), (33, 10)] {
            let (lower, diag, upper) = random_system(n, seed);
            let lu = TridiagonalLu::new(&lower, &diag, &upper).unwrap();
            let (stride, systems) = (11, 2..9);
            let mut rng = Lcg(seed + 7);
            let data: Vec<f64> = (0..n * stride).map(|_| rng.next() - 0.3).collect();
            let mut batch = data.clone();
            lu.solve_many_in_place(&mut batch, stride, systems.clone());
            for j in 0..stride {
                let mut single: Vec<f64> = (0..n).map(|i| data[i * stride + j]).collect();
                if systems.contains(&j) {
                    lu.solve_in_place(&mut single);
                }
                for i in 0..n {
                    assert_eq!(batch[i * stride + j].to_bits(), single[i].to_bits());
                }
            }
        }
    }

    #[test]
    fn solves_a_known_system() {
        // 1-D Laplacian with Dirichlet ends; exact solution x = (1, 2, 3, 4).
        let lower = [-1.0; 3];
        let upper = [-1.0; 3];
        let diag = [2.0; 4];
        let x_true = [1.0, 2.0, 3.0, 4.0];
        let mut b = [0.0; 4];
        tridiagonal_mul(&lower, &diag, &upper, &x_true, &mut b);
        assert_eq!(b, [0.0, 0.0, 0.0, 5.0]);
        let lu = TridiagonalLu::new(&lower, &diag, &upper).unwrap();
        lu.solve_in_place(&mut b);
        for (x, t) in b.iter().zip(x_true) {
            assert!((x - t).abs() < 1e-14, "{x} vs {t}");
        }
    }

    #[test]
    fn random_systems_have_small_residuals() {
        for (n, seed) in [(1, 1), (2, 2), (3, 3), (17, 4), (1000, 5)] {
            let (lower, diag, upper) = random_system(n, seed);
            let mut rng = Lcg(seed + 100);
            let x_true: Vec<f64> = (0..n).map(|_| rng.next() * 2.0 - 1.0).collect();
            let mut b = vec![0.0; n];
            tridiagonal_mul(&lower, &diag, &upper, &x_true, &mut b);
            let lu = TridiagonalLu::new(&lower, &diag, &upper).unwrap();
            let mut x = b.clone();
            lu.solve_in_place(&mut x);
            let err = x
                .iter()
                .zip(&x_true)
                .map(|(a, b)| (a - b).abs())
                .fold(0.0, f64::max);
            assert!(err < 1e-13, "n = {n}: max error {err}");
        }
    }

    #[test]
    fn nonsymmetric_system_matches_dense_elimination() {
        // Upwind-like matrix (non-symmetric); compare with Gaussian elimination.
        let lower = [-1.5, -0.25, -2.0];
        let diag = [3.0, 2.0, 4.0, 3.5];
        let upper = [-0.5, -1.0, -0.75];
        let b = [1.0, -2.0, 0.5, 3.0];
        let mut dense = [[0.0; 5]; 4];
        for i in 0..4 {
            dense[i][i] = diag[i];
            if i > 0 {
                dense[i][i - 1] = lower[i - 1];
            }
            if i < 3 {
                dense[i][i + 1] = upper[i];
            }
            dense[i][4] = b[i];
        }
        for k in 0..4 {
            let pivot_row = dense[k];
            for row in dense.iter_mut().skip(k + 1) {
                let f = row[k] / pivot_row[k];
                for (x, p) in row[k..].iter_mut().zip(&pivot_row[k..]) {
                    *x -= f * p;
                }
            }
        }
        let mut expect = [0.0; 4];
        for i in (0..4).rev() {
            let s: f64 = (i + 1..4).map(|j| dense[i][j] * expect[j]).sum();
            expect[i] = (dense[i][4] - s) / dense[i][i];
        }
        let lu = TridiagonalLu::new(&lower, &diag, &upper).unwrap();
        let mut x = b;
        lu.solve_in_place(&mut x);
        for (a, e) in x.iter().zip(expect) {
            assert!((a - e).abs() < 1e-14, "{a} vs {e}");
        }
    }

    #[test]
    fn factors_are_reused_for_many_right_hand_sides() {
        let (lower, diag, upper) = random_system(50, 9);
        let mut lu = TridiagonalLu::new(&lower, &diag, &upper).unwrap();
        let mut rng = Lcg(10);
        for _ in 0..10 {
            let b: Vec<f64> = (0..50).map(|_| rng.next()).collect();
            let mut x = b.clone();
            lu.solve_in_place(&mut x);
            let mut back = vec![0.0; 50];
            tridiagonal_mul(&lower, &diag, &upper, &x, &mut back);
            for (r, s) in back.iter().zip(&b) {
                assert!((r - s).abs() < 1e-13);
            }
        }
        // Refactoring with the same size keeps the storage.
        let ptr = lu.inv_pivot.as_ptr();
        let (lower2, diag2, upper2) = random_system(50, 11);
        lu.refactor(&lower2, &diag2, &upper2).unwrap();
        assert_eq!(ptr, lu.inv_pivot.as_ptr());
        assert_eq!(lu, TridiagonalLu::new(&lower2, &diag2, &upper2).unwrap());
    }

    #[test]
    fn m_matrix_gives_non_negative_solutions() {
        // Backward-Euler diffusion matrix: positive diagonal, negative off-diagonals.
        let n = 200;
        let g = 1e6;
        let lower = vec![-g; n - 1];
        let upper = vec![-g; n - 1];
        let diag: Vec<f64> = (0..n)
            .map(|i| 1.0 + if i == 0 || i == n - 1 { g } else { 2.0 * g } + 1e-3)
            .collect();
        let lu = TridiagonalLu::new(&lower, &diag, &upper).unwrap();
        let mut b = vec![0.0; n];
        b[0] = 1.0;
        b[n / 2] = 1e-300;
        lu.solve_in_place(&mut b);
        assert!(b.iter().all(|&v| v >= 0.0));
    }

    #[test]
    fn edge_cases_and_errors() {
        let empty = TridiagonalLu::new(&[], &[], &[]).unwrap();
        assert!(empty.is_empty());
        empty.solve_in_place(&mut []);
        let one = TridiagonalLu::new(&[], &[4.0], &[]).unwrap();
        let mut x = [2.0];
        one.solve_in_place(&mut x);
        assert_eq!(x, [0.5]);
        assert_eq!(
            TridiagonalLu::new(&[1.0], &[1.0, 2.0, 3.0], &[1.0, 1.0]),
            Err(TridiagonalError::DimensionMismatch)
        );
        assert_eq!(
            TridiagonalLu::new(&[1.0], &[1.0, 1.0], &[1.0]),
            Err(TridiagonalError::BadPivot { row: 1 })
        );
        assert_eq!(
            TridiagonalLu::new(&[], &[f64::NAN], &[]),
            Err(TridiagonalError::BadPivot { row: 0 })
        );
        assert!(
            TridiagonalError::BadPivot { row: 3 }
                .to_string()
                .contains("row 3")
        );
    }

    #[test]
    #[should_panic(expected = "wrong length")]
    fn solve_rejects_a_wrong_length() {
        let lu = TridiagonalLu::new(&[1.0], &[3.0, 3.0], &[1.0]).unwrap();
        lu.solve_in_place(&mut [1.0, 2.0, 3.0]);
    }
}
