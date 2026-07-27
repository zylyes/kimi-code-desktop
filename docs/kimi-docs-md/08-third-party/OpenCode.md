> 来源: https://www.kimi.com/code/docs/third-party-tools/opencode.html

# 在 OpenCode 中使用

[OpenCode](https://opencode.ai/) 是一款终端编程 Agent。本文介绍如何通过内置认证把 OpenCode 的模型请求转发到 Kimi For Coding，由 Kimi K3 或 Kimi K2.7 Code 提供模型推理能力。

## 安装 OpenCode

通过安装脚本是最简单的安装方式：

```bash
curl -fsSL https://opencode.ai/install | bash
```

也可通过 npm 安装：

```bash
npm install -g opencode-ai
```

## 配置 API 密钥

运行 `opencode auth login`，在提供商列表中选择 **Kimi For Coding**：

```bash
$ opencode auth login
┌  添加凭证
│
◆  选择提供商
│  ● Kimi For Coding
│  ...
└
```

输入你的 Kimi For Coding API Key：

```bash
$ opencode auth login
┌  添加凭证
│
◇  选择提供商
│  Kimi For Coding
│
◇  输入您的 API 密钥
│  _
└
```

> API Key 可在 [Kimi Code 控制台](https://www.kimi.com/code/console) 创建和管理（最多 5 个，仅创建时显示一次，请妥善保存）。

## 启动并使用

配置完成后启动 OpenCode：

```bash
$ opencode
```

在会话中输入 `/models`：

```bash
/models
```

在 **Kimi For Coding** 列表下选择要用的模型：

- **Kimi K3**（`k3`）：当前最强旗舰模型
- **Kimi K3-256K**（`k3-256k`）：`k3-256k`全新上线，256k上下文内效果相同, `k3`（1M）消耗约为 `k3-256k` 两倍，适合日常问答、代码补全、常规功能开发、单文件或少量文件修场景，不支持视频输入。
- **Kimi K2.7 Code**（`kimi-for-coding`）：成熟稳定的 Coding 模型
- **Kimi For Coding HighSpeed**（`kimi-for-coding-highspeed`）：K2.7 Code 高速版

> **📌 模型上新推荐**
>
>

`k3-256k`全新上线，256k上下文内效果相同, `k3`（1M）消耗约为 `k3-256k` 两倍，适合日常问答、代码补全、常规功能开发、单文件或少量文件修场景，不支持视频输入。如从 `k3`（1M 版本）切换至 `k3-256k`，建议先压缩上下文再切换。

使用前请了解自己的会员档位与可用权限，使用超出权限的模型和上下文会触发报错：

<table><thead><tr><th>会员档位</th><th>可用模型</th><th>上下文窗口</th></tr></thead><tbody><tr><td>Andante</td><td>Kimi K2.7 Code</td><td>256K</td></tr><tr><td>Moderato</td><td>Kimi K3
Kimi K3-256K
Kimi K2.7 Code</td><td>均为 256K</td></tr><tr><td>Allegretto 及以上</td><td>Kimi K3
Kimi K3-256K
Kimi K2.7 Code
Kimi For Coding HighSpeed</td><td>Kimi K3：最高 1M
Kimi K3-256K：256K
Kimi K2.7 Code：256K
Kimi For Coding HighSpeed：256K</td></tr></tbody></table>

选中 K3 后，可输入 `/variants` 切换思考程度（effort）：

```bash
/variants
```

> **📌 思考程度（effort）映射**
>
>

OpenCode 可选的 variant 有 `Default` / `low` / `high` / `max`，会按下表映射到 K3 实际档位（完整映射表见 [模型配置](kimi-code/models.html#switch-model)）：

<table><thead><tr><th>OpenCode variant</th><th>K3 实际 effort</th></tr></thead><tbody><tr><td>`Default`</td><td>`high`（K3 默认值）</td></tr><tr><td>`low`</td><td>`low`</td></tr><tr><td>`high`</td><td>`high`（推荐）</td></tr><tr><td>`max`</td><td>`max`</td></tr></tbody></table>

当前 Kimi K3 支持 `low` / `high` / `max` 三档；Kimi K2.7 Code 系列无需配置该字段。

模型能力与配置细节见 [模型配置](kimi-code/models.md)。

## 下一步

- [模型配置](kimi-code/models.md) — 查看模型的能力对比和完整 effort 映射表
- [会员权益](kimi-code/membership.md) — 确认可用模型与档位要求
