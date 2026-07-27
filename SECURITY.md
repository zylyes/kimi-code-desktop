# 安全策略

## 报告漏洞

如果你发现了安全漏洞，**请不要通过公开 Issue 报告**。

请通过 GitHub Security Advisory 的 **"Report a vulnerability"** 私下报告：

1. 进入 [Security 标签页](https://github.com/zylyes/kimi-code-desktop/security)
2. 点击 **"Report a vulnerability"**
3. 填写漏洞详情并提交

我们将尽快确认并在修复后发布安全更新。

## 安全注意事项

Kimi Code Desktop 作为桌面应用，涉及以下安全边界：

| 区域 | 说明 |
|------|------|
| **日志脱敏** | 所有日志自动过滤 token、Authorization 头、带 fragment 的完整 URL |
| **局域网访问安全** | `host=0.0.0.0` 模式下 URL 含 token，仅在受信任网络使用；关闭后及时轮换 token |
| **敏感目录保护** | 在 home 根、盘符根、`.ssh`、`.gnupg`、`KIMI_CODE_HOME` 路径新建会话时会弹出警告 |
| **权限审批** | ACP 原生审批弹窗对危险操作进行 once/always 语义映射，工具调用附加上下文详情 |
| **数据目录** | 配置文件、会话数据存储在 `%APPDATA%\kimi-code-desktop\`，凭据保护在清理操作中不可清除 |
| **电子签名** | 发行包建议进行代码签名以验证来源完整性（本仓库暂未强制） |

## 版本支持

| 版本 | 安全更新 |
|------|----------|
| v1.0.x | ✅ 当前活跃版本 |
| v0.x | ❌ 仅限严重漏洞按需修复 |

## 依赖项

项目依赖定期审查。如发现依赖项漏洞，请一并报告。

建议使用 `npm audit` 检查已知漏洞。
