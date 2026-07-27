> 来源: https://www.kimi.com/code/docs/third-party-tools/codex.html

# 在 Codex 中使用

[Codex](https://openai.com/zh-Hans-CN/codex/) 是 OpenAI 提供的编程 Agent。本文介绍如何通过 CC Switch，将 Codex CLI 接入 Kimi For Coding，由 Kimi K3 或 Kimi K2.7 Code 提供模型推理能力。

> **⚠️ 社区第三方接入方案，仅供参考**
>
>

CC Switch + Codex 为社区提供的第三方接入方案，内容仅供参考。该方案不在官方维护与支持范围内，我们无法保证其与各版本 Codex / CC Switch 的兼容性。如遇 API 兼容性问题，请结合您的实际环境自行排查修复，也欢迎将解决方案分享至社区。

> Codex CLI 目前支持文本和图片输入，但尚未提供原生视频输入通道，无法将视频文件直接作为多模态输入提交给模型。若需分析视频，可先用 ffmpeg 提取关键帧并配合音频转写后交给模型处理。这是 Codex CLI 输入层的限制，并非 Kimi K3 模型的能力限制——Kimi K3 API 原生支持视频输入。

## 会员权限

配置前先了解自己的会员档位，再根据下表选择合适的模型和上下文窗口参数：

<table><thead><tr><th>会员档位</th><th>可用模型</th><th>上下文窗口</th></tr></thead><tbody><tr><td>Andante</td><td>`kimi-for-coding`</td><td>256K</td></tr><tr><td>Moderato</td><td>`k3`
`k3-256k`
`kimi-for-coding`</td><td>均为 256K</td></tr><tr><td>Allegretto 及以上</td><td>`k3`
`k3-256k`
`kimi-for-coding`
`kimi-for-coding-highspeed`</td><td>`k3`：最高 1M
`k3-256k`：256K
`kimi-for-coding`：256K
`kimi-for-coding-highspeed`：256K</td></tr></tbody></table>

> **📌 模型上新推荐**
>
>

`k3-256k`全新上线，256k上下文内效果相同, `k3`（1M）消耗约为 `k3-256k` 两倍，适合日常问答、代码补全、常规功能开发、单文件或少量文件修场景，不支持视频输入。如从 `k3`（1M 版本）切换至 `k3-256k`，建议先压缩上下文再切换。

## 接入原理

Codex CLI 使用 OpenAI Responses API，而 Kimi For Coding 提供 OpenAI 兼容的 Chat Completions API。两者协议不兼容，因此需要本地路由层做请求与流式响应的双向转换：

```text
<span>Codex CLI → CC Switch（本地路由） → Kimi For Coding API
```

下文以 **CC Switch** 为例。使用 Kimi For Coding Provider 期间，请保持 CC Switch 和 Codex 路由处于运行状态。

## 准备工作

开始前，请完成以下准备：

- 按照 [Codex 官方文档](https://developers.openai.com/codex/cli) 安装 Codex CLI，并至少启动一次。
- 在 [Kimi Code 控制台](https://www.kimi.com/code/console) 创建并保存 API Key。
- 按照 [CC Switch 官方指引](https://ccswitch.io/zh/docs?section=getting-started&item=installation) 下载并安装适合当前操作系统的版本。

> > <p class="custom-block-title custom-block-title-default">WARNING

CC Switch 是第三方开源工具，不由 Kimi 维护。使用前请根据所在组织的安全与合规要求评估；API Key 以及 Codex 的请求和响应将由其本地路由处理。

完成安装后，打开 CC Switch，再按下面步骤操作。

## 第一步：开启 Codex 路由

在 CC Switch 中进入 **设置 > 路由**：

- 开启 **路由总开关**，启动本地路由服务。
- 在 **路由启用** 区域开启 **Codex**。

![开启路由总开关和 Codex 路由]

## 第二步：添加 Kimi For Coding Provider

- 返回 CC Switch 主界面，选择顶部的 **Codex** Tab。
- 点击右上角的 **+**，添加供应商。

![CC Switch 主界面，点击右上角 + 添加供应商]

<ol start="3">- 确认当前位于 **Codex 供应商** 页面，在预设供应商列表中选择 **Kimi For Coding**。

![预设供应商列表，选择 Kimi For Coding]

<ol start="4">- 填写以下配置：

<table><thead><tr><th>配置项</th><th>值</th></tr></thead><tbody><tr><td>API 请求地址（Base URL）</td><td>`https://api.kimi.com/coding/v1`</td></tr><tr><td>API Key</td><td>在 Kimi Code 控制台创建的 API Key</td></tr></tbody></table>

![填写 API Key 和 API 请求地址]

<ol start="5">- 向下滚动到 **模型映射**，点击 **获取模型列表**，CC Switch 会拉取 Kimi For Coding 当前支持的模型。然后按下表逐一填写 **菜单显示名** 和 **上下文窗口**：

> **📌 模型上新推荐**
>
>

`k3-256k`全新上线，256k上下文内效果相同, `k3`（1M）消耗约为 `k3-256k` 两倍，适合日常问答、代码补全、常规功能开发、单文件或少量文件修场景，不支持视频输入。如从 `k3`（1M 版本）切换至 `k3-256k`，建议先压缩上下文再切换。

<table><thead><tr><th>菜单显示名（建议）</th><th>实际请求模型</th><th>上下文窗口</th></tr></thead><tbody><tr><td>`K3`</td><td>`k3`</td><td>`1048576`（无 1M 权限时填 `262144`）</td></tr><tr><td>`K3-256K`</td><td>`k3-256k`</td><td>`262144`</td></tr><tr><td>`K2.7 Code`</td><td>`kimi-for-coding`</td><td>`262144`</td></tr><tr><td>`K2.7 Code HighSpeed`</td><td>`kimi-for-coding-highspeed`</td><td>`262144`</td></tr></tbody></table>

同时确认以下高级配置：

<table><thead><tr><th>配置项</th><th>值</th></tr></thead><tbody><tr><td>上游格式</td><td>`Chat Completions（需开启路由）`</td></tr><tr><td>提示词缓存路由</td><td>`自动（推荐）`</td></tr><tr><td>支持思考模式</td><td>开启（**必须开启**，关闭后 K3 和 K2.7 Code 都会被路由到 K2.6）</td></tr><tr><td>支持思考等级</td><td>开启</td></tr></tbody></table>

<ol start="6">- 确认无误后，点击右下角的 **添加**。

![高级配置：上游格式、思考能力、模型映射]

## 第三步：启用 Kimi For Coding Provider

添加完成后返回 Codex 供应商列表，在刚添加的 Kimi For Coding Provider 上点击 **启用**。

![在 Codex 供应商列表中启用 Kimi For Coding]

启用后请确认：

- Kimi For Coding 是 Codex Tab 中当前启用的 Provider；
- CC Switch 的本地路由正在运行；
- Codex 路由开关处于开启状态。

## 第四步：启动 Codex CLI

如果 Codex CLI 已经在运行，请先退出当前会话。然后进入需要使用的项目目录，重新启动 Codex CLI：

```bash
cd /path/to/your/project
codex
```

重启是为了让 Codex CLI 加载 CC Switch 写入的最新 Provider 和模型配置。

启动后，先确认 Codex CLI 顶部显示的模型为 `k3-256k`（或你选用的模型），然后发送一个简单请求：

```text
<span>hello
```

如果 Codex CLI 正常返回结果，并且底部状态栏显示 `k3-256k`（或你选用的模型），说明配置已生效。

![在 Codex CLI 中验证 k3 已生效]

也可以查看 CC Switch 的路由请求数或请求日志，确认其中出现了新的 Codex 请求。

## 切换思考程度（effort）

K3 支持 `low` / `high` / `max` 三档思考程度。在 Codex CLI 会话中，输入 `/model` 重新选中当前模型，然后在 **Select Reasoning Level** 菜单中选择档位：

![Codex CLI 中选择 Reasoning Level]

Codex 展示的档位与 K3 实际 effort 的映射关系如下（完整映射规则见 [模型配置](kimi-code/models.html#switch-model)）：

<table><thead><tr><th>Codex Reasoning Level</th><th>K3 实际 effort</th></tr></thead><tbody><tr><td>Low</td><td>`low`</td></tr><tr><td>Medium (default)</td><td>`high`（推荐）</td></tr><tr><td>High</td><td>`high`（推荐）</td></tr><tr><td>Extra high</td><td>`max`</td></tr></tbody></table>

切换档位后建议新建会话，避免旧上下文缓存失效带来的额外消耗。

## 常见问题

### Codex 启动后仍使用原模型

CC Switch 写入的配置未生效，或 Codex CLI 未重启。退出当前 Codex 会话后重新启动，并确认 CC Switch 的本地路由处于运行状态。

### 无法连接本地路由地址

CC Switch 未启动，或 Codex 路由开关未打开。启动 CC Switch，检查 **设置 > 路由** 中的总开关和 Codex 开关是否都已开启。

### 返回 401 或鉴权错误

API Key 未配置、过期，或当前套餐权限不足。在 [Kimi Code 控制台](https://www.kimi.com/code/console) 重新生成 API Key，并确认套餐支持所选模型（见上方[会员权限](#会员权限)表）。

### 请求格式或流式响应报错

上游格式未设为 Chat Completions，或路由未开启。在 Provider 高级配置中确认 **上游格式** 为 `Chat Completions（需开启路由）`。

### 模型参数报错

Kimi 模型对部分采样参数有固定要求。不要在 CC Switch 中强行覆盖 `temperature`、`top_p`、`n` 等字段。

## 下一步

- [模型配置](kimi-code/models.md) — 查看模型的能力对比和完整 effort 映射表
- [会员权益](kimi-code/membership.md) — 确认可用模型与档位要求
