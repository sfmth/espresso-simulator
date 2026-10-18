# M3: explainable taste potential, with low trust

M3 adds four **relative heuristic indices**: acidity, bitterness, astringency and
body. They compare the model's chemical outputs under a stated set of assumptions.
They are not measured sensory intensities, probabilities, quality scores or a
prediction of whether someone will enjoy a shot. The numerical scales of different
attributes cannot be compared or added. A bitterness index of 60 does not mean
60% bitter, nor is it necessarily more intense than an acidity index of 40.

The implementation is `crates/puckmodel/src/taste.rs`. Native Python and browser
Wasm use the same function. Nothing in this step fits a sensory curve, changes
the physical shot, reassigns compound mass or consumes the held-out validation
data. All numerical reference scales and weights live in `data/params/taste.yaml`
as **estimated, evidence grade D**, with normal registry override support.

## Inputs and response

The Rust entry point is
`taste::estimate(&Recipe, &Built, &ShotResult, &TasteConditions)`.
`TasteConditions` accepts `serving_temperature_c` (optional, 0–100 °C) and
`dilution_water_g` (0–500 g, default 0). Unknown fields and nonfinite or
out-of-range values are rejected.

The JSON response schema is `puckworks.taste/1`, with nullable top-level
`acidity_index`, `bitterness_index`, `astringency_index` and `body_index`.
`attributes` carries each index's drivers, raw values and units, registry/source
references, trust label and assumptions. `sources` explains which claim each
primary source supports. Driver `contribution` values are dimensionless terms
**before compression**, not shares of perceived taste or points on the index.

`conditions` includes original/final beverage mass, serving temperature, chemistry
reference temperature and the M2 aroma-age context. `score_semantics` states the
interpretation in every response. All attributes have low trust; the astringency
correlate has very low trust.

Unavailable results use null, not a fabricated zero:

| Status | Meaning |
| --- | --- |
| `estimated` | Required M2 inventories are present; the indices remain unvalidated. |
| `no_cup` | No beverage was recovered, even if dilution water was requested. |
| `chemistry_disabled` | No M2 chemistry result exists. |
| `incomplete_chemistry` | Required named inventories or the chemistry spec are missing. |

If M2 has no acid/base balance root, the acidity index alone is null. Missing
inventories are not treated as absent compounds. Measured zero inventories are
valid and remain zero. Invalid nonfinite or negative mass/concentration inputs
produce an API error.

## Equations and conventions

Each attribute has a nonnegative latent value `x`, displayed as
`index = 100*x/(1+x)`. This bounded transformation is a presentation convention,
not a psychophysical dose-response law. The reference values below are arbitrary
normalizations, not detection thresholds or fitted panel ratings.

Concentrations use M2's approximate beverage-volume convention:
`volume_L = beverage_mass_kg / water_density_kg_m3 * 1000`.
Thus the default 1000 kg/m³ density gives g/L concentrations numerically equal
to mg/g of beverage. Density, emulsion and dissolved-solids volume effects are
not an independently validated cup-volume model.

| Attribute | Latent value `x` at the default coefficients |
| --- | --- |
| Acidity potential | TA to pH 6.6 in mmol/L divided by 20 |
| Bitterness potential | mono/di-lactones in g/L divided by 0.5 + phenylindanes in g/L divided by 0.1 + 0.2 × caffeine in g/L divided by 3 |
| Astringency correlate | combined 3-/4-/5-CQA, FQA and diCQA concentration in g/L divided by 4 |
| Body / texture potential | 0.7 × true coffee TDS fraction divided by 0.08 + 0.2 × soluble polymer concentration in g/L divided by 12 + 0.1 × lipid concentration in g/L divided by 1.5 |

Acidity uses titratable acidity rather than a pH-only or EY-only rule. This is
acid-load potential: acid identity, buffer composition and masking affect the
actual sourness. CGA and the estimated unresolved buffer contribute to M2 TA
without necessarily sharing organic acids' sensory effect. Source-water
alkalinity already affects M2 TA and is not applied a second time.

The bitter-family labels distinguish the modeled compound groups: lactones,
harsh/lingering phenylindanes and matrix-dependent caffeine. The index does not
predict which bitterness type a person will perceive. Its caffeine weight is
not a 20% contribution claim. No universal correction for melanoidin binding or
other mixture interactions is inferred. DKPs, mozambioside products and further
bitter compounds are omitted until their relevant mixture contributions are
better constrained.

The astringency quantity is explicitly a **correlate**. CGAs' correlation with
astringency does not establish that they cause it. Salivary chemistry, oral
friction, sip sequence, suspended particles and individual responses remain
unmodelled.

Body uses true coffee TDS, excluding source-water minerals and optical/ATC bias.
The polymer term includes polysaccharides and the three melanoidin fractions.
Those compounds already occur in TDS: this is a declared composition reweighting,
not an addition of separate masses. The lipid term uses M2's phase-recovery
estimate. Neither the score nor the individual terms represent viscosity,
creaminess, droplet size, suspended fines or foam lifetime.

## Cup conditions and uncertainty

Dilution means neutral water added after the shot. Concentrations and TA are
scaled by `original_beverage_mass/final_beverage_mass`; physical extraction,
compound amounts and EY are unchanged. The added water's carbonate chemistry,
pH respeciation, density/volume nonadditivity and aroma partitioning are not
recomputed. The response states this approximation when dilution is used.

Serving temperature is recorded, with `serving_temperature_modelled: false`.
M2 acid/base chemistry remains at its declared reference temperature, normally
25 °C. The refractometer sample temperature is a measurement condition and is
not silently interpreted as serving temperature. No unsupported hot-cup taste
correction is applied. Aroma age is displayed as inherited context; M3 does
not turn OAV or post-shot binding into an aroma or sweetness score.

Selected input scenarios can propagate through these indices in the M3
uncertainty engine. The resulting bands are conditional scenario spreads,
not validated sensory prediction intervals. Unless explicitly varied, the
arbitrary taste coefficients stay fixed. Missing mechanisms, coffee-matrix
thresholds, compound grouping errors, individual differences and model discrepancy
remain outside these bands. A narrow band cannot raise the taste trust label.

## Evidence and its limits

The scientific literature motivates the directions and caveats, **not the
numerical equations above**. Primary sources checked for this implementation:

- [Gloess et al. (2013), *Comparison of nine common coffee extraction methods*](https://doi.org/10.1007/s00217-013-1917-x)
  measured chemistry and descriptive sensory attributes for espresso and lungo
  methods. Total solids correlated with body; caffeine/CGA concentrations
  correlated with bitterness and astringency. The article itself cautions that
  the compounds causing astringency may differ from CGAs. These are constrained
  experimental correlations, not a transferable universal espresso map.
- [Frank, Zehentbauer and Hofmann (2006), *Bioresponse-guided decomposition of roast coffee beverage*](https://doi.org/10.1007/s00217-005-0143-6)
  identified bitter chlorogenic-acid lactones using sensory-guided work.
  This supports a distinct lactone driver; it does not supply one common
  concentration-to-intensity law for the lumped M2 group.
- [Frank et al. (2007), *Sensory analysis of bitter 4-vinylcatechol oligomers*](https://doi.org/10.1021/jf0632280)
  identified bitter phenylindanes and related oligomers. Their individual
  potencies cannot be transferred to one pooled inventory without uncertainty.
- [Gigl, Kreissl and Frank (2026), *Impact of Interactions between Melanoidins and Caffeine on the Bitter Taste of Coffee Beverages*](https://doi.org/10.1021/acs.jafc.5c17022)
  used spectroscopy and sensory experiments to demonstrate matrix-dependent
  suppression of caffeine bitterness by high-molecular-weight coffee fractions.
  The tested matrices and room-temperature conditions do not establish a
  universal espresso correction or a fixed caffeine share.

The research starting point remains
[`02-chemistry-and-sensory.md`, §6](../research/02-chemistry-and-sensory.md).
The 2026 caffeine/melanoidin work adds a reason to avoid treating water thresholds
as direct sensory intensity predictions. Sweetness and specific aroma notes
remain deferred because the available inputs do not support credible values.

## Verification and remaining work

Tests cover unavailable states, invalid conditions, concentration rather than
per-cup-dose dependence, dilution directions, water-alkalinity direction and
registry override behavior. These are software/mechanistic checks, not empirical
sensory validation. Remaining accuracy work includes measured lot composition,
compound-specific matrix potency, hot-cup chemistry/perception, oral texture,
individual preference learning and a prospective espresso sensory dataset with
hold-out evaluation. No past validation data are fitted in this milestone.
