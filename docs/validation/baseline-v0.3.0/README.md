<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# Preserved M1.1 validation — 0.3.0

These preserve the 0.3.0 validation report, numerical report and figures before the 0.4.0 tooling release. Only three relative documentation links in the Markdown were adjusted for this folder; numerical content and figures are unchanged. The fit remains `data/calibration/v2.yaml` (also `current.yaml`); no parameters were refitted for 0.4.0.

The [current report](../m1-validation.md) reruns the same physical cases and obtains identical fit-quality and held-out predictions. Its conservative build-identity check marks cached leave-one-condition-out refits as historical because the package version and Cargo lockfile changed. Their 0.3.0 result—54/60 rates and 178/180 cup masses within ±15%—remains available in this [original report](m1-validation.md), not advertised as newly rerun refits.

The new community comparisons are exploratory diagnostics; they neither enter the fitted dataset set nor replace any original acceptance criterion.
