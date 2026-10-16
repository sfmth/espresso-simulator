# SPDX-License-Identifier: GPL-2.0-or-later
"""Offline DE1 source qualification, using synthetic logs only."""

from __future__ import annotations

import csv
import hashlib
import io
import json
import subprocess
import zipfile
from pathlib import Path

import pytest

from puckworks_tools.sources import de1, gagne2021


def synthetic_shot(*, overrides=None, omit=(), extra="", notes="private note") -> str:
    """A deliberately small invented trace; no original source records are copied."""
    channels = {
        "espresso_elapsed": "0 1 2 3 4 5",
        "espresso_pressure": "0 1 4 4 3 2",
        "espresso_weight": "0 -0.04 0.2 0.8 0.7 1.1",
        "espresso_flow": "0 2 3 0 0 1",
        "espresso_flow_weight": "0 0 0.2 0.6 -0.1 0.4",
        "espresso_flow_weight_raw": "0 -0.04 0.24 0.6 -0.1 0.4",
        "espresso_temperature_basket": "80 85 86 86 85 84",
        "espresso_temperature_mix": "90 89 88 87 86 85",
        "espresso_water_dispensed": "0 2 5 5 5 6",
        "espresso_pressure_goal": "0 6 6 0 0 3",
        "espresso_flow_goal": "0 3 3 0 0 1",
        "espresso_temperature_goal": "90 90 90 88 88 88",
    }
    channels.update(overrides or {})
    records = [f"{key} {{{value}}}" for key, value in channels.items() if key not in omit]
    records += ["clock 123456789", "settings {", "  owner_name {Private Person}",
                f"  profile_notes {{{notes}}}",
                "  advanced_shot {{seconds 3 flow 3 pressure 6 temperature 90 volume 50 pump flow sensor coffee "
                "transition fast exit_if 1 exit_type pressure_over exit_pressure_over 5 name {private stage}} "
                "{seconds 2 flow 0 pressure 0 temperature 88 pump flow sensor water transition smooth exit_if 0}}",
                "  final_desired_shot_weight_advanced 2", "  final_desired_shot_volume_advanced 0",
                "  seconds_after_espresso_stop_to_continue_weighing 4", "  stop_weight_before_seconds 0.5",
                "  shot_weight_percentage_stop 90", "}",
                "machine {serial_number private-serial previouscmd {binary \x00 sample}}", extra]
    return "\n".join(records)


def log_row(number=1, *, basename="20250101T010101.shot", group="EG1", **overrides):
    row = {"N": str(number), "Grinder": group, "Output weight": "2.0", "File": basename,
           "pregrind_dose": "18.1", "postgrind_dose": "NaN", "postwdt_dose": "NaN",
           "dose": "18", "drip": "NaN", "TDS": "6", "TDS-f": "5.5", "eTDS": "0.02",
           "Comments": "private spreadsheet comment"}
    row.update(overrides)
    return row


def csv_text(rows):
    stream = io.StringIO(newline="")
    writer = csv.DictWriter(stream, fieldnames=list(log_row()))
    writer.writeheader()
    writer.writerows(rows)
    return stream.getvalue()


def local_inputs(tmp_path, *, rows=None, shots=None, metadata=True):
    rows = rows if rows is not None else [
        log_row(2, basename="20250101T020202.shot", group="EG1"),
        log_row(1, basename="20250101T010101.shot", group="Niche"),
    ]
    shots = shots if shots is not None else [(f"records/{row['File']}", synthetic_shot()) for row in rows]
    archive = tmp_path / "synthetic.zip"
    log = tmp_path / "synthetic.csv"
    with zipfile.ZipFile(archive, "w") as handle:
        for name, contents in shots:
            handle.writestr(name, contents)
        if metadata:
            handle.writestr("__MACOSX/records/._20250101T010101.shot", "resource fork, not a shot")
            handle.writestr("records/.DS_Store", "not a shot")
    log.write_text(csv_text(rows), encoding="utf-8", newline="")
    return archive, log


def test_literal_parser_preserves_signed_measurements_and_separates_goals():
    parsed = de1.parse_shot(synthetic_shot().encode(), source_name="local-only.shot")
    assert parsed["scale_mass_g"] == [0, -0.04, 0.2, 0.8, 0.7, 1.1]
    assert parsed["estimated_inlet_flow_ml_s"] == [0, 2, 3, 0, 0, 1]
    assert parsed["target_flow_ml_s"] == [0, 3, 3, 0, 0, 1]
    assert parsed["derived_scale_flow_g_s"][4] == -0.1
    assert parsed["measured_basket_temperature_c"] != parsed["measured_mix_temperature_c"]
    first = parsed["profile_steps"][0]
    assert first["exit_enabled"] and first["exit_type"] == "pressure_over"
    assert first["exit_pressure_over_bar"] == 5
    assert first["target_flow_ml_s"] == 3 and first["duration_s"] == 3
    assert parsed["profile_settings"]["post_stop_weighing_s"] == 4
    serialized = json.dumps(parsed, allow_nan=False)
    for private in ("Private Person", "private-serial", "private note", "private stage", "123456789", "local-only.shot"):
        assert private not in serialized


def test_command_and_variable_text_is_never_evaluated(tmp_path):
    marker = tmp_path / "must-not-exist"
    text = synthetic_shot(notes=f"[exec touch {marker}] $env(HOME) \\{{literal\\}}")
    result = de1.parse_shot(text)
    assert not marker.exists()
    assert str(marker) not in json.dumps(result)
    injected = synthetic_shot(overrides={"espresso_weight": f"0 [exec touch {marker}] 0.2 0.8 0.7 1.1"})
    with pytest.raises(de1.ShotFormatError, match="plain finite number"):
        de1.parse_shot(injected)
    assert not marker.exists()


@pytest.mark.parametrize("token", ["NaN", "nan", "inf", "-Inf", "1e999", "0x10", "1;exit", "$value", "1\\n"])
def test_selected_numeric_samples_reject_nonfinite_and_nonliteral_tokens(token):
    with pytest.raises(de1.ShotFormatError):
        de1.parse_shot(synthetic_shot(overrides={"espresso_flow": f"0 1 2 {token} 4 5"}))


@pytest.mark.parametrize("times", ["0 1 1 3 4 5", "0 1 2 3 4 3", "0 1 2 3 4"])
def test_elapsed_must_increase_and_align(times):
    with pytest.raises(de1.ShotFormatError):
        de1.parse_shot(synthetic_shot(overrides={"espresso_elapsed": times}))


@pytest.mark.parametrize("change", [
    lambda text: text + "\nespresso_weight {0 1 2 3 4 5}",
    lambda text: text.replace("owner_name {Private Person}", "owner_name A owner_name B"),
    lambda text: text.replace("machine {", "machine {{"),
    lambda text: text.replace("espresso_weight {", "espresso_weight {" + "{" * 130),
    lambda text: text.replace("exit_type pressure_over ", ""),
    lambda text: text.replace("exit_pressure_over 5 ", ""),
    lambda text: text.replace("seconds 3", "seconds -3"),
    lambda text: text.replace("pump flow", "pump {$command}"),
])
def test_duplicate_malformed_and_unusable_control_data_rejected(change):
    with pytest.raises(de1.ShotFormatError):
        de1.parse_shot(change(synthetic_shot()))


def test_minimal_parser_requires_time_pressure_and_mass():
    text = "espresso_elapsed {5 6} espresso_pressure {0 1} espresso_weight {-0.1 0.1}"
    parsed = de1.parse_shot(text)
    assert parsed["t_s"] == [5, 6]  # no assumed pump-start shift
    assert parsed["profile_steps"] == []
    with pytest.raises(de1.ShotFormatError, match="missing channels"):
        de1.parse_shot("espresso_elapsed {0 1} espresso_weight {0 1}")


def test_observables_interpolate_first_crossing_without_repairing_noise():
    parsed = de1.parse_shot(synthetic_shot())
    observed = de1.observed_summary(parsed["t_s"], parsed["scale_mass_g"], final_beverage_g=2)
    assert observed["thresholds"] == [
        {"mass_g": 0.5, "time_s": pytest.approx(2.5), "status": "observed"},
        {"mass_g": 1.0, "time_s": pytest.approx(4.75), "status": "observed"},
    ]
    assert observed["negative_mass_samples"] == 1
    assert observed["downward_mass_steps"] == 2
    assert observed["largest_downward_mass_step_g"] == pytest.approx(0.1)
    assert observed["final_logged_mass_g"] == 1.1
    assert observed["annotated_minus_logged_mass_g"] == pytest.approx(0.9)
    recrossing = de1.observed_summary([0, 1, 2, 3], [0, 0.6, 0.4, 0.8])
    assert recrossing["thresholds"][0]["time_s"] == pytest.approx(5 / 6)


def test_missing_and_left_censored_thresholds_are_explicit():
    observed = de1.observed_summary([8, 9, 10], [0.6, 0.4, 0.8])
    assert observed["thresholds"] == [
        {"mass_g": 0.5, "time_s": None, "status": "left_censored"},
        {"mass_g": 1.0, "time_s": None, "status": "not_reached"},
    ]
    assert observed["annotated_minus_logged_mass_g"] is None


def test_exact_join_preserves_spreadsheet_groups_and_omits_private_metadata(tmp_path):
    archive, log = local_inputs(tmp_path)
    result = gagne2021.load_experiment(archive, log, verify_hashes=False)
    assert [(case["id"], case["grinder_group"]) for case in result["cases"]] == [
        ("gagne2021-01", "Niche"), ("gagne2021-02", "EG1")]
    assert all(case["annotated_drip_g"] is None for case in result["cases"])
    assert result["summaries"]["all"]["sample_count"] == 12
    assert result["summaries"]["groups"]["Niche"]["case_count"] == 1
    assert not result["sources"]["identity_verified"]
    assert result["sources"]["archive"]["sha256"] == hashlib.sha256(archive.read_bytes()).hexdigest()
    serialized = json.dumps(result, allow_nan=False)
    for private in (str(tmp_path), "private", "123456789"):
        assert private not in serialized
    assert "not verified" in serialized


def test_pinned_hash_verification_is_default_and_checks_both_sources(tmp_path, monkeypatch):
    archive, log = local_inputs(tmp_path)
    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        gagne2021.load_experiment(archive, log)
    monkeypatch.setattr(gagne2021, "ARCHIVE_SHA256", hashlib.sha256(archive.read_bytes()).hexdigest())
    with pytest.raises(ValueError, match="SHA-256 mismatch"):
        gagne2021.load_experiment(archive, log)
    monkeypatch.setattr(gagne2021, "LOG_SHA256", hashlib.sha256(log.read_bytes()).hexdigest())
    result = gagne2021.load_experiment(archive, log)
    assert result["sources"]["identity_verified"]
    assert result["sources"]["measurement_log"]["matches_pin"]


@pytest.mark.parametrize("rows,shots,match", [
    ([log_row(), log_row()], [("records/20250101T010101.shot", synthetic_shot())], "duplicate File"),
    ([log_row(), log_row(basename="20250101T020202.shot")], None, "duplicate N"),
    ([log_row()], [("records/20250101T020202.shot", synthetic_shot())], "source join"),
    ([log_row()], [("a/20250101T010101.shot", synthetic_shot()),
                  ("b/20250101T010101.shot", synthetic_shot())], "duplicate shot basename"),
    ([log_row()], [("../20250101T010101.shot", synthetic_shot())], "unsafe member path"),
])
def test_duplicate_or_incomplete_joins_are_rejected(tmp_path, rows, shots, match):
    archive, log = local_inputs(tmp_path, rows=rows, shots=shots)
    with pytest.raises(ValueError, match=match):
        gagne2021.load_experiment(archive, log, verify_hashes=False)


@pytest.mark.parametrize("overrides", [
    {"dose": "NaN"}, {"dose": "0"}, {"Output weight": "inf"}, {"TDS": "101"},
    {"drip": "-1"}, {"N": "1.5"}, {"Grinder": "unknown"}, {"File": "path/20250101T010101.shot"},
])
def test_malformed_spreadsheet_measurements_are_rejected(tmp_path, overrides):
    archive, log = local_inputs(tmp_path, rows=[log_row(**overrides)])
    with pytest.raises(ValueError):
        gagne2021.load_experiment(archive, log, verify_hashes=False)


def test_source_specific_import_requires_all_selected_channels(tmp_path):
    archive, log = local_inputs(tmp_path, rows=[log_row()], shots=[
        ("records/20250101T010101.shot", synthetic_shot(omit=("espresso_flow_goal",)))])
    with pytest.raises(de1.ShotFormatError, match="missing Gagné channels"):
        gagne2021.load_experiment(archive, log, verify_hashes=False)


def test_archive_member_sizes_are_bounded_before_reading(tmp_path, monkeypatch):
    archive, log = local_inputs(tmp_path)
    monkeypatch.setattr(gagne2021, "MAX_SHOT_BYTES", 20)
    with pytest.raises(ValueError, match="oversized"):
        gagne2021.load_experiment(archive, log, verify_hashes=False)


def test_duplicate_zip_member_is_rejected(tmp_path):
    archive, log = local_inputs(tmp_path, rows=[log_row()])
    with pytest.warns(UserWarning, match="Duplicate name"):
        with zipfile.ZipFile(archive, "a") as handle:
            handle.writestr("records/20250101T010101.shot", synthetic_shot())
    with pytest.raises(ValueError, match="duplicate member path"):
        gagne2021.load_experiment(archive, log, verify_hashes=False)


def test_local_outputs_are_reproducible_and_replace_file_symlinks_safely(tmp_path):
    archive, log = local_inputs(tmp_path)
    bundle = gagne2021.load_experiment(archive, log, verify_hashes=False)
    output = tmp_path / "output"
    output.mkdir()
    protected = tmp_path / "protected.txt"
    protected.write_text("do not modify")
    (output / "normalized-cases.json").symlink_to(protected)
    paths = gagne2021.write_bundle(bundle, output)
    before = [path.read_bytes() for path in paths]
    assert protected.read_text() == "do not modify"
    assert not paths[0].is_symlink()
    gagne2021.write_bundle(bundle, output)
    assert [path.read_bytes() for path in paths] == before
    assert "scale_mass_g" not in json.loads(paths[1].read_text())["cases"][0]


def test_output_guard_requires_ignored_untracked_repository_directory(tmp_path):
    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "--quiet", str(repo)], check=True)
    (repo / ".gitignore").write_text("/.local/\n")
    assert gagne2021.ensure_local_output(repo / ".local" / "community") == repo / ".local" / "community"
    assert gagne2021.ensure_local_output(tmp_path / "external") == tmp_path / "external"
    for path in (repo, repo / "data" / "community", repo / ".git" / "objects"):
        with pytest.raises(ValueError, match="ignored"):
            gagne2021.ensure_local_output(path)
    local = repo / ".local"
    local.mkdir()
    (local / "tracked.json").write_text("{}")
    subprocess.run(["git", "-C", str(repo), "add", "-f", ".local/tracked.json"], check=True)
    with pytest.raises(ValueError, match="tracked"):
        gagne2021.ensure_local_output(local)
    (tmp_path / "alias").symlink_to(repo / "data", target_is_directory=True)
    with pytest.raises(ValueError, match="ignored"):
        gagne2021.ensure_local_output(tmp_path / "alias" / "output")


def test_cli_is_offline_and_defaults_to_pinned_identity(tmp_path, capsys):
    archive, log = local_inputs(tmp_path)
    args = ["--archive", str(archive), "--log", str(log), "--out", str(tmp_path / "out")]
    with pytest.raises(SystemExit) as exc:
        gagne2021.main(args)
    assert exc.value.code == 2
    assert "SHA-256 mismatch" in capsys.readouterr().err
    assert not (tmp_path / "out").exists()
    assert gagne2021.main([*args, "--allow-unverified"]) == 0
    assert "qualified 2 local cases" in capsys.readouterr().out
