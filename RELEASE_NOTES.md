### 新功能

- **ACP 原生聊天斜杠命令菜单**：`available_commands_update` 全量转发至渲染层（commands 事件载荷改为 `{type:'commands', count, commands:[{name, description, hint}]}`，hint 无值时为 `''`）；输入 `/` 触发前缀过滤弹窗，键盘上下键 + Enter 与鼠标点击均可选中插入；命令作为普通文本 prompt 发送，由 agent 原样执行。
- **ACP 原生聊天图片输入**：composer 新增圆形附件按钮（回形针图标），系统选图后以 base64 图片块（`{type:'image', data, mimeType}`）随 prompt 发送（图片块在前、文本块在后）；mimeType 白名单 image/png、image/jpeg、image/gif、image/webp，单张解码后 ≤10MB，一次 ≤4 张（超限跳过并提示）；textarea 上方缩略图 chips 可单张移除，用户气泡内嵌图片预览；CSP 放行 `img-src data:`。
- **WebView 降级入口**：聊天窗状态条右侧新增「Web UI」小按钮，一键聚焦主窗高级面板，原生聊天能力缺失场景可随时降级回 Web UI。

### 其他

- `acp-client.js` 的 `prompt()` 签名扩展为 `prompt(text, images)`（images 可选，元素 `{mimeType, data(base64)}`；不传 images 时行为与现状完全一致）
- 新增 IPC 通道 `acp-chat:pick-images`（系统选图 + 白名单/大小/数量校验，返回 `{ok, images, skipped}`）与 `acp-chat:open-webui`（聚焦主窗）；`acp-chat:prompt` 现接收 `(text, images)`
- preload `window.kimiChat` 新增 `sendPrompt(text, images)`/`pickImages()`/`openWebUI()`（start/setConfig/cancel/onEvent 保持现状）；chat.html 新增 slashMenu/attachBtn/chips/webuiBtn
- 新增 `scripts/acp-probe4.js`（第四次 ACP 探测：图片块 prompt 往返，验证 agent 识图）
- 已知限制：probe4 实测本机 CLI 0.27.0 虽声明 `promptCapabilities.image:true`，但图文 prompt 会致 `kimi acp` 子进程崩溃（0xC0000409）或挂起无响应（docs/acp-probe4-output.txt）；图片输入链路已按协议完整实现并带失败引导（提示改走 Web UI），待 CLI 修复后重跑 `node scripts/acp-probe4.js` 复测
- 无破坏性变更

📦 下载：见下方 `KimiCodeDesktop-Portable.exe`
