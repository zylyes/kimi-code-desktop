# Kimi Code 离线文档（Markdown 版）

> 📅 生成时间: 2026-07-27
> 📦 源文件: [kimi-docs/](../kimi-docs/) (VitePress 静态站点镜像)
> 🔧 转换脚本: [extract-docs.js](../kimi-docs/extract-docs.js)
> 🌐 官方站点: https://www.kimi.com/code/docs/

---

## 📊 概览

| 项目 | 数值 |
|------|------|
| Markdown 文档 | **39 篇** |
| 搜索页面 | 1 个 (`search.html`) |
| 搜索索引 | 1 个 (`search-index.json`) |
| 总大小 | ~400 KB |

## 📂 目录结构

```
kimi-docs-md/
├── README.md                ← 本文件
├── search.html              ← 🔍 离线全文搜索页面
├── search-index.json        ← 搜索索引数据
├── 01-overview/             ← Kimi Code 概览 (7篇)
│   ├── 产品概览.md
│   ├── 模型配置.md
│   ├── 会员权益.md
│   ├── 最新动态.md
│   ├── 社区倡议.md
│   ├── 常见问题.md
│   ├── 错误参考.md
│   └── 联系与反馈.md
├── 02-cli-guides/            ← CLI 使用指南 (7篇)
│   ├── 开始使用.md
│   ├── 从kimi-cli迁移.md
│   ├── 常见使用案例.md
│   ├── 交互与输入.md
│   ├── 会话与上下文.md
│   ├── 使用目标模式.md
│   └── 在IDE中使用.md
├── 03-cli-configuration/     ← CLI 配置 (5篇)
│   ├── 配置文件.md
│   ├── 平台与模型.md
│   ├── 配置覆盖.md
│   ├── 环境变量.md
│   └── 数据路径.md
├── 04-cli-customization/     ← CLI 定制化 (6篇)
│   ├── Model-Context-Protocol.md
│   ├── Agent-Skills.md
│   ├── Plugins.md
│   ├── Agent与子Agent.md
│   ├── Hooks.md
│   └── 自定义主题.md
├── 05-cli-reference/         ← CLI 参考 (5篇)
│   ├── kimi命令.md
│   ├── kimi-acp子命令.md
│   ├── 内置工具.md
│   ├── 斜杠命令.md
│   └── 键盘快捷键.md
├── 06-cli-release-notes/     ← 发布说明 (1篇)
│   └── 变更记录.md
├── 07-vscode/                ← VS Code 扩展 (4篇)
│   ├── 开始使用.md
│   ├── 核心操作.md
│   ├── 配置.md
│   └── 定制化.md
└── 08-third-party/           ← 第三方工具接入 (3篇)
    ├── Claude-Code.md
    ├── OpenCode.md
    └── Codex.md
```

## 🔍 使用方式

### 方式一：浏览器全文搜索（推荐）

用浏览器打开 `search.html`，输入关键词即可实时搜索所有 39 篇文档。

### 方式二：VS Code / IDE 内搜索

在 VS Code 中打开本目录，使用 `Ctrl+Shift+F` 跨文件全文搜索。

### 方式三：命令行搜索

```bash
# 使用 ripgrep
rg "关键词" docs/kimi-docs-md/

# 使用 grep
grep -r "关键词" docs/kimi-docs-md/
```

## 🔄 更新文档

1. 重新下载官方站点到 `docs/kimi-docs/`
2. 运行转换脚本:
   ```bash
   cd docs/kimi-docs
   node extract-docs.js
   ```
3. 输出自动覆盖 `docs/kimi-docs-md/`

## 📝 说明

- 文档内容来自 Kimi Code 官方文档站 (https://www.kimi.com/code/docs/)
- 原始格式为 VitePress 预渲染的 SPA 页面，经 `extract-docs.js` 转换为 Markdown
- 代码块保留原始语法高亮信息，显示为未着色纯文本
- 复杂表格保留为 HTML 格式（Markdown 表格表达能力有限）
- 所有文档均为**简体中文**版
