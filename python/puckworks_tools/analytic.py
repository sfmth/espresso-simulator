# SPDX-License-Identifier: GPL-2.0-or-later
"""Independent implementation of Crank's perfect-sink sphere solution.

A sphere of radius a holds a uniform concentration at t = 0; its surface is
held at zero for t > 0 and the solute diffuses out with constant D. With
tau = D t / a², the released fraction is (Crank 1975, *The Mathematics of
Diffusion*, 2nd ed., eqs. 6.20 and 6.21)

    M_t/M_inf = 1 - (6/pi²) sum_{n>=1} exp(-n² pi² tau) / n²                 (long time)
              = 6 sqrt(tau) [1/sqrt(pi) + 2 sum_{n>=1} ierfc(n/sqrt(tau))] - 3 tau  (short time)

with ierfc(x) = exp(-x²)/sqrt(pi) - x erfc(x).

This module is written from those formulas and deliberately does not call
puckcore, so that it can check ``puckcore.crank_sphere_release_fraction``.
The long-time series is summed with as many terms as tau needs (NumPy's
pairwise summation keeps the rounding error near machine precision); the
short-time series is an algebraically different second route used to
cross-check it.
"""

from __future__ import annotations

import math

import numpy as np
from numpy.typing import ArrayLike, NDArray

_PI2 = math.pi**2
_SQRT_PI = math.sqrt(math.pi)


def _as_tau(tau: ArrayLike) -> NDArray[np.float64]:
    values = np.asarray(tau, dtype=np.float64)
    if not np.all(np.isfinite(values)) or np.any(values < 0):
        raise ValueError("tau must be finite and >= 0")
    return values


def terms_needed(tau: float, rel_tol: float = 1e-20) -> int:
    """Number of long-time terms after which exp(-n² pi² tau) < rel_tol."""
    return int(math.ceil(math.sqrt(-math.log(rel_tol) / (_PI2 * tau)))) + 1


def release_fraction(tau: ArrayLike) -> NDArray[np.float64] | float:
    """Released fraction from the long-time series (Crank eq. 6.20).

    Accepts a scalar or an array of tau = D t / a² >= 0 and returns the same shape.
    """
    values = _as_tau(tau)
    out = np.zeros_like(values)
    flat_in, flat_out = values.ravel(), out.reshape(-1)
    for i, t in enumerate(flat_in):
        if t == 0.0:
            continue
        n = np.arange(1, terms_needed(float(t)) + 1, dtype=np.float64)
        n2 = n * n
        flat_out[i] = 1.0 - 6.0 / _PI2 * float(np.sum(np.exp(-n2 * _PI2 * t) / n2))
    return float(out) if out.ndim == 0 else out


def _ierfc(x: float) -> float:
    return math.exp(-x * x) / _SQRT_PI - x * math.erfc(x)


def release_fraction_short_time(tau: ArrayLike) -> NDArray[np.float64] | float:
    """Released fraction from the short-time series (Crank eq. 6.21).

    Accurate to near machine precision for tau up to about 1; beyond that the
    final subtraction loses digits, so use :func:`release_fraction` there.
    """
    values = _as_tau(tau)
    out = np.zeros_like(values)
    flat_in, flat_out = values.ravel(), out.reshape(-1)
    for i, t in enumerate(flat_in):
        t = float(t)
        if t == 0.0:
            continue
        root = math.sqrt(t)
        total = 0.0
        for n in range(1, 10_000):
            term = _ierfc(n / root)
            total += term
            if term < 1e-22:
                break
        flat_out[i] = 6.0 * root * (1.0 / _SQRT_PI + 2.0 * total) - 3.0 * t
    return float(out) if out.ndim == 0 else out
