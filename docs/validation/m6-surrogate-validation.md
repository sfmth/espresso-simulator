# M6 scalar surrogate: offline evaluation

Artifact `a690bd23d56deccd0f8f1131b5042d5e54390e9dcdba5c6cf3fa267bb72dc7e8` · dataset `4a8bef561c67a281616741c03ee717074ec34c91da97ce85b055bb6c3ceae605`.

Teacher core `0.13.0`; behavior fingerprint `2302a903a89a1f0de14d35e02fef4abefae073acd08fac94bc624d4998dd0f0c`.

This is a four-input, three-member 4 → 16 tanh → 3 neural ensemble trained on Tier-1 simulator outputs. It has no shot curves, species, chemistry or spatial-state predictions. TDS is derived from the ensemble mean EY, dose and final beverage mass, preserving the reported scalars' accounting.

Small-scope accuracy qualification: **fail**. **Browser approved: false. M6 and scientific validation gates remain open.**

## Frozen evaluation

Inputs scale against declared support; output centers/scales use training rows only. The acceptance threshold is a maximum absolute error ≤1% of each training output's range on both test and boundary sets. A constant training range has no normalized error and passes only with exactly zero error. No test or boundary values choose weights, scales, optimizer settings or calibration radii.

| Split | Rows | Physical predictions (all members and mean) |
|---|---:|---|
| train | 256 | True |
| calibration | 64 | True |
| test | 128 | True |
| boundary | 16 | True |

| Split | Output | MAE | RMSE | p95 absolute | Maximum absolute | Training range | Max / range | ≤1% |
|---|---|---:|---:|---:|---:|---:|---:|---|
| test | shot_time_s | 0.00251727 | 0.00349382 | 0.00647112 | 0.0139888 | 6.78633 | 0.00206132 | True |
| test | beverage_mass_kg | 7.46514e-05 | 0.000152588 | 0.000186354 | 0.00128675 | 0.0252897 | 0.0508805 | False |
| test | ey | 6.5936e-05 | 0.000126615 | 0.000207514 | 0.000991236 | 0.0323262 | 0.0306636 | False |
| test | tds | 6.58936e-05 | 0.00012358 | 0.000144276 | 0.00101109 | 0.0270326 | 0.0374026 | False |
| boundary | shot_time_s | 0.0209583 | 0.0281066 | 0.0525659 | 0.0751278 | 6.78633 | 0.0110705 | False |
| boundary | beverage_mass_kg | 0.000525436 | 0.00102922 | 0.0016037 | 0.00383655 | 0.0252897 | 0.151704 | False |
| boundary | ey | 0.000453645 | 0.000823888 | 0.00135754 | 0.0029908 | 0.0323262 | 0.0925195 | False |
| boundary | tds | 0.000464534 | 0.000860179 | 0.0013728 | 0.0031611 | 0.0270326 | 0.116937 | False |

## Approximation-error bands

The 64 calibration rows alone determine separate absolute-residual 90% radii (order statistic 59). These describe simulation approximation error, not confidence intervals, calibrated espresso coverage, sensory accuracy or M3 input-scenario uncertainty. Raw ensemble spread is not treated as confidence. Observed coverage below is a finite simulator comparison.

| Output | Absolute radius | Calibration coverage | Test coverage | Boundary coverage |
|---|---:|---:|---:|---:|
| shot_time_s | 0.00648725 | 92.2% | 94.5% | 18.8% |
| beverage_mass_kg | 0.000106709 | 92.2% | 83.6% | 18.8% |
| ey | 0.000137642 | 92.2% | 89.1% | 25.0% |
| tds | 0.000137536 | 92.2% | 94.5% | 31.2% |

## Fixed training controls

Seed 20261020; L-BFGS-B with analytic gradients; at most 2000 iterations per independently seeded member; fixed weight penalty 1e-06. Reaching an iteration limit is reported without retrying or tuning against held-out results.

| Member seed | Iterations | Converged | Final loss | Optimizer message |
|---:|---:|---|---:|---|
| 1773373401 | 2000 | False | 0.000128397 | STOP: TOTAL NO. OF ITERATIONS REACHED LIMIT |
| 3682398207 | 2000 | False | 0.000109618 | STOP: TOTAL NO. OF ITERATIONS REACHED LIMIT |
| 1402023368 | 2000 | False | 0.00011223 | STOP: TOTAL NO. OF ITERATIONS REACHED LIMIT |

## Limits

- The artifact covers only its fixed recipe template and four declared feature supports. It is not a general espresso model; out-of-domain and incompatible inputs require full-physics fallback.
- Successful simulator emulation does not correct the teacher's scientific limitations or validate real shots.
- Finite held-out and boundary checks are evidence on sampled inputs, not a uniform accuracy proof over the whole support box.
- Independently scrambled Sobol points are a sampling design, not an exchangeability guarantee; residual bands have no formal coverage guarantee here.
- All dataset failures must be resolved before training; no failed rows are silently discarded.
- Browser integration, curve emulation, calibrated real-world uncertainty and target-device speed gates are not established here.
