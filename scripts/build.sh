#!/usr/bin/env bash
# The pinned build pipeline (spec Requirement 14) — the only supported way to
# produce a release binary:
#
#   cargo test (exports TS types) -> npm run build -> cargo build --release
#
# Fails if frontend/src/types/ is dirty, checked both before the export
# (uncommitted manual edits) and after it (committed types stale against the
# Rust definitions — regenerate and commit them).
set -euo pipefail

cd "$(dirname "$0")/.."

check_types_clean() {
  local dirty
  dirty=$(git status --porcelain -- frontend/src/types)
  if [ -n "$dirty" ]; then
    echo "FAIL: frontend/src/types/ is dirty ($1):" >&2
    echo "$dirty" >&2
    exit 1
  fi
}

# Vite 8 / rolldown require node ^20.19 || >=22.12. Under an older node, npm
# silently skips the native rolldown binding (an optional dep gated on
# `engines`) and `vite build` fails. Prefer a conforming node over a stale
# one on PATH (e.g. an old nvm default shadowing the Homebrew install).
node_ok() {
  command -v "$1" >/dev/null 2>&1 &&
    "$1" -e 'const [a, b] = process.versions.node.split(".").map(Number);
             if (!((a === 20 && b >= 19) || (a === 22 && b >= 12) || a > 22)) process.exit(1)'
}
if ! node_ok node; then
  for dir in /opt/homebrew/bin /usr/local/bin; do
    if node_ok "$dir/node"; then
      export PATH="$dir:$PATH"
      break
    fi
  done
  node_ok node || {
    echo "FAIL: node $(node -v 2>/dev/null || echo "not found") is too old;" \
      "Vite 8 requires ^20.19 || >=22.12" >&2
    exit 1
  }
fi

# rust-embed's macro requires the folder to exist at compile time, but the
# pinned order compiles (cargo test) before the frontend is built.
mkdir -p frontend/dist

check_types_clean "uncommitted edits to generated types"
cargo test
check_types_clean "export changed generated types; commit the regenerated files"

if [ ! -d frontend/node_modules ]; then
  npm --prefix frontend ci
fi
npm --prefix frontend run build

# rust-embed reads frontend/dist during macro expansion, which cargo does not
# track; touch the source file holding the derive so a rebuilt dist is always
# re-embedded.
touch src/api.rs
cargo build --release

echo "ok: target/release/mesa"
