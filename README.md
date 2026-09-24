# sing-box for LuCI

适用于 OpenWrt 的 sing-box 管理页面，可在 LuCI 中编辑 JSON 配置、校验并应用配置、控制服务和查看系统日志。项目还提供独立打开的裁剪版 zashboard，用于查看概览、代理、连接和实时日志。

本项目是 sing-box 的管理界面。路由规则、入站、出站和 API 监听地址仍由 sing-box 配置文件决定；安装本插件不会自动创建代理配置或开放 API 端口。

## 快速设置

安装后重新登录 LuCI，进入 **服务 → sing-box**，按以下顺序操作：

1. 在**配置**页上传本地 JSON、从 URL 拉取配置，或直接编辑。导入后先确认页面内容，再点击**校验**；导入本身不会保存到路由器。
2. 点击**保存并应用**。页面会把内容写入 UCI `conffile` 指向的文件，使用已安装的 sing-box 校验，然后重启服务。也可以只点**保存**，稍后再应用。
3. 在**服务**页查看运行状态、配置路径和内核版本；按需开启**开机启动**。
4. 服务启动后，点击**运行面板 → 独立打开**，填写浏览器可以访问的 sing-box API 地址、端口和密钥。独立面板不会自动读取密钥。

配置文件最大为 **64 KiB**，按 UTF-8 字节数计算。**格式化 JSON** 只修改编辑框；**校验**使用临时文件，不保存也不重启。**保存并应用**会先保存再校验；如果校验失败，已保存的文件仍会保留，服务不会重启。请根据页面显示的错误修改后重新应用。

### 服务配置

面板读取 `/etc/config/sing-box` 中的 `main` 节，例如：

```uci
config sing-box 'main'
        option enabled '1'
        option conffile '/etc/sing-box/config.json'
        option workdir '/usr/share/sing-box'
        option log_stderr '1'
```

| 选项 | 用途 |
| ---- | ---- |
| `enabled` | 服务启动开关；启动、重启或应用时设为 `1` |
| `conffile` | 面板直接读写的 JSON 文件，须使用绝对路径 |
| `workdir` | sing-box 工作目录，须使用绝对路径 |
| `log_stderr` | stderr 日志收集选项，实际效果取决于设备上的启动脚本 |
| `user` | 面板新建配置文件时使用的所有者；未设置时按 root 处理 |

面板使用 `/usr/bin/sing-box` 和 `/etc/init.d/sing-box`。配置文件父目录须已存在；保存现有文件会保留其所有者和权限，新建文件权限为 `0600`。**开机启动**同时启用 init 启动链接并设置 `enabled=1`；取消勾选只禁用启动链接。**停止**不会修改开机启动设置。

## 安装

### 通过 apk-repository 软件源安装

[lauyv/apk-repository](https://github.com/lauyv/apk-repository) 提供签名的 `sing-box` 和 `luci-app-sing-box` APK，适用于 OpenWrt 25.12 的 `aarch64_generic` 和 `x86_64`。其他架构及 `opkg` 系统请使用下方的安装方式。先在路由器上运行 `cat /etc/apk/arch`，确认设备架构。

1. 通过 SSH 下载公钥并显示指纹：

   ```sh
   wget -O /tmp/apk-repository.pem 'https://lauyv.github.io/apk-repository/apk/apk-repository.pem'
   sha256sum /tmp/apk-repository.pem
   ```

   将输出与维护者提供的可信指纹核对，确认一致后安装公钥：

   ```sh
   mkdir -p /etc/apk/keys
   mv /tmp/apk-repository.pem /etc/apk/keys/apk-repository.pem
   ```

2. 在 LuCI 的 **系统 → 软件包 → 配置** 中打开 `/etc/apk/repositories.d/customfeeds.list`，保留原有内容，另起一行添加与设备架构对应的地址：

   | 架构 | `latest` 软件源地址 |
   | ---- | ----------------- |
   | `aarch64_generic` | `https://lauyv.github.io/apk-repository/apk/latest/aarch64_generic/packages.adb` |
   | `x86_64` | `https://lauyv.github.io/apk-repository/apk/latest/x86_64/packages.adb` |

3. 保存配置并**更新列表**，在 **系统 → 软件包 → 可用** 中搜索 `luci-app-sing-box`，核对版本和来源后安装。保留系统官方软件源，以便安装其他依赖。

`latest` 包含上游预发布版；只需要正式版时，把地址中的 `latest` 改为 `stable`。同一时间只添加一个本仓库通道。首次订阅、从其他来源切换软件包及更新的完整步骤见 [apk-repository README](https://github.com/lauyv/apk-repository#readme)。

### 安装 GitHub Release 软件包

[Releases](https://github.com/lauyv/luci-app-sing-box/releases) 提供未签名的 APK 和 IPK。APK 面向兼容的 `apk` 系统，IPK 面向兼容的 `opkg` 系统；具体固件的兼容性需在设备上验证。把安装包复制到路由器的 `/tmp` 后，执行对应命令：

```sh
# APK 系统
apk add --allow-untrusted /tmp/luci-app-sing-box-*.apk

# opkg 系统
opkg install /tmp/luci-app-sing-box_*.ipk

/etc/init.d/rpcd restart
```

依赖包括 `luci-base`、`sing-box`、`rpcd`、`jshn`、`jsonfilter` 和 `uclient-fetch`，由设备匹配的软件源安装。操作锁使用系统自带的 `flock` 命令；精简固件若未提供该命令，需要启用 BusyBox flock 或安装对应软件包。安装后重新登录 LuCI；升级后若仍显示旧界面，请强制刷新浏览器。

### 在固件构建树或 SDK 中编译

先在本仓库运行 `bash dashboard/build.sh` 生成运行面板静态资源；构建主机需要 Node.js 24、pnpm 11.20.0 及脚本所列工具，路由器不需要 Node.js。然后在 Linux 上将本项目放入与目标固件匹配的 OpenWrt 源码树或 SDK 的 `package/luci-app-sing-box`，打开构建菜单：

```sh
make menuconfig
```

在菜单中选择 **LuCI → Applications → luci-app-sing-box**，保存后编译：

```sh
make package/luci-app-sing-box/compile V=s
```

生成的包位于 `bin/packages/` 下；包格式由源码树或 SDK 决定。构建运行面板的详细要求见 [dashboard/README.md](dashboard/README.md)。

## 运行面板

独立页面地址为 `http://路由器地址/luci-static/sing-box/dashboard/index.html`，也可以从 LuCI 的**服务**页打开。它提供概览、代理、连接和实时日志四页，仅连接 sing-box 原生 API。页面是静态资源，通常无需 LuCI 登录；数据和操作由 sing-box API 的密钥独立认证。LuCI 的只读权限不适用于该 API。

API 地址必须能从**当前浏览器**访问。跨源访问需要相应 CORS 设置；通过 HTTPS 打开的页面需要可访问的 HTTPS API。连接地址和密钥保存在当前浏览器的 localStorage；清除站点数据或在面板中删除连接可移除这些信息。sing-box 停止时页面仍能打开，但无法取得运行数据。

运行面板中的日志来自 API；LuCI 的**系统日志**通过 `logread` 读取启动和运行日志。面板固定使用裁剪版 zashboard v3.22.0，随插件更新，不提供上游自更新入口。裁剪内容与构建方式见 [dashboard/README.md](dashboard/README.md)。

## 清理缓存

在 **服务 → 维护缓存 → 清理缓存** 中确认后执行。面板只读取已保存配置的 `experimental.cache_file`，且仅在 `enabled: true` 时提供操作；路径留空时使用 `cache.db`，相对路径按 UCI `workdir` 解析。

弹窗会显示工作目录和缓存文件的实际路径。操作先停止服务并确认进程退出，再删除该缓存文件；**不会备份旧缓存**。可选择完成后启动服务，新缓存由 sing-box 启动时生成。若启动失败，旧缓存无法恢复。

为避免误删，面板只接受 `/usr/share/sing-box`、`/var/lib/sing-box`、`/tmp/sing-box` 三个已存在且路径各级没有符号链接的专用工作目录。缓存须是目录内的普通文件，不能是配置文件、链接或挂载点。部分 OpenWrt 的 `/var` 是符号链接，此时 `/var/lib/sing-box` 会被拒绝。缓存不存在或配置未启用缓存时无需清理。

## 运行与排查

**系统日志**页显示最近 200 行 sing-box 日志，最多 24 KiB；停留在该页时每 5 秒刷新，可通过 LuCI 刷新开关暂停。能否收集到 sing-box 输出取决于设备启动脚本及日志配置。如果 JSON 设置了 `log.output`，日志可能写入文件；设置 `log.disabled: true` 时，sing-box 日志会关闭。

```sh
/etc/init.d/sing-box status
uci show sing-box.main
sing-box check -c /etc/sing-box/config.json -D /usr/share/sing-box
logread -e sing-box
```

最后两条命令中的配置路径和工作目录应按本机 UCI 设置调整。页面校验同样使用已安装的 sing-box 内核及工作目录。若页面提示配置已变化，先**重载配置**，再继续编辑；此提示用于避免覆盖其他窗口或 SSH 写入的内容。

配置路径或工作目录异常时，仍可停止服务并查看日志。只读账号可查看状态、配置和日志，不能编辑、校验或控制服务。临时任务数据位于 `/tmp/sing-box-panel/`，设备重启后清除；操作锁由进程退出时自动释放，不要因锁文件存在而手动删除它。

## 致谢

感谢 [Zephyruso/zashboard](https://github.com/Zephyruso/zashboard) 的作者和贡献者。本项目的运行面板基于 zashboard v3.22.0 裁剪和适配；具体改动与构建方式见 [dashboard/README.md](dashboard/README.md)。

## 许可证

本项目采用 [MIT 许可证](LICENSE)。运行面板保留 zashboard 上游的 MIT 许可证。
