#!/usr/bin/env sh
# Shallow-clones read-only reference sources into .repos/ (gitignored) for agents and editors.
# effect-smol is pinned to the installed effect version so its LLMS.md and source match.
set -eu
cd "$(dirname "$0")/.."
version=$(node -p 'require("./node_modules/.pnpm/node_modules/effect/package.json").version')
mkdir -p .repos
if [ -d .repos/effect-smol/.git ]; then
  git -C .repos/effect-smol fetch --depth 1 origin "refs/tags/effect@$version"
  git -C .repos/effect-smol checkout -q FETCH_HEAD
else
  git clone -q --depth 1 --branch "effect@$version" https://github.com/Effect-TS/effect.git .repos/effect-smol
fi
echo "effect-smol at effect@$version in .repos/effect-smol"
