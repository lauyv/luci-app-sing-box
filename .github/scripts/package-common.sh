#!/usr/bin/env bash
# Shared package metadata, payload and OpenWrt install hooks.
# NAME, DESCRIPTION, VERSION, DEPENDS and LICENSE are consumed by the sourcing
# build-apk.sh and build-ipk.sh scripts, not by child-process environments.
# shellcheck disable=SC2034
set -euo pipefail

: "${RELEASE_TAG:?Set RELEASE_TAG, for example v0.1.0}"
[[ "$RELEASE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "Release tag must be vMAJOR.MINOR.PATCH" >&2; exit 1;
}
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
[[ -s "$SOURCE_DIR/htdocs/luci-static/sing-box/dashboard/index.html" ]] || {
  echo "Run bash dashboard/build.sh before packaging" >&2; exit 1;
}
NAME=luci-app-sing-box
DESCRIPTION='sing-box 配置与服务管理面板'
DIST="$SOURCE_DIR/dist"
RELEASE=$(sed -n 's/^PKG_RELEASE:=//p' "$SOURCE_DIR/Makefile")
VERSION="${RELEASE_TAG#v}-r$RELEASE"
# This package has only unconditional dependencies.
DEPENDS=$(sed -n 's/^LUCI_DEPENDS:=//p' "$SOURCE_DIR/Makefile" | tr -d '+')
LICENSE=$(sed -n 's/^PKG_LICENSE:=//p' "$SOURCE_DIR/Makefile")
WORK=$(mktemp -d "${RUNNER_TEMP:-/tmp}/sing-box-package.XXXXXX")
trap 'rm -rf -- "$WORK"' EXIT
DATA="$WORK/data"
HOOKS="$WORK/hooks"
mkdir -p "$DATA/www" "$HOOKS" "$DIST"
cp -R "$SOURCE_DIR/root/." "$DATA/"
cp -R "$SOURCE_DIR/htdocs/." "$DATA/www/"
find "$DATA" -type d -exec chmod 0755 {} +
find "$DATA" -type f -exec chmod 0644 {} +
chmod 0755 "$DATA/usr/libexec/rpcd/luci.sing-box" "$DATA/usr/libexec/sing-box-panel-worker"

cat > "$HOOKS/postinst" <<'EOF'
#!/bin/sh
[ "${IPKG_NO_SCRIPT:-}" = 1 ] && exit 0
[ -s "${IPKG_INSTROOT}/lib/functions.sh" ] || exit 0
. "${IPKG_INSTROOT}/lib/functions.sh"
export root="${IPKG_INSTROOT}"
export pkgname="luci-app-sing-box"
default_postinst
[ -n "$IPKG_INSTROOT" ] || {
  rm -f /tmp/luci-indexcache.*
  rm -rf /tmp/luci-modulecache/
  /etc/init.d/rpcd reload 2>/dev/null
}
exit 0
EOF

cat > "$HOOKS/prerm" <<'EOF'
#!/bin/sh
[ -s "${IPKG_INSTROOT}/lib/functions.sh" ] || exit 0
. "${IPKG_INSTROOT}/lib/functions.sh"
export root="${IPKG_INSTROOT}"
export pkgname="luci-app-sing-box"
default_prerm
EOF
chmod 0755 "$HOOKS/postinst" "$HOOKS/prerm"
