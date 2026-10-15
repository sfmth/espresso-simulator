# 0006: Parameter registry

- **Status:** Accepted
- **Date:** 2026-10-14

## Context

Design principle 3 ([PLAN.md §1.2](../PLAN.md#12-design-principles)) requires every physical number to carry its provenance. The research notes give values of very different quality: measured, fitted, derived or estimated, and graded A to D. Their conditions and caveats matter, and the M1 physics will use them as priors and calibration targets ([§7.3](../PLAN.md#73-modules), modules R and U).

## Decision

**Where the parameters live.** One YAML file per domain in `data/params/`, each with the header `schema: puckworks.parameters/1`. The M0 files are `bed`, `hydraulics`, `extraction`, `kinetics`, `psd`, `co2`, `composition` and `shot`.

**What a record holds.** Each record is validated against `data/schema/parameter.schema.json` (JSON Schema 2020-12).

| field | content |
|---|---|
| `id` | dotted id |
| `name`, `symbol`, `description` | human-readable identification |
| `units` | from the vocabulary in `data/schema/units.yaml`: 31 units with SI dimension exponents and scale factors |
| `value` and/or `prior` | fixed, uniform, normal, lognormal or triangular |
| `range` | the valid range |
| `conditions` | measurement conditions |
| `tag` | measured / derived / estimated / fitted |
| `evidence_grade` | A–D, as defined in the research notes |
| `sources` | citations with DOIs |
| `research_note_ref` | e.g. `01 §4.3` |
| `used_by` | PLAN §7.3 module letters |
| `status` | draft / accepted |
| `licence_note`, `comment` | optional |

**Validation.** `puckworks-tools validate-registry` checks the registry in CI:
- schema validity;
- unique ids;
- known units;
- values inside their ranges and priors consistent with them;
- DOI syntax;
- note references that resolve to an existing note heading.

**Combined grades.** When a note gives a combined grade such as "A/B", the record takes the weaker one.

**Datasets.** They live in `data/datasets/<id>/`, each with a sidecar validated against `data/schema/dataset.schema.json`. The sidecar records licence, redistribution terms and digitisation method ([ADR 0007](0007-licensing-and-dependency-policy.md), PLAN §11).

**Code reads the registry.** From M1, physics code takes parameters from the registry (compiled to JSON for the web app), not from bare literals.

## Consequences

- **M0 contents:** 143 records, all `draft`. Tags: 56 measured, 37 fitted, 28 estimated, 22 derived. Grades: 49 A, 42 B, 45 C, 7 D. One dataset (Schmieder 2023 centre point, CC BY 4.0).
- **Linked quantities.** Derived records must carry a `relation` field: `derived_from` ids plus a formula. The validator checks those ids. This makes linked quantities explicit, so M1 sampling can keep them consistent: total porosity from bulk and skeletal density, axial dispersion from the Bodenstein number, initial pore concentration from soluble fraction and porosity.
- **Grade policy.** A record takes the note's grade, or the weaker one if the note gives a combined grade. A derived record takes the weakest grade among its inputs.
- **Priors.** They cover every value the notes cite. A parameter fitted on only one or two grinders is widened by a stated factor (√2 each side), because no data constrain the spread between grinders.
- **Errors found so far.** Cross-checking the dataset against the paper found two labelling slips in research note 02, now corrected. An independent audit of all records found no wrong values, unit conversions or DOIs. It did find over-stated grades and tags ("measured" on fitted diffusivities), priors that cut off cited values, a dispersion prior centred on a contradicted assumption, and over-determined linked quantities. All were fixed in M0.
- **Promotion to `accepted`.** It happens when M1 code uses a record and validation exercises it.
- **YAML risk.** YAML is readable and diffable but easy to get subtly wrong. The schema, the unit vocabulary and the CI validator carry that risk.

## Alternatives considered

| alternative | why rejected |
|---|---|
| Constants in code | no provenance; invisible to the UI's "why this number?" |
| JSON files | no comments; harder to review |
| TOML | awkward for lists of nested records |
| A database | overkill for about 10² records; poor diffs |
