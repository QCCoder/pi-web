# 上游许可与客户端边界

## pi-web 能否改造

可以。仓库根目录的 `LICENSE` 是 MIT License，明确允许使用、复制、修改、合并、发布、分发、再许可和销售软件副本。分发修改版或包含其重要部分的产品时，必须保留原版权声明和 MIT 许可文本。

MIT 许可不提供质量、适销性、特定用途适用性或不侵权保证。正式商业分发前还应对 npm 依赖、图标、字体和自有品牌素材分别做一次许可证清单；pi-web 的 MIT 许可不能替代第三方依赖许可。

本次改造保留了原仓库 `LICENSE`，没有改变上游版权声明。

## 能否打包为 iOS、Android、Windows、macOS

法律上，MIT 许可不阻止原生打包。技术上也可以用 WebView、Tauri、Electron、Capacitor 等容器加载 Pi Workspace。

但 Pi Agent 实际运行在 Linux 服务器时，客户端只是私网 Web 页的壳，仍依赖：

- 手机或桌面设备能够连接 Tailscale、WireGuard 等私网；
- WebView 支持 SSE、文件上传、剪贴板与安全区域；
- 服务器持续在线并保存 Pi 与 Workspace 数据；
- 客户端不绕过服务端的 Host / Origin 安全检查。

MVP 不制作原生客户端。PC 和手机直接使用响应式 Web 页面，避免同时维护四个平台。将来确有离线能力、系统分享入口、推送或应用商店分发需求时，再增加薄客户端；Pi Agent 仍留在服务器端，不把高权限执行环境放进手机 WebView。
