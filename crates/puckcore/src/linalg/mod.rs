// SPDX-License-Identifier: GPL-2.0-or-later
//! Linear algebra used by the solvers.

pub mod tridiag;

pub use tridiag::{TridiagonalError, TridiagonalLu, tridiagonal_mul};
