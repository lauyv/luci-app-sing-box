include $(TOPDIR)/rules.mk

LUCI_TITLE:=sing-box 配置与服务管理面板
LUCI_DEPENDS:=+luci-base +sing-box +rpcd +jshn +jsonfilter +uclient-fetch
LUCI_PKGARCH:=all

PKG_LICENSE:=MIT
PKG_RELEASE:=1

# Optional version override for SDK or firmware source builds.
ifneq ($(LUCI_SING_BOX_VERSION),)
  PKG_VERSION:=$(LUCI_SING_BOX_VERSION)
endif

define Build/Prepare/luci-app-sing-box
	test -s $(CURDIR)/htdocs/luci-static/sing-box/dashboard/index.html || \
		{ echo "Run bash dashboard/build.sh before building the LuCI package" >&2; exit 1; }
	chmod 0755 $(PKG_BUILD_DIR)/root/usr/libexec/rpcd/luci.sing-box \
		$(PKG_BUILD_DIR)/root/usr/libexec/sing-box-panel-worker
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
