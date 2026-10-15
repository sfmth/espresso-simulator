# SPDX-License-Identifier: GPL-2.0-or-later
"""CLI wiring of the M1 commands: export delegation, calibrate and validate entry points."""

from __future__ import annotations

import sys
import types

import pytest

from puckworks_tools import cli


def test_export_forwards_its_arguments(monkeypatch):
    seen = {}

    def fake_main(argv):
        seen["argv"] = argv
        return 3

    monkeypatch.setitem(sys.modules, "puckworks_tools.export", types.SimpleNamespace(main=fake_main))
    assert cli.main(["export", "--check", "--root", "/somewhere"]) == 3
    assert seen["argv"] == ["--check", "--root", "/somewhere"]


def test_export_without_the_module_explains(monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "puckworks_tools.export", None)  # import raises ImportError
    assert cli.main(["export"]) == 2
    assert "workstream D" in capsys.readouterr().err


def test_export_without_main_explains(monkeypatch, capsys):
    monkeypatch.setitem(sys.modules, "puckworks_tools.export", types.SimpleNamespace())
    assert cli.main(["export", "--check"]) == 2
    assert "no main(argv)" in capsys.readouterr().err


def test_help_lists_the_m1_commands(capsys):
    with pytest.raises(SystemExit):
        cli.main(["--help"])
    text = capsys.readouterr().out
    for command in ("calibrate", "validate", "shot-fixtures", "export"):
        assert command in text


def test_calibrate_dry_run(repo, capsys):
    pytest.importorskip("puckcore")
    code = cli.main(["calibrate", "--dry-run", "--blocks", "V2", "--root", str(repo.root)])
    assert code == 0
    out = capsys.readouterr().out
    assert "dry run" in out and "V2" in out


def test_calibrate_rejects_unknown_blocks(repo, capsys):
    pytest.importorskip("puckcore")
    assert cli.main(["calibrate", "--dry-run", "--blocks", "V9", "--root", str(repo.root)]) == 2
    assert "unknown blocks" in capsys.readouterr().err
