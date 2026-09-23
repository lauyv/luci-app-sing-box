#!/usr/bin/env bash
set -euo pipefail

: "${TOOLS_DIR:?Set TOOLS_DIR to the directory containing apk}"
TOOLS_DIR=$(cd "$TOOLS_DIR" && pwd)
# shellcheck source=package-common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/package-common.sh"

{ printf '#!/bin/sh\nexport PKG_UPGRADE=1\n'; tail -n +2 "$HOOKS/postinst"; } > "$HOOKS/post-upgrade"
mkdir -p "$DATA/lib/apk/packages"
(cd "$DATA"; find . -type f -printf '/%P\n' | sort) > "$WORK/$NAME.list"
install -m 0644 "$WORK/$NAME.list" "$DATA/lib/apk/packages/$NAME.list"
fakeroot "$TOOLS_DIR/apk" mkpkg \
  --info "name:$NAME" --info "version:$VERSION" --info "arch:noarch" \
  --info "license:$LICENSE" --info "origin:$NAME" \
  --info "url:https://github.com/lauyv/luci-app-sing-box" \
  --info "description:$DESCRIPTION" --info "depends:$DEPENDS" \
  --script "post-install:$HOOKS/postinst" \
  --script "post-upgrade:$HOOKS/post-upgrade" \
  --script "pre-deinstall:$HOOKS/prerm" \
  --files "$DATA" --output "$DIST/$NAME-$VERSION.apk"
