# SPDX-License-Identifier: GPL-2.0-or-later
"""``puckworks-tools``: command-line entry point.

Subcommands:

- ``validate-registry``: parameter registry, unit vocabulary and dataset sidecars;
- ``fixtures [--check]``: write, or check, data/fixtures/sphere_cases.json;
- ``shot-fixtures [--check]``: write, or check, data/fixtures/shot_cases.json;
- ``verify``: write the kernel verification report to docs/validation/;
- ``calibrate``: fit the M1 calibration (data/calibration/<label>.yaml and current.yaml);
- ``validate``: write the M1 validation report to docs/validation/;
- ``community``: compare locally downloaded community shots with fixed model scenarios;
- ``export [--check]``: presets and registry for the model crate (puckworks_tools.export);
- ``check-versions [--release]``: the same version everywhere.

Exit status: 0 on success, 1 when a check fails, 2 on usage or setup errors.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Sequence
from pathlib import Path

from . import __version__
from .paths import RepoNotFoundError, RepoPaths, find_repo_root


def _cmd_validate_registry(args: argparse.Namespace, paths: RepoPaths) -> int:
    from .datasets import validate_repo_datasets
    from .registry import validate_repo_registry

    registry = validate_repo_registry(paths)
    datasets = validate_repo_datasets(paths)
    for issue in [*registry.issues, *datasets.issues]:
        print(f"error: {issue}")
    status = "ok" if registry.ok else f"{len(registry.issues)} problem(s)"
    print(f"registry: {len(registry.records)} parameters in {len(registry.files)} files: {status}")
    status = "ok" if datasets.ok else f"{len(datasets.issues)} problem(s)"
    print(f"datasets: {len(datasets.datasets)} dataset(s): {status}")
    return 0 if registry.ok and datasets.ok else 1


def _cmd_fixtures(args: argparse.Namespace, paths: RepoPaths) -> int:
    from . import fixtures

    target = args.output or paths.fixtures_file
    if args.check:
        comparison = fixtures.check(target, tolerance=args.tolerance)
        where = paths.relative(target)
        if comparison.ok:
            print(f"fixtures: {where} matches the current build ({comparison.summary()})")
            return 0
        print(f"fixtures: {where} differs from the current build: {comparison.summary()}")
        print("Regenerate it with `puckworks-tools fixtures` after checking that the change is intended.")
        return 1
    written = fixtures.write(target)
    print(f"fixtures: wrote {paths.relative(written)} ({len(fixtures.CASES)} cases)")
    return 0


def _cmd_shot_fixtures(args: argparse.Namespace, paths: RepoPaths) -> int:
    from . import shotfixtures

    target = args.output or paths.root / "data" / "fixtures" / shotfixtures.FILENAME
    where = paths.relative(target)
    if args.check:
        comparison = shotfixtures.check(target, paths, tolerance=args.tolerance)
        if comparison.ok:
            print(f"shot-fixtures: {where} matches the current build ({comparison.summary()})")
            return 0
        print(f"shot-fixtures: {where} differs from the current build: {comparison.summary()}")
        print("Regenerate it with `puckworks-tools shot-fixtures` after checking that the change is intended.")
        return 1
    document = shotfixtures.generate(paths)
    shotfixtures.write(target, document)
    print(f"shot-fixtures: wrote {where} ({len(document['cases'])} cases)")
    return 0


def _cmd_calibrate(args: argparse.Namespace, paths: RepoPaths) -> int:
    from . import calibrate

    try:
        return calibrate.run(args, paths)
    except calibrate.CalibrationError as exc:
        print(f"calibrate: {exc}", file=sys.stderr)
        return 2


def _cmd_validate(args: argparse.Namespace, paths: RepoPaths) -> int:
    from . import validate
    from .calibrate import CalibrationError

    try:
        return validate.run(args, paths)
    except CalibrationError as exc:
        print(f"validate: {exc}", file=sys.stderr)
        return 2


def _cmd_community(args: argparse.Namespace, paths: RepoPaths) -> int:
    from .community import run_comparison, write_report
    from .sources.gagne2021 import ensure_local_output, load_experiment, write_bundle

    try:
        output = ensure_local_output(args.output_dir or paths.root / ".local/community/gagne2021")
        bundle = load_experiment(args.archive, args.log)
        report = run_comparison(bundle, paths, tier=args.tier)
        normalized = write_bundle(bundle, output)
        written = write_report(report, output)
        for target in [*normalized, *written.values()]:
            print(f"community: wrote {paths.relative(target)}")
        print("community: exploratory comparisons only; no parameters fitted or validation gates changed")
        return 0
    except (OSError, ValueError) as exc:
        print(f"community: {exc}", file=sys.stderr)
        return 2


def _run_export(argv: Sequence[str]) -> int:
    """Forwards to ``puckworks_tools.export.main(argv)`` (workstream D's module)."""
    import importlib

    try:
        export = importlib.import_module(f"{__package__}.export")
    except ImportError as exc:
        print(
            "puckworks-tools export: the export module (python/puckworks_tools/export.py, written by workstream D) "
            f"is not available: {exc}",
            file=sys.stderr,
        )
        return 2
    main_function = getattr(export, "main", None)
    if main_function is None:
        print("puckworks-tools export: puckworks_tools.export has no main(argv) function", file=sys.stderr)
        return 2
    return int(main_function(list(argv)) or 0)


def _cmd_verify(args: argparse.Namespace, paths: RepoPaths) -> int:
    from . import verify

    config = verify.QUICK_CONFIG if args.quick else verify.VerifyConfig()
    doc = verify.run(config)
    md_path, json_path = verify.write_report(doc, args.output_dir or paths.validation_dir)
    print(f"verify: wrote {paths.relative(md_path)} and {paths.relative(json_path)}")
    check = doc["analytic_check"]
    print(f"verify: independent analytic check, max |difference| = {check['max_abs_diff']:.3e}")
    for combo in doc["combinations"]:
        finest = combo["space"][-1]
        print(
            f"  {combo['grid']:>14} {combo['scheme']:<14} finest max|e| = {finest['max_abs_error']:.3e}, "
            f"worst mass balance = {combo['worst_mass_balance_error']:.1e}, "
            f"targets {'met' if combo['meets_targets'] else 'not met'}"
        )
    ignored = [name for name in ("grid", "scheme") if doc["ignored_options"][name]]
    if ignored:
        print(f"verify: note: the solver ignores {' and '.join(ignored)} (identical results); placeholder?")
    return 0


def _cmd_check_versions(args: argparse.Namespace, paths: RepoPaths) -> int:
    from .versions import check_versions

    report = check_versions(paths, release=args.release)
    for source in report.sources:
        shown = source.version if source.version is not None else "?"
        print(f"  {source.name:<20} {shown:<12} {source.location}")
    for problem in report.problems:
        print(f"error: {problem}")
    mode = " (release)" if args.release else ""
    if report.ok:
        print(f"check-versions{mode}: ok, version {report.reference}")
        return 0
    print(f"check-versions{mode}: {len(report.problems)} problem(s)")
    return 1


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="puckworks-tools",
        description="Offline tools for Puckworks: registry, datasets, fixtures, verification, calibration, "
        "validation, export, versions.",
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument(
        "--root", type=Path, help="repository root (default: found from the current directory)"
    )
    sub = parser.add_subparsers(dest="command", required=True, metavar="COMMAND")

    p = sub.add_parser(
        "validate-registry",
        parents=[common],
        help="validate data/params, the unit vocabulary and the dataset sidecars",
    )
    p.set_defaults(handler=_cmd_validate_registry)

    p = sub.add_parser("fixtures", parents=[common], help="write or check data/fixtures/sphere_cases.json")
    p.add_argument("--check", action="store_true", help="fail if the committed file differs from the current build")
    p.add_argument("--output", type=Path, help="fixture path (default: data/fixtures/sphere_cases.json)")
    p.add_argument(
        "--tolerance",
        type=float,
        default=0.0,
        help="with --check: largest allowed absolute difference in results (default: 0, exact)",
    )
    p.set_defaults(handler=_cmd_fixtures)

    p = sub.add_parser(
        "shot-fixtures", parents=[common], help="write or check data/fixtures/shot_cases.json (shot API golden file)"
    )
    p.add_argument("--check", action="store_true", help="fail if the committed file differs from the current build")
    p.add_argument("--output", type=Path, help="fixture path (default: data/fixtures/shot_cases.json)")
    p.add_argument(
        "--tolerance",
        type=float,
        default=0.0,
        help="with --check: largest allowed absolute difference in outputs (default: 0, exact)",
    )
    p.set_defaults(handler=_cmd_shot_fixtures)

    from . import calibrate as _calibrate
    from . import validate as _validate

    p = sub.add_parser("calibrate", parents=[common], help="fit the M1 calibration (data/calibration)")
    _calibrate.add_arguments(p)
    p.set_defaults(handler=_cmd_calibrate)

    p = sub.add_parser("validate", parents=[common], help="write the M1 validation report (docs/validation)")
    _validate.add_arguments(p)
    p.set_defaults(handler=_cmd_validate)

    p = sub.add_parser(
        "community", parents=[common],
        help="compare local Gagné DE1 logs with fixed model scenarios (no fitting or downloads)",
    )
    p.add_argument("--archive", type=Path, required=True, help="original shotfiles_Mar2_2021.zip")
    p.add_argument("--log", type=Path, required=True, help="original measurement-log CSV export")
    p.add_argument("--output-dir", type=Path,
                   help="local output directory, outside git or ignored (default: .local/community/gagne2021)")
    p.add_argument("--tier", type=int, choices=(0, 1), default=1, help="solver tier (default: 1)")
    p.set_defaults(handler=_cmd_community)

    sub.add_parser(
        "export",
        help="write or check the presets and registry JSON of the model crate (forwards to puckworks_tools.export)",
        add_help=False,
    )

    p = sub.add_parser("verify", parents=[common], help="write the kernel verification report")
    p.add_argument("--output-dir", type=Path, help="output directory (default: docs/validation)")
    p.add_argument("--quick", action="store_true", help="small refinement series, for smoke tests")
    p.set_defaults(handler=_cmd_verify)

    p = sub.add_parser("check-versions", parents=[common], help="check that every version agrees")
    p.add_argument("--release", action="store_true", help="also require a CHANGELOG.md heading for the version")
    p.set_defaults(handler=_cmd_check_versions)
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv and argv[0] == "export":
        # forwarded verbatim (including --help and --root) to workstream D's export module
        return _run_export(argv[1:])
    args = build_parser().parse_args(argv)
    try:
        paths = RepoPaths(find_repo_root(args.root))
        return args.handler(args, paths)
    except (RepoNotFoundError, RuntimeError) as exc:
        print(f"puckworks-tools: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":  # pragma: no cover
    sys.exit(main())
