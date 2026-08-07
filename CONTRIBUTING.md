# 贡献指南

感谢你对 Kimi Code Desktop 的关注！欢迎任何形式的贡献。

## 行为准则

参与本项目的所有互动均需遵守[行为准则](CODE_OF_CONDUCT.md)。请先阅读。

## 如何贡献

### 报告 Bug

1. 在 [Issues](https://github.com/zylyes/kimi-code-desktop/issues) 中搜索，确认相同问题未被报告。
2. 使用 **Bug 报告** 模板提交 Issue，提供尽可能详细的信息：
   - 操作系统版本（Windows 10/11 版本号）
   - Kimi Code Desktop 版本
   - Kimi Code CLI 版本（`kimi --version`）
   - 复现步骤与预期/实际行为
   - 相关日志（`%APPDATA%\kimi-code-desktop\app.log`）

### 请求功能

1. 在 Issues 中搜索，确认功能未被请求。
2. 使用 **功能请求** 模板，描述使用场景和期望行为。
3. 功能建议也可参考 `FEATURE-IDEAS.md` 中已调研的条目。

### 提交代码

1. **Fork** 本仓库并创建功能分支：

   ```bash
   git checkout -b feature/your-feature
   ```

2. 遵循现有代码风格（JavaScript CommonJS，2 空格缩进，无分号）。

3. 确保你的更改：
   - 不影响现有功能
   - 添加了对应的单元测试（`tests/`）
   - 通过 `npm start` 验证正常运行

4. 提交前运行现有测试确保通过：

   ```powershell
   Get-ChildItem tests\test-*.js | ForEach-Object { node $_.FullName }
   ```

   或逐个运行：
   ```bash
   node tests/test-acp-client.js
   node tests/test-config-manager.js
   node tests/test-skills-manager.js
   node tests/test-session-export.js
   node tests/test-plugins-manager.js
   node tests/test-instances-manager.js
   node tests/test-ide-integration.js
   node tests/test-cli-update.js
   ```

5. 使用清晰的中文或英文提交信息。

6. Push 并创建 Pull Request，填写 PR 模板中的信息。

## 项目结构

```
src/main/     — Electron 主进程（窗口管理、IPC、ACP 协议）
src/pages/    — 原生 HTML/JS 页面
src/preload/  — Context Bridge 桥接层
src/styles/   — 共享设计令牌（kimi-theme.css）
scripts/      — 工具脚本（build/ 打包、dev/ 开发探测、archive/ 归档）
tests/        — 单元测试
docs/         — 调研文档
```

## 开发环境

- **Node.js** 18+
- **Electron** 38+
- Windows 10+ x64

```bash
npm install
npm start                # 开发运行
npm run dev              # 开发模式（--dev 标志，启用 DevTools）
npm run mock             # 启动 Mock 服务端（端口 58999）
npm run pack:versioned   # 按版本号打包（release/v<version>/）
npm run pack:versioned:ca  # 使用系统 CA 证书打包
npm run pack             # 仅本地目录打包（electron-builder --dir）
```

国内网络建议设置 Electron 镜像（见 README）。

## 代码规范

- 保持与现有代码风格一致（2 空格缩进、无分号、CommonJS）
- 日志输出使用项目统一的日志工具（已脱敏）
- 用户可见文案使用中文
- 配置变更前后验证（doctor 校验 + 失败回滚）
- 敏感信息（token、API 密钥）不得硬编码或出现在日志中
- 项目暂未引入 lint 工具，代码风格请手动自查

## 许可

贡献的代码将在 [MIT 许可证](LICENSE) 下发布。
