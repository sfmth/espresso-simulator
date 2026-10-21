# Experimental scalar surrogate

`scalar-v1.json` is a frozen three-member 4 → 16 tanh → 3 neural ensemble,
licensed GPL-2.0-or-later with its training data and source. It predicts only
pump-stop time, final beverage mass and EY within a fixed recipe family. TDS is
derived from those scalars and dry dose. `scalar-v1-recipe.json` is a compatible
template recipe, including Tier 1 numerics.

**This first baseline fails its declared accuracy gate.** The guarded offline
prediction command therefore performs an actual Tier 1 simulation and reports
the fallback reason:

```bash
.venv/bin/puckworks-tools surrogate-check \
  --model models/scalar-v1.json --dataset data/surrogates/scalar-v1.json
.venv/bin/puckworks-tools surrogate-predict \
  --model models/scalar-v1.json --recipe models/scalar-v1-recipe.json
```

The check verifies the loaded teacher, dataset sampling and artifact integrity,
then recomputes scales, metrics, physical flags and calibration bands from the
actual saved weights without fitting. Add `--require-qualified` only to request
a readiness gate; it exits 1 for this baseline. A failed accuracy result is
deliberately preserved, rather than hidden by tuning on the final test set.

The artifact was trained once with seed 20261020, fixed L2 penalty 1e-6 and
2,000 L-BFGS-B iterations per member. All members reached the iteration limit.
The 0.12.0 release refreshes teacher/provenance identities after exact native
replay of all 464 original cases, retaining every weight, target and evaluation.
The [version replay receipt](../docs/validation/setup-inference-version-replay.json)
records the original and refreshed digests; no retraining was performed.
Maximum final-mass errors are 1.287 g on the test set and 3.837 g at the boundary.
See [all measured errors and coverage](../docs/validation/m6-surrogate-validation.md),
[synthetic data provenance](../data/surrogates/README.md) and the
[reproduction/guard contract](../docs/model/m6-surrogates.md).

No curves, species, taste or spatial state are emulated. Simulator approximation
bands do not quantify real espresso uncertainty. These JSON files are outside
`web/`, are not bundled or cached by the app, and have `browser_approved: false`.
