<!-- SPDX-License-Identifier: GPL-2.0-or-later -->
# ADR 0012: M2 chemistry and phase accounting

Status: accepted for development, 2026-10-17.

The owner selected M2 after the novel-shot diagnostic. Remaining M1
scientific criteria remain visible and unchanged.

Expand the catalogue with shared K1–K6 transport classes, preserving the
M1 measured analytes. Separate overlapping acid diagnostics, oils, gas
and water minerals from coffee TDS. Distinguish an independently
transported unresolved stock from a derived accounting remainder.
Never normalize measured species to force agreement with lumped TDS.

Add optional core cup-chemistry spec/result fields so native, raw-spec
and WebAssembly simulations share one implementation. Effective acid
buffering, closed-headspace aroma, thiol binding, phase recovery and
optical observations are postprocessing estimates. They must not feed
unvalidated chemistry back into the hydraulic calibration.

Altitude and variety are recorded without universal composition factors.
Storage/process, absolute acidity and crema assumptions stay labelled.
No M3 taste claims are introduced. Preserve the prior validation and
calibration; incomplete Gloess inputs cannot establish V7 accuracy.

The embedded registry now occupies about 471 KB uncompressed, and the
seven full native/WASM parity fixtures about 7.34 MB. Retain bounded
size checks at 600 KB and 10 MB respectively; the larger fixtures exercise
all dissolved passengers and cup outputs instead of dropping chemistry
from cross-target verification.

See [M2 chemistry](../model/m2-chemistry.md) for the contract and limits.
