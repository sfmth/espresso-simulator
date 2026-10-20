# M6 accessibility verification

Version 0.10.1 · 2026-10-19. This is an initial quality pass, not a conformance
certification or public-launch sign-off.

## Baseline findings

The initial production Chrome audit found a heading-order violation when the
recipe editor was expanded. Review also identified preset badge labels on
unnamed paragraphs, pointer-only camera operations, incomplete text alternatives
for chart samples/pinned runs, array-index timeline announcements, and journal
actions whose focused controls disappeared after save/delete. Focused component
tests reproduced initially hidden validation errors and compound families that
could not collapse while filtered. Auditing the pinned-overlay state also caught
an accessible name that omitted the visible phrase “Load recipe”; the corrected
name retains that phrase and identifies the pinned run.

## Local results

Chrome **131.0.6778.139** on Linux, headless with SwiftShader, and axe-core
**4.14.0** produced:

| Check | Result |
|---|---|
| Rendered production audit | **14 states, zero detected violations** |
| Keyboard/data/layout workflow assertions | **30 passed** |
| Web unit/integration/cross-language tests | **737 passed in 54 files** |
| Manifest/installed extension release versions | All **0.10.1**, release check passed |
| Golden fixtures | **218,221 values unchanged**, maximum difference **0** |
| Natural benchmark completion with Cancel focused | Focus returns to Measure at **5k, 25k, 30k and 150k** particles |

The 14 states include preview Lab; expanded recipe/help; pinned chart samples;
dark Lab; empty and measurement-form Dial-in; coupled Explore with the exact shell
table in dark/light; refined 150-cell Explore after keyboard selection; phone
Explore, expanded Lab, kernel verification, journal and privacy. Page-overflow
checks also pass at 320px for all three modes. The audit confirms that its own
development engine is absent from production dependency notices and that the
page/workers request only the local app origin.

These are functional checks under software rendering. Concurrent test workloads
and emulated phone widths are not new hardware performance evidence.

## Reproduction

```bash
scripts/build_wasm.sh
cd web
npm ci
npm run e2e:a11y
```

The report is `web/test-results/accessibility-checks.json`. It records Chrome and
axe versions, exact rule tags, each viewport/state, detected violations, passes,
all incomplete results and completed keyboard workflow checks. Screenshots in
the same directory retain the phone Lab and camera view. CI keeps these artifacts
on failure. No rule is disabled or excluded to pass the audit.

## Scope and outstanding review

The suite checks rendered production states and real browser focus/range/tab
behavior. It includes light/dark desktop, a 390px phone viewport and page-overflow
checks down to 320px. The numerical core, calibration and all 218,221 golden
values are unchanged by this pass.

Automated results cannot establish full WCAG conformance. `incomplete` results
remain visible in the report: symbolic help button names and image/overlapping
SVG backgrounds require judgment. The phone journal also reports partially
clipped table cells for contrast review; its table scrolls within its own region.
Canvas contrast, spoken announcements with
real screen readers, speech input and physical touch operation remain manual
work. A complete audit of every scenario/error/import state is also outstanding.

These changes advance M6 quality. Scientific validation, prospective accuracy,
surrogates and the specified laptop/physical-phone performance gates remain open.
