<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# V1 fixed-parameter timestep check

All 15 Schmieder conditions use the final v5 main/prune coefficients. The maximum timestep changes from 0.05 to 0.025 s; output intervals, physical inputs and fitted/fixed values stay the same. No refit or held-out case enters this check.

| Maximum step | Completed | λ within ±10% | Eq.3 cups within ±10% | V1 cost |
|---|---:|---:|---:|---:|
| 0.05 s | 15/15 | 51/60 | 174/180 | 478.519789 |
| 0.025 s | 15/15 | 51/60 | 174/180 | 480.116759 |

| Observable | Compared | Largest absolute relative change | Worst condition/analyte |
|---|---:|---:|---|
| lambda | 60/60 | 0.389883% | exp13, caffeine |
| c0 | 60/60 | 0.302899% | exp13, caffeine |
| cup_eq3 | 180/180 | 0.143571% | exp13, caffeine, 20 g cup |
| cup_direct | 180/180 | 0.12865% | exp14, cqa5, 20 g cup |
| peak_pressure_bar | 15/15 | 0% | exp01 |
| pour_peak_pressure_bar | 15/15 | 0.361923% | exp02 |
| switch_s | 15/15 | 0.0202106% | exp15 |
| beverage_g | 15/15 | 0.000540969% | exp14 |

Both runs: maximum soluble-mass balance residual 3.18883e-14; maximum hydraulic carrier-volume residual 6.39444e-14; minimum concentration 0 kg/m³.

Local timestep sensitivity at one unchanged output interval; this does not establish an asymptotic convergence order or independent physical validity.

Source artifact SHA256: `80c84114eaa1b1ecb9092f35c2a5ecf67fa6e80c748d2ee20f9585b855199e3d`. Checkpoint SHA256: `e014995a0d89108a8f5300f92e8c59a9ec1959889b43c60002115df5981c89b6`. The companion JSON preserves every λ/c0/cup/pressure/timing comparison, values, solver/input identities and per-condition summary/diagnostics without duplicating full input specs.
