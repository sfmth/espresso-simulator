#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later
# Builds the WebAssembly engine and its JavaScript bindings into web/src/engine/pkg/.
# Usage: scripts/build_wasm.sh [release|dev]   (default: release)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
profile="${1:-release}"
case "$profile" in
  # Release builds drop the function-name section (about 105 KB of the ~1 MB
  # module); dev builds keep it for readable stack traces.
  release) cargo_flags=(--release); dir=release; bindgen_flags=(--remove-name-section --remove-producers-section) ;;
  dev) cargo_flags=(); dir=debug; bindgen_flags=() ;;
  *) echo "usage: $0 [release|dev]" >&2; exit 2 ;;
esac

# Local installs put cargo and wasm-bindgen here; CI already has them on PATH.
export PATH="$HOME/.cargo/bin:$PATH"

want="$(sed -n 's/^wasm-bindgen = "=\([0-9.]*\)".*/\1/p' "$root/Cargo.toml")"
have="$(wasm-bindgen --version 2>/dev/null | awk '{print $2}' || true)"
if [[ -z "$want" || "$want" != "$have" ]]; then
  echo "wasm-bindgen CLI '${have:-missing}' does not match the crate version '$want'." >&2
  echo "Install it with: cargo install wasm-bindgen-cli --version $want --locked" >&2
  exit 1
fi

cargo build --locked --manifest-path "$root/Cargo.toml" -p puckcore-wasm \
  --target wasm32-unknown-unknown "${cargo_flags[@]}"
wasm-bindgen --target web "${bindgen_flags[@]}" --out-dir "$root/web/src/engine/pkg" --out-name puckcore \
  "$root/target/wasm32-unknown-unknown/$dir/puckcore_wasm.wasm"
echo "Wrote $root/web/src/engine/pkg/"
