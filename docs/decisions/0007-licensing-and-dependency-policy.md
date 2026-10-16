# 0007: Licensing and dependency policy

- **Status:** Accepted
- **Date:** 2026-10-13

## Context

Puckworks is licensed GPL-2.0-or-later (D12). Data sources carry their own terms, from CC0 and CC BY to non-commercial or no licence at all ([PLAN.md §11](../PLAN.md#11-data-and-licensing-rules)). Licence mistakes are easy to make and hard to undo once a release is public.

## Decision

- **Code licence.** All code is GPL-2.0-or-later. `LICENSE` holds the canonical GPL version 2 text from gnu.org, and every source file starts with `SPDX-License-Identifier: GPL-2.0-or-later`.
- **Allowed dependency licences.** MIT, BSD-2-Clause, BSD-3-Clause, ISC, Zlib, 0BSD, Unicode-3.0 and Unicode-DFS-2016, CC0-1.0, and BlueOak-1.0.0. Apache-2.0 (including the LLVM exception) is also allowed; a build that includes it is distributed under GPLv3, which "or later" permits.
- **Forbidden dependency licences.** Non-commercial, proprietary, SSPL, BUSL, and anything else incompatible with the GPL.
- **Enforcement.** cargo-deny checks Rust dependencies (`deny.toml`, `.github/workflows/rust.yml`). `web/scripts/check-licenses.mjs` checks the transitive production npm dependencies (`npm run licenses`). Offline Python tooling is not shipped to users; it follows the same preference but is not gate-checked in M0.
- **Data.** Datasets follow PLAN §11 and carry a metadata sidecar recording their licence and redistribution terms. Non-commercial material is never bundled.
- **Existing code.** Code from GPL-3.0 projects may be combined, with the result under GPLv3. Code from non-commercial projects is never copied; their file formats are read through parsers written from the format documentation.

## Consequences

- CI fails when a dependency with a disallowed licence enters the build.
- Some convenient libraries are off-limits. When that happens, the choice and the reason are recorded here.

## Alternatives considered

- **GPL-2.0-only.** Rejected by the owner: it would have ruled out Apache-2.0 and GPL-3.0 code.
- **No automated check.** Rejected: transitive npm dependencies change silently between installs.
