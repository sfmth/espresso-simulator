# SPDX-License-Identifier: GPL-2.0-or-later
"""Case builders: valid ShotSpecs for every dataset condition, which simulate on the current build."""

from __future__ import annotations

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
