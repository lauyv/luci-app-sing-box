#!/usr/bin/env bash
set -euo pipefail

PROJECT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
VERSION=v3.22.0
SHA256=7756b2940ade0ccb7541cb1ae79a99d3a08a43507c0d6dfd86fd7713444d1e06
BUILD_ROOT="$PROJECT_DIR/.dashboard-build"
ARCHIVE="$BUILD_ROOT/zashboard-$VERSION.tar.gz"
OUTPUT="$PROJECT_DIR/htdocs/luci-static/sing-box/dashboard"
mkdir -p "$BUILD_ROOT"
BUILD_DIR=''
cleanup() {
  cd "$PROJECT_DIR"
  if [[ -n "$BUILD_DIR" ]]; then rm -rf -- "$BUILD_DIR"; fi
  rm -f -- "$ARCHIVE.part"
}
trap cleanup EXIT

if [[ ! -f "$ARCHIVE" ]]; then
  curl --fail --location --retry 3 \
    "https://codeload.github.com/Zephyruso/zashboard/tar.gz/refs/tags/$VERSION" \
    --output "$ARCHIVE.part"
  mv "$ARCHIVE.part" "$ARCHIVE"
fi
if command -v sha256sum >/dev/null; then
  printf '%s  %s\n' "$SHA256" "$ARCHIVE" | sha256sum --check
else
  printf '%s  %s\n' "$SHA256" "$ARCHIVE" | shasum -a 256 --check
fi

BUILD_DIR=$(mktemp -d "$BUILD_ROOT/build.XXXXXX")
tar -xzf "$ARCHIVE" -C "$BUILD_DIR" --strip-components=1
cd "$BUILD_DIR"
patch --batch -p1 < "$PROJECT_DIR/dashboard/trim.patch"

# The upstream lockfile and pnpm version remain unchanged. No install hooks are needed.
pnpm install --frozen-lockfile --ignore-scripts --registry=https://registry.npmjs.org
pnpm exec vue-tsc --noEmit -p tsconfig.app.json
pnpm exec tsc --noEmit -p tsconfig.node.json
pnpm exec vite build
rm -f dist/pwa-*.png dist/apple-touch-icon.png
cp LICENSE dist/LICENSE.zashboard
printf 'zashboard %s\nSource: https://github.com/Zephyruso/zashboard/tree/%s\nArchive SHA-256: %s\nLocal changes: dashboard/trim.patch in luci-app-sing-box\n' \
  "$VERSION" "$VERSION" "$SHA256" > dist/UPSTREAM.txt

# Replace only generated files, after a successful build, so stale hashed chunks disappear.
mkdir -p "$(dirname -- "$OUTPUT")"
if [[ -d "$OUTPUT" ]]; then rm -rf -- "$OUTPUT"; fi
cp -R dist "$OUTPUT"
printf 'Dashboard installed into %s\n' "$OUTPUT"
