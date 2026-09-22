# 裁剪版 zashboard

固定上游 [v3.22.0](https://github.com/Zephyruso/zashboard/tree/v3.22.0)，保留概览、代理、连接、日志及必要的后端连接设置。仅支持 sing-box 原生 API，Clash REST/WebSocket 实现不再打包。

`trim.patch` 是相对该版本源码的补丁。源码归档通过 SHA-256 校验，依赖使用上游 `pnpm-lock.yaml`；不修改压缩后的发布文件。补丁保留原页面组件及其功能依赖，移除其他页面的路由与导入，未引用组件由构建器排除。

改动包括：

- 用紧凑的四页导航替换侧栏和移动端底栏，保留后端管理；语言仅保留简体中文和英文，旧繁中偏好迁移为简中，其他不支持的语言回退为英文。
- Tailwind 仅扫描应用入口可达的本地源码（含静态、动态导入），保留条件状态和响应式类名；关闭无用 daisyUI 组件，清除已删除导航样式。构建检查所有打包的本地代码均在 CSS 扫描范围内。
- 删除规则、工具、全局设置页的路由及通往这些页面的按钮。
- 删除概览中的“全球连接”及卡片设置入口，清除浏览器旧卡片配置中的对应条目；地球渲染器、纹理和定位 Worker 不再打包。
- 移除升级、配置更新弹窗与入口，禁用内核和面板升级能力；关闭上游更新检查、设置自动同步及弃用提示。
- 不生成 PWA / Service Worker，删除 PWA 及 Apple Touch 图标，资源更新随插件安装包发布。
- 只保留 light / dark 主题；旧主题偏好回退为浅色 / 深色，保留随系统切换。
- 删除 Clash API 分支及订阅更新、Smart 封锁、反向 DNS 请求等专属入口。旧存档只保留原生 sing-box 连接；若当前选中的是 Clash 连接，返回连接设置，不自动转换地址。
- 使用系统正文字体，仅保留本地 Twemoji 国旗字体，无字体 CDN 请求。
- 新建连接默认填写当前网页主机；类型固定为 sing-box 原生 API，用户填写端口及密钥。
- 保留上游 MIT 许可证，随生成文件安装为 `LICENSE.zashboard`。

与同版本上游 [v3.22.0 的 dist-cdn-fonts.zip](https://github.com/Zephyruso/zashboard/releases/download/v3.22.0/dist-cdn-fonts.zip) 相比，静态文件总量从 5,629,120 字节（约 5.63 MB）降至 2,062,463 字节（约 2.06 MB），减少 **63.4%**。两者均按全部文件的未压缩大小统计，不是 ZIP 或 APK 大小；上游通过 CDN 加载的外部字体不计入。

## 构建

构建主机需要 Node.js 24、pnpm 11.20.0、curl、tar、patch，以及 sha256sum 或 shasum。路由器不需要 Node.js / pnpm。

```sh
bash dashboard/build.sh
```

脚本下载、校验、应用补丁、安装锁定依赖，对应用入口的完整依赖链和声明文件进行 Vue/TypeScript 检查，对构建配置进行 TypeScript 检查；Vite 构建检查最终 JS 模块，禁止混入 Clash API 实现。全部通过后，输出到 `htdocs/luci-static/sing-box/dashboard/`。源码归档缓存在被忽略的 `.dashboard-build/`，生成资源也不提交 Git。每次构建使用独立临时目录，退出时自动删除解压源码、依赖和中间产物，仅保留归档缓存和最终静态资源。

GitHub 发布工作流会先运行此脚本。OpenWrt SDK 构建前也需在本仓库运行；缺少生成资源时打包会报错，不会生成缺少面板的安装包。

## 浏览器验证

构建后，可用本机 Chromium 系浏览器运行：

```sh
BROWSER_BIN=/path/to/chromium node dashboard/smoke.mjs
```

测试使用临时浏览器配置和本地模拟 **sing-box 原生 API**（`daemon.StartedService`）：一元请求走 gRPC-Web/Protobuf，订阅走 `grpc-websockets`，并校验 Bearer 认证、订阅请求和节点切换参数。模拟协议字段取自固定 v3.22.0 源码的 `src/gen/daemon/started_service_pb.ts`，实现位于 `mock-singbox.mjs`。

覆盖版本和启动时间、模式查询、代理组和出站订阅、节点切换、状态/流量、连接及日志订阅；同时检查原生连接表单提交、旧连接、主题及语言迁移、中英文切换、导航和弹窗样式、唯一国旗字体、两种主题、无 PWA 图标、四页导航、被移除的路由、手机窄屏、iframe 共享连接设置，以及未注册 Service Worker、未发送升级请求。原生测试断言所需 RPC 确实被调用，且没有调用 Clash 端点。

测试通过浏览器请求拦截仅允许临时本地模拟服务器，阻止访问默认端口的真实服务及外部网络；不替代真实 sing-box / OpenWrt 设备联调。测试结束后清理临时浏览器配置，不保留测试截图。

## 访问与认证

- LuCI：服务 → sing-box → 运行面板，iframe 中只加载一个实例。
- 独立：`http://路由器地址/luci-static/sing-box/dashboard/index.html`，也可用服务器支持的 HTTPS。
- 直接打开静态页面通常不要求 LuCI 登录；API 使用自身的 secret 认证，与 LuCI ACL 独立。LuCI 不自动读取或传递配置中的密钥。
- 后端地址、密钥和偏好沿用上游保存在当前浏览器的 localStorage；相同协议、主机和端口下，内嵌和独立访问共享设置。清除站点数据或在后端管理中删除连接可移除保存的连接。
- API 地址必须能从浏览器访问，不能将路由器的 `127.0.0.1` 当成浏览器可访问地址。不同源需要 API 允许面板所在源；HTTPS 页面需使用可访问的 HTTPS API。本项目没有新增反向代理或开放防火墙端口。
- sing-box 停止时静态页面仍可打开，但运行数据不可用；启动失败信息应查看 LuCI 的系统日志。

## 维护补丁

从同一校验通过的归档解压干净副本，将改动整理为 `a/`、`b/` 路径的 unified diff 更新 `trim.patch`，再运行构建脚本。升级上游时同时修改版本、归档摘要和补丁，并验证四个页面及 sing-box 原生 API 的兼容性。
