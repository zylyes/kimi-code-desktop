### 新功能

- **运行时状态层**：WS/ACP 事件统一规范化（任务状态机 + 会话分桶用量）。
- **任务目录**：运行时 + ACP 观察 + 磁盘三源合并，带诊断计数。
- **子 Agent 树**：从运行时快照构建子 Agent 层级树。
- **用量统计**：会话分桶 + 托管用量拉取（OAuth）。
- **CLI 更新模块**：托管更新流程。
- **本地命令服务**：本地命令执行。

### 改进

- **ACP 原生聊天窗扩展**：任务目录/子 Agent 树渲染、运行时状态可视化（+1033 行）。
- **setup.html**：CLI 更新与用量配置入口（+151 行）。
- 托盘状态改由 RuntimeState 快照提供。

### 其他

- 新增 7 套单元测试（runtime-state/task-catalog/subagent-tree/usage-stats/cli-update/local-command-service/managed-usage）
- 无破坏性变更

📦 下载：见下方附件（NSIS 安装包 / 便携版 / 7z 自解压）
