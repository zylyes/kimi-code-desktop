# 获取支持

## 文档

- [README](README.md) — 项目概述、安装、使用方式、快捷键、文件结构
- [CHANGELOG](CHANGELOG.md) — 自 v0.1.0 以来的完整版本变更历史
- [RELEASE_NOTES](RELEASE_NOTES.md) — 当前版本发行说明

## 遇到问题？

1. **查看 FAQ**：常见问题（认证错误、CLI 版本适配、网络代理等）在应用内的排查卡片中有说明。
2. **搜索已有 Issues**：[GitHub Issues](https://github.com/zylyes/kimi-code-desktop/issues?q=is%3Aissue)
3. **提交新 Issue**：使用 Bug 报告模板，附上 `%APPDATA%\kimi-code-desktop\app.log` 日志。

## 诊断工具

应用内置的诊断功能可帮助定位问题：

- **kimi doctor**：菜单栏「帮助→运行 kimi doctor」或设置页「环境诊断」按钮
- **维护面板**：设置页「维护」标签，支持 CLI 更新检查、数据目录清理、诊断打包
- **开发模式**：`npm run dev` 以 `--dev` 标志启动，启用 DevTools，用于排查渲染层问题
- **Mock 验证**：`npm run mock` 启动测试用 Mock 服务端（端口 58999），用于验证核心流程

## 功能建议

功能请求和建议请使用 Issue 模板提交。已调研的功能建议记录在 [FEATURE-IDEAS.md](FEATURE-IDEAS.md)。

## 安全漏洞

安全漏洞请通过 [Security Advisory](https://github.com/zylyes/kimi-code-desktop/security) 私下报告，详见 [SECURITY.md](SECURITY.md)。
