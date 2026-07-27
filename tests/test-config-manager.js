// 配置管理模块单元测试
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { spawnSync } = require('child_process');

// 复用模块，但通过 monkey-patch KIMI_CODE_HOME 指向临时目录
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-desktop-test-'));
process.env.KIMI_CODE_HOME = tmpDir;

// 创建假 CLI：记录 argv 到临时文件，doctor 子命令总是成功
const argvRecordPath = path.join(tmpDir, 'last-argv.txt');
const fakeCliDir = path.join(tmpDir, 'bin');
fs.mkdirSync(fakeCliDir, { recursive: true });
const fakeCli = path.join(fakeCliDir, process.platform === 'win32' ? 'kimi.cmd' : 'kimi');
if (process.platform === 'win32') {
  // Windows batch: %* 表示全部参数，写入记录文件
  fs.writeFileSync(fakeCli, `@echo off\nsetlocal\n> "%KIMI_CODE_HOME%\\last-argv.txt" echo %*\necho doctor ok\nexit /b 0\n`);
} else {
  fs.writeFileSync(fakeCli, '#!/bin/sh\necho "$*" > "$KIMI_CODE_HOME/last-argv.txt"\necho doctor ok\nexit 0\n');
  fs.chmodSync(fakeCli, 0o755);
}

const configManager = require('../src/main/config-manager');

function cleanup() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

function readLastArgv() {
  try { return fs.readFileSync(argvRecordPath, 'utf8').trim(); } catch { return ''; }
}

function writeConfig(tomlContent) {
  fs.writeFileSync(path.join(tmpDir, 'config.toml'), tomlContent, 'utf8');
}

function readConfig() {
  return fs.readFileSync(path.join(tmpDir, 'config.toml'), 'utf8');
}

async function run() {
  try {
    console.log('测试目录:', tmpDir);

    // ============ 1. 空配置加载 ============
    const empty = configManager.loadConfigToml();
    assert.deepStrictEqual(empty.data, {});
    assert.strictEqual(empty.ok, true);
    assert.strictEqual(empty.migrated, undefined);
    console.log('✅ 空配置加载');

    // ============ 2. TOML 解析 ============
    const initialToml = `default_model = "kimi-for-coding"\ndefault_permission_mode = "manual"\n\n[[permission.rules]]\ndecision = "deny"\npattern = "Bash(rm -rf*)"\nscope = ""\n`;
    writeConfig(initialToml);
    const loaded = configManager.loadConfigToml();
    assert.strictEqual(loaded.data.default_model, 'kimi-for-coding');
    assert.strictEqual(loaded.data.default_permission_mode, 'manual');
    assert.ok(Array.isArray(loaded.data.permission.rules));
    assert.strictEqual(loaded.data.permission.rules[0].decision, 'deny');
    assert.strictEqual(loaded.ok, true);
    console.log('✅ TOML 解析');

    // ============ 3. 保存配置并检查 doctor argv ============
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
    const saveRes = await configManager.saveConfigToml(newConfig, fakeCli, process.env);
    assert.strictEqual(saveRes.ok, true);

    // 验证 saveConfigToml 触发 doctor config <path>
    const configPath = path.join(tmpDir, 'config.toml');
    const configArgv = readLastArgv();
    assert.strictEqual(configArgv, `doctor config ${configPath}`, `saveConfigToml argv: "${configArgv}"`);
    console.log('✅ saveConfigToml 触发 doctor config 正确路径');

    const saved = configManager.loadConfigToml();
    assert.strictEqual(saved.data.default_model, 'kimi-for-coding-highspeed');
    assert.strictEqual(saved.data.permission.rules.length, 2);
    assert.ok(fs.existsSync(path.join(tmpDir, 'config.toml.bak')), '应生成备份文件');
    console.log('✅ 保存配置并生成备份');

    // ============ 4. 保存失败时回滚 ============
    if (process.platform !== 'win32') {
      const failCli = path.join(fakeCliDir, 'kimi-fail');
      fs.writeFileSync(failCli, '#!/bin/sh\nexit 1\n');
      fs.chmodSync(failCli, 0o755);
      const before = readConfig();
      try {
        await configManager.saveConfigToml({ default_model: 'should-not-save' }, failCli, process.env);
        throw new Error('应失败');
      } catch (err) {
        assert(err.message.includes('kimi doctor'));
        const after = readConfig();
        assert.strictEqual(before, after);
        console.log('✅ 保存失败时回滚原文件');
      }
    }

    // ============ 5. MCP JSON 读写 ============
    const mcp = configManager.loadMcpJson(true);
    assert.deepStrictEqual(mcp.data, { mcpServers: {} });
    const savedMcp = configManager.saveMcpJson({ mcpServers: { test: { type: 'stdio', command: 'node test.js' } } }, true);
    assert.strictEqual(savedMcp.ok, true);
    const mcp2 = configManager.loadMcpJson(true);
    assert.strictEqual(mcp2.data.mcpServers.test.command, 'node test.js');
    console.log('✅ MCP JSON 读写');

    // ============ 6. 迁移：default_thinking=true → thinking.enabled ============
    writeConfig('default_thinking = true\n');
    const mig1 = configManager.loadConfigToml(fakeCli, process.env);
    assert.strictEqual(mig1.ok, true);
    assert.strictEqual(mig1.data.thinking.enabled, true);
    assert.strictEqual(mig1.data.default_thinking, undefined);
    assert.ok(mig1.migrated.includes('default_thinking→thinking.enabled'));
    // 验证文件已写回
    const file1 = readConfig();
    assert.ok(file1.includes('enabled = true'), `文件应包含 enabled = true, 实际: ${file1}`);
    assert.ok(!file1.includes('default_thinking'), `文件不应包含 default_thinking, 实际: ${file1}`);
    console.log('✅ 迁移 default_thinking=true → thinking.enabled');

    // ============ 7. 迁移：thinking.mode='off' → enabled=false ============
    writeConfig('[thinking]\nmode = "off"\n');
    const mig2 = configManager.loadConfigToml(fakeCli, process.env);
    assert.strictEqual(mig2.ok, true);
    assert.strictEqual(mig2.data.thinking.enabled, false);
    assert.strictEqual(mig2.data.thinking.mode, undefined);
    assert.ok(mig2.migrated.includes('thinking.mode→thinking.enabled'));
    const file2 = readConfig();
    assert.ok(file2.includes('enabled = false'), `文件应包含 enabled = false, 实际: ${file2}`);
    assert.ok(!file2.includes('mode = "off"'), `文件不应包含 mode, 实际: ${file2}`);
    console.log('✅ 迁移 thinking.mode=off → thinking.enabled=false');

    // ============ 8. thinking.enabled 已存在时仅删旧键不覆盖 ============
    writeConfig('default_thinking = true\n\n[thinking]\nenabled = false\n');
    const mig3 = configManager.loadConfigToml(fakeCli, process.env);
    assert.strictEqual(mig3.ok, true);
    // enabled 保持原值 false（不被 default_thinking 覆盖）
    assert.strictEqual(mig3.data.thinking.enabled, false);
    assert.strictEqual(mig3.data.default_thinking, undefined);
    assert.ok(mig3.migrated.includes('default_thinking→thinking.enabled'));
    const file3 = readConfig();
    assert.ok(file3.includes('enabled = false'), `文件应保持 enabled = false, 实际: ${file3}`);
    assert.ok(!file3.includes('default_thinking'), `文件不应包含 default_thinking, 实际: ${file3}`);
    console.log('✅ thinking.enabled 已存在时仅删旧键不覆盖');

    // ============ 9. 两旧键同时存在时 default_thinking 优先 ============
    writeConfig('default_thinking = true\n\n[thinking]\nmode = "off"\n');
    const mig4 = configManager.loadConfigToml(fakeCli, process.env);
    assert.strictEqual(mig4.ok, true);
    // default_thinking 优先，所以 enabled=true
    assert.strictEqual(mig4.data.thinking.enabled, true);
    assert.strictEqual(mig4.data.default_thinking, undefined);
    assert.strictEqual(mig4.data.thinking.mode, undefined);
    assert.ok(mig4.migrated.includes('default_thinking→thinking.enabled'));
    assert.ok(mig4.migrated.includes('thinking.mode→thinking.enabled'));
    const file4 = readConfig();
    assert.ok(file4.includes('enabled = true'), `文件应包含 enabled = true, 实际: ${file4}`);
    assert.ok(!file4.includes('default_thinking'), `文件不应包含 default_thinking, 实际: ${file4}`);
    assert.ok(!file4.includes('mode = "off"'), `文件不应包含 mode, 实际: ${file4}`);
    console.log('✅ 两旧键同时存在时 default_thinking 优先');

    // ============ 10. thinking.mode='on' → enabled=true ============
    writeConfig('[thinking]\nmode = "on"\n');
    const mig5 = configManager.loadConfigToml(fakeCli, process.env);
    assert.strictEqual(mig5.ok, true);
    assert.strictEqual(mig5.data.thinking.enabled, true);
    assert.strictEqual(mig5.data.thinking.mode, undefined);
    console.log('✅ 迁移 thinking.mode=on → thinking.enabled=true');

    // ============ 11. thinking.mode='auto' → enabled=true ============
    writeConfig('[thinking]\nmode = "auto"\n');
    const mig6 = configManager.loadConfigToml(fakeCli, process.env);
    assert.strictEqual(mig6.ok, true);
    assert.strictEqual(mig6.data.thinking.enabled, true);
    assert.strictEqual(mig6.data.thinking.mode, undefined);
    console.log('✅ 迁移 thinking.mode=auto → thinking.enabled=true');

    // ============ 12. tui.toml 读写往返 ============
    const tuiData = { theme: 'dark', disable_paste_burst: true, editor: { command: 'code' }, notifications: { enabled: false } };
    const tuiSaveRes = await configManager.saveTuiToml(tuiData, fakeCli, process.env);
    assert.strictEqual(tuiSaveRes.ok, true);
    // 验证 saveTuiToml 触发 doctor tui <path>
    const tuiPath = path.join(tmpDir, 'tui.toml');
    const tuiArgv = readLastArgv();
    assert.strictEqual(tuiArgv, `doctor tui ${tuiPath}`, `saveTuiToml argv: "${tuiArgv}"`);
    console.log('✅ saveTuiToml 触发 doctor tui 正确路径');

    const tuiLoaded = configManager.loadTuiToml();
    assert.strictEqual(tuiLoaded.data.theme, 'dark');
    assert.strictEqual(tuiLoaded.data.disable_paste_burst, true);
    assert.strictEqual(tuiLoaded.data.editor.command, 'code');
    assert.strictEqual(tuiLoaded.data.notifications.enabled, false);
    console.log('✅ tui.toml 读写往返');

    // ============ 13. loadConfigToml 无 cli 时不触发迁移 ============
    writeConfig('default_thinking = true\n');
    const noCli = configManager.loadConfigToml();
    assert.strictEqual(noCli.ok, true);
    assert.strictEqual(noCli.migrated, undefined);
    // 数据仍包含旧键（不迁移）
    assert.strictEqual(noCli.data.default_thinking, true);
    console.log('✅ loadConfigToml 无 cli 时不触发迁移');

    // ============ 14. 无迁移时不带 migrated 字段 ============
    writeConfig('default_model = "test"\n');
    const noMig = configManager.loadConfigToml(fakeCli, process.env);
    assert.strictEqual(noMig.ok, true);
    assert.strictEqual(noMig.migrated, undefined);
    console.log('✅ 无迁移时不带 migrated 字段');

    console.log('\n全部测试通过');
    cleanup();
    process.exit(0);
  } catch (err) {
    console.error('测试失败:', err);
    cleanup();
    process.exit(1);
  }
}

run();