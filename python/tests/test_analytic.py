# SPDX-License-Identifier: GPL-2.0-or-later
"""The independent NumPy implementation of Crank's solution, and its check of puckcore."""

from __future__ import annotations

import math

import numpy as np
import pytest

from puckworks_tools import analytic, verify


def test_limits():
    assert analytic.release_fraction(0.0) == 0.0
    assert analytic.release_fraction(50.0) == 1.0
    assert 0.0 < analytic.release_fraction(1e-9) < 1e-3


def test_shape_and_monotonicity():
    tau = np.logspace(-7, 1, 400)
    m = analytic.release_fraction(tau)
    assert isinstance(m, np.ndarray) and m.shape == tau.shape
    assert np.all(np.diff(m) >= 0)
    assert np.all(np.diff(m[m < 1.0]) > 0)
    assert np.all((m >= 0) & (m <= 1))
    grid = analytic.release_fraction(tau.reshape(20, 20))
    assert grid.shape == (20, 20)
    np.testing.assert_array_equal(grid.ravel(), m)


def test_long_and_short_time_series_agree():
    """Two algebraically different routes (Crank eqs. 6.20 and 6.21) give the same numbers."""
    tau = np.logspace(-6, 0, 121)
    long_time = analytic.release_fraction(tau)
    short_time = analytic.release_fraction_short_time(tau)
    np.testing.assert_allclose(long_time, short_time, rtol=0, atol=2e-14)


def test_small_time_asymptote():
    tau = 1e-8
    expected = 6.0 * math.sqrt(tau / math.pi) - 3.0 * tau
    assert analytic.release_fraction(tau) == pytest.approx(expected, rel=1e-10)


def test_large_time_single_term():
    tau = 1.0
    expected = 1.0 - 6.0 / math.pi**2 * math.exp(-(math.pi**2) * tau)
    assert analytic.release_fraction(tau) == pytest.approx(expected, rel=0, abs=1e-15)


def test_half_release_time():
    """Half the solute has left a sphere at D t / a² ≈ 0.0305 (textbook value)."""
    assert analytic.release_fraction(0.0305) == pytest.approx(0.5, abs=1e-3)


def test_rejects_invalid_tau():
    with pytest.raises(ValueError):
        analytic.release_fraction(-1e-3)
    with pytest.raises(ValueError):
        analytic.release_fraction([0.1, float("nan")])


def test_terms_needed():
    assert analytic.terms_needed(1.0) <= 4
    assert analytic.terms_needed(1e-8) > 20_000


def test_agrees_with_puckcore():
    puckcore = pytest.importorskip("puckcore")
    config = verify.VerifyConfig(analytic_tau_min=1e-8, analytic_tau_max=10.0, analytic_points=801)
    check = verify.analytic_check(puckcore, config)
    assert check["n_tau"] >= 801
    assert check["max_abs_diff"] < 1e-12, check
    # Also in physical units: a 150 µm particle with D = 1e-10 m²/s.
    for t in (0.0, 0.5, 2.25, 22.5, 60.0, 225.0):
        tau = 1e-10 * t / 150e-6**2
        ours = analytic.release_fraction(tau)
        theirs = puckcore.crank_sphere_release_fraction(t, 150e-6, 1e-10)
        assert abs(ours - theirs) < 1e-12, (t, ours, theirs)
