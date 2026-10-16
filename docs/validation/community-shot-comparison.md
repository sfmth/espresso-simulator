# Community comparison: Gagné 2021

**Exploratory conditional simulations; no parameters fitted and no validation gates scored.**

Ranges span the shots within a grinder group and a stated hypothesis. They are descriptive ranges, not uncertainty intervals.

| Group | Shots | Logged 0.5 g crossing (s) | Logged bloom gain (g) | Logged target inlet (mL) | Estimated inlet (mL) | Last logged cup mass (g) |
|---|---:|---:|---:|---:|---:|---:|
| EG1 | 6 | 19.28–22.19 | 3.02–4.06 | 1.76–1.77 | 0.44–0.60 | 69.14–69.92 |
| Niche | 5 | 14.07–15.90 | 4.12–5.85 | 1.75–1.76 | 0.43–0.68 | 68.70–69.74 |

The bloom interval is the sampled positive minimum-flow-goal plateau, excluding its transitions. Estimated inlet flow is firmware-derived; it is not an independent flowmeter measurement. Mass and volume are distinct quantities.

| Group / mode | PSD scale / headspace (mL) | Completed / runs | Model 0.5 g crossing (s) | Model bloom gain (g) | Model mass at record end (g) | Pressure RMSE (bar) |
|---|---:|---:|---:|---:|---:|---:|
| EG1 / pressure_conditioned | 0.5 / 0 | 6/6 | 14.35–14.95 | 19.51–21.13 | 83.05–93.56 | 0.01–0.02 |
| EG1 / pressure_conditioned | 0.5 / 10 | 6/6 | 14.66–15.21 | 19.05–20.74 | 82.64–93.17 | 0.02–0.02 |
| EG1 / pressure_conditioned | 0.5 / 30 | 6/6 | 15.57–15.93 | 17.80–19.57 | 81.44–91.94 | 0.04–0.05 |
| EG1 / pressure_conditioned | 1 / 0 | 6/6 | 11.06–11.98 | 80.56–85.42 | 330.29–352.89 | 0.35–0.99 |
| EG1 / pressure_conditioned | 1 / 10 | 6/6 | 11.25–12.14 | 79.19–84.05 | 328.54–351.24 | 0.35–0.99 |
| EG1 / pressure_conditioned | 1 / 30 | 6/6 | 11.84–12.57 | 75.45–80.67 | 323.72–346.30 | 0.35–0.99 |
| EG1 / pressure_conditioned | 2 / 0 | 6/6 | 8.07–8.90 | 170.38–178.29 | 483.44–508.65 | 1.08–1.81 |
| EG1 / pressure_conditioned | 2 / 10 | 6/6 | 8.33–9.14 | 167.95–175.94 | 479.78–505.21 | 1.08–1.80 |
| EG1 / pressure_conditioned | 2 / 30 | 6/6 | 9.01–9.73 | 161.81–170.20 | 469.86–496.50 | 1.07–1.79 |
| EG1 / recorded_flow_target | 1 / 10 | 6/6 | 7.17–7.23 | 1.45–1.51 | 86.55–94.43 | 3.23–3.62 |
| EG1 / zero_plateau_probe | 1 / 10 | 6/6 | 7.17–7.23 | 0.00–0.00 | 84.82–92.71 | 3.23–3.62 |
| Niche / pressure_conditioned | 0.5 / 0 | 5/5 | 13.73–14.67 | 19.68–26.55 | 80.89–100.37 | 0.01–0.01 |
| Niche / pressure_conditioned | 0.5 / 10 | 5/5 | 14.02–14.96 | 19.25–26.06 | 80.48–99.91 | 0.02–0.02 |
| Niche / pressure_conditioned | 0.5 / 30 | 5/5 | 14.89–15.86 | 18.01–24.57 | 79.31–98.55 | 0.04–0.05 |
| Niche / pressure_conditioned | 1 / 0 | 5/5 | 10.60–11.34 | 81.75–103.55 | 339.98–378.55 | 0.06–0.65 |
| Niche / pressure_conditioned | 1 / 10 | 5/5 | 10.78–11.50 | 80.46–101.98 | 338.36–376.58 | 0.06–0.65 |
| Niche / pressure_conditioned | 1 / 30 | 5/5 | 11.34–12.03 | 76.84–97.60 | 333.91–371.25 | 0.07–0.65 |
| Niche / pressure_conditioned | 2 / 0 | 5/5 | 7.67–8.49 | 170.99–211.38 | 502.81–528.92 | 0.92–1.56 |
| Niche / pressure_conditioned | 2 / 10 | 5/5 | 7.90–8.64 | 168.57–209.00 | 499.06–525.43 | 0.91–1.56 |
| Niche / pressure_conditioned | 2 / 30 | 5/5 | 8.59–9.24 | 163.01–201.07 | 489.88–513.30 | 0.91–1.55 |
| Niche / recorded_flow_target | 1 / 10 | 5/5 | 7.20–7.26 | 1.45–1.45 | 84.13–91.82 | 3.16–3.43 |
| Niche / zero_plateau_probe | 1 / 10 | 5/5 | 7.20–7.26 | 0.00–0.00 | 82.41–90.10 | 3.17–3.43 |

Pressure replay uses observed pressure as an input; its apparent pressure agreement is not a prediction. Required inlet delivery, headspace filling and the pump cap can prevent exact pressure tracking. The positive-floor and zero-command probes use control targets, not estimated inlet observations.

## Fixed assumptions

Two particle diameters 40/400 µm at volume fractions 0.3/0.7, scaled together by 0.5/1/2; headspace 0/10/30 mL. The same nine scenarios apply to both grinder groups. Command probes use scale 1 and 10 mL. None is selected as a best fit.

Actual dose is supplied by the log. Basket diameter 58 mm, perforated diameter 54 mm, constant inlet 92 °C, ideal pump limits 8 mL/s and 12 bar; remaining bean/preparation/thermal properties retain builder defaults. Stop at the record's last timestamp, with no post-record drip. Thus these are conditional scenarios, not matched reconstructions.

## Limitations

- Pressure-conditioned replay consumes measured pressure and cannot validate pressure prediction.
- Pressure replay may require virtual inlet delivery during bloom; it is not an actual pump-control reconstruction.
- The ideal pump cap and sequential headspace filling can prevent exact pressure tracking; errors are reported.
- No measured PSD or headspace exists; every grinder receives the same illustrative scenario grid.
- A constant 92 C inlet and builder-default initial thermal state replace the varying temperature program; basket temperature is not imposed as inlet temperature.
- Other bean, paper-filter, geometry and preparation properties remain builder defaults, not measured experiment inputs.
- The flow probe uses logged targets (not measured inlet flow). The negative startup sentinel is replaced by the first valid command.
- The zero plateau is a counterfactual structural probe. The real logged bloom goal is positive, with ramps outside the selected plateau.
- Mid-program zero flow has no independent pressure-storage or gravity-drainage state in the current solver.
- Comparing cup grams with inlet millilitres is not a closed experimental water/solute balance: inlet estimates, density, dissolved solids and sensor uncertainty remain unresolved.
- Bloom discrepancies motivate pressure/storage and drainage investigation but do not uniquely identify gas, headspace or particle-water mechanisms; do not tune pore-air coefficients to replace missing storage physics.
- Scale noise, latency and clock alignment limit physical interpretation of threshold times.
- Window metrics interpolate 0.1 s model outputs; sharp phase boundaries can cause small apparent zero-probe gains.
- Recorded-end mass and spreadsheet final beverage mass are different endpoints; their difference is not classified as drip.
- No coefficient is selected by residual, no scientific pass/fail gate is assigned, and existing held-out datasets are untouched.

## Approximation checks

Case `gagne2021-01`, chosen by experiment id, uses the central hypothesis. No parameter changes or response-based selection occur.

| Phase budget | Actual phases | Maximum step (s) | Input interpolation error (bar) | 0.5 g crossing (s) | Record-end mass (g) |
|---|---:|---:|---:|---:|---:|
| 64 | 64 | 0.05 | 0.03109 | 11.2483 | 340.4269 |
| 32 | 32 | 0.05 | 0.07182 | 11.2705 | 340.6168 |
| 64 | 64 | 0.025 | 0.03109 | 11.2460 | 340.4657 |

Numerical checks: 124 simulations; 0 invalid and 0 incomplete scenario runs. Invalid input or failed simulations stop report generation rather than being silently omitted. Worst absolute relative hydraulic volume residual 7.17e-14; solute mass residual 1.54e-14. This is a hydraulic carrier-volume check, not exact solvent mass accounting; numerical conservation does not establish experimental accuracy.

## Reproduction identity

Solver: `0.4.0`, extension `2cb29430ad716e12`; tier 1.

Analysis module SHA-256: `63e252a1df9303fcb0d9049ca500b9ba2b912148bdb97eddc49da98b4da19476`.

Case-helper module SHA-256: `b5d1e45d47af5963b6ed8e6fd79e64f4efbdc03425170d725fb675ce866ba43a`.

Unchanged v2 calibration SHA-256: `d7b27532bc5d936250820bfcd24e837de6aadaed2f1bdfe6755b075e697ad373`.

[Original experiment](https://coffeeadastra.com/2021/05/10/a-comparison-between-standard-and-low-fines-espresso-shots/). Raw files remain local; source qualification does not grant redistribution rights.

[archive](https://www.dropbox.com/s/l0v4a5d3h98kasn/shotfiles_Mar2_2021.zip?raw=1): SHA-256 `a41f92b755cf028e310d0d4de2cc24051d75f719fe65dbc3d022a215d469c73b`.

[measurement log](https://docs.google.com/spreadsheets/d/1r33CI6lczJhuYcNjy8z3jABagZoxO8Z0kkd6h5Ppos0/export?format=csv): SHA-256 `490c691d06920f2c3d9cba18398d8d2193acefe037530cabcab8488cbdeb2e6d`.

Source parser `de1.py` SHA-256: `613e22b5777d605fef6213289428df9afec64e2a7473eaa8bd26788cdf7eda07`.

Source parser `gagne2021.py` SHA-256: `610cf7a34ec46895b8a19af33c9ebde94991b4f38c2ded6dbf1c4ebf08ff584a`.
