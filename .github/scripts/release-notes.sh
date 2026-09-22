#!/usr/bin/env bash
set -euo pipefail

: "${GH_REPO:?Set GH_REPO to owner/repository}"
: "${BUILD_SHA:?Set BUILD_SHA to the commit being packaged}"
: "${NOTES_FILE:?Set NOTES_FILE to the release description file}"

RELEASES_FILE=$(mktemp)
trap 'rm -f -- "$RELEASES_FILE"' EXIT

# Include prereleases; ignore drafts and releases without this application's APK.
# Select by publication time, not tag version or commit creation time.
gh api --paginate "repos/$GH_REPO/releases?per_page=100" \
  --jq '.[] | select(.draft == false and any(.assets[]; .name | test("^luci-app-sing-box-.*\\.apk$"))) | [.published_at, .tag_name] | @tsv' \
  > "$RELEASES_FILE"
PREVIOUS_TAG=$(LC_ALL=C sort -r "$RELEASES_FILE" | awk -F '\t' 'NR == 1 { print $2 }')

COMMIT_RANGE="$BUILD_SHA"
if [[ -n "$PREVIOUS_TAG" ]]; then
  PREVIOUS_COMMIT=$(git rev-parse --verify "refs/tags/$PREVIOUS_TAG^{commit}")
  COMMIT_RANGE="$PREVIOUS_COMMIT..$BUILD_SHA"
fi

# Write commit text directly to a file so multiline messages and shell syntax stay literal.
git log --reverse --format='%B' "$COMMIT_RANGE" -- > "$NOTES_FILE"
shopt -s nullglob
APK_FILES=(dist/luci-app-sing-box-*.apk)
[[ ${#APK_FILES[@]} -eq 1 ]] || {
  printf 'Expected exactly one APK in dist, found %d\n' "${#APK_FILES[@]}" >&2
  exit 1
}
APK_NAME=$(basename -- "${APK_FILES[0]}")

cat >> "$NOTES_FILE" <<EOF

Install:
apk add --allow-untrusted ./$APK_NAME
/etc/init.d/rpcd restart
EOF
