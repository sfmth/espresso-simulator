<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# M1.1 startup investigation — 0.3.0

M1.1 improves startup timing, but **does not resolve the scientific validation failures**. The
extraction fit regresses after recalibration. This is an experimental model increment; M2 remains
deferred while the startup and extraction coupling needs further work.

The results below describe the original [0.3.0 evaluation](baseline-v0.3.0/README.md). Version 0.4.0
adds [community comparison tooling](community-shot-comparison.md) without changing the physics or fit.
Its rerun reproduces the same predictions; cached leave-one-condition-out refits remain labelled with
their original build identity.

## What changed

The front now fills the accessible intraparticle pore-water inventory, and the same water enters
liquid holdup and thermal storage exactly once. Particle extraction states represent effective soluble
loading. This single-liquid approximation does not resolve uptake into a separate immobile liquid.

A separate pore-air closure reduces early hydraulic connectivity and relaxes according to each cell's
wetting age. Its amplitude, power and mapping from a moisture diffusivity are grade-D assumptions in
[`startup.yaml`](../../data/params/startup.yaml). They were fixed before evaluating the held-out
transients. Headspace filling now integrates ramps and pump caps exactly, respects pump-off phases,
and limits drainage to retained water. Headspace filling remains sequential and vented.

The [decision record](../decisions/0010-startup-water-and-pore-air.md) states the equations, evidence
and limitations. The owner's preset records the confirmed **58 mm single-wall basket**; its detailed
geometry and the machine's pump characteristics remain estimates.

## Experimental results

The original calibration blocks, held-out split and scoring targets are unchanged. The complete v1
baseline is [preserved](baseline-v0.2.0/README.md). The [current report](m1-validation.md) and
[calibration comparison](calibration.md) include the full results, all 15 leave-one-condition-out
refits and all seven structural sensitivity refits.

| Observable | 0.2.0 / v1 | 0.3.0 / v2 | Measurement or target |
|---|---:|---:|---:|
| V4 first drops after full pressure | 1.8 s | 6.83 s | 12.76 s |
| V4 time from first drops to 90% of the 100 s flow | 6.7 s | 12.08 s | 25.48 s |
| V4 time to 36 g after the pressure rise | 22.2 s | 30.47 s | 47.69 s |
| Generic recipes, pump stop at 36 g | 10.5–13.2 s | 15.6–17.0 s | 25–35 s sanity check |
| V1 extraction rates within ±10% | 57/60 | 48/60 | 60/60 |
| V1 cup masses within ±10% | 167/180 | 163/180 | 180/180 |
| Leave-one-condition-out rates within ±15% | 59/60 | 54/60 | 60/60 |
| Leave-one-condition-out cup masses within ±15% | 179/180 | 178/180 | 180/180 |

The observed V4 rise was reported as 25.78 s in v1. Interpolating the crossing within the same recorded
curve gives 25.48 s in v2; this is a scoring correction, not a changed measurement or target. Neither
startup timing criterion passes. The 15-second overshoot check now passes, but later overshoot remains
visible in the [flow plot](m1/v4-waszkiewicz.png).

V3 peak EY reaches 22.09%, within the 22–24% magnitude target, but its maximum remains at the edge of
the grind range (setting 1.1 instead of 1.5–1.9). V2 dispersion and V5's EY/time rank correlation also
regress; the full report retains these failures. No complete M1 scientific exit criterion passes.

The generic 36 g timing is the pump-stop time. Its reported final EY and TDS include modeled post-stop
drip: the default EK43 example ends at 56.89 g, including 20.89 g of drip. Those concentration and yield
values therefore do not describe a final 36 g cup.

## Separating the new assumptions

The [reproducible ablations](m11-startup-sensitivity.json) hold every fitted v2 coefficient fixed. They
show each assumption's effect; they do not identify its value from experiment. All rows use the M1.1
core, so the combined disabled case is not a reproduction of v1.

| Fixed-v2 variant | V4 first-drop delay | V4 rise time | V4 time to 36 g | Generic EK43 pump-stop time |
|---|---:|---:|---:|---:|
| M1.1 default | 6.83 s | 12.08 s | 30.47 s | 16.06 s |
| Pore-air closure disabled | 2.21 s | 6.56 s | 22.73 s | 10.36 s |
| Half intraparticle water inventory | 5.51 s | 10.35 s | 28.22 s | 15.10 s |
| Half inventory and pore-air disabled | 1.61 s | 5.49 s | 21.22 s | 9.33 s |

Full water capacity changes extraction as well as infiltration. The worse V1 fit and early TDS mismatch
show that a longer startup alone does not establish a correct water/solute model. Total shot times also
depend on permeability and pump behavior, so these results do not assign the entire remaining error
to one mechanism.

## Numerical evidence and remaining work

Analytical and limiting-case tests cover the water inventory, capped filling ramps, pump-off periods, local wetting age,
late-flow recovery, legacy defaults and water/solute conservation. Halving the controlled test's time
step from 0.05 to 0.025 s changes first drops by 0.0063 s, shot time by 0.0118 s and EY by 0.0099
percentage point. All 117 validation simulations succeed; worst relative hydraulic carrier-volume
balance error is 1.06×10⁻¹³. This is a carrier-volume diagnostic, not an exact solvent-mass balance.
Native and WebAssembly shot fixtures agree exactly, including a noninteger pore-air exponent and the
disabled closure. Software verification and measured browser runtimes are recorded in the
[changelog](../../CHANGELOG.md).

The next model investigation needs to separate mobile water, finite-rate intraparticle uptake and
solute exchange, and assess gas displacement and simultaneous headspace/puck filling. Independent
uptake and pressure/flow evidence is needed to constrain those choices. The held-out curves should
remain diagnostic evidence rather than become tuning targets. M1's validation gates and the remaining
preview-performance target stay open.

Reproduce the complete calibration and validation with `python/scripts/m1-pipeline.sh 8` (writes v2).
Reproduce only these fixed-fit ablations with
`.venv/bin/python python/scripts/m11-startup-sensitivity.py`.
