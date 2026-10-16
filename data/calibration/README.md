<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# Calibration

Calibrated model parameters (docs/PLAN.md §12 M1, §7.3 K).

| File | Content |
|---|---|
| `config.yaml` | what `puckworks-tools calibrate` fits: parameters (registry ids, how each enters the cases, bounds), the parameters reviewed and held at their registry values (`fixed`, with reasons), and residual blocks (V1 Schmieder 2023, V2 Vaca Guerra 2024, V4 Waszkiewicz 2026, V6 Corrochano 2017) |
| `v1.yaml` | the preserved M1 calibration on puckcore 0.2.0 |
| `v2.yaml` | the M1.1 startup-model calibration (written by `calibrate --label v2`, now the default label) |
| `current.yaml` | the calibration the app uses: `puckworks-tools export` embeds its `parameters` as registry defaults |

Calibration documents follow `schema: puckworks.calibration/1`:

```yaml
schema: puckworks.calibration/1
label: v2
created: 2026-10-15
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

The original 0.2.0 report, figures, configuration and current calibration are also preserved under
[`docs/validation/baseline-v0.2.0`](../../docs/validation/baseline-v0.2.0/). M1.1 keeps the same calibration
observables and strict validation targets; the V4 transient remains held out.

The complete v2 run includes all 15 leave-one-condition-out refits and all seven sensitivity variants.
Startup timings improve, while V1 extraction fits, V2 dispersion and V5 EY/time correlation regress;
the M1 scientific exit criteria are still unmet. The before/after results and limitations are recorded
in [the calibration report](../../docs/validation/calibration.md#results-of-the-m11-calibration-v2-2026-10-15).
The supplemental [startup ablations](../../docs/validation/m11-startup-sensitivity.json) hold the v2 fit
fixed; they do not refit the startup assumptions or reproduce the historical v1 solver.
