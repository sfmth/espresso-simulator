#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
#
# The M1 calibration and validation pipeline (docs/validation/calibration.md, "Running it") as one command
# sequence: rebuild puckcore from the current sources, calibrate (writes data/calibration/v1.yaml and
# current.yaml), export (embeds current.yaml), rebuild, write the validation report
# (docs/validation/m1-validation.md, .json and m1/*.png), regenerate the golden shot fixture
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

step() { printf '\n== %s (%s)\n' "$*" "$(date '+%H:%M:%S')"; }

step "rebuild puckcore from the current sources"
.venv/bin/pip install --quiet ./crates/puckcore-py
step "registry and export are current"
"$TOOLS" validate-registry
"$TOOLS" export --check
step "calibration dry run"
"$TOOLS" calibrate --dry-run --jobs "$JOBS"
step "calibration (prune, leave-one-out, sensitivity)"
"$TOOLS" calibrate --jobs "$JOBS" --prune --loo --sensitivity
step "export the calibration"
"$TOOLS" export
step "rebuild puckcore with the calibration embedded"
.venv/bin/pip install --quiet ./crates/puckcore-py
step "validation report"
"$TOOLS" validate --jobs "$JOBS"
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
