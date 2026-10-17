# SPDX-License-Identifier: GPL-2.0-or-later
"""Case builders: valid ShotSpecs for every dataset condition, which simulate on the current build."""

from __future__ import annotations

import copy
import math

import numpy as np
import pytest

from puckworks_tools.cases import MODULES
from puckworks_tools.cases.common import (
    Psd,
    bimodal_psd,
    fit_exponential,
    get_path,
    kozeny_carman,
    lognormal_mixture,
    set_path,
    spec_problems,
)

puckcore = pytest.importorskip("puckcore")

EXPECTED_CASES = {"schmieder2023": 15, "vacaguerra2024": 5, "waszkiewicz2026": 11, "corrochano2017": 12,
                  "cameron2020": 7, "smrke2024": 15}


@pytest.fixture(scope="module")
def built(repo):
    out = {}
    for key, module in MODULES.items():
        kwargs = {"tier": 0, "n_classes": 6} if key not in ("vacaguerra2024", "corrochano2017") else {}
        out[key] = module.build_cases(module.load(repo), **kwargs)
    return out


def test_every_dataset_has_cases(built):
    assert {k: len(v) for k, v in built.items()} == EXPECTED_CASES
    names = [c.name for cases in built.values() for c in cases]
    assert len(names) == len(set(names))


@pytest.mark.parametrize("key", sorted(EXPECTED_CASES))
def test_specs_are_valid_and_simulate(repo, built, key):
    module = MODULES[key]
    for case in built[key]:
        problems = spec_problems(case.spec, repo, simulate=False)
        assert problems == [], f"{case.name}: {problems}"
        assert case.spec["schema"] == "puckworks.shot-spec/1"
        classes = case.spec["bed"]["size_classes"]
        assert sum(c["volume_fraction"] for c in classes) == pytest.approx(1.0)
        result = puckcore.simulate_shot(case.spec)
        assert result["schema"] == "puckworks.shot-result/1"
        observed = module.observe(case, result) if key != "vacaguerra2024" else module.observe(case, result, case.spec)
        assert isinstance(observed, dict) and observed


def test_paper_conditions_are_set(built):
    centre = next(c for c in built["schmieder2023"] if c.info["experiment"] == 7)
    spec = centre.spec
    assert spec["bed"]["dose_kg"] == pytest.approx(0.020)
    assert spec["basket"]["profile_m"][0][1] == pytest.approx(0.029)
    phases = spec["machine"]["phases"]
    assert [p["control"]["type"] for p in phases] == ["flow", "flow"]
    assert phases[0]["exit"]["pressure_pa"] == pytest.approx(2.5e5)
    assert phases[1]["control"]["target_m3_s"] == pytest.approx(1.9e-6)
    assert spec["thermal"]["water_temp_c"] == pytest.approx(88.3)
    nine = next(c for c in built["waszkiewicz2026"] if c.info["group"] == "9")
    assert nine.spec["machine"]["phases"][0]["control"] == {"type": "pressure", "target_pa": pytest.approx(8.716916e5)}
    # the 18.5 g dose fills the 58 mm basket to the measured 14 mm
    bed = nine.spec["bed"]
    solid = bed["dose_kg"] / ((1 - bed["intraparticle_porosity"]) * bed["skeletal_density_kg_m3"])
    height = solid / (1 - bed["intergranular_porosity"]) / (math.pi * 0.029**2)
    assert height == pytest.approx(0.014)
    cameron = built["cameron2020"][0]
    assert cameron.spec["machine"]["phases"][0]["control"] == {"type": "pressure", "target_pa": pytest.approx(6e5)}
    assert cameron.spec["machine"]["stop"]["beverage_mass_kg"] == pytest.approx(0.040)


def test_cases_rebuild_with_parameters(built, repo):
    """The builder applies the density closure: κ₀ ∝ [KC(ε)/KC(ε_ref)]^α, the case's porosity ε passed as
    an override and ε_ref the registry default, so doubling α multiplies κ₀ by the KC ratio once more."""
    from puckworks_tools.calibrate import registry_default
    from puckworks_tools.cases.common import kozeny_carman
    from puckworks_tools.registry import load_registry

    case = next(c for c in built["corrochano2017"] if c.info["density"] == 480.0)
    one = case.build({"hydraulics.kozeny_carman.density_exponent": 1.0})
    two = case.build({"hydraulics.kozeny_carman.density_exponent": 2.0, "hydraulics.poroelastic.critical_pressure": 10.0})
    eps_ref = registry_default(load_registry(repo)["bed.porosity.intergranular"])
    ratio = kozeny_carman(case.info["porosity"]) / kozeny_carman(eps_ref)
    assert two["hydraulics"]["permeability_m2"] / one["hydraulics"]["permeability_m2"] == pytest.approx(ratio, rel=1e-9)
    assert two["bed"]["intergranular_porosity"] == pytest.approx(case.info["porosity"])
    assert two["hydraulics"]["poroelastic_pc_pa"] == pytest.approx(1.0e6)


def test_schmieder_reports_preparation_without_inventing_a_distribution_category(built):
    from puckworks_tools.cases.common import base_spec

    for case in built["schmieder2023"]:
        preparation = case.info["preparation"]
        assert preparation["reported_distributor"] == "Grande TRE (Sahdia Enterprises)"
        assert preparation["reported_tamp_kgf"] == 25.0
        assert preparation["builder_distribution_fallback"] == "tap"
        assert case.recipe["prep"]["tamp_kgf"] == 25.0
        assert "distribution" not in case.recipe["prep"]
        # Recording the reported load must not alter legacy physics: the builder has no
        # numerical tamp effect at this load, and no Grande TRE closure was introduced.
        legacy_recipe = copy.deepcopy(case.recipe)
        del legacy_recipe["prep"]["tamp_kgf"]
        legacy_spec = base_spec(legacy_recipe)
        case.finalize(legacy_spec, {})
        assert legacy_spec == case.spec


def test_schmieder_preparation_nuisances_replace_only_the_two_v1_spec_fields(repo):
    from puckworks_tools.calibrate import build_problem, load_config
    from puckworks_tools.cases import schmieder2023 as sch

    config = copy.deepcopy(load_config(repo.root / "data/calibration/config.yaml"))
    config["parameters"] = [p for p in config["parameters"] if p["id"] in sch.PREPARATION_NUISANCES]
    config["fixed"] = []
    assert {p["id"] for p in config["parameters"]} == set(sch.PREPARATION_NUISANCES)
    assert all(p["mode"] == "spec" and p["applies_to"] == sch.KEY for p in config["parameters"])
    problem = build_problem(repo, config, blocks=["V1", "V4"])
    values = {sch.PREPARATION_NUISANCES[0]: 0.3, sch.PREPARATION_NUISANCES[1]: 0.4}
    try:
        for block in problem.blocks:
            for case in block.cases:
                baseline = block.spec_for(case, {}, [])
                changed = block.spec_for(case, values, problem.params)
                expected = copy.deepcopy(baseline)
                if block.name == "V1":
                    expected["bed"]["heterogeneity"]["sigma_ln_permeability"] = 0.3
                    expected["bed"]["heterogeneity"]["edge_multiplier"] = 0.4
                assert changed == expected
                # Neither this dataset's conditional values nor a fictitious distribution
                # category may enter the registry overrides consumed by the native builder.
                assert not set(sch.PREPARATION_NUISANCES).intersection(case.recipe["overrides"])
    finally:
        problem.runner.close()


def test_schmieder_preparation_priors_are_transformed_existing_supports(repo):
    from puckworks_tools.calibrate import registry_default
    from puckworks_tools.cases import schmieder2023 as sch
    from puckworks_tools.registry import load_registry

    records = load_registry(repo)
    cases = sch.build_cases(sch.load(repo), psd_source="wet_cdf", n_classes=16)
    tap = records["model.prep.sigma_ln_permeability.tap"]
    factors = [c.spec["bed"]["heterogeneity"]["sigma_ln_permeability"] / registry_default(tap) for c in cases]
    actual_sigma = records[sch.PREPARATION_NUISANCES[0]]["prior"]
    assert actual_sigma["min"] == pytest.approx(max(f * tap["prior"]["min"] for f in factors), rel=1e-12)
    assert actual_sigma["max"] == pytest.approx(min(f * tap["prior"]["max"] for f in factors), rel=1e-12)

    base = records["model.prep.edge_multiplier.base"]
    actual_edge = records[sch.PREPARATION_NUISANCES[1]]["prior"]
    for case in cases:
        factor = case.spec["bed"]["heterogeneity"]["edge_multiplier"] / registry_default(base)
        assert actual_edge["min"] == pytest.approx(factor * base["prior"]["min"], rel=1e-12)
        assert actual_edge["max"] == pytest.approx(factor * base["prior"]["max"], rel=1e-12)


def test_bimodal_psd_matches_statistics():
    psd = bimodal_psd(share_below_100um=0.25, median_um=267.25)
    assert psd.share_below(100.0) == pytest.approx(0.25, abs=1e-4)
    assert psd.median_um() == pytest.approx(267.25, rel=1e-4)
    psd = bimodal_psd(de_brouckere_um=277.0, fines_weight=0.25)
    assert psd.de_brouckere_um() == pytest.approx(277.0, rel=1e-4)
    classes = psd.classes(16)
    assert len(classes) <= 16 and sum(c["volume_fraction"] for c in classes) == pytest.approx(1.0)
    radii = [c["radius_m"] for c in classes]
    assert radii == sorted(radii)
    with pytest.raises(ValueError):
        bimodal_psd(median_um=200.0)


def test_psd_statistics_of_a_known_mixture():
    single = lognormal_mixture([(1.0, 100.0, 0.4)])
    assert single.median_um() == pytest.approx(100.0, rel=2e-3)
    # volume-weighted log-normal: D[4,3] = median·exp(σ²/2), D[3,2] = median·exp(−σ²/2)
    assert single.de_brouckere_um() == pytest.approx(100.0 * math.exp(0.08), rel=5e-3)
    assert single.sauter_um() == pytest.approx(100.0 * math.exp(-0.08), rel=5e-3)
    assert Psd(np.array([10.0, 100.0]), np.array([1.0, 3.0])).weight.tolist() == [0.25, 0.75]


def _uniform_wet_psd_data(head_mass=0.2):
    """Uniform volume density on [10, 1000] µm, optionally with an unresolved atom at 2 µm."""
    from puckworks_tools.cases import schmieder2023 as sch

    d32 = 1.0 / (head_mass / 2.0 + (1.0 - head_mass) * math.log(100.0) / 990.0)
    d43 = head_mass * 2.0 + (1.0 - head_mass) * 505.0
    return {"psd": [
        {"grind_level": grind, "diameter_um": diameter,
         "cumulative_volume_fraction": head_mass + (1.0 - head_mass) * (diameter - 10.0) / 990.0,
         "reported_d32_um": d32, "reported_d32_sd_um": 0.1,
         "reported_d43_um": d43, "reported_d43_sd_um": 3.0}
        for grind in sch.D43_WET_UM for diameter in (10.0, 100.0, 1000.0)
    ]}


@pytest.mark.parametrize("head_mass", [0.0, 0.2])
def test_schmieder_wet_psd_uniform_density_moments_and_area(head_mass):
    from puckworks_tools.cases import schmieder2023 as sch

    data = _uniform_wet_psd_data(head_mass)
    before = copy.deepcopy(data)
    psd = sch.wet_psd(data, 1.7)
    expected_d32 = data["psd"][0]["reported_d32_um"]
    expected_d43 = data["psd"][0]["reported_d43_um"]
    assert data == before
    assert np.all(psd.weight > 0) and np.all(np.diff(psd.diameter_um) > 0)
    assert psd.weight.sum() == pytest.approx(1.0, abs=1e-14)
    assert psd.de_brouckere_um() == pytest.approx(expected_d43, rel=1e-14)
    assert psd.sauter_um() == pytest.approx(expected_d32, rel=1e-7)
    assert psd.share_below(100.0) == pytest.approx(head_mass + (1 - head_mass) / 11, abs=1e-7)
    if head_mass:
        assert psd.diameter_um[0] == pytest.approx(2.0, rel=1e-14)
        assert psd.weight[0] == pytest.approx(head_mass, abs=1e-14)
    # Classes must conserve spherical surface area per particle volume, including the head atom
    # and the tails folded into their end classes; this is not preserved by arithmetic class means.
    for n in (6, 16):
        classes = psd.classes(n)
        area_per_volume = sum(3 * c["volume_fraction"] / c["radius_m"] for c in classes)
        assert sum(c["volume_fraction"] for c in classes) == pytest.approx(1.0, abs=1e-14)
        assert area_per_volume == pytest.approx(6e6 / expected_d32, rel=1e-7)


def test_schmieder_wet_psd_offset_only_changes_unresolved_head():
    from puckworks_tools.cases import schmieder2023 as sch

    data = _uniform_wet_psd_data()
    nominal = sch.wet_psd(data, 1.4)
    for offset in (-1.0, 1.0):
        shifted = sch.wet_psd(data, 1.4, sauter_offset_sd=offset)
        assert shifted.sauter_um() == pytest.approx(data["psd"][0]["reported_d32_um"] + offset * 0.1, rel=1e-7)
        assert np.array_equal(nominal.weight, shifted.weight)
        assert np.array_equal(nominal.diameter_um[1:], shifted.diameter_um[1:])
        assert shifted.diameter_um[0] != nominal.diameter_um[0]


def test_schmieder_wet_psd_keeps_nonuniform_tail_and_zero_density_gaps():
    from puckworks_tools.cases import schmieder2023 as sch

    data = _uniform_wet_psd_data()
    inverse_moment = 0.2 / 2.0 + 0.3 * math.log(10.0) / 90.0 + 0.5 * math.log(5.0) / 800.0
    d43 = 0.2 * 2.0 + 0.3 * 55.0 + 0.5 * 600.0
    template = data["psd"][0]
    data["psd"] = [{**template, "grind_level": grind, "diameter_um": diameter,
                    "cumulative_volume_fraction": cdf, "reported_d32_um": 1.0 / inverse_moment,
                    "reported_d43_um": d43}
                   for grind in sch.D43_WET_UM
                   for diameter, cdf in [(10.0, 0.2), (100.0, 0.5), (200.0, 0.5), (1000.0, 1.0)]]
    psd = sch.wet_psd(data, 2.0)
    assert psd.sauter_um() == pytest.approx(1.0 / inverse_moment, rel=1e-7)
    assert psd.de_brouckere_um() == pytest.approx(d43, rel=1e-14)
    assert psd.weight[psd.diameter_um < 100.0].sum() == pytest.approx(0.5, abs=1e-14)
    assert not np.any((psd.diameter_um >= 100.0) & (psd.diameter_um <= 200.0))


@pytest.mark.parametrize("row,column,value,match", [
    (0, "diameter_um", -1.0, "positive, strictly increasing diameters"),
    (1, "diameter_um", 10.0, "positive, strictly increasing diameters"),
    (1, "diameter_um", 5.0, "positive, strictly increasing diameters"),
    (1, "diameter_um", math.nan, "finite"),
    (0, "cumulative_volume_fraction", -0.1, "CDF"),
    (1, "cumulative_volume_fraction", 1.1, "CDF"),
    (1, "cumulative_volume_fraction", 0.1, "CDF"),
    (2, "cumulative_volume_fraction", 0.99, "ending at 1"),
    (1, "cumulative_volume_fraction", math.inf, "finite"),
    (0, "grind_level", 1.5, "exactly the grinding levels"),
    (1, "reported_d32_um", 20.0, "inconsistent reported moments"),
])
def test_schmieder_wet_psd_rejects_invalid_source_points(row, column, value, match):
    from puckworks_tools.cases import schmieder2023 as sch

    data = _uniform_wet_psd_data()
    data["psd"][row][column] = value
    with pytest.raises(ValueError, match=match):
        sch.wet_psd(data, 1.7)  # also validate a malformed curve other than the requested one


@pytest.mark.parametrize("column,value,match", [
    ("reported_d32_um", 0.0, "positive reported means"),
    ("reported_d32_sd_um", -0.1, "nonnegative SDs"),
    ("reported_d43_um", -1.0, "positive reported means"),
    ("reported_d43_sd_um", -0.1, "nonnegative SDs"),
    ("reported_d32_um", 100.0, "below the first resolved diameter"),
    ("reported_d32_um", 10000.0, "no positive unresolved-head inverse moment"),
])
def test_schmieder_wet_psd_rejects_invalid_or_infeasible_moments(column, value, match):
    from puckworks_tools.cases import schmieder2023 as sch

    data = _uniform_wet_psd_data()
    for row in data["psd"]:
        row[column] = value
    with pytest.raises(ValueError, match=match):
        sch.wet_psd(data, 1.4)


def test_schmieder_wet_psd_requires_three_levels_and_a_feasible_offset():
    from puckworks_tools.cases import schmieder2023 as sch

    data = _uniform_wet_psd_data()
    with pytest.raises(ValueError, match="exactly the grinding levels"):
        sch.wet_psd({"psd": [r for r in data["psd"] if r["grind_level"] != 2.0]}, 1.4)
    with pytest.raises(ValueError, match="grind must be"):
        sch.wet_psd(data, 1.5)
    with pytest.raises(ValueError, match="must be finite"):
        sch.wet_psd(data, 1.4, sauter_offset_sd=math.nan)
    with pytest.raises(ValueError, match="target D\\[3,2\\] must be positive"):
        sch.wet_psd(data, 1.4, sauter_offset_sd=-1000.0)
    with pytest.raises(ValueError, match="without an unresolved head"):
        sch.wet_psd(_uniform_wet_psd_data(0.0), 1.4, sauter_offset_sd=1.0)


def test_schmieder_reconstructed_psd_remains_default(repo, built):
    from puckworks_tools.cases import schmieder2023 as sch

    data = sch.load(repo)
    del data["psd"]  # legacy callers only supplied the original four tables
    explicit = sch.build_cases(data, tier=0, n_classes=6, psd_source="reconstructed")
    for original, case in zip(built[sch.KEY], explicit):
        assert original.spec == case.spec and original.recipe == case.recipe
        assert case.info["psd_source"] == "reconstructed"
        expected = bimodal_psd(de_brouckere_um=sch.D43_WET_UM[case.info["grind_level"]], fines_weight=0.25)
        assert case.spec["bed"]["size_classes"] == expected.classes(6)
        assert case.info["psd"]["d32_um"] == pytest.approx(expected.sauter_um(), rel=1e-14)
        assert case.info["class_psd"]["d32_um"] == pytest.approx(expected.sauter_um(), rel=1e-14)
    with pytest.raises(ValueError, match="psd_source"):
        sch.build_cases(data, psd_source="unknown")
    with pytest.raises(ValueError, match="only supported"):
        sch.build_cases(data, sauter_offset_sd=1.0)


def test_schmieder_wet_cdf_cases_are_valid_and_simulate(repo, built):
    from puckworks_tools.cases import schmieder2023 as sch

    data = sch.load(repo)
    cases = sch.build_cases(data, tier=0, n_classes=6, psd_source="wet_cdf")
    assert len(cases) == 15
    assert [c.name for c in cases] == [c.name for c in built[sch.KEY]]
    for case in cases:
        assert case.info["psd_source"] == "wet_cdf"
        psd = case.info["psd"]
        assert psd["d32_um"] == pytest.approx(psd["reported_d32_um"], rel=1e-7)
        assert 0 < psd["unresolved_head_diameter_um"] < psd["resolved_start_um"]
        assert 0 < psd["unresolved_head_fraction"] < 1
        curve = [r for r in data["psd"] if r["grind_level"] == case.info["grind_level"]]
        assert psd["fines_fraction_below_100um"] == pytest.approx(np.interp(
            100.0, [r["diameter_um"] for r in curve], [r["cumulative_volume_fraction"] for r in curve]))
        classes = case.spec["bed"]["size_classes"]
        assert case.info["class_psd"]["d32_um"] == pytest.approx(psd["d32_um"], rel=1e-14)
        assert case.info["class_psd"]["d43_um"] == pytest.approx(
            sum(c["volume_fraction"] * c["radius_m"] * 2e6 for c in classes))
        assert case.info["class_psd"]["fines_fraction_below_100um"] == pytest.approx(
            sum(c["volume_fraction"] for c in classes if c["radius_m"] * 2e6 < 100))
        assert spec_problems(case.spec, repo, simulate=False) == []
        result = puckcore.simulate_shot(case.spec)
        assert result["schema"] == "puckworks.shot-result/1"
        assert sch.observe(case, result)["fractions"]
    for offset in (-1.0, 1.0):
        case = sch.build_cases(data, tier=0, n_classes=6, psd_source="wet_cdf", experiments=[7],
                               sauter_offset_sd=offset)[0]
        psd = case.info["psd"]
        assert psd["sauter_offset_sd"] == offset
        assert case.info["class_psd"]["d32_um"] == pytest.approx(
            psd["reported_d32_um"] + offset * psd["reported_d32_sd_um"], rel=1e-7)


def test_spec_paths(built):
    spec = built["schmieder2023"][0].spec
    set_path(spec, "solubles.species[id=caffeine].mass_fraction", 0.0123)
    assert get_path(spec, "solubles.species[id=caffeine].mass_fraction") == 0.0123
    with pytest.raises(KeyError):
        set_path(spec, "solubles.no_such_field", 1.0)
    with pytest.raises(KeyError):
        get_path(spec, "solubles.species[id=nothing].mass_fraction")


def test_exponential_fit_recovers_parameters():
    m = np.array([3.0, 9.0, 15.0, 27.0, 38.0, 53.0])
    fit = fit_exponential(m, 0.25 * np.exp(-m / 17.5))
    assert fit.c0 == pytest.approx(0.25, rel=1e-6)
    assert fit.lam == pytest.approx(17.5, rel=1e-6)


def test_kozeny_carman():
    assert kozeny_carman(0.2) == pytest.approx(0.008 / 0.64)


def test_schmieder_observables_flag_the_pump_limit():
    """Time at the pump's pressure limit is split into the transition and the pour."""
    from puckworks_tools.cases import schmieder2023 as sch

    t = [0.1 * k for k in range(200)]
    # preinfusion below the exit pressure, then 12 bar from 6.0 s to 7.0 s (inside the 4 s ramp) and
    # from 12.0 s to 13.0 s (in the pour)
    p = [1.0e5 if ti < 5.0 else (12.0e5 if 6.0 <= ti < 7.0 or 12.0 <= ti < 13.0 else 3.0e5) for ti in t]
    windows = [{"start_g": 0.0, "end_g": 1.0, "replicate": 1, "fraction": 1, "fraction_mass_g": 1.0,
                "cumulative_mass_g": 0.5, "trigonelline_mg_g": 1, "caffeine_mg_g": 1, "cqa5_mg_g": 1, "tds_g_g": 0.1}]

    class FakeCase:
        info = {"windows": windows, "transition_ramp_s": sch.TRANSITION_RAMP_S}

    m = [0.001 * ti for ti in t]
    result = {"series": {"t_s": t, "pressure_pa": p, "beverage_mass_kg": m, "tds_cup": [0.1] * len(t),
                         "species_cup_kg": [{"id": sp, "values": [1e-6 * ti for ti in t]}
                                            for sp in ("caffeine", "trigonelline", "cqa5", "acids")]},
              "summary": {"max_pressure_pa": 12.0e5, "beverage_mass_kg": m[-1]}}
    obs = sch.observe(FakeCase(), result)
    assert obs["switch_s"] == pytest.approx(5.0)
    assert obs["pump_limit_s"]["transition"] == pytest.approx(1.0, abs=0.11)
    assert obs["pump_limit_s"]["pour"] == pytest.approx(1.0, abs=0.11)
    assert obs["pour_capped"] and obs["pour_peak_pressure_bar"] == pytest.approx(12.0)
