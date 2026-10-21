# Equipment workspace and first-visit setup

The 0.11.0 browser UI draws the coffee path as a local SVG: beans in the hopper,
grinder burrs, machine/group, handled portafilter and basket, coffee puck, then
the cup on its scale. This is an illustrative schematic; it does not claim to
depict the selected hardware exactly or replace the solver's measured geometry.

## Connected settings

Six numbered bubbles connect to their parts through leader lines. Choose a bubble
to expand common settings, or use **More settings** to open and focus the related
full-editor section. One bubble is expanded at a time. Escape closes it and returns
focus to its button. Buttons expose expanded state and validation problem counts.

| Part | Quick controls |
|---|---|
| Beans | Bean preset, roast level, days off roast |
| Grinder | Grinder preset and setting or burr gap; custom PSD remains available in the full editor |
| Machine | Machine preset, brew temperature and post-stop venting; programs and pumps remain in the full editor |
| Portafilter / basket | Basket preset; custom geometry remains in the full editor |
| Puck / dose | Dry dose and distribution |
| Cup / stop | Beverage-mass stop and optional time stop |

Quick controls use the same recipe store, preset-clearing helpers and validation
as the full editor. They do not maintain a second simulation state. Preset changes
can replace gear-specific settings just as in the full editor. Original controls,
advanced settings, provenance and builder errors remain available below the drawing.
Quick-field IDs differ from full-field IDs, so both views can remain accessible.

The vector illustration and leaders scale with the editor. Narrow screens show
compact numbered bubbles and a full-width settings panel; the same labels remain
available to assistive technology. No remote images or fonts are loaded.

## Detailed parts

**Open machine**, **Open grinder** and **Open portafilter** move from the overview
bubbles into the corresponding full section and place keyboard focus on its
cutaway. Opening the full section directly shows the same controls.

The machine cutaway follows reservoir → pump → heater → group. Three connected
bubbles expose heating layout, pump and group/valve settings. Boiler and thermoblock
drawings compare layouts only: their view choice is not saved as a machine part
and does not change the solver. The current model has constant inlet-water
temperature, one shared thermal node and no heater recovery, PID or thermostat
dynamics. Ideal/vibratory pump choices and curve fields change the actual recipe;
the three-way valve changes the real post-stop vent flag.

Group controls edit the existing basket/portafilter heat-capacity, preheat and
cooling-time overrides. Their defaults come from the existing registry and machine
preset, with estimated evidence; they do not specify a measured boiler.
**Use existing group defaults** removes only those three overrides. Unrelated
overrides remain intact and Undo restores previous custom values.

The grinder shows two flat discs or a ring and cone, cutting faces and a gap
indicator. Swapping a burr family changes the existing empirical family and
preserves the resolved gap while clearing calibration/shape overrides belonging
to the previous grinder. Undo restores the named grinder, measured PSD or custom
configuration. A measured PSD does not identify burr geometry. Tooth shapes are
schematic; family coefficients determine the modeled PSD. Diameter and RPM are
recorded without a modeled effect.

The portafilter separates the screen, top paper, puck, bottom paper and basket.
Layer toggles edit the preparation inputs. Screen and bottom-paper effects remain
estimated; top paper is recorded without an extraction effect. Basket cards show
their actual wall-profile proportions, with layer spacing separated for clarity.
Swapping an outlet first copies all preset geometry and coefficients into a custom
basket. Custom profiles remain editable, malformed geometry is withheld, and Undo
restores replaced baskets. All saved changes use the existing recipe/draft and
setup persistence; heater-comparison state is temporary.

See the [detailed-parts verification](../validation/m6-detailed-parts-validation.md)
for rendered examples, native recipe checks and release replay evidence.

## First visit

Version 0.12.0 replaces the mandatory chooser wizard with a welcome popup.
**Set up equipment** opens the illustrated setup tab with the current recipe;
Escape takes the same path. **Skip setup with defaults** explicitly validates and
loads the standard recipe, records completion locally, and opens **Dial in**.
Skipping is a deliberate recipe replacement with Undo. Existing complete setups
restore their latest valid draft and open Dial in without the popup.

The setup tab reuses the same overview, detailed parts and full Lab editor. It
adds known/range/unknown controls, direct observed-shot entry and multiple-shot
inference. Keeping an alternative does not select it; **Use … in Dial in** explicitly
loads it. Users can also proceed with stated settings and assumptions. A setup-first
visit is remembered as completed only when a setup is saved/activated; opening the
tab alone does not silently accept defaults. See the [inference contract](setup-inference.md).

## Persistence and cookie

Equipment records and valid recipe drafts use localStorage. The setup record has
schema `puckworks.equipment-setup/1`, a complete recipe and completion/expiry times.
Its key is scoped to the deployment path. Reads validate bounded finite JSON and
recipe structure, reject expired/corrupt records and check current preset support.
A valid newer draft takes precedence over the setup snapshot. A valid setup snapshot
can restore gear when the draft is missing.

The owner's explicit 2026-10-19 request permits one first-party cookie,
`puckworks_setup_v1=done`. It has the same value for everyone, app-relative Path,
SameSite=Strict, Secure on HTTPS and a maximum age of one year. It contains no
machine, recipe, journal or unique identifier. Browsers include it in matching
requests to the host; the [privacy page](../../web/public/privacy.html) says so.

A cookie alone cannot reconstruct gear or bypass setup. Valid unexpired local
records can restore equipment when cookies are blocked or cleared. If storage is
fully unavailable, confirmed setup works for the current session and a notice
explains that it cannot be remembered. Site-data clearing can remove the profile,
cookie, drafts and journals; backups remain the user's responsibility.

This changes the earlier no-cookie rule only for the fixed completion marker.
There are no accounts, analytics, tracking identifiers or recipe uploads. See
[ADR 0018](../decisions/0018-visual-equipment-and-first-visit-setup.md).

## Verification scope

Unit checks cover shared-state edits, preset changes, error links, keyboard focus,
setup validation and persistence failures. Production browser checks exercise the
required first visit, fixed/scoped cookie, return visit, drawing controls, phone
layouts, dark mode and offline restoration. The accessibility audit retains checks
that require manual review; automated success does not establish full conformance.

See the [equipment verification report](../validation/m6-equipment-validation.md)
for results, screenshots and remaining manual checks.
