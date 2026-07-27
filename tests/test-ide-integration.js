// IDE 接入模块单元测试
// 不真实 spawn kimi、不访问网络；detectAcp 用本地假命令验证各分支。
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-desktop-ide-test-'));

const ide = require('../src/main/ide-integration');

// 仅作为字符串嵌入配置，测试中不会真实执行它
const fakeCli = process.platform === 'win32'
  ? 'C:\\Users\\tester\\.kimi-code\\bin\\kimi.exe'
  : '/home/tester/.kimi-code/bin/kimi';

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('✅', name);
  } catch (err) {
    failed += 1;
    console.error('❌', name);
    console.error('   ', err && err.message ? err.message : err);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log('✅', name);
  } catch (err) {
    failed += 1;
    console.error('❌', name);
    console.error('   ', err && err.message ? err.message : err);
  }
}

function cleanup() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// 创建假 CLI：Windows 用 .cmd（detectAcp 会以 shell 方式启动），其它平台用 sh 脚本
function makeFakeCli(name, winCmd, shScript) {
  const isWin = process.platform === 'win32';
  const p = path.join(tmpDir, 'bin', isWin ? `${name}.cmd` : name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, isWin ? winCmd : shScript);
  if (!isWin) fs.chmodSync(p, 0o755);
  return p;
}

async function run() {
  console.log('测试目录:', tmpDir);

  // ---------- ① stripJsonc ----------
  check('stripJsonc 行注释', () => {
    const out = JSON.parse(ide.stripJsonc('{\n  // 这是注释\n  "a": 1\n}'));
    assert.deepStrictEqual(out, { a: 1 });
  });

  check('stripJsonc 块注释与文件末尾行注释', () => {
    const out = JSON.parse(ide.stripJsonc('/* 头注释 */ { "a": 1, /* 行内 */ "b": 2 } // 尾注释无换行'));
    assert.deepStrictEqual(out, { a: 1, b: 2 });
  });

  check('stripJsonc 尾逗号', () => {
    const out = JSON.parse(ide.stripJsonc('{ "a": 1, "b": [1, 2,], }'));
    assert.deepStrictEqual(out, { a: 1, b: [1, 2] });
  });

  check('stripJsonc 字符串内的 // 必须保留（关键边界）', () => {
    const out = JSON.parse(ide.stripJsonc('{ "url": "https://example.com//path", "a": 1 }'));
    assert.strictEqual(out.url, 'https://example.com//path');
    assert.strictEqual(out.a, 1);
  });

  check('stripJsonc 字符串内的 /* */ 与逗号+括号必须保留', () => {
    const out = JSON.parse(ide.stripJsonc('{ "s": "x /* not comment */ , }", }'));
    assert.strictEqual(out.s, 'x /* not comment */ , }');
  });

  check('stripJsonc 转义引号后紧跟 // 不误判', () => {
    const out = JSON.parse(ide.stripJsonc('{ "s": "a\\" // tail", "b": 2 }'));
    assert.strictEqual(out.s, 'a" // tail');
    assert.strictEqual(out.b, 2);
  });

  // ---------- ② applyZedConfig ----------
  check('applyZedConfig 文件不存在时新建（含父目录）', () => {
    const p = path.join(tmpDir, 'zed-new', 'settings.json'); // 父目录也不存在
    const res = ide.applyZedConfig(p, fakeCli);
    assert.deepStrictEqual(res, { ok: true, path: p });
    const written = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.deepStrictEqual(written, { agent_servers: { 'kimi-code': { command: fakeCli, args: ['acp'] } } });
  });

  check('applyZedConfig 合并已有 JSONC 并保留其它键、生成备份', () => {
    const p = path.join(tmpDir, 'zed-merge', 'settings.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const original = [
      '{',
      '  // 主题设置',
      '  "theme": "Ayu Dark",',
      '  "agent_servers": {',
      '    "other-agent": { "command": "/bin/other", "args": ["serve"], },',
      '  },',
      '  "vim_mode": true,',
      '}',
      '',
    ].join('\n');
    fs.writeFileSync(p, original, 'utf8');

    const res = ide.applyZedConfig(p, fakeCli);
    assert.deepStrictEqual(res, { ok: true, path: p });

    const merged = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.strictEqual(merged.theme, 'Ayu Dark', '其它顶层键应保留');
    assert.strictEqual(merged.vim_mode, true, '其它顶层键应保留');
    assert.deepStrictEqual(merged.agent_servers['other-agent'], { command: '/bin/other', args: ['serve'] }, '已有 agent 应保留');
    assert.deepStrictEqual(merged.agent_servers['kimi-code'], { command: fakeCli, args: ['acp'] });

    assert.ok(fs.existsSync(p + '.bak'), '应生成 .bak 备份文件');
    assert.strictEqual(fs.readFileSync(p + '.bak', 'utf8'), original, '备份内容应与原文件一致');
  });

  check('applyZedConfig 坏 JSON 返回 manualRequired 且不改动原文件', () => {
    const p = path.join(tmpDir, 'zed-bad', 'settings.json');
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const broken = '{ this is not json !!!';
    fs.writeFileSync(p, broken, 'utf8');

    const res = ide.applyZedConfig(p, fakeCli);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.manualRequired, true);
    assert.strictEqual(typeof res.reason, 'string');
    assert.strictEqual(fs.readFileSync(p, 'utf8'), broken, '原文件不应被改动');
    assert.ok(!fs.existsSync(p + '.bak'), '失败时不应生成备份');
  });

  // ---------- ③ build* 生成器 ----------
  check('buildZedSnippet 结构正确且含 cliPath', () => {
    assert.deepStrictEqual(ide.buildZedSnippet(fakeCli), {
      agent_servers: { 'kimi-code': { command: fakeCli, args: ['acp'] } },
    });
  });

  check('buildGenericSnippet 为 JSON 文本且含 command/args/description', () => {
    const text = ide.buildGenericSnippet(fakeCli);
    assert.strictEqual(typeof text, 'string');
    const parsed = JSON.parse(text);
    assert.strictEqual(parsed.command, fakeCli);
    assert.deepStrictEqual(parsed.args, ['acp']);
    assert.ok(typeof parsed.description === 'string' && parsed.description.length > 0);
  });

  check('buildJetBrainsGuide 含 cliPath 且强调绝对路径', () => {
    const guide = ide.buildJetBrainsGuide(fakeCli);
    assert.strictEqual(typeof guide, 'string');
    assert.ok(guide.includes(fakeCli), '指引应嵌入 cliPath');
    assert.ok(guide.includes('绝对路径'), '指引应强调绝对路径');
    assert.ok(guide.includes('Settings') && guide.includes('ACP'), '指引应包含设置入口说明');
  });

  // ---------- ④ detectAcp（本地假命令，不触碰真实 kimi / 网络） ----------
  const okCli = makeFakeCli(
    'kimi-ok',
    '@echo off\r\necho kimi cli help\r\nexit /b 0\r\n',
    '#!/bin/sh\necho kimi cli help\nexit 0\n'
  );
  await checkAsync('detectAcp 退出码 0 分支 → available', async () => {
    const res = await ide.detectAcp(okCli);
    assert.strictEqual(res.available, true, res.detail);
    assert.strictEqual(typeof res.detail, 'string');
  });

  const usageCli = makeFakeCli(
    'kimi-usage',
    '@echo off\r\necho usage: kimi acp [options]\r\nexit /b 1\r\n',
    '#!/bin/sh\necho "usage: kimi acp [options]"\nexit 1\n'
  );
  await checkAsync('detectAcp 非零退出码但输出含 usage/acp 关键字 → available', async () => {
    const res = await ide.detectAcp(usageCli);
    assert.strictEqual(res.available, true, res.detail);
  });

  await checkAsync('detectAcp 路径不存在 → unavailable（spawn error 分支）', async () => {
    const res = await ide.detectAcp(path.join(tmpDir, 'bin', process.platform === 'win32' ? 'no-such.exe' : 'no-such'));
    assert.strictEqual(res.available, false);
    assert.ok(res.detail.length > 0);
  });

  // 超时分支：假 CLI 通过本机 node 空转 6 秒，detectAcp 应在 3 秒时判定超时
  const slowJs = path.join(tmpDir, 'bin', 'slow.js');
  fs.writeFileSync(slowJs, 'setTimeout(() => {}, 6000);\n');
  const slowCli = makeFakeCli(
    'kimi-slow',
    `@echo off\r\n"${process.execPath}" "%~dp0slow.js"\r\n`,
    `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/slow.js"\n`
  );
  await checkAsync('detectAcp 3 秒无响应 → unavailable（超时分支）', async () => {
    const started = Date.now();
    const res = await ide.detectAcp(slowCli);
    assert.strictEqual(res.available, false);
    assert.ok(res.detail.includes('超时'), res.detail);
    assert.ok(Date.now() - started < 5500, '应在超时后立即返回');
  });

  // ---------- ⑤ detectEditors ----------
  check('detectEditors 不抛异常且返回结构形状正确', () => {
    const res = ide.detectEditors();
    assert.ok(res && typeof res === 'object');
    assert.strictEqual(typeof res.zed.installed, 'boolean');
    assert.ok(res.zed.execPath === null || typeof res.zed.execPath === 'string');
    assert.strictEqual(typeof res.zed.settingsPath, 'string');
    assert.strictEqual(typeof res.jetbrains.installed, 'boolean');
    assert.ok(Array.isArray(res.jetbrains.ides));
  });

  check('detectEditors 在伪造的 LOCALAPPDATA 下检出 Zed 与 JetBrains IDE', () => {
    const fakeLocal = path.join(tmpDir, 'fake-local');
    const fakeRoaming = path.join(tmpDir, 'fake-roaming');
    fs.mkdirSync(path.join(fakeLocal, 'Programs', 'Zed'), { recursive: true });
    fs.writeFileSync(path.join(fakeLocal, 'Programs', 'Zed', 'Zed.exe'), '');
    fs.mkdirSync(path.join(fakeLocal, 'Programs', 'IntelliJ IDEA 2024.2'), { recursive: true });
    fs.mkdirSync(path.join(fakeLocal, 'JetBrains', 'Toolbox', 'apps', 'PyCharm-P'), { recursive: true });
    fs.mkdirSync(path.join(fakeLocal, 'Programs', 'NotAnEditor'), { recursive: true });

    const savedLocal = process.env.LOCALAPPDATA;
    const savedRoaming = process.env.APPDATA;
    process.env.LOCALAPPDATA = fakeLocal;
    process.env.APPDATA = fakeRoaming;
    try {
      const res = ide.detectEditors();
      assert.strictEqual(res.zed.installed, true);
      assert.strictEqual(res.zed.execPath, path.join(fakeLocal, 'Programs', 'Zed', 'Zed.exe'));
      assert.strictEqual(res.zed.settingsPath, path.join(fakeRoaming, 'Zed', 'settings.json'));
      assert.strictEqual(res.jetbrains.installed, true);
      assert.ok(res.jetbrains.ides.includes('IntelliJ IDEA 2024.2'));
      assert.ok(res.jetbrains.ides.includes('PyCharm-P'));
      assert.ok(!res.jetbrains.ides.includes('NotAnEditor'));
    } finally {
      if (savedLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = savedLocal;
      if (savedRoaming === undefined) delete process.env.APPDATA; else process.env.APPDATA = savedRoaming;
    }
  });

  check('detectEditors 空环境下 installed=false 且不抛异常', () => {
    const emptyLocal = path.join(tmpDir, 'empty-local');
    fs.mkdirSync(emptyLocal, { recursive: true });
    const savedLocal = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = emptyLocal;
    try {
      const res = ide.detectEditors();
      assert.strictEqual(res.zed.installed, false);
      assert.strictEqual(res.zed.execPath, null);
      assert.strictEqual(res.jetbrains.installed, false);
      assert.deepStrictEqual(res.jetbrains.ides, []);
    } finally {
      if (savedLocal === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = savedLocal;
    }
  });

  console.log(`\n通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    console.error('存在失败用例');
    cleanup();
    process.exit(1);
  }
  console.log('全部 ide-integration 测试通过');
  cleanup();
  process.exit(0);
}

run().catch((err) => {
  console.error('测试运行异常:', err);
  cleanup();
  process.exit(1);
});
