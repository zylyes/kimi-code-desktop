# Kimi Code Desktop

Kimi Code 网页版（`kimi web`）的桌面套壳应用。基于 Electron，打开后自动启动 `kimi web` 本地服务，捕获带 token 的会话地址并在桌面窗口中打开，无需再手动复制链接到浏览器。

## 直接使用（已打包）

从 [Releases](https://github.com/zylyes/kimi-code-desktop/releases) 下载最新 `KimiCodeDesktop-Portable.exe` 即可运行（绿色便携版，无需安装）。

## 工作方式

1. 启动后自动探测 Kimi Code CLI（默认 `%USERPROFILE%\.kimi-code\bin\kimi.exe`），运行 `kimi web --no-open`。
2. **CLI 版本自动适配**：自动检测 CLI 版本号——v0.28+ 使用新版参数（不含 `--foreground`），旧版自动添加 `--foreground` 确保前台运行。
3. **双通道地址捕获**：优先读取 `~/.kimi-code/server.token` 文件拼合 `http://127.0.0.1:端口/#token=token` 地址；stdout 正则解析作为兜底，兼容旧版 CLI。
4. **就绪探测（HTTP 轮询）**：捕获端口后轮询 `GET /openapi.json` 直到 HTTP 200 再加载页面，消除时序竞争导致的白屏。
5. **优雅退出**：先 `POST /api/v1/shutdown` 发送关闭请求并等待 5 秒，超时后强杀回退，避免会话数据写损。
6. **重启互斥**：连续触发重启时自动合并为单次执行，防止重复启停。
7. **日志脱敏**：所有日志自动过滤 token、Authorization 头、完整带 fragment URL，防止敏感信息泄漏。
8. 若自动启动失败（未找到 CLI / 超时 / 服务中途停止等），会进入设置页：
   - **浏览…**：手动选择已有的 `kimi.exe`；
   - **在线安装**：选择安装文件夹（默认 `%USERPROFILE%\.kimi-code`），一键运行官方安装脚本，完成后自动连接；
   - 或切换到"手动填写"，粘贴已在终端启动的会话地址。
9. 登录状态、窗口大小位置持久保存。

## 快捷键与菜单

按 `Alt` 显示菜单栏。

| 功能 | 快捷键 |
|---|---|
| 新建 Web 会话 | `Ctrl+Shift+N` |
| 手动输入地址 | `Ctrl+L` |
| 重新加载 | `Ctrl+R` |
| 窗口置顶 | `Ctrl+T` |

## 系统托盘

应用常驻系统托盘，关闭或最小化窗口都不会退出：

- **最小化 / 点 X** → 收进托盘，Web 会话保持运行
- **单击托盘图标** → 秒回窗口（会话原样恢复）
- **双击托盘图标** → 秒开新 Web 会话
- **右键托盘图标** → 显示主窗口 / 新建 Web 会话 / 退出

首次收进托盘时会弹出气泡提示。真正退出请用托盘菜单或应用菜单中的"退出"。

## 从源码运行 / 重新打包

```bash
npm install        # 安装依赖
npm start          # 开发运行
npm run dist       # 打包便携版 exe 到 release/
```

国内网络建议设置镜像：

```bash
ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ \
ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/ \
npm install
```

## 数据目录

配置与日志位于 `%APPDATA%\kimi-code-desktop\`：

- `config.json` — 启动模式 / CLI 路径 / 手动地址
- `app.log` — 启动与捕获日志（已脱敏）
- `window-state.json` — 窗口位置尺寸

## 文件结构

```
main.js       Electron 主进程（CLI 版本检测、双通道地址捕获、HTTP 轮询就绪探测、优雅退出、IPC）
preload.js    渲染进程桥接
loading.html  启动等待页（实时显示 CLI 日志）
setup.html    设置页（自动/手动两种连接方式）
assets/       应用图标
CHANGELOG.md  版本变更历史
FEATURE-IDEAS.md  功能建议报告与实施状态
```