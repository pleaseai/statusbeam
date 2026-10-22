#!/usr/bin/env bash
# Copy the spike site (with the built probe) to a directory outside the
# monorepo and install it there, one copy per execution mode. Staging also
# avoids a Vite tsconfig-paths lookup that climbs into an outer checkout when
# this repo is a nested git worktree (see README.md, step 3).
# Usage: scripts/stage.sh [target-dir]
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
target="${1:-/tmp/statusbeam-emdash-spike}"

if [[ ! -f "$here/probe/dist/plugin.mjs" ]]; then
  echo "probe/dist is missing; run 'bun run probe:build' first" >&2
  exit 1
fi

mkdir -p "$target"
rsync -a --delete \
  --exclude node_modules --exclude /dist --exclude .astro --exclude .wrangler \
  --exclude 'data-*.db*' --exclude uploads \
  "$here/" "$target/"
cd "$target"
bun install
echo "staged at $target"
