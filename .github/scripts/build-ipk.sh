#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_TAG:?Set RELEASE_TAG, for example v0.1.0}"
[[ "$RELEASE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "Release tag must be vMAJOR.MINOR.PATCH" >&2; exit 1;
}

SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
[[ -s "$SOURCE_DIR/htdocs/luci-static/sing-box/dashboard/index.html" ]] || {
  echo "Run bash dashboard/build.sh before packaging" >&2; exit 1;
}

DIST="$SOURCE_DIR/dist"
RELEASE=$(sed -n 's/^PKG_RELEASE:=//p' "$SOURCE_DIR/Makefile")
VERSION="${RELEASE_TAG#v}-r$RELEASE"
DEPENDS=$(sed -n 's/^LUCI_DEPENDS:=//p' "$SOURCE_DIR/Makefile" | tr ' ' '\n' | sed 's/^+//' | paste -sd, - | sed 's/,/, /g')
LICENSE=$(sed -n 's/^PKG_LICENSE:=//p' "$SOURCE_DIR/Makefile")
WORK=$(mktemp -d "${RUNNER_TEMP:-/tmp}/sing-box-ipk.XXXXXX")
trap 'rm -rf -- "$WORK"' EXIT

DATA="$WORK/data"
CONTROL="$WORK/control"
PACKAGE="$WORK/package"
mkdir -p "$DATA/www" "$CONTROL" "$PACKAGE" "$DIST"
cp -R "$SOURCE_DIR/root/." "$DATA/"
cp -R "$SOURCE_DIR/htdocs/." "$DATA/www/"

find "$DATA" -type d -exec chmod 0755 {} +
find "$DATA" -type f -exec chmod 0644 {} +
chmod 0755 "$DATA/usr/libexec/rpcd/luci.sing-box" "$DATA/usr/libexec/sing-box-panel-worker"

cat > "$CONTROL/control" <<EOF
Package: luci-app-sing-box
Version: $VERSION
Architecture: all
Depends: $DEPENDS
License: $LICENSE
Section: luci
Priority: optional
Source: https://github.com/lauyv/luci-app-sing-box
Description: sing-box 配置与服务管理面板
EOF

cat > "$CONTROL/postinst" <<'EOF'
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

cat > "$CONTROL/prerm" <<'EOF'
#!/bin/sh
[ -s "${IPKG_INSTROOT}/lib/functions.sh" ] || exit 0
. "${IPKG_INSTROOT}/lib/functions.sh"
export root="${IPKG_INSTROOT}"
export pkgname="luci-app-sing-box"
default_prerm
EOF
chmod 0755 "$CONTROL/postinst" "$CONTROL/prerm"

printf '2.0\n' > "$PACKAGE/debian-binary"
tar --sort=name --owner=0 --group=0 --numeric-owner -C "$CONTROL" -czf "$PACKAGE/control.tar.gz" .
tar --sort=name --owner=0 --group=0 --numeric-owner -C "$DATA" -czf "$PACKAGE/data.tar.gz" .
(
  cd "$PACKAGE"
  ar rcsD "$DIST/luci-app-sing-box_${VERSION}_all.ipk" debian-binary control.tar.gz data.tar.gz
)
