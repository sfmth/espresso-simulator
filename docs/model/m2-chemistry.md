<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# M2 chemistry, beans and water

Version 0.6.0 starts M2 development, selected by the owner on 2026-10-17
after reviewing the novel-shot diagnostic. Remaining M1 scientific
criteria stay documented and unchanged; they do not prevent M2 development.

## Inventory and transport

`data/chemistry/species.json` covers the 55 Appendix A compounds plus the
overlapping legacy `acids` diagnostic and `unassigned_solubles`. Each entry
identifies its family, K1–K6 class, phase, composition/transport evidence
and registry references. The M1 measured analytes and their inputs/order
remain intact. New dissolved compounds share class transport bases.
K5 oil and K6 gas/flash volatiles use separate source inventories and
estimated cup-recovery fractions. The lipid-emulsion inventory excludes
the separately listed cafestol and kahweol inventories: their estimated
Arabica allocation is 16.2% + 0.4% + 0.4% of dry dose. Each contributes
once to the phase inventory sum. The texture output uses residual lipid
emulsion alone, rather than claiming a measured total-lipid recovery.

Named inventories are never rescaled to match TDS. The initial unresolved
stock is the nonnegative extractable budget minus named dissolved stocks,
and follows lumped-solids transport. Overlarge named inventories remain
visible. The result distinguishes two accounts:

- `relative_transport_closure_error` compares independently transported
  named plus unresolved solids with lumped solids: this is the roadmap's
  5% diagnostic.
- `unassigned_solubles_kg` is an accounting remainder derived from lumped
  minus quantified named cup solids. Its identity is not validation.

Gas, lipid emulsion, overlapping diagnostic acids and source-water minerals
are excluded from coffee TDS. Cup chemistry does not change hydraulic
flow, lumped coffee EY or shot stopping rules.

## Beans

Altitude and variety group are recorded without a universal roasted-bean
composition correction. Storage changes estimated odorant inventories
through broad-prior loss scenarios. Anaerobic processing changes an
estimated acetic-acid inventory through an explicit grade-D scenario;
the process label does not identify a fermentation history. Neither
effect replaces the measured caffeine, trigonelline or 5-CQA anchors.
Three new generic descriptor presets are scenarios, not measured lots.

## Water and acidity

Alkalinity and hardness are distinct source-water inputs in mg/L as
CaCO3. Calcium, magnesium, mineral TDS and source pH are also accepted.
Defaults are illustrative, not a mandatory brewing specification.
Hardness does not impose an unsupported extraction multiplier.

The ideal dilute-solution acid/base calculation is at 25 C. Polyprotic
acids use complete dissociation-state weights. Carbonate is inferred
from alkalinity and pH with two equivalents per mole of CaCO3. Constants
follow the [USGS advanced carbonate speciation method](https://water.usgs.gov/water-resources/memos/memo.php?id=2098).
Compound-registry entries identify primary pKa measurements and transfers.

Unknown coffee counterions and macromolecular buffers are closed by an
estimated intrinsic reference pH and unresolved monoprotic buffer.
Absolute pH is therefore an effective estimate, not an independent
composition-to-pH prediction. Titratable acidity is calculated base demand
to pH 6.6 and 8.0. Absent beverage and missing roots are explicit states.
Mineral TDS is a supplied total; calcium and magnesium are not added again.

## Aroma, phases and observations

Available free aroma partitions between liquid and a specified closed
headspace through a dimensionless air/water concentration ratio.
First-order effective thiol binding transfers mass to a reported bound
pool. Liquid, gas and bound masses are conserved. Open-cup evaporation
and sensory intensity are not predicted; odor activity is a threshold ratio.

Oil and CO2 cup masses use explicit recovery priors. Captured CO2 mass
is converted to a gas volume and divided by an assumed foam gas fraction.
This crema-volume proxy does not predict foam lifetime or bubble size.

The refractometer output separates physical coffee TDS, source-water
mineral contribution and an illustrative coffee-equivalent optical reading.
Optional mineral-blank subtraction removes the mineral response only.
Sample/reference temperatures describe a cooled measurement, not brewing.
Residual temperature response is in K^-1; zero means ideal compensation.
The observation factors are not a manufacturer calibration.

## API and verification

Optional recipe blocks are `water` and `chemistry`. Chemistry is enabled
by default; `chemistry.enabled: false` restores four M1 passengers and
disables cup postprocessing. Observation settings are `aroma_age_s`,
`cup_headspace_ml`, `sample_temperature_c` and `mineral_blank_subtracted`.
Built output adds `derived.compounds` and resolved bean descriptors.
Optional raw `ShotSpec.chemistry` defaults to null, retaining old raw-spec
physics; `ShotResult.chemistry` carries additive cup outputs.

Physical parameters enter through the registry-backed builder. Native
and WebAssembly use the same deterministic math. Checks cover independent
speciation, buffering direction, phase/aroma mass accounts, mineral blanks,
temperature residuals, descriptor validation and recipe round trips.

`puckworks-tools m2-validate` writes the [M2 report](../validation/m2-validation.md).
The Gloess subset comes from original publisher tables with attribution.
Volume-to-mass conversion, PSD, alkalinity and roast assumptions are
explicit; conditional agreement is not an independent V7 pass.
The pre-M2 report is preserved in [baseline-v0.5.0](../validation/baseline-v0.5.0/README.md).
M1 case builders explicitly disable M2, preserving their calibration
boundary; M2 builders explicitly enable it. Fitted values stay unchanged.
Admissibility ranges for the three pre-existing mineral diffusivities
are bounded to the solver's supported positive interval; their defaults,
priors and measurement sources are unchanged.

The production-browser smoke test checks native/WASM equality, same-origin
requests, console errors and mobile overflow. One local run took 2.23 s
for the default Tier-1 shot and 36.3 ms for a warm Tier-0 shot. These are
environment-specific observations; the roadmap's 1 s / 10 ms performance
targets remain unmet for this M2 configuration.
