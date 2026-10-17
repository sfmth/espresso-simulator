#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# The M1 calibration and validation pipeline (docs/validation/calibration.md, "Running it") as one command
# sequence: rebuild puckcore from the current sources, warm-start v3 from preserved v2 and retain each
# refit checkpoint in .local/calibration-v3, validate the candidate, publish a completed v3/current,
# export (embeds current.yaml), rebuild, write the validation report
# (docs/validation/m1-validation.md, .json and m1/*.png), record fixed-prior startup ablations,
# regenerate the golden shot fixture
# (data/fixtures/shot_cases.json), then run every check. Each step stops the script on failure.
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
TOOLS=.venv/bin/puckworks-tools
STAGE=.local/calibration-v3
mkdir -p "$STAGE/checkpoints"
sha256sum data/calibration/v1.yaml data/calibration/v2.yaml \
  docs/validation/m11-particle-inputs.json docs/validation/m11-particle-inputs.md \
  docs/validation/m11-startup-sensitivity.json > "$STAGE/preserved.sha256"
rg --files docs/validation/baseline-v0.2.0 docs/validation/baseline-v0.3.0 | sort | xargs sha256sum >> "$STAGE/preserved.sha256"

step() { printf '\n== %s (%s)\n' "$*" "$(date '+%H:%M:%S')"; }

step "rebuild puckcore from the current sources"
.venv/bin/python -m pip install --quiet ./crates/puckcore-py
step "registry and export are current"
"$TOOLS" validate-registry
"$TOOLS" export --check
step "calibration dry run"
"$TOOLS" calibrate --dry-run --jobs "$JOBS" --start-from data/calibration/v2.yaml
step "calibration (prune, 15 leave-one-out refits, nine sensitivities)"
"$TOOLS" calibrate --label v3 --jobs "$JOBS" --prune --loo --sensitivity \
  --start-from data/calibration/v2.yaml --out-dir "$STAGE" --no-current \
  --checkpoint-dir "$STAGE/checkpoints" --verbose 2 2>&1 | tee "$STAGE/calibration.log"
step "candidate validation (scientific failures remain reported)"
"$TOOLS" validate --jobs "$JOBS" --calibration "$STAGE/v3.yaml" \
  --config data/calibration/config.yaml --output-dir "$STAGE/validation"
step "verify numerical completion and preserve historical artifacts"
sha256sum --check "$STAGE/preserved.sha256"
.venv/bin/python - "$STAGE/v3.yaml" <<'PY'
import sys
from pathlib import Path
from puckworks_tools.calibrate import completion_issues, load_calibration_document, write_documents
document = load_calibration_document(Path(sys.argv[1]))
issues = completion_issues(document)
if issues:
    raise SystemExit("Candidate retained without promotion: " + "; ".join(issues))
write_documents(document, Path("data/calibration"), label="v3")
PY
step "export the calibration"
"$TOOLS" export
step "rebuild puckcore with the calibration embedded"
.venv/bin/python -m pip install --quiet ./crates/puckcore-py
step "validation report"
"$TOOLS" validate --jobs "$JOBS" --config data/calibration/config.yaml
step "fixed-prior startup sensitivity (no refit)"
.venv/bin/python python/scripts/m11-startup-sensitivity.py --calibration data/calibration/v3.yaml
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
step "checks"
"$TOOLS" validate-registry
"$TOOLS" export --check
"$TOOLS" fixtures --check
"$TOOLS" shot-fixtures --check
"$TOOLS" check-versions
.venv/bin/python -m pytest -q python/tests
step "done"
