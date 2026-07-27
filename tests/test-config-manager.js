// 配置管理模块单元测试
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');

// 复用模块，但通过 monkey-patch KIMI_CODE_HOME 指向临时目录
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-desktop-test-'));
process.env.KIMI_CODE_HOME = tmpDir;

// 创建假 CLI：doctor 子命令总是成功
const fakeCliDir = path.join(tmpDir, 'bin');
fs.mkdirSync(fakeCliDir, { recursive: true });
const fakeCli = path.join(fakeCliDir, process.platform === 'win32' ? 'kimi.cmd' : 'kimi');
if (process.platform === 'win32') {
  fs.writeFileSync(fakeCli, '@echo off\necho doctor ok\nexit /b 0\n');
} else {
  fs.writeFileSync(fakeCli, '#!/bin/sh\necho doctor ok\nexit 0\n');
  fs.chmodSync(fakeCli, 0o755);
}

const configManager = require('../src/main/config-manager');

function cleanup() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function run() {
  console.log('测试目录:', tmpDir);

  // 1. 加载不存在的 config.toml 应返回空对象
  const empty = configManager.loadConfigToml();
  assert.deepStrictEqual(empty.data, {});
  console.log('✅ 空配置加载');

  // 2. 写入初始 config.toml 并解析
  const initialToml = `default_model = "kimi-for-coding"\ndefault_permission_mode = "manual"\n\n[[permission.rules]]\ndecision = "deny"\npattern = "Bash(rm -rf*)"\nscope = ""\n`;
  fs.writeFileSync(path.join(tmpDir, 'config.toml'), initialToml, 'utf8');
  const loaded = configManager.loadConfigToml();
  assert.strictEqual(loaded.data.default_model, 'kimi-for-coding');
  assert.strictEqual(loaded.data.default_permission_mode, 'manual');
  assert.ok(Array.isArray(loaded.data.permission.rules));
  assert.strictEqual(loaded.data.permission.rules[0].decision, 'deny');
  console.log('✅ TOML 解析');

  // 3. 保存新配置（doctor 成功）
  const newConfig = {
    default_model: 'kimi-for-coding-highspeed',
    default_permission_mode: 'yolo',
    telemetry: true,
    permission: {
      rules: [
        { decision: 'deny', pattern: 'Bash(rm -rf*)', scope: '' },
        { decision: 'ask', pattern: 'Read(*.env*)', scope: '' },
      ],
    },
  };
  const saveRes = configManager.saveConfigToml(newConfig, fakeCli, process.env);
  assert(saveRes.then, 'saveConfigToml 应返回 Promise');
  saveRes.then((res) => {
    assert.strictEqual(res.ok, true);
    const saved = configManager.loadConfigToml();
    assert.strictEqual(saved.data.default_model, 'kimi-for-coding-highspeed');
    assert.strictEqual(saved.data.permission.rules.length, 2);
    assert.ok(fs.existsSync(path.join(tmpDir, 'config.toml.bak')), '应生成备份文件');
    console.log('✅ 保存配置并生成备份');

    // 4. 保存失败时回滚
    if (process.platform !== 'win32') {
      // Windows 批处理无法动态改变退出码，跳过此分支
      const failCli = path.join(fakeCliDir, 'kimi-fail');
      fs.writeFileSync(failCli, '#!/bin/sh\nexit 1\n');
      fs.chmodSync(failCli, 0o755);
      const before = fs.readFileSync(path.join(tmpDir, 'config.toml'), 'utf8');
      configManager.saveConfigToml({ default_model: 'should-not-save' }, failCli, process.env)
        .then(() => { throw new Error('应失败'); })
        .catch((err) => {
          assert(err.message.includes('kimi doctor'));
          const after = fs.readFileSync(path.join(tmpDir, 'config.toml'), 'utf8');
          assert.strictEqual(before, after);
          console.log('✅ 保存失败时回滚原文件');
        })
        .finally(() => {
          // 5. MCP JSON 读写
          const mcp = configManager.loadMcpJson(true);
          assert.deepStrictEqual(mcp.data, { mcpServers: {} });
          const savedMcp = configManager.saveMcpJson({ mcpServers: { test: { type: 'stdio', command: 'node test.js' } } }, true);
          assert.strictEqual(savedMcp.ok, true);
          const mcp2 = configManager.loadMcpJson(true);
          assert.strictEqual(mcp2.data.mcpServers.test.command, 'node test.js');
          console.log('✅ MCP JSON 读写');

          console.log('\n全部测试通过');
          cleanup();
          process.exit(0);
        });
    } else {
      // Windows 下直接测试 MCP
      const mcp = configManager.loadMcpJson(true);
      assert.deepStrictEqual(mcp.data, { mcpServers: {} });
      const savedMcp = configManager.saveMcpJson({ mcpServers: { test: { type: 'stdio', command: 'node test.js' } } }, true);
      assert.strictEqual(savedMcp.ok, true);
      const mcp2 = configManager.loadMcpJson(true);
      assert.strictEqual(mcp2.data.mcpServers.test.command, 'node test.js');
      console.log('✅ MCP JSON 读写');

      console.log('\n全部测试通过');
      cleanup();
      process.exit(0);
    }
  }).catch((err) => {
    console.error('测试失败:', err);
    cleanup();
    process.exit(1);
  });
}

run();
