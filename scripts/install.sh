#!/usr/bin/env bash
# Build the release binary and install it onto this machine.
#
# Runs the pinned build pipeline (scripts/build.sh) and copies the resulting
# binary to an install dir on PATH. Override the destination with PREFIX:
#
#   PREFIX=/usr/local scripts/install.sh   # installs to /usr/local/bin/mesa
#
# Default install dir is ~/.local/bin (already on PATH on this machine).
set -euo pipefail

cd "$(dirname "$0")/.."

BIN_DIR="${PREFIX:+$PREFIX/bin}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

scripts/build.sh

mkdir -p "$BIN_DIR"
install -m 0755 target/release/mesa "$BIN_DIR/mesa"

echo "ok: installed mesa -> $BIN_DIR/mesa"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "warning: $BIN_DIR is not on your PATH; add it to use 'mesa' directly" >&2 ;;
esac
