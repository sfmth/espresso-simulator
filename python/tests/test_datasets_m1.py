# SPDX-License-Identifier: GPL-2.0-or-later
"""The M1 validation datasets: sidecars validate, licences follow PLAN §11, tables are complete."""

from __future__ import annotations

import csv

import pytest

from puckworks_tools.datasets import validate_repo_datasets
from puckworks_tools.yamlio import load_yaml

#: dataset id → (licence, redistribution, data rows in its CSV file)
EXPECTED = {
    "schmieder2023-centre-point": ("CC-BY-4.0", "allowed", 48),
    "schmieder2023-design": ("CC-BY-4.0", "allowed", 15),
    "schmieder2023-fractions": ("CC-BY-4.0", "allowed", 288),
    "schmieder2023-kinetics": ("CC-BY-4.0", "allowed", 60),
    "schmieder2023-replicates": ("CC-BY-4.0", "allowed", 48),
    "waszkiewicz2026-flow-transient": ("CC-BY-4.0", "allowed", 2211),
    "waszkiewicz2026-flow-pressure": ("CC-BY-4.0", "allowed", 11),
    "waszkiewicz2026-tds": ("CC-BY-4.0", "allowed", 12),
    "waszkiewicz2026-psd": ("CC-BY-4.0", "allowed", 47),
    "cameron2020-ey-grind": ("facts-cited", "cite-only", 7),
    "cameron2020-psd": ("facts-cited", "cite-only", 420),
    "cameron2020-two-class": ("facts-cited", "cite-only", 4),
    "vacaguerra2024-rtd": ("facts-cited", "cite-only", 25),
    "corrochano2017-permeability": ("facts-cited", "cite-only", 12),
    "corrochano2017-psd": ("facts-cited", "cite-only", 15),
    "corrochano2017-properties": ("facts-cited", "cite-only", 39),
    "smrke2024-psd": ("CC-BY-4.0", "allowed", 15),
    "smrke2024-shots": ("CC-BY-4.0", "allowed", 46),
}


def test_all_datasets_validate(repo):
    report = validate_repo_datasets(repo)
    assert report.ok, "\n".join(map(str, report.issues))
    assert set(EXPECTED) <= set(report.datasets)


@pytest.mark.parametrize("dataset", sorted(EXPECTED))
def test_licence_and_size(repo, dataset):
    licence, redistribution, rows = EXPECTED[dataset]
    meta = load_yaml(repo.datasets_dir / dataset / "dataset.yaml")
    assert meta["licence"] == licence
    assert meta["redistribution"] == redistribution
    # every sidecar says how the data were obtained and how uncertain they are (PLAN §11)
    assert len(meta["obtained"]) > 80 and len(meta["uncertainty"]) > 80
    with open(repo.datasets_dir / dataset / meta["files"][0]["path"], encoding="utf-8", newline="") as handle:
        assert sum(1 for _ in csv.reader(handle)) - 1 == rows


def test_no_non_commercial_source_is_bundled(repo):
    """Vaca Guerra 2024 is CC BY-NC-ND: only cited facts, and its sidecar says why."""
    meta = load_yaml(repo.datasets_dir / "vacaguerra2024-rtd" / "dataset.yaml")
    assert meta["licence"] == "facts-cited"
    assert "CC BY-NC-ND" in meta["notes"] and "not digitised" in meta["notes"]
    for folder in repo.datasets_dir.iterdir():
        if (folder / "dataset.yaml").is_file():
            assert "NC" not in load_yaml(folder / "dataset.yaml")["licence"].upper().split("-")


def test_digitised_sources_record_their_files(repo):
    """Digitised and converted datasets name the source file by its SHA-256."""
    for dataset in ("cameron2020-ey-grind", "cameron2020-psd", "smrke2024-psd", "smrke2024-shots",
                    "schmieder2023-fractions", "waszkiewicz2026-flow-transient"):
        meta = load_yaml(repo.datasets_dir / dataset / "dataset.yaml")
        assert "sha256" in meta["obtained"]
        assert "python/puckworks_tools/sources/" in meta["obtained"]


def test_cameron_curves_integrate_to_100_percent(repo):
    """The vector-read PSD curves are volume % per 0.1 decade: each sums to about 100%."""
    import math
    from collections import defaultdict

    curves = defaultdict(list)
    with open(repo.datasets_dir / "cameron2020-psd" / "psd.csv", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            curves[row["grind_setting"]].append((float(row["diameter_um"]), float(row["volume_percent"])))
    assert sorted(curves) == ["1.0", "1.5", "2.0", "2.5"]
    for points in curves.values():
        d = [p[0] for p in points]
        step = math.log10(d[1] / d[0])
        assert sum(p[1] for p in points) * step / 0.1 == pytest.approx(100.0, abs=1.5)


def test_schmieder_tables_agree(repo):
    """Table 2's measured conditions are the replicate means of Table S3 (to the printed precision)."""
    from collections import defaultdict

    reps = defaultdict(list)
    with open(repo.datasets_dir / "schmieder2023-replicates" / "replicates.csv", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            reps[int(row["experiment"])].append(row)
    with open(repo.datasets_dir / "schmieder2023-design" / "design.csv", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            shots = reps[int(row["experiment"])]
            assert len(shots) == int(row["replicates"])
            mean_p = sum(float(s["pressure_max_bar"]) for s in shots) / len(shots)
            mean_t = sum(float(s["temp_measured_c"]) for s in shots) / len(shots)
            assert mean_p == pytest.approx(float(row["pressure_bar"]), abs=0.051)
            assert mean_t == pytest.approx(float(row["temp_measured_c"]), abs=0.051)
