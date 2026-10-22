#!/usr/bin/env bash
# Copy the spike site (with the built probe) to a directory outside the
# monorepo and install it there, one copy per execution mode. Staging also
# avoids a Vite tsconfig-paths lookup that climbs into an outer checkout when
# this repo is a nested git worktree (see README.md, step 3).
#
# A staged copy serves the probe spike only: pages that import monorepo
# packages by relative path (src/pages/status.astro) are left out, and
# STATUSBEAM_BLOCK=1 does not build there (see README.md).
#
# The copy uses `rsync --delete`, so the target must be a directory this script
# staged before (it carries a .statusbeam-stage marker), a new directory, or an
# empty one. The source tree, its ancestors and its descendants are refused.
# Usage: scripts/stage.sh [target-dir]
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd -P)"
target="${1:-/tmp/statusbeam-emdash-spike}"
marker=.statusbeam-stage

if [[ ! -f "$here/probe/dist/plugin.mjs" ]]; then
  echo "probe/dist is missing; run 'bun run probe:build' first" >&2
  exit 1
fi

if [[ -e "$target" && ! -d "$target" ]]; then
  echo "refusing to stage into $target: it is not a directory" >&2
  exit 1
fi
if [[ -d "$target" && ! -f "$target/$marker" && -n "$(ls -A "$target")" ]]; then
  echo "refusing to stage into $target: it is not empty and was not staged by this script (no $marker)" >&2
  exit 1
fi
# The physical path the target has, or will have once created: the nearest
# existing ancestor resolved, plus the components still to create.
resolve() {
  local path="$1" rest=""
  while [[ ! -d "$path" ]]; do
    rest="/$(basename "$path")$rest"
    path="$(dirname "$path")"
  done
  echo "$(cd "$path" && pwd -P)$rest"
}
resolved="$(resolve "$target")"
case "$here/" in
  "${resolved%/}"/*)
    echo "refusing to stage into $target: it is the source tree or one of its ancestors" >&2
    exit 1
    ;;
esac
case "$resolved/" in
  "$here"/*)
    echo "refusing to stage into $target: it is inside the source tree" >&2
    exit 1
    ;;
esac
mkdir -p "$resolved"
touch "$resolved/$marker"

rsync -a --delete \
  --exclude "/$marker" \
  --exclude node_modules --exclude /dist --exclude .astro --exclude .wrangler \
  --exclude 'data-*.db*' --exclude uploads \
  --exclude /src/pages/status.astro \
  "$here/" "$resolved/"
target="$resolved"
cd "$target"
bun install --ignore-scripts
echo "staged at $target"
