# ADR 0018: visual equipment controls and first-visit setup

## Status

Accepted, 2026-10-19, following the owner's explicit request for equipment
drawings, connected setting bubbles, cookies and required first-visit setup.

The mandatory first-visit flow is superseded by [ADR 0019](0019-equipment-inference-before-dial-in.md), 2026-10-21. Visual controls and fixed-cookie restrictions remain in force.

## Context

The full recipe editor has many controls with relationships that are easier to
understand through the equipment. New visitors also need to choose their setup
before a generic starting recipe can be meaningful to them.

## Decision

Use a native SVG drawing of the coffee, grinder, machine, portafilter, puck and
cup. Numbered callouts connect to each part through leader lines. Expanding a
callout exposes common settings backed by the same recipe store as the full
editor; advanced controls remain available below. The illustration is a
schematic, not a measurement or a claim to depict the selected machine exactly.

Require explicit equipment choices and a valid starting recipe before first
use. Users can select real generic presets when their equipment is unlisted.
Keep setup editable through an Equipment setup control. Preserve existing
advanced recipe fields unless a deliberate gear change replaces them according
to the existing preset rules.

The owner's cookie request overrides the earlier no-cookie rule in D9 for one
specific purpose. Use the fixed first-party completion marker
`puckworks_setup_v1=done`, scoped to the application path, with SameSite=Strict,
Secure on HTTPS and a one-year lifetime. Store equipment values and expiry
metadata in local browser storage, rather than in the cookie. The cookie is not
an authentication credential, consent record or unique identifier. Browsers
send it on matching host requests; the privacy page explicitly describes this.
See the [Document.cookie reference](https://developer.mozilla.org/en-US/docs/Web/API/Document/cookie)
for attribute and transport semantics.

Validate stored data before use. If persistent storage is unavailable, allow a
completed setup for the current session and explain that it cannot be remembered.
A cookie alone cannot reconstruct equipment settings. Clearing or expiring the
local record requires setup again; no account or server profile exists.

## Consequences

### Detailed parts extension, 2026-10-21

Use code-native SVG cutaways in the full machine, grinder and basket sections,
reachable from the overview's Open controls. Part choices continue to use one
recipe and existing conversion/validation. Replacing a burr family or basket
retains an Undo; group controls edit their three existing overrides and can reset
them with Undo. No new physical effect is inferred from a drawing: boiler/thermoblock
comparison is temporary illustration, diameter/RPM and top paper keep their
recorded-only semantics, and empirical burr coefficients remain distinct from
schematic tooth geometry. Numerical replay demonstrates version-only parity;
the frozen surrogate is not retrained or qualified by this interface change.

### Existing setup and overview

Both keyboard and pointer users can move between equipment and its controls.
Every quick edit must use existing recipe conversion, preset-clearing and
validation rules. Input errors must remain discoverable in the full editor.
Small screens use a compact drawing and a full-width settings panel.

First-visit browser tests now need to complete setup through its real UI.
Returning, blocked-storage, corrupt-data, cookie scoping, keyboard, dark-theme,
phone layout and offline scenarios are part of the verification scope.

No analytics, recipe uploads, third-party assets or new numerical assumptions
are introduced. The frozen surrogate experiment and its failed accuracy gate
remain unchanged.

## Alternatives considered

Keep all settings in a cookie: unnecessary host transmission and cookie-size
limits. Maintain a second independent diagram recipe: would let graphics and
the solver disagree. Require third-party drawings: would add remote assets and
make exact callout placement harder than a code-native SVG.
