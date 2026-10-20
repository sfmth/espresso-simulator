<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# M3 uncertainty and taste checks

These are **software and mechanistic verification checks**. Empirical interval coverage and independent espresso sensory accuracy remain **unvalidated**. No sensory panel was fitted.

Reproduce: `puckworks-tools m3-validate --seed 20261018 --samples 16`.

The seed reproduces scientific outputs on the same engine; timestamps, build identity and wall-clock timings are expected to differ between runs.

## Verification checks

| Check | Result |
|---|---|
| seeded scientific output replays exactly | pass |
| unknown ensemble accounting and quantile contract | pass |
| fixed ensemble accounting and quantile contract | pass |
| measured ensemble accounting and quantile contract | pass |
| all fixed scalar and trajectory bands collapse | pass |
| fixed members reproduce their unperturbed Tier 0 preview | pass |
| unknown inputs produce nonzero outcome ranges | pass |
| unknown ranges exceed fixed ranges for this scenario | pass |
| fixed preview matches independently simulated Tier 0 central summary | pass |
| taste indices expose bounded values, limited trust and resolved drivers | pass |
| pure dilution lowers acidity | pass |
| pure dilution lowers bitterness | pass |
| pure dilution lowers astringency | pass |
| pure dilution lowers body | pass |
| disabled chemistry yields unavailable taste | pass |
| no beverage yields unavailable taste | pass |
| higher source alkalinity lowers acidity index under fixed other inputs | pass |
| M1 calibration file and fitted values preserved | pass |
| scenario and taste parameters retain estimated grade D provenance | pass |

## Scenario ranges

The table uses the ensemble's 5th–95th percentile scenario ranges. These are not 90% predictive intervals or confidence intervals. A fixed input range can collapse even though model error remains.

| Quantity | Fixed width | Measured width | Unknown width |
|---|---:|---:|---:|
| /summary/shot_time_s | 0 | 0.603144 | 3.26183 |
| /summary/beverage_mass_kg | 0 | 0.000830711 | 0.00463687 |
| /summary/tds | 0 | 0.00102766 | 0.00881286 |
| /summary/ey | 0 | 0.00185591 | 0.0156047 |
| /chemistry/acidity/ph | 0 | 0.00533903 | 0.0363063 |
| /chemistry/acidity/titratable_acidity_mmol_l_to_ph_6_6 | 0 | 2.02654 | 9.09235 |
| /taste/acidity_index | 0 | 2.23668 | 10.1439 |
| /taste/bitterness_index | 0 | 2.21179 | 10.2754 |
| /taste/astringency_index | 0 | 2.55625 | 11.8381 |
| /taste/body_index | 0 | 1.34401 | 5.69446 |

## Central solver discrepancy and timing

Tier 0 preview discrepancies are shown separately from the input ranges; neither tier is treated as experimental truth.

| Quantity | Tier 0 | Tier 1 | Tier 0 − Tier 1 |
|---|---:|---:|---:|
| shot_time_s | 15.7774 | 16.0582 | -0.280763 |
| beverage_mass_kg | 0.0570203 | 0.0568924 | +0.000127937 |
| tds | 0.0700829 | 0.0686093 | +0.00147362 |
| ey | 0.222008 | 0.216853 | +0.00515579 |

| Run | Elapsed seconds |
|---|---:|
| central_tier1 | 0.800682 |
| central_tier0 | 0.0165559 |
| ensemble_unknown | 0.213471 |
| ensemble_fixed | 0.218616 |
| ensemble_measured | 0.222628 |
| ensemble_unknown_replay | 0.21625 |
| chemistry_disabled | 0.397876 |
| no_beverage | 0.00682942 |
| alkalinity_low | 0.821262 |
| alkalinity_high | 0.813899 |

## Preserved M1 fit

The 9 shared fitted values match the existing M1 report: **yes**. Calibration file unchanged during these checks: **yes**. No refitting was performed. This check does not close the remaining M1/M2 scientific gates.

## Assumptions and limits

- Checks are software verification and mechanistic direction checks, not independent sensory validation.
- The scenario distributions and widths are estimated modelling judgements; empirical coverage is unmeasured.
- Scenario quantiles omit structural model error, kinetic uncertainty and taste-mapping error.
- Taste indices are relative explanatory indices, not panel scores, liking or coffee quality.
- Dilution checks hold the extracted cup inventory fixed and add water; they do not predict a longer extraction.
- Tier 0 versus Tier 1 discrepancy is reported separately and is not absorbed by enlarging scenario bands.
- M1 fit values are preserved, but their prior scientific limitations and the blocked M2 V7 gate remain.
- Timing is a local wall-clock observation including Python boundary overhead, not a browser performance guarantee.

Full recipes, deterministic hashes, scenario reports, taste drivers and check details: [m3-validation.json](m3-validation.json).
