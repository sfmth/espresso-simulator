# SPDX-License-Identifier: GPL-2.0-or-later
"""CLI publication boundaries for frozen, local surrogate artifacts."""

from __future__ import annotations

import json

import pytest

from puckworks_tools import cli, surrogate


def test_json_reader_rejects_nonfinite_values_and_nonobjects(tmp_path):
    source = tmp_path / "input.json"
    for text in ('{"x": NaN}', '{"x": Infinity}', '[]', 'null'):
        source.write_text(text)
        with pytest.raises(ValueError):
            surrogate.read_document(source)
    source.write_text('{"x": 1.25}')
    assert surrogate.read_document(source) == {"x": 1.25}


def test_model_inputs_are_size_bounded(tmp_path, monkeypatch):
    source = tmp_path / "large.json"
    source.write_text('{"text": "' + 'x' * 100 + '"}')
    monkeypatch.setattr(surrogate, "MAX_DOCUMENT_BYTES", 32)
    with pytest.raises(ValueError, match="exceeds"):
        surrogate.read_document(source)


def test_frozen_outputs_require_explicit_overwrite_and_leave_no_temporary_files(tmp_path):
    target = tmp_path / "artifact.json"
    surrogate.write_document(target, {"run": 1})
    with pytest.raises(ValueError, match="already exists"):
        surrogate.write_document(target, {"run": 2})
    assert json.loads(target.read_text()) == {"run": 1}
    surrogate.write_document(target, {"run": 3}, force=True)
    assert json.loads(target.read_text()) == {"run": 3}
    assert list(tmp_path.iterdir()) == [target]


def test_generate_keeps_failed_teacher_rows_and_returns_a_failed_check(tmp_path, monkeypatch, capsys):
    from puckworks_tools import surrogate_data

    calls = []
    def generate(paths, **kwargs):
        calls.append(kwargs)
        return {"schema": "puckworks.surrogate-dataset/1", "failures": [{"id": "test-0"}]}
    monkeypatch.setattr(surrogate_data, "generate_dataset", generate)
    target = tmp_path / "data.json"
    args = ["surrogate-generate", "--output", str(target), "--train", "8", "--calibration", "8",
            "--test", "8", "--jobs", "1", "--seed", "42"]
    assert cli.main(args) == 1
    assert calls[0]["seed"] == 42 and calls[0]["workers"] == 1
    assert surrogate.read_document(target)["failures"] == [{"id": "test-0"}]
    assert "failed/capped samples retained" in capsys.readouterr().out
    assert cli.main(args) == 2
    assert len(calls) == 1  # no expensive work before refusing overwrite


def test_command_help_and_parallelism_limits_are_explicit(capsys):
    with pytest.raises(SystemExit) as info:
        cli.main(["surrogate-predict", "--help"])
    assert info.value.code == 0
    assert "physics fallback" in capsys.readouterr().out
    with pytest.raises(SystemExit) as info:
        cli.main(["surrogate-generate", "--output", "unused.json", "--jobs", "5"])
    assert info.value.code == 2


@pytest.mark.parametrize("output_kind", ["model", "report_json", "report_md"])
@pytest.mark.parametrize("alias_kind", ["same_path", "resolved_path", "hardlink"])
def test_train_force_cannot_alias_its_input_dataset(tmp_path, monkeypatch, capsys, output_kind, alias_kind):
    from puckworks_tools import surrogate_train

    reports = tmp_path / "reports"
    reports.mkdir()
    outputs = {"model": tmp_path / "model.json",
               "report_json": reports / "m6-surrogate-validation.json",
               "report_md": reports / "m6-surrogate-validation.md"}
    aliased = outputs[output_kind]
    source = tmp_path / "dataset.json" if alias_kind == "hardlink" else aliased
    frozen = b'{"frozen": "source dataset must survive"}\n'
    source.write_bytes(frozen)
    if alias_kind == "hardlink":
        aliased.hardlink_to(source)
        dataset_arg = source
    elif alias_kind == "resolved_path":
        (source.parent / "nested").mkdir()
        dataset_arg = source.parent / "nested" / ".." / source.name
    else:
        dataset_arg = source
    monkeypatch.setattr(surrogate_train, "train_dataset",
                        lambda *a, **k: pytest.fail("aliased outputs reached training"))
    assert cli.main(["surrogate-train", "--dataset", str(dataset_arg), "--model", str(outputs["model"]),
                     "--report-dir", str(reports), "--force"]) == 2
    assert "distinct files" in capsys.readouterr().out
    assert source.read_bytes() == frozen and aliased.read_bytes() == frozen
    assert all(not path.exists() for key, path in outputs.items() if key != output_kind)


@pytest.mark.parametrize("input_kind", ["recipe", "model"])
@pytest.mark.parametrize("alias_kind", ["same_path", "resolved_path", "hardlink"])
def test_predict_force_cannot_alias_recipe_or_model(tmp_path, monkeypatch, capsys, input_kind, alias_kind):
    from puckworks_tools import surrogate_infer

    inputs = {"recipe": tmp_path / "recipe.json", "model": tmp_path / "model.json"}
    frozen = {key: json.dumps({"frozen": key}).encode() for key in inputs}
    for key, path in inputs.items():
        path.write_bytes(frozen[key])
    source = inputs[input_kind]
    if alias_kind == "hardlink":
        target = tmp_path / "prediction.json"
        target.hardlink_to(source)
    elif alias_kind == "resolved_path":
        (tmp_path / "nested").mkdir()
        target = tmp_path / "nested" / ".." / source.name
    else:
        target = source
    monkeypatch.setattr(surrogate_infer, "predict_or_simulate",
                        lambda *a, **k: pytest.fail("aliased outputs reached inference or physics"))
    assert cli.main(["surrogate-predict", "--recipe", str(inputs["recipe"]), "--model", str(inputs["model"]),
                     "--output", str(target), "--force"]) == 2
    assert "distinct files" in capsys.readouterr().out
    assert all(path.read_bytes() == frozen[key] for key, path in inputs.items())
    assert target.read_bytes() == frozen[input_kind]


def test_dataset_backed_check_replays_frozen_weights_instead_of_trusting_resigned_metrics(repo, tmp_path, monkeypatch, capsys):
    from puckworks_tools import surrogate_data, surrogate_train

    # The checked-in experiment is evidence to replay, never a model to refit.
    model = surrogate.read_document(repo.root / "models/scalar-v1.json")
    dataset_path = repo.root / "data/surrogates/scalar-v1.json"
    monkeypatch.setattr(surrogate_data, "teacher_identity", lambda paths: model["teacher"])
    monkeypatch.setattr(surrogate_train, "minimize",
                        lambda *a, **k: pytest.fail("surrogate-check fitted the frozen model"))
    target = tmp_path / "model.json"
    surrogate.write_document(target, model)
    args = ["surrogate-check", "--model", str(target), "--dataset", str(dataset_path)]
    assert cli.main(args) == 0
    capsys.readouterr()
    model["members"][0]["b2"][0] += 0.25
    model["artifact_digest"] = surrogate_data.digest({key: value for key, value in model.items()
                                                      if key != "artifact_digest"})
    surrogate_train.validate_artifact(model)  # Structurally valid and re-signed; metrics are stale.
    surrogate.write_document(target, model, force=True)
    assert cli.main(["surrogate-check", "--model", str(target)]) == 0
    capsys.readouterr()
    assert cli.main(args) == 2
    assert "evaluation replay differs at metrics" in capsys.readouterr().out
