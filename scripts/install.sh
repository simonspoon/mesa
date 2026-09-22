#!/usr/bin/env bash
# Build the release binary and install it onto this machine.
#
# Runs the pinned build pipeline (scripts/build.sh) and copies the resulting
# `naru` binary to an install dir on PATH, with `mesa` (its pre-rename name)
# as a symlink to it beside it. Override the destination with PREFIX:
#
#   PREFIX=/usr/local scripts/install.sh   # installs to /usr/local/bin/naru
#
# Default install dir is ~/.local/bin (already on PATH on this machine).
set -euo pipefail

cd "$(dirname "$0")/.."

BIN_DIR="${PREFIX:+$PREFIX/bin}"
BIN_DIR="${BIN_DIR:-$HOME/.local/bin}"

scripts/build.sh

mkdir -p "$BIN_DIR"
install -m 0755 target/release/naru "$BIN_DIR/naru"
# Replaces an older install's real `mesa` binary with the symlink.
ln -sf naru "$BIN_DIR/mesa"

echo "ok: installed naru -> $BIN_DIR/naru (mesa -> naru)"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *) echo "warning: $BIN_DIR is not on your PATH; add it to use 'naru' directly" >&2 ;;
esac
