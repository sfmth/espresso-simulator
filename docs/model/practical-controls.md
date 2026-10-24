# Practical equipment and coffee controls

Version 0.13.0, 2026-10-23. This update follows the equipment-setup workflow;
users first describe or infer their setup and then adjust future shots in Dial in.
It adds usable observations and inputs without claiming that a fitted setup is
uniquely identified or that the model has new real-shot validation.

## Contextual help and ordinary controls

A question-mark button sits beside shared fields, the illustrated quick controls,
setup measurements, and output metrics. Help explains meaning, physical effect
(or recorded-only status), and a way to obtain the value. Tools are suggested only
where they can measure the relevant quantity. Detailed coefficient help retains
registry descriptions and links to parameter sources. Output help distinguishes
calculated diagnostics, laboratory assays and optional household measurements.

Standalone help opens a labelled nonmodal dialog that supports Escape and returns
focus to its trigger. Shared field help expands below the field. Buttons stay
outside input labels so the accessible input name remains stable. Calculation
notes, preset assumptions and numerical diagnostics are expandable. Error messages
and invalid measurements remain visible. Main controls use Standard/Fast preview
and practical labels rather than developer milestones.

The setup checklist prioritizes coffee identity/roast information, dry dose, final
cup weight, elapsed time with its start convention, grinder number, basket and
preparation. TDS, actual inlet-water temperature and water chemistry are optional.
A machine display value is a recorded fact separate from inlet temperature;
choosing boiler or thermoblock does not introduce heater-recovery or PID physics.

## Grinder numbers and calibration

`grinder.setting_ref` is an optional finite reference number. Effective gap is:

```
gap_um = gap_at_ref_um + gap_per_unit_um * (setting - reference)
reference = setting_ref ?? preset.dial.ref ?? 0
```

The sensitivity is signed and nonzero. Increasing numbers can mean coarser or
finer. The reference permits arbitrary offsets and negative numbers. Omitting the
new field retains exactly the previous numerical path. An explicit `gap_um`
continues to override dial mapping, and a supplied PSD bypasses the gap-to-PSD model.
Native mapped gaps retain their existing plausibility checks/clamping.

**Use my grinder numbers** anchors the current effective fineness at the number
the user actually sees. Direction and an explicitly provisional sensitivity form
a starting conversion; they are not measured burr geometry. **Estimate from my
shots** fixes the number/reference and exposes reference fineness and sensitivity
as bounded unknowns. A calibration replacement updates its related locks and
Undo restores both the conversion and previous knowledge. Later setup edits
invalidate that recovery action. Record several shots at different numbers with their known
changes to constrain the conversion. Burr family, puck permeability and fineness
can remain confounded; a one-shot match cannot prove the physical gap or slope.
Advanced two-anchor entry accepts either scale direction and validates distinct
numbers, nonzero sensitivity and native gap limits.

Mechanical axial movement per click is not particle size or automatically effective
grinding gap. For example [1Zpresso publishes K-Ultra click travel](https://1zpresso.coffee/k-ultra/)
and a [zero-reference procedure](https://1zpresso.coffee/jp/calibration/), while
[Baratza explains stepped/stepless adjustment](https://www.baratza.com/en-us/blog/product-guides/stepped-vs-stepless).
An ordinary caliper is not an operating burr-gap instrument.

## Published coffee facts and model estimates

`bean.coffee` stores optional identity, roaster, country, region, producer,
varieties, original processing/roast labels, roast date/harvest, source URL,
verification date and model-roast basis. A roast-color record has:

- the original numeric reading, including readings above 100;
- scale: Agtron Gourmet, Agtron Commercial, Colorette, CIELAB L* or other;
- sample: ground, whole-bean or unspecified;
- optional instrument name.

All metadata is validated and round-tripped, but does not alter physics. A named
roast choice maps explicitly to an estimated existing model roast index. The
technical index remains editable for sourced studies and existing files. An explicit
age calculator uses the bag’s roast date and a chosen shot date; it never advances
saved historical ages automatically. There
is no universal conversion between these color scales or fixed whole/ground
reading offset. Published color does not establish composition, porosity or gas
inventory. [Onyx’s roast information](https://onyxcoffeelab.com/pages/find-my-roast)
and [SCA’s discussion of color](https://sca.coffee/sca-news/25/issue-21/what-color-is-your-coffee-37lk7)
explain why scale and sample matter. A lot’s actual color fact is retained even
when the model’s approximate roast assumption is broad.

The ordinary species choices are Arabica or Canephora/Robusta. Exact variety and
processing names remain available even when the physical model has no matching
category. Unsupported descriptors stay recorded-only; altitude is not a universal
chemistry correction. Older native mixed templates remain importable for compatibility.

## US catalogue

The first curated catalogue has 13 single-origin entries from Counter Culture,
Onyx, Verve, Intelligentsia, Black & White, George Howell, Klatch and PT’s. Each
entry has a direct roaster/merchant URL and verification date, 2026-10-23. Facts,
availability status and assumptions are separate. Estimated roast mappings and
altitude midpoints are identified; a published range and original description
remain in the catalogue. No tasting prose, photographs or product-page text is
reproduced. The factual-data method and rights/scope limitations are in
[`catalog.metadata.json`](../../web/src/coffee/catalog.metadata.json).

This is a reviewed starter catalogue, not every US coffee or a live inventory.
Seasonal lots, harvests and product URLs change. The user can edit bag facts and
add any custom single origin. No remote catalogue or shop request happens until
the user opens a source link. The catalogue works offline with the app.

## Custom mixtures in the shared native engine

`bean.components` contains one to six `{weight, bean}` leaves. Weights are finite
positive relative dry masses, normalized by their sum; `70/30` and `7/3` are the
same mixture. Nested mixtures and conflicting top-level physical descriptors are
rejected. Top-level descriptive coffee metadata is allowed. Each leaf may use any
legacy single-coffee descriptors or template and its own source metadata.

Each leaf is resolved and modeled first, including its roast/age/storage-dependent
composition, gas and phase contents. Then the native builder combines:

- species and separate-phase inventories and remaining/roast CO₂ by dry mass;
- solid density by summed solid volume: `rho = 1 / sum(w_i / rho_i)`;
- intraparticle porosity from summed particle and solid volumes;
- species transport properties and phase transfer using their inventory weights;
- gas resistance by reapplying the existing nonlinear gas closure to combined CO₂.

The aggregate roast, species share and bean temperature are dry-mass weighted for
the existing grinder/thermal interfaces. The downstream puck is a homogeneous
mixture: it does not track distinct origin particles, grind each origin separately,
or predict spatial segregation. A one-leaf mixture is exactly the same native
specification as that leaf. Legacy recipes use the unchanged original path.

Setup inference exposes component-prefixed leaf parameters and relative amounts,
while suppressing incompatible top-level physical descriptors. Metadata is
recorded-only. Component structure is edited deliberately in the coffee UI; the
solver does not invent new coffees or nested blends. When coffees are replaced,
removed or moved into/out of a mixture, their locks follow retained coffees rather
than positional row numbers. One Undo restores both coffee settings and knowledge.
These structural actions apply consistently in Lab and Setup. Historical observations
are immutable. If per-coffee shot changes refer to an older component count,
ordering or identity, inference stops with a review message before simulation;
old indexed values cannot silently overwrite a different coffee.

## Measurement suggestions

`web/src/help/instruments.ts` holds checked US price snapshots and limitations:
a 0.1 g coffee scale, existing phone/scale stopwatch, optional contact thermometer,
GH/KH drop tests, optional caliper and coffee-specific refractometer. Start with
existing equipment and the bag/manufacturer/water report. These are inexpensive
examples with documented specifications, not a guarantee of the absolute lowest
price or independent laboratory verification of every unit.

A water conductivity/TDS pen does not measure coffee TDS, separate ions or GH/KH.
Probe temperature in a collected cup does not establish temperature at the puck.
Scale increments are not accuracy; manual timing includes reaction uncertainty.
A refractometer is optional and requires the maker’s espresso sampling procedure.
Prices are dated, before tax/shipping, and links do not imply current availability.

## Compatibility and validation

The exact replay receipt records unchanged 0.12.0 golden/M3 scientific values and
all 464 frozen native cases under 0.13.0. Source and behavior identities reflect
actual new inputs; frozen scalar weights, coordinates, split roles, errors and
failed qualification remain unchanged. No surrogate was retrained to mask a change.
See [the receipt](../validation/practical-controls-version-replay.json).

Focused tests cover component mass/volume/phase invariants, nonlinear aging before
mixing, metadata isolation, signed/shifted grinder scales, form/import boundaries,
component-aware locks and observed-shot replay. Browser checks exercise the actual
WASM catalogue/blend/calibration/help workflows, keyboard operation and responsive
layout. These are software regression checks, not evidence of new real-shot,
physical color-to-composition or sensory accuracy.
