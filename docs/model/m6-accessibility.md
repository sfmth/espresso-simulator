# M6 accessibility and keyboard controls

Version 0.10.1 fixes concrete keyboard and numerical-readout gaps. It does not
declare WCAG conformance or complete the M6 launch gates.

## Keyboard behavior

- **Navigation:** Skip to content focuses the main region. Mode/view tabs use
  arrows, Home and End. Native details, form controls and buttons retain their
  browser keyboard behavior.
- **Recipe:** sections containing errors open on first mount or when new errors
  appear. Help buttons expose their expanded state. Sandbox override labels name
  the parameter. Filtered compound families initially expand but can be collapsed;
  a changed filter starts a fresh expansion context.
- **Journal:** row actions name their shot and row. Explicitly opening Record
  shot focuses the first measurement. A successful save focuses that row's Use
  recipe action; deletion focuses an adjacent row or the journal heading. Failed
  saves leave the form available. Edit full recipe in Lab focuses the Lab tab.
- **3D camera:** focus the camera group and use arrows to orbit, plus/minus to
  zoom, and Home to reset. Named buttons provide the same operations. Particle
  number selects a representative particle independently of pointer picking.
  Frame-rate measurement has an explicit Cancel measurement button.
- **Cross-section:** arrows change the selected column/depth cell; the native
  Column and Depth cell controls provide the same selection. The live readout
  describes the selected field, cell bounds and wetted fraction. The viewport
  shows its own focus ring so scrolling does not clip the SVG's indicator.
- **Timeline:** the range's spoken value includes actual snapshot seconds and
  ordinal, rather than treating the stored array index as time. Playback begins
  only on request.

## Numerical text alternatives

Every line chart offers **Read chart values**. Its native sample slider traverses
the complete aligned x array, including irregular times. The readout lists every
plotted series, including pinned runs, in the same format as the hover legend.
An absent aligned value is explicitly unavailable; it is not interpolated or
silently replaced. The existing sampled table remains a compact overview.

Explore's particle inspector reports the selected particle's actual coupled EY
or its unavailable state, alongside class/size and the exact shell table. The
cross-section readout follows the selected field, including liquid solubles.
Packing remains illustrative and never changes the solver.

## Regression checks and limits

Run `cd web && npm run e2e:a11y`. The suite serves the production build under a
repository subpath, uses installed Chrome and exercises actual keyboard events.
It runs the axe-core WCAG A/AA tags through 2.2 and best-practice checks on rendered
states, including expanded recipe/help, pinned chart values, a journal measurement
form, coupled Explore/inspector/table, kernel verification, privacy, both themes
and phone widths. It fails on detected violations and preserves `incomplete`
results for review. Unit tests cover irregular times, missing values, imported
IDs, failed saves and selection/focus races.

axe-core is exact-pinned as a development dependency under
[MPL-2.0](https://github.com/dequelabs/axe-core/blob/v4.14.0/LICENSE). The test runner
injects it locally through Playwright; it is not an app import, production bundle,
cached app asset or runtime service. The production licence policy and privacy
boundary are unchanged. The [axe API documentation](https://github.com/dequelabs/axe-core/blob/v4.14.0/doc/API.md)
explains that hidden states need to be opened and `incomplete` checks need review.

The audit does not prove screen-reader announcement quality, speech-control
usability, touch usability, full chart/canvas visual contrast or every possible
error/import/scenario state. Help glyph naming and SVG/canvas backgrounds can
need manual review. Test those with assistive technology and physical devices
before claiming conformance. Phone viewport checks establish layout behavior,
not physical-phone performance or the G5 hardware gate.

See [verification](../validation/m6-accessibility-validation.md) for the measured
scope and outstanding checks.
