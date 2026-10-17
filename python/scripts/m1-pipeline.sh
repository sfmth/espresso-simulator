#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# The M1 calibration and validation pipeline (docs/validation/calibration.md, "Running it") as one command
# sequence: rebuild puckcore from the current sources, warm-start v5 from preserved v4 and retain each
# refit checkpoint in .local/calibration-v5, validate the candidate, publish a completed v5/current,
# export (embeds current.yaml), rebuild, write the validation report
# (docs/validation/m1-validation.md, .json and m1/*.png), record v5-labelled startup ablations,
# regenerate the golden shot fixture
# (data/fixtures/shot_cases.json), refresh kernel verification, then run the Python checks.
# Rust and browser release checks are listed in CONTRIBUTING.md. Each step stops on failure.
#
#     python/scripts/m1-pipeline.sh [JOBS]        # JOBS: parallel simulation processes, default 8
#
# The report records the solver build it ran on (extension hash and source-tree hashes); re-render it
# without simulating with `puckworks-tools validate --from-json docs/validation/m1-validation.json`.
set -euo pipefail

JOBS="${1:-8}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
export PATH="$HOME/.cargo/bin:$PATH"
export PYTHONUNBUFFERED=1
TOOLS=.venv/bin/puckworks-tools
STAGE=.local/calibration-v5
CAL_CONFIG=data/calibration/config.yaml
CAL_START=data/calibration/v4.yaml
CAL_CANDIDATE="$STAGE/v5.yaml"
mkdir -p "$STAGE/checkpoints"
sha256sum data/calibration/v1.yaml data/calibration/v2.yaml data/calibration/v3.yaml data/calibration/v4.yaml \
  docs/validation/m11-particle-inputs.json docs/validation/m11-particle-inputs.md \
  docs/validation/m11-startup-sensitivity.json \
  docs/validation/m11-startup-sensitivity-v3.json \
  docs/validation/m11-startup-sensitivity-v4.json \
  docs/validation/m11-startup-identification.json docs/validation/m11-startup-refits.json > "$STAGE/preserved.sha256"
rg --files -0 docs/validation/baseline-v0.2.0 docs/validation/baseline-v0.3.0 \
  docs/validation/baseline-v0.5.1 docs/validation/baseline-v0.6.0 \
  docs/validation/baseline-v0.6.1 docs/validation/baseline-v0.6.2 \
  | sort -z | xargs -0 sha256sum >> "$STAGE/preserved.sha256"

step() { printf '\n== %s (%s)\n' "$*" "$(date '+%H:%M:%S')"; }

step "rebuild puckcore from the current sources"
.venv/bin/python -m pip install --quiet ./crates/puckcore-py
step "registry and export are current"
"$TOOLS" validate-registry
"$TOOLS" export --check
step "calibration dry run"
"$TOOLS" calibrate --config "$CAL_CONFIG" --dry-run --jobs "$JOBS" --start-from "$CAL_START" --fd-step 0.01
step "v5 calibration (prune, 15 full-block leave-one-out refits, nine sensitivities)"
"$TOOLS" calibrate --config "$CAL_CONFIG" --label v5 --jobs "$JOBS" --prune --loo --loo-jobs 2 --sensitivity \
  --start-from "$CAL_START" --fd-step 0.01 --max-nfev 120 --out-dir "$STAGE" --no-current \
  --checkpoint-dir "$STAGE/checkpoints" --verbose 2 2>&1 | tee "$STAGE/calibration.log"
step "candidate validation (scientific failures remain reported)"
"$TOOLS" validate --jobs "$JOBS" --calibration "$CAL_CANDIDATE" \
  --config "$CAL_CONFIG" --output-dir "$STAGE/validation"
step "verify numerical completion and preserve historical artifacts"
sha256sum --check "$STAGE/preserved.sha256"
.venv/bin/python - "$CAL_CANDIDATE" <<'PY'
import sys
from pathlib import Path
from puckworks_tools.calibrate import completion_issues, load_calibration_document, write_documents
from puckworks_tools.identity import input_hashes, solver_identity
from puckworks_tools.paths import RepoPaths
document = load_calibration_document(Path(sys.argv[1]))
issues = completion_issues(document)
fit = document.get("fit") or {}
paths = RepoPaths(Path.cwd())
if document.get("label") != "v5":
    issues.append("candidate is not labelled v5")
if not (fit.get("pipeline") or {}).get("completed"):
    issues.append("candidate pipeline is not complete")
if fit.get("solver") != solver_identity(paths):
    issues.append("candidate solver identity changed")
if fit.get("inputs") != input_hashes(paths, fit.get("config", "data/calibration/config.yaml"), fit.get("datasets") or []):
    issues.append("candidate inputs changed")
refitted = set((fit.get("loo") or {}).get("refitted_blocks") or [])
if refitted != set(fit.get("blocks") or {}):
    issues.append("leave-one-out did not refit every selected calibration block")
if issues:
    raise SystemExit("Candidate retained without promotion: " + "; ".join(issues))
write_documents(document, Path("data/calibration"), label="v5")
PY
step "export the calibration"
"$TOOLS" export
step "rebuild puckcore with the calibration embedded"
.venv/bin/python -m pip install --quiet ./crates/puckcore-py
step "validation report"
"$TOOLS" validate --jobs "$JOBS" --calibration data/calibration/v5.yaml --config "$CAL_CONFIG"
step "v5 startup sensitivity (no refit; writes m11-startup-sensitivity-v5.json)"
.venv/bin/python python/scripts/m11-startup-sensitivity.py \
  --calibration data/calibration/v5.yaml --config "$CAL_CONFIG" --output-dir docs/validation
step "golden fixtures (core_version follows the rebuilt extension)"
"$TOOLS" shot-fixtures
cp data/fixtures/sphere_cases.json "${TMPDIR:-/tmp}/sphere_cases.before.json"
"$TOOLS" fixtures
.venv/bin/python - "${TMPDIR:-/tmp}/sphere_cases.before.json" data/fixtures/sphere_cases.json <<'PY'
import json, sys
def numbers(x):
    if isinstance(x, dict):
        return [v for k in sorted(x) if k != "core_version" for v in numbers(x[k])]
    if isinstance(x, list):
        return [v for item in x for v in numbers(item)]
    return [x] if isinstance(x, (int, float)) and not isinstance(x, bool) else []
a, b = (numbers(json.load(open(f))) for f in sys.argv[1:3])
diff = max((abs(p - q) for p, q in zip(a, b)), default=0.0) if len(a) == len(b) else float("inf")
print(f"sphere fixture: {len(b)} numbers, max |difference| from the previous file = {diff}")
sys.exit(0 if diff == 0 else 1)
PY
step "kernel verification report"
"$TOOLS" verify
step "checks"
"$TOOLS" validate-registry
"$TOOLS" export --check
"$TOOLS" fixtures --check
"$TOOLS" shot-fixtures --check
"$TOOLS" check-versions --release
"$TOOLS" validate --check
.venv/bin/python -m pytest -q python/tests
step "historical artifacts remain unchanged"
sha256sum --check "$STAGE/preserved.sha256"
step "done"
