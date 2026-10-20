# SPDX-License-Identifier: GPL-2.0-or-later
"""Local surrogate command orchestration; no browser runtime imports these tools."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from pathlib import Path
from typing import Any

from .paths import RepoPaths

MAX_DOCUMENT_BYTES = 8 * 1024 * 1024


def _nonfinite(text: str) -> Any:
    raise ValueError(f"non-finite JSON constant {text}")


def read_document(path: Path) -> dict[str, Any]:
    """Read bounded JSON data, never pickle or executable model formats."""
    with Path(path).open("rb") as stream:
        payload = stream.read(MAX_DOCUMENT_BYTES + 1)
    if len(payload) > MAX_DOCUMENT_BYTES:
        raise ValueError(f"{path}: document exceeds {MAX_DOCUMENT_BYTES} bytes")
    document = json.loads(payload, parse_constant=_nonfinite)
    if not isinstance(document, dict):
        raise ValueError(f"{path}: expected a JSON object")
    return document


def write_document(path: Path, document: dict[str, Any], *, force: bool = False) -> None:
    write_text(path, json.dumps(document, indent=2, sort_keys=True, allow_nan=False) + "\n", force=force)


def write_text(path: Path, text: str, *, force: bool = False) -> None:
    """Keep an interrupted write from replacing a frozen artifact with partial JSON."""
    path = Path(path)
    if path.exists() and not force:
        raise ValueError(f"{path} already exists; choose a new output or explicitly pass --force")
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(text)
        if force:
            os.replace(temporary, path)
        else:
            # Atomic no-clobber publication even if another process creates path.
            os.link(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


def _available(path: Path, force: bool) -> None:
    if Path(path).exists() and not force:
        raise ValueError(f"{path} already exists; choose a new output or explicitly pass --force")


def _distinct(paths: tuple[Path, ...]) -> None:
    for index, first in enumerate(paths):
        for second in paths[index + 1:]:
            if first.resolve() == second.resolve() or (
                first.exists() and second.exists() and first.samefile(second)
            ):
                raise ValueError("input and output paths must be distinct files")


def generate(args: argparse.Namespace, paths: RepoPaths) -> int:
    from .surrogate_data import generate_dataset

    _available(args.output, args.force)
    def progress(completed: int, total: int) -> None:
        if completed == 0 or completed == total or completed % 32 == 0:
            print(f"surrogate-generate: {completed}/{total} teacher runs", flush=True)
    document = generate_dataset(paths, train=args.train, calibration=args.calibration,
                                test=args.test, seed=args.seed, workers=args.jobs,
                                on_progress=progress)
    write_document(args.output, document, force=args.force)
    failed = len(document["failures"])
    print(f"surrogate-generate: wrote {paths.relative(args.output)}; {failed} failed/capped samples retained")
    return 1 if failed else 0


def train(args: argparse.Namespace, paths: RepoPaths) -> int:
    from .surrogate_train import render_report, train_dataset, validate_artifact

    report_json = args.report_dir / "m6-surrogate-validation.json"
    report_md = args.report_dir / "m6-surrogate-validation.md"
    _distinct((args.dataset, args.model, report_json, report_md))
    for path in (args.model, report_json, report_md):
        _available(path, args.force)
    document = read_document(args.dataset)
    artifact = train_dataset(document, seed=args.seed, max_iter=args.max_iter)
    validate_artifact(artifact)
    write_document(args.model, artifact, force=args.force)
    write_document(report_json, artifact, force=args.force)
    write_text(report_md, render_report(artifact), force=args.force)
    print(f"surrogate-train: wrote {paths.relative(args.model)} and {paths.relative(report_md)}")
    print("surrogate-train: experimental scalar emulator of simulated data; browser approval remains false")
    # A failed accuracy target is a valid experimental result, not a failed command.
    # `surrogate-check --require-qualified` can be used as an explicit readiness gate.
    return 0


def check(args: argparse.Namespace, paths: RepoPaths) -> int:
    from .surrogate_data import teacher_identity
    from .surrogate_train import validate_artifact, verify_evaluation

    artifact = read_document(args.model)
    validate_artifact(artifact)
    if artifact["teacher"] != teacher_identity(paths):
        raise ValueError("model teacher identity does not match the installed core and effective inputs")
    if args.dataset:
        dataset = read_document(args.dataset)
        verify_evaluation(artifact, dataset)
    if args.require_qualified and not artifact["quality"]["qualified_small_scope"]:
        print("surrogate-check: the frozen scalar accuracy target is not met; physics fallback required")
        return 1
    evidence = "; dataset evaluation replay matches" if args.dataset else ""
    print(f"surrogate-check: artifact structure, digest and teacher identity match{evidence}; no browser approval")
    return 0


def predict(args: argparse.Namespace, paths: RepoPaths) -> int:
    from .surrogate_infer import predict_or_simulate

    if args.output:
        _distinct((args.output, args.recipe, args.model))
        _available(args.output, args.force)
    recipe = read_document(args.recipe)
    artifact = read_document(args.model)
    result = predict_or_simulate(recipe, artifact, paths)
    if args.output:
        write_document(args.output, result, force=args.force)
        print(f"surrogate-predict: wrote {paths.relative(args.output)}")
    else:
        print(json.dumps(result, indent=2, allow_nan=False))
    return 0


def dispatch(args: argparse.Namespace, paths: RepoPaths) -> int:
    try:
        return {"surrogate-generate": generate, "surrogate-train": train,
                "surrogate-check": check, "surrogate-predict": predict}[args.command](args, paths)
    except (OSError, ValueError, RuntimeError) as error:
        print(f"{args.command}: {error}")
        return 2


def add_commands(sub: Any, common: argparse.ArgumentParser) -> None:
    parser = sub.add_parser("surrogate-generate", parents=[common],
                            help="generate frozen synthetic Tier-1 scalar training/calibration/test data")
    parser.add_argument("--output", type=Path, required=True)
    for name, default in (("train", 256), ("calibration", 64), ("test", 128)):
        parser.add_argument(f"--{name}", type=int, default=default,
                            help="power-of-two count (1–4096; at most 8192 statistical samples total)")
    parser.add_argument("--jobs", type=int, choices=range(1, 5), default=4)
    parser.add_argument("--seed", type=int, default=20261020)
    parser.add_argument("--force", action="store_true")
    parser.set_defaults(handler=dispatch)

    parser = sub.add_parser("surrogate-train", parents=[common],
                            help="fit an offline scalar neural ensemble and report frozen held-out errors")
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--report-dir", type=Path, required=True)
    parser.add_argument("--seed", type=int, default=20261020)
    parser.add_argument("--max-iter", type=int, default=2000)
    parser.add_argument("--force", action="store_true")
    parser.set_defaults(handler=dispatch)

    parser = sub.add_parser("surrogate-check", parents=[common],
                            help="check a scalar model's structure, integrity and current teacher identity")
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--dataset", type=Path)
    parser.add_argument("--require-qualified", action="store_true")
    parser.set_defaults(handler=dispatch)

    parser = sub.add_parser("surrogate-predict", parents=[common],
                            help="guarded offline scalar estimate with automatic Tier-1 physics fallback",
                            description="Guarded offline scalar estimate with automatic Tier-1 physics fallback.")
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--recipe", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--force", action="store_true")
    parser.set_defaults(handler=dispatch)
