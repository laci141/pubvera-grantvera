#!/usr/bin/env bash
# vendor-cli.sh — cross-compile the grants CLI to bin/grants-pp-cli-linux
# (linux/amd64), which the Docker image copies and runs.
#
# The default source is the monorepo under ~/printing-press-library, NOT the
# Desktop copy: there are two clones on this machine and they sit on different
# branches. Vendoring from a feature branch ships whatever that branch happens
# to hold, so check out main (or pass the path explicitly) before running.
#
# USAGE (from the grantvera repo, Git Bash):
#   ./vendor-cli.sh
#   ./vendor-cli.sh "/c/Users/LACI/printing-press-library/library/health/grants"
set -euo pipefail
CLI_SRC="${1:-/c/Users/LACI/printing-press-library/library/health/grants}"
OUT="bin/grants-pp-cli-linux"
if [ ! -f "$CLI_SRC/go.mod" ] || [ ! -d "$CLI_SRC/cmd" ]; then
  echo "ERROR: CLI source not found at: $CLI_SRC" >&2
  exit 1
fi
echo "Vendoring from: $CLI_SRC"
( cd "$CLI_SRC" && git log --oneline -1 -- . )
rm -rf cli-src && mkdir -p cli-src
cp "$CLI_SRC/go.mod" cli-src/
[ -f "$CLI_SRC/go.sum" ] && cp "$CLI_SRC/go.sum" cli-src/ || true
cp -r "$CLI_SRC/cmd" "$CLI_SRC/internal" cli-src/
echo "Cross-compiling -> $OUT"
mkdir -p bin
( cd cli-src && CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -o "../$OUT" ./cmd/grants-pp-cli )
command -v file >/dev/null && file "$OUT" || true
ls -la "$OUT"