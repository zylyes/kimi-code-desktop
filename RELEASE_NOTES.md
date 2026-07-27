### 改进

- **移除旧版 CLI（< 0.28）兼容代码**：不再向后兼容 0.27 及更早版本，启动检测到过旧 CLI 时提示升级；实例管理移除 `server/lock` 旧格式回退，仅使用新版格式。
- **文档重整**：删除内部开发文档（FEATURE-IDEAS.md、ACP 探测输出/调研），新增公开文档（ROADMAP.md、kimi-docs 参考文档、regression-0.29 回归测试）。

### 其他

- 新增 `scripts/regression-0.29.js`（CLI 0.29 回归测试）与 `scripts/ws-event-probe.js`（WS 事件探测）
- 无破坏性变更

📦 下载：见下方附件（NSIS 安装包 / 便携版 / 7z 自解压）
