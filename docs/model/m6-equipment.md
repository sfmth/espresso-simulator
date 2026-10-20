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

## First visit

Before using the simulator, choose machine, grinder, basket and coffee. Generic
presets are available for unlisted gear; choosing one explicitly records an
assumption rather than identifying the actual machine. Then review dose, beverage
target, temperature and grinder setting, and confirm the setup. The shared native
builder must accept the recipe before setup finishes. Invalid combinations remain
in the wizard with their errors.

Initial setup is required and Escape cannot dismiss it. **Equipment setup** opens
a later review with a Cancel action. Existing drafts can be reviewed and custom
gear/advanced fields retained. Deliberately choosing another preset follows the
existing replacement rules. Confirmed choices update the same recipe used by Lab,
Dial-in and Explore.

If retained advanced inputs cannot pass validation, **Start with a clean recipe**
resets only the wizard's working copy and requires the four equipment choices
again. The original recipe remains intact until confirmation; cancelling a later
equipment review also preserves it.

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
