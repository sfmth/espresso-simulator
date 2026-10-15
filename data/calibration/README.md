<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# Calibration

Calibrated model parameters (docs/PLAN.md §12 M1, §7.3 K).

| File | Content |
|---|---|
| `config.yaml` | what `puckworks-tools calibrate` fits: parameters (registry ids, how each enters the cases, bounds), the parameters reviewed and held at their registry values (`fixed`, with reasons), and residual blocks (V1 Schmieder 2023, V2 Vaca Guerra 2024, V4 Waszkiewicz 2026, V6 Corrochano 2017) |
| `v1.yaml` | the M1 calibration, versioned (written by `calibrate --label v1`; created in phase 2, once the M1 solver has landed) |
| `current.yaml` | the calibration the app uses: `puckworks-tools export` embeds its `parameters` as registry defaults |

Calibration documents follow `schema: puckworks.calibration/1`:

```yaml
schema: puckworks.calibration/1
label: v1
created: 2026-10-14
parameters: {<registry id>: <value in the registry's units>}
fit: {datasets, optimizer, nuisance, reference_permeability, fixed, blocks, uncertainties, loo, sensitivity, ...}
```

Every id in `parameters` is a parameter-registry record, with a value inside its range. The format, the
parameter mapping and the residuals are documented in
[docs/validation/calibration.md](../../docs/validation/calibration.md). Do not edit the documents by hand:
regenerate them with `puckworks-tools calibrate`, then run `puckworks-tools export` so the generated
registry stays current (`export --check` runs in CI). After a change to the grinder models, re-pool the
reference permeability with `puckworks-tools calibrate --pool-only` (no refit) and export again. `calibrate` will not write here while the solver
reports itself as a placeholder.
