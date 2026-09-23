#!/usr/bin/env bash
set -euo pipefail

# shellcheck source=package-common.sh
source "$(dirname -- "${BASH_SOURCE[0]}")/package-common.sh"
DEPENDS=${DEPENDS// /, }
CONTROL="$WORK/control"
PACKAGE="$WORK/package"
mkdir -p "$CONTROL" "$PACKAGE"
cp "$HOOKS/postinst" "$HOOKS/prerm" "$CONTROL/"

cat > "$CONTROL/control" <<EOF
Package: $NAME
Version: $VERSION
Architecture: all
Depends: $DEPENDS
License: $LICENSE
Section: luci
Priority: optional
Source: https://github.com/lauyv/luci-app-sing-box
Description: $DESCRIPTION
EOF

printf '2.0\n' > "$PACKAGE/debian-binary"
tar --sort=name --owner=0 --group=0 --numeric-owner -C "$CONTROL" -czf "$PACKAGE/control.tar.gz" .
tar --sort=name --owner=0 --group=0 --numeric-owner -C "$DATA" -czf "$PACKAGE/data.tar.gz" .
(
  cd "$PACKAGE"
  ar rcsD "$DIST/luci-app-sing-box_${VERSION}_all.ipk" debian-binary control.tar.gz data.tar.gz
)
