<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# Presets

Ready-made descriptions of gear and coffees, so a user can pick "my grinder" instead of entering every number. Presets are only defaults: every value can be overridden in a recipe, and every kind of gear can also be described from scratch (PLAN design principle 7). How each field turns into physics is in [docs/model/input-models.md](../../docs/model/input-models.md).

## Layout

| Folder | `kind` | Contents |
|---|---|---|
| `grinders/` | `grinder_family` | the three burr families (`flat-unimodal`, `flat-traditional`, `conical`) |
| `grinders/` | `grinder` | named grinders with published data (Bentwood V63, Mahlkönig E65S, EK43), one generic grinder per family, and the owner's AMZCHEF single-dose grinder |
| `baskets/` | `basket` | 58 mm precision (15/18/20/22 g), 58 mm stock double and single, 54/53/51/49 mm doubles, 58 and 51 mm pressurised doubles; named by geometry, all dimensions estimated |
| `machines/` | `machine` | programs (flat 9 bar, declining, spring lever, blooming, turbo, 2 mL/s flow, allongé), a generic vibratory pump, a rotary-pump E61-style machine, and the owner's AMZCHEF Ultra |
| `beans/` | `bean` | light washed Arabica, medium washed Arabica (the default bean), medium natural Brazil, medium-dark 90/10 and dark 80/20 blends, Robusta |

Counts: 3 families, 7 grinders, 12 baskets, 10 machines, 6 beans.

## File format

Each file is YAML with `schema: puckworks.preset-file/1`, one `kind`, an optional `description` and a `presets` list. Every preset has:

| Field | Content |
|---|---|
| `id` | lower-case words joined by hyphens; unique within its kind |
| `name`, `description` | for people |
| `flags` | `estimated` (values are estimates), `unverified` (retail-listing specifications no manufacturer confirmed), `disputed` (sources conflict), `owner-gear` (the project owner's equipment, PLAN D10), `generic` (a family or typical device) |
| `notes` | notes shown to the user whenever the preset is used |
| `sources` | citations (`citation`, optional `doi`, `url`, `locator`) |
| `evidence_grade` | the weakest grade among the preset's numbers (manufacturer and retail specifications are D) |
| `tag` | measured / derived / estimated / fitted |
| `registry_refs` | optional registry ids that describe the preset's data |

plus the fields of its kind, in the recipe's practical units ([`data/schema/preset.schema.json`](../schema/preset.schema.json) has them all). Basket fields equal the recipe's `basket.custom`; machine `program` and `pump` equal the recipe's `machine.profile` and `machine.pump`.

## Rules

- **Source every number.** Values the registry already has stay in `data/params/` and are referenced, not copied. A new number either cites its source with an evidence grade, or is flagged `estimated` and says so in a note.
- **Say what is unverified.** Retail-listing specifications get the `unverified` flag and a note beginning "UNVERIFIED:".
- **Name generic gear by geometry, not by brand.** Named products are for grinders with published PSD data and the owner's gear.
- **No user data** (D9): presets describe equipment and coffees, never people or their shots.

## Export

The model crate embeds the presets as JSON. After any change here, run

```sh
.venv/bin/python -m puckworks_tools.export          # writes crates/puckmodel/generated/*.json
.venv/bin/python -m puckworks_tools.export --check  # what CI runs: fails if they are stale
```

The export validates every file against the schema and checks cross-references (grinder families, default baskets, registry ids), basket profiles, dose ranges, program rules and that exactly one bean has `default: true`. It writes nothing if anything fails.
