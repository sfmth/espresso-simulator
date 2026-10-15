# SPDX-License-Identifier: GPL-2.0-or-later
"""The unit vocabulary: self-consistency, parsing, conversion, and tamper detection."""

from __future__ import annotations

import math

import pytest

from puckworks_tools.registry import load_registry
from puckworks_tools.units import UnitError, load_units


def test_vocabulary_is_self_consistent(units):
    assert units.check() == []
    assert units.base_dimensions == ("m", "kg", "s", "K", "mol")


def test_every_registry_unit_is_listed(repo, units):
    used = {record["units"] for record in load_registry(repo).values()}
    assert used <= set(units.units), sorted(used - set(units.units))


@pytest.mark.parametrize(
    "expression,dims,scale",
    [
        ("1", (0, 0, 0, 0, 0), 1.0),
        ("%", (0, 0, 0, 0, 0), 0.01),
        ("mg/g", (0, 0, 0, 0, 0), 1e-3),
        ("um", (1, 0, 0, 0, 0), 1e-6),
        ("m^2/s", (2, 0, -1, 0, 0), 1.0),
        ("kg/m^3", (-3, 1, 0, 0, 0), 1.0),
        ("mPa*s", (-1, 1, -1, 0, 0), 1e-3),
        ("mL/s", (3, 0, -1, 0, 0), 1e-6),
        ("g/s", (0, 1, -1, 0, 0), 1e-3),
        ("bar", (-1, 1, -2, 0, 0), 1e5),
        ("kJ/mol", (2, 1, -2, 0, -1), 1e3),
        ("m^7*kg^-2*s^-1", (7, -2, -1, 0, 0), 1.0),
        ("%/um", (-1, 0, 0, 0, 0), 1e4),
        ("1/s", (0, 0, -1, 0, 0), 1.0),
        ("mmol", (0, 0, 0, 0, 1), 1e-3),
    ],
)
def test_parse(units, expression, dims, scale):
    unit = units.parse(expression)
    assert unit.dims == dims
    assert math.isclose(unit.scale, scale, rel_tol=1e-12)


@pytest.mark.parametrize(
    "expression,message",
    [
        ("m//s", "at most one '/'"),
        ("kg/", "at most one '/'"),
        ("/s", "empty numerator"),
        ("furlong", "unknown unit symbol 'furlong'"),
        ("kmin", "unknown unit symbol 'kmin'"),
        ("degC*s", "affine unit cannot be combined"),
        ("m s", "no spaces"),
        ("m^x", "cannot parse factor"),
    ],
)
def test_parse_errors(units, expression, message):
    with pytest.raises(UnitError, match=message.replace("(", r"\(")):
        units.parse(expression)


def test_convert(units):
    assert units.convert(1.0, "bar", "Pa") == pytest.approx(1e5)
    assert units.convert(25.0, "degC", "K") == pytest.approx(298.15)
    assert units.convert(0.315, "mPa*s", "Pa*s") == pytest.approx(3.15e-4)
    assert units.convert(1.0, "mg/g", "%") == pytest.approx(0.1)
    assert units.convert(14.0, "mm", "m") == pytest.approx(0.014)
    with pytest.raises(UnitError, match="cannot convert"):
        units.convert(1.0, "bar", "mPa*s")
    with pytest.raises(UnitError, match="unknown unit"):
        units.convert(1.0, "furlong", "m")


def _tampered(repo, tmp_path, old: str, new: str):
    text = repo.units.read_text(encoding="utf-8")
    assert old in text
    path = tmp_path / "units.yaml"
    path.write_text(text.replace(old, new), encoding="utf-8")
    return load_units(path)


def test_wrong_scale_is_detected(repo, tmp_path):
    vocab = _tampered(repo, tmp_path, '"mm":    {dims: {m: 1}, scale: 1.0e-3', '"mm":    {dims: {m: 1}, scale: 1.0e-2')
    assert any("units.mm: declared scale 0.01" in p for p in vocab.check())


def test_wrong_dimensions_are_detected(repo, tmp_path):
    vocab = _tampered(repo, tmp_path, '"m^2/s":  {dims: {m: 2, s: -1}', '"m^2/s":  {dims: {m: 2, s: 1}')
    assert any("units.m^2/s: declared dimensions m^2 s" in p for p in vocab.check())


def test_unparseable_unit_is_detected(repo, tmp_path):
    vocab = _tampered(repo, tmp_path, '"mL/s":  {dims', '"mL/hour":  {dims')
    assert any("units.mL/hour" in p and "unknown unit symbol 'hour'" in p for p in vocab.check())


def test_unknown_base_dimension_is_detected(repo, tmp_path):
    vocab = _tampered(repo, tmp_path, '"um":    {dims: {m: 1}', '"um":    {dims: {metre: 1}')
    assert any("unknown base dimension 'metre'" in p for p in vocab.check())
