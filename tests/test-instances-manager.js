// 实例扫描模块单元测试
// 全部使用临时目录与临时 localhost 服务，不访问真实 ~/.kimi-code 与外部网络
const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const http = require('http');

const instancesManager = require('../src/main/instances-manager');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-desktop-instances-test-'));

let passed = 0;
let failed = 0;

function report(name, err) {
  if (err) {
    failed++;
    console.error('❌', name);
    console.error('   ', err.message);
  } else {
    passed++;
    console.log('✅', name);
  }
}

function check(name, fn) {
  try {
    fn();
    report(name, null);
  } catch (err) {
    report(name, err);
  }
}

async function checkAsync(name, fn) {
  try {
    await fn();
    report(name, null);
  } catch (err) {
    report(name, err);
  }
}

function cleanup() {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// 在临时目录下造一个假的 kimi home
function makeHome(name) {
  const home = path.join(tmpDir, name);
  fs.mkdirSync(home, { recursive: true });
  return home;
}

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content), 'utf8');
}

async function run() {
  console.log('测试目录:', tmpDir);

  // 1. instances 目录：多文件（含坏 JSON、缺字段文件），解析并按 startedAt 降序
  const home1 = makeHome('home-instances');
  const instDir = path.join(home1, 'server', 'instances');
  writeFile(path.join(instDir, 'a.json'), {
    pid: process.pid, // 当前进程，alive 应为 true
    host: '127.0.0.1',
    port: 58627,
    started_at: '2026-07-22T09:00:00.000Z',
    host_version: '0.28.0',
  });
  writeFile(path.join(instDir, 'b.json'), {
    processId: 999999, // camelCase 候选字段 + 肯定不存在的 pid
    host: '127.0.0.1',
    port: 58628,
    startedAt: '2026-07-22T10:00:00.000Z',
    version: '0.28.1',
  });
  writeFile(path.join(instDir, 'c.json'), { pid: process.pid, port: 58629 }); // 缺 host/version/startedAt
  writeFile(path.join(instDir, 'bad.json'), '{ this is not json'); // 坏 JSON，应跳过
  writeFile(path.join(instDir, 'useless.json'), { note: 'no pid no port' }); // 无效条目，应跳过

  check('instances 目录多文件解析与排序', () => {
    const list = instancesManager.scanInstances(home1);
    assert.strictEqual(list.length, 3, '坏 JSON 与无效条目应被跳过');
    // 排序约定：startedAt 降序，缺失的排最后
    assert.strictEqual(list[0].port, 58628);
    assert.strictEqual(list[1].port, 58627);
    assert.strictEqual(list[2].port, 58629);
    assert.ok(list.every((i) => i.source === 'instances-dir'));
    // 候选字段名归一化
    assert.strictEqual(list[0].pid, 999999);
    assert.strictEqual(list[0].version, '0.28.1');
    assert.strictEqual(list[0].startedAt, '2026-07-22T10:00:00.000Z');
    assert.strictEqual(list[1].version, '0.28.0');
    // 缺字段文件仍被解析，缺失字段为 null
    assert.strictEqual(list[2].host, null);
    assert.strictEqual(list[2].version, null);
    assert.strictEqual(list[2].startedAt, null);
    // alive 由 checkPidAlive 填充
    assert.strictEqual(list[0].alive, false);
    assert.strictEqual(list[1].alive, true);
  });

  // 2. 无 instances 目录时返回 []（基线已切换 0.28+，不再回退 server/lock）
  const home2 = makeHome('home-no-instances');
  check('无 instances 目录返回空数组', () => {
    assert.deepStrictEqual(instancesManager.scanInstances(home2), []);
  });

  // 3. instances 目录存在但文件全为坏 JSON / 无效条目时返回 []
  const home3 = makeHome('home-all-invalid');
  writeFile(path.join(home3, 'server', 'instances', 'bad.json'), 'not json at all');
  writeFile(path.join(home3, 'server', 'instances', 'useless.json'), { note: 'no pid no port' });
  check('instances 全为坏 JSON 或无效条目返回空数组', () => {
    assert.deepStrictEqual(instancesManager.scanInstances(home3), []);
  });

  // 4. checkPidAlive
  check('checkPidAlive 判活', () => {
    assert.strictEqual(instancesManager.checkPidAlive(process.pid), true);
    assert.strictEqual(instancesManager.checkPidAlive(999999), false);
    assert.strictEqual(instancesManager.checkPidAlive(null), false);
    assert.strictEqual(instancesManager.checkPidAlive(0), false);
    assert.strictEqual(instancesManager.checkPidAlive(undefined), false);
  });

  // 5. probeInstance：临时 localhost 服务验证 true / false 分支
  await checkAsync('probeInstance 2xx / 非 2xx / 拒连', async () => {
    let respondOk = true;
    const server = http.createServer((req, res) => {
      if (respondOk && req.url === '/openapi.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{}');
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    try {
      assert.strictEqual(await instancesManager.probeInstance('127.0.0.1', port), true, '2xx 应为 true');
      respondOk = false;
      assert.strictEqual(await instancesManager.probeInstance('127.0.0.1', port), false, '非 2xx 应为 false');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    assert.strictEqual(await instancesManager.probeInstance('127.0.0.1', port, 500), false, '拒连应为 false');
    assert.strictEqual(await instancesManager.probeInstance(null, port, 500), false, '无 host 应为 false');
  });

  console.log(`\n通过 ${passed}，失败 ${failed}`);
  cleanup();
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((err) => {
  console.error('测试运行异常:', err);
  cleanup();
  process.exit(1);
});
