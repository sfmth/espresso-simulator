<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# M3 bounded input uncertainty contract

M3 propagates selected uncertainty in grinder/particle-size distribution (PSD), roast age,
compound inventories and water through a reproducible **Tier 0 scenario ensemble**. It keeps the
normal central simulation at the recipe's requested tier. The displayed 5th/50th/95th percentiles
are empirical scenario percentiles, **not calibrated confidence intervals**. There is no claim
that 90% of real shots lie in the band. Unknown model discrepancy, Tier 0 discretization error,
taste-coefficient error and sensory-threshold error are outside these bands.

## Shared additive API

- Rust JSON: `api::simulate_uncertainty_json(recipe_json, options_json)`.
- Browser/WASM: `simulateUncertainty(recipeJson, optionsJson)`; both arguments and the result are JSON strings.
- Python: `puckcore.simulate_uncertainty(recipe, options=None)`; arguments accept dictionaries or JSON strings; the result is a dictionary.
- Normal `simulateRecipe` / `simulate_recipe` now also returns `taste` alongside the existing
  `build` and `result` fields. `estimateTaste(recipeJson, resultJson, conditionsJson)` /
  `estimate_taste(recipe, result, conditions=None)` reuses an existing result without simulating
  it again. `analyzeTaste(recipeJson, conditionsJson)` / `analyze_taste(recipe, conditions=None)`
  builds and simulates a standalone recipe. Taste assumptions are in [m3-taste.md](m3-taste.md).

Example uncertainty options:

```json
{
  "samples": 16,
  "seed": 1729,
  "groups": {
    "grinder_psd": "unknown",
    "roast_age": "measured",
    "composition": "unknown",
    "water": "fixed"
  },
  "taste_conditions": {"serving_temperature_c": 60, "dilution_water_g": 0}
}
```

`samples` is an integer 8–64, default 16. `seed` is an unsigned 32-bit integer, default 1729.
Unknown fields, invalid knowledge states, invalid taste conditions and invalid recipes fail
explicitly. Groups default to `unknown`, except a supplied custom PSD defaults to `measured`.
A numerical value typed into a recipe is not automatically evidence of a measurement: the
caller selects the knowledge state. `fixed` removes input variation in that group, while all
other groups can continue varying. A fixed input is not a claim of physical certainty.

## Scenario supports and correlations

Every support width is a grade-D, estimated registry parameter in
`data/params/uncertainty.yaml`. The endpoint is a modelling judgement, not an empirical error
bar or a fit to the held-out datasets. Registry-source links and support definitions remain
visible through the regular registry API. Widths can be overridden using the normal recipe
`overrides` map, including zero width.

| Input variation | Unknown half-width | Measured half-width | Shared latent variable |
| --- | ---: | ---: | --- |
| PSD diameter scale | 25% | 3% | One scale for all original bins |
| PSD fines-bin reweighting | 35% | 8% | One factor for original bins with diameter ≤100 µm |
| Roast age | max(7 days, 50% of age) | 1 day | One age draw |
| Dry-bean compound inventory | 35% | 8% | One common scale for non-fixed composition source parameters |
| Water minerals, hardness, alkalinity, TDS | 50% | 5% | One common concentration factor |
| Source-water pH | 0.5 pH unit | 0.1 pH unit | Independent of mineral factor |

Latent variables are bounded uniform draws. Draws of different groups are independent; the
within-group correlations above are explicit assumptions. The factors are uniform on the
intersection of the illustrative support and all admissible source bounds. Support truncation
can make a distribution asymmetric around the central value. Draws are not clipped against
limits, so boundaries do not accumulate artificial point masses. Zero inventory stays zero.
Fines weights are normalized by the regular measured-PSD builder. PSD bin edges and method
remain those supplied by the user when a custom distribution exists; otherwise the resolved
model size classes supply the bins. This does not substitute a different grinder preset.

Composition scales the `bean.composition.*`, `model.bean.trigonelline.*`, and
`chemistry.composition.*.{arabica,robusta}` inventory source parameters together. It does not
randomize pure-chemical constants, roast coefficients, extraction rate constants, unknown
aroma thresholds or the independent lumped-solubles yield. The normal M2 unresolved inventory
and closure diagnostics remain visible. This is partial input propagation, not a complete
joint prior over bean chemistry. Roast degree, blend fraction, extraction model structure,
preparation heterogeneity and hardware calibration remain at the central recipe values.

Existing explicit source-registry overrides remain fixed. In particular, a PSD source override
holds the whole resolved PSD fixed and adds a note. A fixed water-source override is excluded
from the shared concentration factor; ratios among the remaining varying fields are
preserved. An explicit recipe value still has the builder's normal precedence over a registry
override. Water variation preserves the baseline ratios; it does not infer missing ionic
measurements or repair an inconsistent water recipe.

A resolved model PSD can include representative bins outside the more restricted
measured-PSD input interval. Such a distribution remains valid for the central solver, but
M3 holds PSD variation fixed and reports `unsupported.grinder_psd` instead of projecting it
to a different distribution. Other groups still vary. Chemistry disabled by the recipe is
reported under `unsupported.chemistry`, with no invented chemistry or taste bands.

## Output document

The `puckworks.uncertainty/1` document contains:

- `seed`, `samples_requested`, `samples_completed`, `ensemble_tier: 0`,
  `band_kind: "scenario_percentiles_not_confidence_interval"`, resolved `groups`.
- `baseline_preview`: `{summary, chemistry, taste}` for the unchanged central inputs at Tier 0.
  This is distinct from the independent central Tier 1 shot and allows a visible fidelity check.
- `bands`: JSON-pointer paths to `{p05,p50,p95,min,max,n}`. Numeric leaves in summary,
  chemistry, diagnostics, derived builder output and taste are aggregated. Examples:
  `/summary/ey`, `/summary/tds`, `/summary/species/caffeine/mass_kg`,
  `/chemistry/acidity/ph`, `/chemistry/aroma/furfurylthiol/odor_activity_ratio`,
  `/derived/psd/x50_um`, `/taste/bitterness_index`.
  Arrays whose members have `id` fields use those stable IDs in paths instead of array
  indices; JSON-pointer escaping applies to IDs. Other numeric arrays use their indices.
- `series`: `{progress, time_basis, bands}`. The 21 common progress points span 0–1.
  `time_basis` is `fraction_of_recorded_duration_including_drip`. Each trajectory is linearly
  interpolated on that member's own recorded duration, including post-stop drip. Bands
  for `t_s` convey timing variation. The pressure band at progress 0.5 compares halfway
  through each run; it is **not** a pressure band at one shared physical time. All regular
  numeric series are included; species curves are keyed `species_cup_kg/<id>`.
- `sample_results`: compact `{summary, chemistry, taste}` objects for successful members.
  Large raw spatial fields and trajectories are not duplicated in this array.
- `sample_inputs`: one record per attempted draw containing `sample_index`, `psd_scale`,
  `psd_fines_factor`, `days_off_roast`, `composition_factor`, `water_factor`, `water_ph`,
  and fully resolved sampled `water` measurements where chemistry is enabled.
- `sample_failures`: attempted index and readable error, without replacement draws.
  `warning_counts` reports solver and chemistry warnings from successful members.
- `registry_refs`, `notes`, `unsupported`: visible provenance and limitations. Spatial
  depth, column topology, particle-class and snapshot quantities have an explicit unsupported
  flag because their coordinates change with a draw. The independent central spatial result
  remains available.

Percentiles use linear interpolation at rank `q*(n-1)` after sorting finite values. A nullable
quantity such as pH or first-drop time may have `n < samples_completed`. An absent band means
no finite member supplied that quantity; missing data are not replaced with zero. A failed
member is recorded and not replaced. If any members fail, notes state that bands condition on
successful members; failure rates must remain visible. If every member fails, the API returns
an error naming the first failure. Time and spatial bands must not be described as complete
uncertainty on all physical fields.

## Reproducibility and verification

The implementation uses the specified 32-bit LCG `x = 1664525*x + 1013904223 (mod 2^32)`;
a signed uniform variate is `2*(x+0.5)/2^32-1`. Every sample consumes six fixed slots in PSD,
fines, age, composition, mineral and pH order, even when a group is fixed. Changing a knowledge
state therefore preserves paired draws in other groups. No platform RNG or mutable global
state is used. Recipe and overrides are cloned and never modified in place.

`crates/puckmodel/tests/m3_uncertainty.rs` checks exact seeded replay, all-fixed collapse,
unknown/measured support widths, custom PSD retention, authoritative source overrides,
chemistry-disabled missing values, water ratio preservation at admissible bounds, output
families and option validation. The separate M3 validation report evaluates disclosure and
reproducibility; it does not establish calibrated interval coverage or taste accuracy.
