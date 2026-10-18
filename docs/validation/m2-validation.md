<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# M2 chemistry diagnostics

V7 is **not validated**. The eight fixed scenarios below use explicit input assumptions; matching a measured compound under one assumption does not resolve those unknowns.

No Gloess values were fitted. The original M1 calibration and held-out split are retained.

## Conditional compound comparisons

The measurement is per double extraction (published per-cup mg multiplied by two). The target column uses the planned ±25% compound band as a diagnostic for the measured M1 kinetic anchors. Estimated 3-CQA is reported without a pass/fail score.

| Scenario | Species | Measured mg | Predicted mg | Error | Within ±25% |
|---|---|---:|---:|---:|---|
| DE/fines_10_percent | caffeine | 126 | 140.5 | +11.5% | yes |
| DE/fines_10_percent | cqa3 | 34.8 | 58.58 | +68.3% | estimated; unscored |
| DE/fines_10_percent | cqa5 | 16.6 | 133.6 | +704.5% | no |
| DE/fines_30_percent | caffeine | 126 | 150.3 | +19.2% | yes |
| DE/fines_30_percent | cqa3 | 34.8 | 61.77 | +77.5% | estimated; unscored |
| DE/fines_30_percent | cqa5 | 16.6 | 140.8 | +748.3% | no |
| SE/fines_10_percent | caffeine | 110.4 | 140.2 | +27.0% | no |
| SE/fines_10_percent | cqa3 | 29.8 | 58.45 | +96.1% | estimated; unscored |
| SE/fines_10_percent | cqa5 | 14.4 | 133.3 | +825.4% | no |
| SE/fines_30_percent | caffeine | 110.4 | 150 | +35.9% | no |
| SE/fines_30_percent | cqa3 | 29.8 | 61.67 | +106.9% | estimated; unscored |
| SE/fines_30_percent | cqa5 | 14.4 | 140.6 | +876.4% | no |
| DL/fines_10_percent | caffeine | 132 | 156.2 | +18.3% | yes |
| DL/fines_10_percent | cqa3 | 49.8 | 63.84 | +28.2% | estimated; unscored |
| DL/fines_10_percent | cqa5 | 20.8 | 145.6 | +599.8% | no |
| DL/fines_30_percent | caffeine | 132 | 165.2 | +25.2% | no |
| DL/fines_30_percent | cqa3 | 49.8 | 67.76 | +36.1% | estimated; unscored |
| DL/fines_30_percent | cqa5 | 20.8 | 154.5 | +642.8% | no |
| SL/fines_10_percent | caffeine | 136 | 155.4 | +14.3% | yes |
| SL/fines_10_percent | cqa3 | 51.6 | 63.55 | +23.2% | estimated; unscored |
| SL/fines_10_percent | cqa5 | 20.6 | 144.9 | +603.4% | no |
| SL/fines_30_percent | caffeine | 136 | 164.7 | +21.1% | yes |
| SL/fines_30_percent | cqa3 | 51.6 | 67.55 | +30.9% | estimated; unscored |
| SL/fines_30_percent | cqa5 | 20.6 | 154 | +647.6% | no |

## Acidity and transport closure

pH/TA predictions are reported in the JSON alongside the measured endpoints, but are not independently scored: source alkalinity and intrinsic coffee buffering are missing. The source assay is at 20°C; the current speciation reference is 25°C.

| Scenario | Stop | Predicted / measured time, s | Raw transport closure error | Within ±5% |
|---|---|---:|---:|---|
| DE/fines_10_percent | beverage_mass | 15.8 / 28.7 | 6.15% | no |
| DE/fines_30_percent | beverage_mass | 20.8 / 28.7 | 4.44% | yes |
| SE/fines_10_percent | beverage_mass | 15.9 / 25.3 | 6.17% | no |
| SE/fines_30_percent | beverage_mass | 20.9 / 25.3 | 4.45% | yes |
| DL/fines_10_percent | beverage_mass | 38.8 / 37.2 | 2.70% | yes |
| DL/fines_30_percent | beverage_mass | 43.6 / 37.2 | 1.94% | yes |
| SL/fines_10_percent | beverage_mass | 38.8 / 35.3 | 2.72% | yes |
| SL/fines_30_percent | beverage_mass | 43.7 / 35.3 | 1.96% | yes |

Residual accounting is reported separately. Adding an unassigned-solubles residual to the named compounds is not evidence that the transport closure meets ±5%.

## Compound table and provenance

The catalogue contains 55 Appendix A species plus the legacy acid aggregate and explicit unassigned-solubles inventory. The latter two are not additional identified compounds. Registry tags describe each parameter, rather than assigning an entire compound a misleading 'measured' label.

| Compound | Phase | Kinetic class | Parameter tags | Composition evidence |
|---|---|---|---|---|
| Caffeine | dissolved | K2 | estimated, fitted, measured | existing M1 anchor; unchanged |
| Trigonelline | dissolved | K1 | estimated, measured | existing M1 anchor; unchanged |
| 5-Caffeoylquinic acid (5-CQA) | dissolved | K2 | estimated, measured | existing M1 anchor; unchanged |
| 3-Caffeoylquinic acid (3-CQA) | dissolved | K2 | estimated, measured | estimated broad composition/availability prior |
| 4-Caffeoylquinic acid (4-CQA) | dissolved | K2 | estimated, measured | estimated broad composition/availability prior |
| Feruloylquinic acids | dissolved | K2 | estimated, measured | estimated broad composition/availability prior |
| Dicaffeoylquinic acids | dissolved | K3 | estimated, measured | estimated broad composition/availability prior |
| Monoester chlorogenic acid lactones | dissolved | K1 | estimated | estimated broad composition/availability prior |
| Diester chlorogenic acid lactones | dissolved | K3 | estimated | estimated broad composition/availability prior |
| Phenylindanes | dissolved | K4 | estimated | estimated broad composition/availability prior |
| Quinic acid | dissolved | K1 | estimated, measured | estimated broad composition/availability prior |
| Citric acid | dissolved | K1 | estimated, measured | estimated broad composition/availability prior |
| Malic acid | dissolved | K1 | estimated, measured | estimated broad composition/availability prior |
| Acetic acid | dissolved | K1 | estimated, measured | estimated broad composition/availability prior |
| Formic acid | dissolved | K1 | estimated, measured | estimated broad composition/availability prior |
| Lactic acid | dissolved | K1 | estimated, measured | estimated broad composition/availability prior |
| Phosphate (phosphoric-acid equivalent) | dissolved | K2 | estimated, fitted, measured | estimated broad composition/availability prior |
| Sucrose | dissolved | K1 | estimated, measured | estimated broad composition/availability prior |
| Potassium | dissolved | K1 | estimated, fitted, measured | estimated broad composition/availability prior |
| Melanoidins: low molecular weight | dissolved | K2 | estimated | estimated broad composition/availability prior |
| Melanoidins: medium molecular weight | dissolved | K3 | estimated | estimated broad composition/availability prior |
| Melanoidins: high molecular weight | dissolved | K3 | estimated | estimated broad composition/availability prior |
| Soluble polysaccharides | dissolved | K3 | estimated | estimated broad composition/availability prior |
| Diketopiperazines | dissolved | K2 | estimated | estimated broad composition/availability prior |
| Mozambioside and roast products | dissolved | K2 | estimated | estimated broad composition/availability prior |
| Magnesium | dissolved | K3 | estimated, fitted, measured | estimated broad composition/availability prior |
| Calcium from coffee | dissolved | K3 | estimated, measured | estimated broad composition/availability prior |
| Lipid emulsion (excluding listed diterpenes) | lipid | K5 | estimated | estimated broad composition/availability prior |
| Cafestol | lipid | K5 | estimated, measured | estimated broad composition/availability prior |
| Kahweol | lipid | K5 | estimated, measured | estimated broad composition/availability prior |
| Carbon dioxide | gas | K6 | estimated, measured | estimated broad composition/availability prior |
| 2-Furfurylthiol | dissolved | K2 | estimated | estimated broad composition/availability prior |
| 3-Mercapto-3-methylbutyl formate | dissolved | K2 | estimated | estimated broad composition/availability prior |
| 3-Methyl-2-butene-1-thiol | dissolved | K2 | estimated | estimated broad composition/availability prior |
| Methanethiol | gas | K6 | estimated | estimated broad composition/availability prior |
| Methional | dissolved | K2 | estimated | estimated broad composition/availability prior |
| Acetaldehyde | dissolved | K1 | estimated | estimated broad composition/availability prior |
| Propanal | dissolved | K1 | estimated | estimated broad composition/availability prior |
| 2-Methylpropanal | gas | K6 | estimated | estimated broad composition/availability prior |
| 2-Methylbutanal | dissolved | K2 | estimated | estimated broad composition/availability prior |
| 3-Methylbutanal | dissolved | K2 | estimated | estimated broad composition/availability prior |
| 2,3-Butanedione | dissolved | K1 | estimated | estimated broad composition/availability prior |
| 2,3-Pentanedione | dissolved | K1 | estimated | estimated broad composition/availability prior |
| Furaneol (HDMF) | dissolved | K1 | estimated | estimated broad composition/availability prior |
| Homofuraneol | dissolved | K1 | estimated | estimated broad composition/availability prior |
| Sotolon | dissolved | K1 | estimated | estimated broad composition/availability prior |
| Abhexon | dissolved | K1 | estimated | estimated broad composition/availability prior |
| Guaiacol | dissolved | K2 | estimated | estimated broad composition/availability prior |
| 4-Ethylguaiacol | dissolved | K3 | estimated | estimated broad composition/availability prior |
| 4-Vinylguaiacol | dissolved | K3 | estimated | estimated broad composition/availability prior |
| Vanillin | dissolved | K2 | estimated | estimated broad composition/availability prior |
| Beta-damascenone | dissolved | K3 | estimated | estimated broad composition/availability prior |
| 2-Ethyl-3,5-dimethylpyrazine | dissolved | K2 | estimated | estimated broad composition/availability prior |
| 2,3-Diethyl-5-methylpyrazine | dissolved | K2 | estimated | estimated broad composition/availability prior |
| 3-Isobutyl-2-methoxypyrazine | dissolved | K2 | estimated | estimated broad composition/availability prior |
| Legacy organic-acids aggregate | diagnostic | K1 | measured | sum of M1 aliphatic and quinic priors; overlaps explicit acids |
| Unassigned dissolved solids | dissolved | K2 | estimated | derived nonnegative available-inventory remainder |

## Assumptions and limits

- Output volume is published; beverage mass is not. Every stop uses an explicit 1 g/mL proxy.
- Basket diameter 58 mm, height 26.5 mm and perforated diameter 54 mm are assumptions.
- Two fixed PSD hypotheses use 10% or 30% fines by volume; neither was fitted to these data.
- Each scenario has a 150 s numerical ceiling; failure to reach the mass proxy is reported.
- Boulder medians 400/600 um are proxies near the source's espresso/lungo PSD peaks, not measured medians.
- Schaerer PSDs are unreported; Dalla Corte nominal PSDs are applied to them as explicit proxies.
- A generic medium washed Arabica is used. Pt80/Pt86 have no established mapping to the model roast index.
- Source hardness is 4-6 dH; alkalinity, ionic composition and source pH are unreported. Registry water is a scenario.
- SE/SL 90 C is boiler temperature; actual extraction temperature is unreported.
- Published pH and TA were measured at 20 C; the current chemistry calculation references 25 C.
- Coffee intrinsic pH/background buffer are estimated; pH/TA agreement cannot be an independent predictive pass.
- Total solids are gravimetric residue, and esterified fatty acids are not identical to filtered TDS or total lipid.

## Exit status

- M2 runtime present in 8/8 scenarios.
- Conditional compound comparisons within ±25%: 5/16.
- Compound metadata coverage with parameter tags: complete.
- Raw dissolved transport closure within ±5%: 6/8 conditional scenarios.
- Full M2 exit: **not met** while independent V7 validation remains blocked.
- Independent V7 chemistry validation: **blocked**, not passed.
- Full per-scenario chemistry, warnings and input recipes: [m2-validation.json](m2-validation.json).

Source: Gloess et al. (2013), DOI [10.1007/s00217-013-1917-x](https://doi.org/10.1007/s00217-013-1917-x), main Table 1 and Supplement Tables 2–4. CC BY 2.0. See the dataset sidecar for the source hash, uncertainty and basis audit.
