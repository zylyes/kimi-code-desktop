> 来源: https://www.kimi.com/code/docs/third-party-tools/claude-code.html

# Claude Code

> [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 是 Anthropic 提供的编程 Agent 产品，界面、配置项和支持能力可能随版本变化。本文说明一种通用接入方案：通过环境变量将 Claude Code 的模型请求转发到 Kimi Code API。

## 开始之前

- 确保你已经订阅 [Kimi 会员](https://www.kimi.com/membership/pricing?from=)并开通 Kimi Code 权益。
- 获取 API Key：
- 进入 [Kimi Code 控制台](https://www.kimi.com/code/console)；
- 点击「新建 API Key」，输入名称后确认；
- 复制生成的 Key 并妥善保存（关闭弹窗后无法再次查看完整 Key）。

![Kimi Code 控制台]

## 配置流程

[Claude Code](https://docs.anthropic.com/en/docs/claude-code) 是 Anthropic 推出的命令行编程助手。通过配置环境变量将其接入 Kimi 的 API 端点，你就能在 Claude Code 中直接调用 Kimi Code 的 AI 能力，在熟悉的终端交互里获得 Kimi Code 的编程体验。

① **安装 Claude Code**

安装方式请参考 [Claude Code 官方文档](https://docs.anthropic.com/en/docs/claude-code/getting-started)。

│

② **执行脚本，跳过登录流程**

> 安装完成后，不要直接启动 Claude。先在终端执行以下脚本，跳过 Anthropic 默认的登录流程：

```sh
node --eval "
// enable third party model support and fast mode
const claudeJsonFilePath = path.join(os.homedir(), '.claude.json');
if (fs.existsSync(claudeJsonFilePath)) {
    const content = JSON.parse(fs.readFileSync(claudeJsonFilePath, 'utf-8'));
    fs.writeFileSync(claudeJsonFilePath, JSON.stringify({ ...content, penguinModeOrgEnabled: true, hasCompletedOnboarding: true }, null, 2), 'utf-8');
} else {
    fs.writeFileSync(claudeJsonFilePath, JSON.stringify({ penguinModeOrgEnabled: true, hasCompletedOnboarding: true }), 'utf-8');
}

// delete old model id
const claudeSettingsJsonFilePath = path.join(os.homedir(), '.claude', 'settings.json');
if (fs.existsSync(claudeSettingsJsonFilePath)) {
    const content = JSON.parse(fs.readFileSync(claudeSettingsJsonFilePath, 'utf-8'));
    if (typeof content === 'object' && typeof content.env === 'object') {
        for (const element of [
            'ANTHROPIC_MODEL',
            'ANTHROPIC_SMALL_FAST_MODEL',
            'CLAUDE_CODE_SUBAGENT_MODEL',
            'ANTHROPIC_DEFAULT_FABLE_MODEL',
            'ANTHROPIC_DEFAULT_FABLE_MODEL_NAME',
            'ANTHROPIC_DEFAULT_OPUS_MODEL',
            'ANTHROPIC_DEFAULT_OPUS_MODEL_NAME',
            'ANTHROPIC_DEFAULT_SONNET_MODEL',
            'ANTHROPIC_DEFAULT_SONNET_MODEL_NAME',
            'ANTHROPIC_DEFAULT_HAIKU_MODEL',
            'ANTHROPIC_DEFAULT_HAIKU_MODEL_NAME',
        ]) {
            delete content.env[element];
        }
        fs.writeFileSync(claudeSettingsJsonFilePath, JSON.stringify(content, null, 2), 'utf-8');
    }
}
"
```

</blockquote>

│

③ **设置环境变量后启动**

请先根据自己的会员档位确认可用的模型与上下文窗口，再复制对应的配置：

<table><thead><tr><th>会员档位</th><th>可配置模型</th><th>可用上下文上限</th></tr></thead><tbody><tr><td>Andante</td><td>`kimi-for-coding`</td><td>`262144`</td></tr><tr><td>Moderato</td><td>`k3`、`k3-256k` 或 `kimi-for-coding`</td><td>`262144`</td></tr><tr><td>Allegretto 及以上</td><td>`k3`、`k3-256k`、`kimi-for-coding`、`kimi-for-coding-highspeed`</td><td>`k3` 用 `1048576`；`k3-256k` 用 `262144`；K2.7 Code 系列用 `262144`</td></tr></tbody></table>

> **📌 模型上新推荐**
>
>

`k3-256k`全新上线，256k上下文内效果相同, `k3`（1M）消耗约为 `k3-256k` 两倍，适合日常问答、代码补全、常规功能开发、单文件或少量文件修场景，不支持视频输入。如从 `k3`（1M 版本）切换至 `k3-256k`，建议先压缩上下文再切换。

**K3-256K 配置如下：**

<input type="radio" name="group-134" id="tab-135" checked><label data-title="macOS / Linux" for="tab-135">macOS / Linux</label><input type="radio" name="group-134" id="tab-136"><label data-title="Windows" for="tab-136">Windows</label>

```sh
export ANTHROPIC_BASE_URL=https://api.kimi.com/coding/
export ANTHROPIC_API_KEY=你的API Key

export ANTHROPIC_MODEL="k3-256k"
export ANTHROPIC_DEFAULT_FABLE_MODEL=$ANTHROPIC_MODEL
export ANTHROPIC_DEFAULT_OPUS_MODEL=$ANTHROPIC_MODEL
export ANTHROPIC_DEFAULT_SONNET_MODEL=$ANTHROPIC_MODEL
export ANTHROPIC_DEFAULT_HAIKU_MODEL=$ANTHROPIC_MODEL
export CLAUDE_CODE_SUBAGENT_MODEL=$ANTHROPIC_MODEL
export CLAUDE_CODE_EFFORT_LEVEL=high
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=262144
export CLAUDE_CODE_MAX_CONTEXT_TOKENS=262144

claude
```

```powershell
$env:ANTHROPIC_BASE_URL="https://api.kimi.com/coding/"
$env:ANTHROPIC_API_KEY="你的API Key"

$env:ANTHROPIC_MODEL="k3-256k"
$env:ANTHROPIC_DEFAULT_FABLE_MODEL=$env:ANTHROPIC_MODEL
$env:ANTHROPIC_DEFAULT_OPUS_MODEL=$env:ANTHROPIC_MODEL
$env:ANTHROPIC_DEFAULT_SONNET_MODEL=$env:ANTHROPIC_MODEL
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL=$env:ANTHROPIC_MODEL
$env:CLAUDE_CODE_SUBAGENT_MODEL=$env:ANTHROPIC_MODEL
$env:CLAUDE_CODE_EFFORT_LEVEL="high"
$env:CLAUDE_CODE_AUTO_COMPACT_WINDOW="262144"
$env:CLAUDE_CODE_MAX_CONTEXT_TOKENS="262144"

claude
```

**K3 1M 上下文**配置如下：

> > <p class="custom-block-title">注意 `k3[1m]` 写法仅在 Claude Code 环境变量场景需要

`k3[1m]`（以及外层的引号）用来明确告诉 Claude Code 把上下文窗口设为 1M；其它场景（例如 API 请求、其它第三方工具的 Model ID 字段）只需填 `k3` 即可。

<input type="radio" name="group-146" id="tab-147" checked><label data-title="macOS / Linux" for="tab-147">macOS / Linux</label><input type="radio" name="group-146" id="tab-148"><label data-title="Windows" for="tab-148">Windows</label>

```sh
export ANTHROPIC_BASE_URL=https://api.kimi.com/coding/
export ANTHROPIC_API_KEY=你的API Key

export ANTHROPIC_MODEL="k3[1m]"
export ANTHROPIC_DEFAULT_FABLE_MODEL=$ANTHROPIC_MODEL
export ANTHROPIC_DEFAULT_OPUS_MODEL=$ANTHROPIC_MODEL
export ANTHROPIC_DEFAULT_SONNET_MODEL=$ANTHROPIC_MODEL
export ANTHROPIC_DEFAULT_HAIKU_MODEL=$ANTHROPIC_MODEL
export CLAUDE_CODE_SUBAGENT_MODEL=$ANTHROPIC_MODEL
export CLAUDE_CODE_EFFORT_LEVEL=high
export CLAUDE_CODE_AUTO_COMPACT_WINDOW=1048576
export CLAUDE_CODE_MAX_CONTEXT_TOKENS=1048576

claude
```

```powershell
$env:ANTHROPIC_BASE_URL="https://api.kimi.com/coding/"
$env:ANTHROPIC_API_KEY="你的API Key"

$env:ANTHROPIC_MODEL="k3[1m]"
$env:ANTHROPIC_DEFAULT_FABLE_MODEL=$env:ANTHROPIC_MODEL
$env:ANTHROPIC_DEFAULT_OPUS_MODEL=$env:ANTHROPIC_MODEL
$env:ANTHROPIC_DEFAULT_SONNET_MODEL=$env:ANTHROPIC_MODEL
$env:ANTHROPIC_DEFAULT_HAIKU_MODEL=$env:ANTHROPIC_MODEL
$env:CLAUDE_CODE_SUBAGENT_MODEL=$env:ANTHROPIC_MODEL
$env:CLAUDE_CODE_EFFORT_LEVEL="high"
$env:CLAUDE_CODE_AUTO_COMPACT_WINDOW="1048576"
$env:CLAUDE_CODE_MAX_CONTEXT_TOKENS="1048576"

claude
```

### 环境变量说明

<table><thead><tr><th>变量</th><th>作用</th></tr></thead><tbody><tr><td>`ANTHROPIC_MODEL`</td><td>当前配置生效模型</td></tr><tr><td>`CLAUDE_CODE_EFFORT_LEVEL`</td><td>默认思考档位，K3 默认设为 `high`</td></tr><tr><td>`CLAUDE_CODE_AUTO_COMPACT_WINDOW`</td><td>自动压缩窗口阈值</td></tr><tr><td>`CLAUDE_CODE_MAX_CONTEXT_TOKENS`</td><td>最大上下文 token 数</td></tr></tbody></table>

### 切换思考档位

启动后在会话中输入 `/effort` 即可切换思考档位，无需配置环境变量。K3 支持 `low` / `high` / `max` 三档，Claude Code 的档位与 K3 的映射关系如下：

<table><thead><tr><th>Claude Code 档位</th><th>K3 实际档位</th></tr></thead><tbody><tr><td>`low`</td><td>`low`</td></tr><tr><td>`medium`</td><td>`high`（推荐）</td></tr><tr><td>`high`</td><td>`high`（推荐）</td></tr><tr><td>`xhigh`</td><td>`max`</td></tr><tr><td>`max`</td><td>`max`</td></tr><tr><td>未设置（默认）</td><td>`high`</td></tr></tbody></table>

> **⚠️ 注意**
>
>

关闭 thinking 后 K3 和 K2.7 Code 都会被路由到 K2.6，请保持 thinking 开启以使用 K3 / K2.7；K2.7 Code 快捷键 macOS 为 `Option+T`，Windows / Linux 为 `Alt+T`。

<blockquote>

启动后若提示是否使用该 API key，确认使用即可。随后按照指引选择你信任的项目文件夹，完成授权即可。

![Claude Code 授权访问项目文件]

│

④ **启动后验证**

启动后输入 `/status`，如果返回信息中显示 Base URL 为 `https://api.kimi.com/coding/`，则配置成功。此时即使模型名称仍显示为 Claude 模型，实际调用的仍是 Kimi Code 的 API。

![Claude Code 状态检查]

│
