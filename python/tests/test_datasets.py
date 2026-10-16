# SPDX-License-Identifier: GPL-2.0-or-later
"""Dataset sidecars: the real datasets pass; licensing and CSV rules are enforced."""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from puckworks_tools.datasets import validate_datasets, validate_repo_datasets
from puckworks_tools.yamlio import load_yaml

DATASET = "schmieder2023-centre-point"


def test_real_datasets_are_valid(repo):
    report = validate_repo_datasets(repo)
    assert report.ok, "\n".join(map(str, report.issues))
    assert DATASET in report.datasets


@pytest.fixture
def copy_dataset(repo, tmp_path) -> Path:
    target = tmp_path / "datasets" / DATASET
    shutil.copytree(repo.datasets_dir / DATASET, target)
    return target


def run(tmp_path, dataset_schema, units, notes):
    report = validate_datasets(tmp_path / "datasets", schema=dataset_schema, units=units, notes=notes)
    return "\n".join(map(str, report.issues))


def edit(path: Path, old: str, new: str) -> None:
    text = path.read_text(encoding="utf-8")
    assert old in text
    path.write_text(text.replace(old, new, 1), encoding="utf-8")


def test_copy_passes(copy_dataset, tmp_path, dataset_schema, units, notes):
    assert run(tmp_path, dataset_schema, units, notes) == ""


def test_non_commercial_data_must_not_be_bundled(copy_dataset, tmp_path, dataset_schema, units, notes):
    edit(copy_dataset / "dataset.yaml", "licence: CC-BY-4.0", "licence: CC-BY-NC-3.0")
    text = run(tmp_path, dataset_schema, units, notes)
    assert "non-commercial: redistribution must be 'forbidden'" in text
    assert "non-commercial: no data files may be bundled" in text


def test_facts_cited_must_be_cite_only(copy_dataset, tmp_path, dataset_schema, units, notes):
    edit(copy_dataset / "dataset.yaml", "licence: CC-BY-4.0", "licence: facts-cited")
    assert "requires redistribution 'cite-only'" in run(tmp_path, dataset_schema, units, notes)


def test_id_must_match_folder(copy_dataset, tmp_path, dataset_schema, units, notes):
    edit(copy_dataset / "dataset.yaml", f"id: {DATASET}", "id: someone-else")
    assert "must equal the folder name" in run(tmp_path, dataset_schema, units, notes)


def test_csv_header_and_values_are_checked(copy_dataset, tmp_path, dataset_schema, units, notes):
    csv_path = copy_dataset / "data.csv"
    edit(csv_path, "trigonelline,lambda,,16.08737,g,", "trigonelline,lambda,,sixteen,g,")
    edit(csv_path, "caffeine,c0,,9.70981,mg/g,", "caffeine,c0,,9.70981,mg/gallon,")
    text = run(tmp_path, dataset_schema, units, notes)
    assert "column value: 'sixteen' is not a valid number" in text
    assert "unit 'mg/gallon' (from column unit) is not in the unit vocabulary" in text
    edit(csv_path, "analyte,quantity,", "compound,quantity,")
    assert "does not match the declared columns" in run(tmp_path, dataset_schema, units, notes)


def test_missing_file_and_bad_column_units(copy_dataset, tmp_path, dataset_schema, units, notes):
    edit(copy_dataset / "dataset.yaml", "- path: data.csv", "- path: other.csv")
    edit(copy_dataset / "dataset.yaml", "units: g\n", "units: grams\n")
    text = run(tmp_path, dataset_schema, units, notes)
    assert "files: other.csv does not exist" in text
    assert "columns.beverage_mass_g: unknown unit 'grams'" in text


def test_sidecar_schema(copy_dataset, tmp_path, dataset_schema, units, notes):
    meta = load_yaml(copy_dataset / "dataset.yaml")
    assert meta["licence"] == "CC-BY-4.0" and meta["redistribution"] == "allowed"
    edit(copy_dataset / "dataset.yaml", "redistribution: allowed", "redistribution: maybe")
    assert "redistribution: 'maybe' is not one of" in run(tmp_path, dataset_schema, units, notes)
