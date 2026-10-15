# SPDX-License-Identifier: GPL-2.0-or-later
"""Shared fixtures: the repository paths and its schema, units and research notes."""

from __future__ import annotations

import json
from typing import Any

import pytest

from puckworks_tools.notes import NoteIndex
from puckworks_tools.paths import RepoPaths, find_repo_root
from puckworks_tools.units import UnitVocabulary, load_units


@pytest.fixture(scope="session")
def repo() -> RepoPaths:
    return RepoPaths(find_repo_root())


@pytest.fixture(scope="session")
def parameter_schema(repo: RepoPaths) -> dict[str, Any]:
    return json.loads(repo.parameter_schema.read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def dataset_schema(repo: RepoPaths) -> dict[str, Any]:
    return json.loads(repo.dataset_schema.read_text(encoding="utf-8"))


@pytest.fixture(scope="session")
def units(repo: RepoPaths) -> UnitVocabulary:
    return load_units(repo.units)


@pytest.fixture(scope="session")
def notes(repo: RepoPaths) -> NoteIndex:
    return NoteIndex(repo.notes_dir)
