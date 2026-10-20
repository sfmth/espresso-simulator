# Synthetic scalar teacher data

`scalar-v1.json` freezes 464 Tier 1 simulations of the fixed four-control recipe
family in the [M6 contract](../../docs/model/m6-surrogates.md). The 256 training,
64 calibration, 128 final-test and 16 boundary rows are separate, with no failed
or capped simulations. These are synthetic model outputs, not coffee measurements.

`scalar-v1.metadata.json` records GPL-2.0-or-later licensing, source code identity,
teacher/dataset hashes, generation command, numerical-library versions and local
generation time. The dataset uses `puckworks.surrogate-dataset/1`; the sidecar uses
`puckworks.surrogate-provenance/1`. They are separate from the measured dataset
catalogue in `data/datasets/`.

Validate the committed model, actual metrics and teacher compatibility without
training or regenerating the samples:

```bash
.venv/bin/puckworks-tools surrogate-check \
  --model models/scalar-v1.json --dataset data/surrogates/scalar-v1.json
```

Use the contract's `.local/surrogates/` commands for reproduction. Outputs refuse
replacement by default. Strict validation replays seeded Sobol coordinates,
rejects duplicate/reassigned samples and retains failures rather than resampling.
Changing the model after observing final-test errors requires a separately
declared experiment with a new untouched final evaluation set.

The dataset and model are outside the production browser build. The first model
fails the accuracy gate; see the [evaluation](../../docs/validation/m6-surrogate-validation.md).
