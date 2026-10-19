# SPDX-License-Identifier: GPL-2.0-or-later
"""Synthetic Python-wrapper checks of the shared coupled Tier 1 export."""
from __future__ import annotations

import pytest

puckcore = pytest.importorskip("puckcore")

RECIPE = {
    "schema": "puckworks.recipe/1",
    "bean": {"preset": "medium-washed-arabica"},
    "grinder": {"preset": "generic-flat-traditional-64", "setting": 190},
    "basket": {"preset": "58-precision-18g"},
    "prep": {"dose_g": 18},
    "machine": {"preset": "flat-9-bar"},
    "stop": {"beverage_g": 24},
    "numerics": {"tier": 0, "size_classes": 3},
}


def test_selected_particle_export_is_shared_tier1():
    run = puckcore.simulate_explore(RECIPE, {"column": 0, "cell": 15})
    assert run["build"]["spec"]["numerics"]["tier"] == 1
    metadata = run["result"]["spatial"]["micro"]
    assert metadata["column"] == 0 and metadata["cell"] == 15
    for snapshot in run["result"]["spatial"]["snapshots"]:
        weighted = sum(
            ey * cls["volume_fraction"]
            for ey, cls in zip(snapshot["micro"]["class_ey"], metadata["classes"], strict=True)
        )
        assert weighted == pytest.approx(snapshot["local_ey"][0][15], abs=1e-12)


def test_high_is_refined_1d_and_validates_the_actual_mesh():
    run = puckcore.simulate_explore(RECIPE, {"column": 0, "cell": 149, "resolution": "high"})
    assert run["build"]["spec"]["numerics"]["depth_cells"] == 150
    assert run["result"]["spatial"]["micro"]["resolution"] == "high"
    with pytest.raises(ValueError, match="explore_cell.cell"):
        puckcore.simulate_explore(RECIPE, {"column": 0, "cell": 150, "resolution": "high"})
