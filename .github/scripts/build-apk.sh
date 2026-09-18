#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_TAG:?Set RELEASE_TAG, for example v0.1.0}"
: "${TOOLS_DIR:?Set TOOLS_DIR to the directory containing apk}"
[[ "$RELEASE_TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || {
  echo "Release tag must be vMAJOR.MINOR.PATCH" >&2; exit 1;
}
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)
TOOLS_DIR=$(cd "$TOOLS_DIR" && pwd)
DIST="$SOURCE_DIR/dist"
RELEASE=$(sed -n 's/^PKG_RELEASE:=//p' "$SOURCE_DIR/Makefile")
VERSION="${RELEASE_TAG#v}-r$RELEASE"
# This package has only unconditional dependencies; share the declaration with LuCI.
DEPENDS=$(sed -n 's/^LUCI_DEPENDS:=//p' "$SOURCE_DIR/Makefile" | tr -d '+')
LICENSE=$(sed -n 's/^PKG_LICENSE:=//p' "$SOURCE_DIR/Makefile")
WORK=$(mktemp -d "${RUNNER_TEMP:-/tmp}/sing-box-package.XXXXXX")
MAIN="$WORK/main"
mkdir -p "$MAIN/www" "$DIST"
cp -R "$SOURCE_DIR/root/." "$MAIN/"
cp -R "$SOURCE_DIR/htdocs/." "$MAIN/www/"
# Match OpenWrt package hooks so uci-defaults and LuCI caches are handled on install.
make_hooks() {
  local name="$1" dir="$WORK/$1"
  mkdir -p "$dir"
  {
    printf '#!/bin/sh\nexport pkgname="%s"\n' "$name"
    cat <<'EOF'
[ "${IPKG_NO_SCRIPT:-}" = 1 ] && exit 0
[ -s "${IPKG_INSTROOT}/lib/functions.sh" ] || exit 0
. "${IPKG_INSTROOT}/lib/functions.sh"
export root="${IPKG_INSTROOT}"
default_postinst
[ -n "$IPKG_INSTROOT" ] || {
  rm -f /tmp/luci-indexcache.*
  rm -rf /tmp/luci-modulecache/
  /etc/init.d/rpcd reload 2>/dev/null
}
exit 0
EOF
  } > "$dir/post-install"
  { printf '#!/bin/sh\nexport PKG_UPGRADE=1\n'; tail -n +2 "$dir/post-install"; } > "$dir/post-upgrade"
  {
    printf '#!/bin/sh\nexport pkgname="%s"\n' "$name"
    cat <<'EOF'
[ -s "${IPKG_INSTROOT}/lib/functions.sh" ] || exit 0
. "${IPKG_INSTROOT}/lib/functions.sh"
export root="${IPKG_INSTROOT}"
default_prerm
EOF
  } > "$dir/pre-deinstall"
}

package_apk() {
  local name="$1" files="$2" depends="$3" description="$4"
  local hooks="$WORK/$name"
  make_hooks "$name"
  mkdir -p "$files/lib/apk/packages"
  (cd "$files"; find . -type f -printf '/%P\n' | sort) > "$WORK/$name.list"
  mv "$WORK/$name.list" "$files/lib/apk/packages/$name.list"
  find "$files" -type d -exec chmod 0755 {} +
  find "$files" -type f -exec chmod 0644 {} +
  chmod 0755 "$files/usr/libexec/rpcd/luci.sing-box" "$files/usr/libexec/sing-box-panel-worker"
  fakeroot "$TOOLS_DIR/apk" mkpkg \
    --info "name:$name" --info "version:$VERSION" --info "arch:noarch" \
    --info "license:$LICENSE" --info "origin:luci-app-sing-box" \
    --info "url:https://github.com/lauyv/luci-app-sing-box" \
    --info "description:$description" --info "depends:$depends" \
    --script "post-install:$hooks/post-install" \
    --script "post-upgrade:$hooks/post-upgrade" \
    --script "pre-deinstall:$hooks/pre-deinstall" \
    --files "$files" --output "$DIST/$name-$VERSION.apk"
}

package_apk luci-app-sing-box "$MAIN" "$DEPENDS" 'sing-box 配置与服务管理面板'
