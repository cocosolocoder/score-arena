// 首页“创建公开房间”功能的界面回归测试。
//
// 与 main_test.go 的分工：main_test.go 通过公开 HTTP 接口验证创建与本地保存；
// 本文件用真实浏览器（系统 Chrome）加载真实服务的首页，模拟用户填写与提交，
// 断言用户在页面上实际看到的提示、表单与房间列表变化，重点区分两类请求结果：
//   1. POST /api/rooms 的创建结果（决定成功提示、编号与表单复位）；
//   2. 紧随其后的 GET /api/rooms 列表刷新结果（决定列表区域内容）。
// 两者不能混为一谈：创建被拒时列表不得新增记录；创建成功但列表刷新失败时，
// 成功提示与编号必须保留，列表区域必须显示加载失败而非“还没有房间记录”。
//
// 运行：npm install && npm test（需要系统 Chrome，可用 CHROME_PATH 指定路径）。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer-core';

const repoRoot = import.meta.dirname;
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';

let serverBin;
let browser;

// 与 main_test.go 相同的种子记录：带附带字段（note/tags/extra），
// 用于验证追加新房间时原有房间的内容与次序保持不变。
const SEED_ALPHA =
  '{"id":"seed-alpha","name":"晨间飞行棋","game":"ludo","capacity":4,"turnSeconds":30,' +
  '"status":"playing","visibility":"public","createdAt":"2026-01-01T08:00:00Z","note":"保留我","tags":["老友","周赛"]}';
const SEED_BETA =
  '{"id":"seed-beta","name":"午夜五子棋","game":"gomoku","capacity":2,"turnSeconds":0,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-01-02T23:00:00Z","extra":{"rank":3}}';

before(async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'score-arena-uibin-'));
  serverBin = path.join(dir, 'score-arena');
  await promisify(execFile)('go', ['build', '-o', serverBin, '.'], { cwd: repoRoot });
  browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
});

after(async () => {
  if (browser) await browser.close();
  if (serverBin) await rm(path.dirname(serverBin), { recursive: true, force: true });
});

// startServer 在 dataDir 上启动真实服务子进程（--port 0 自动选端口），返回基地址。
function startServer(t, dataDir) {
  const proc = spawn(
    serverBin,
    ['serve', '--host', '127.0.0.1', '--port', '0', '--data-dir', dataDir],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  t.after(() => { proc.kill('SIGKILL'); });
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('等待服务监听地址超时')), 15000);
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const m = buf.match(/listening on (http:\/\/\S+)/);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    });
    proc.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`服务在输出监听地址前退出，退出码 ${code}`));
    });
  });
}

async function seedRooms(dataDir, ...records) {
  await writeFile(path.join(dataDir, 'rooms.json'), '[\n' + records.join(',\n') + '\n]\n');
}

// 每个用例使用独立的数据目录、服务进程与页面，互不影响。
async function setupPage(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'score-arena-uidata-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await seedRooms(dataDir, SEED_ALPHA, SEED_BETA);
  const baseURL = await startServer(t, dataDir);
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(baseURL, { waitUntil: 'load' });
  await waitForRowCount(page, 2);
  return { page, baseURL };
}

function waitForRowCount(page, n) {
  return page.waitForFunction(
    (want) => document.querySelectorAll('#list-area table tbody tr').length === want,
    { timeout: 10000 },
    n,
  );
}

function waitForMessageKind(page, kind) {
  return page.waitForFunction(
    (cls) => document.getElementById('form-msg').classList.contains(cls),
    { timeout: 10000 },
    kind,
  );
}

// readRows 读取列表每一行的单元格文本、创建时间单元格的 title（原始 ISO 时间）
// 以及状态列徽标文本，用于逐格比对内容与次序。
function readRows(page) {
  return page.$$eval('#list-area table tbody tr', (trs) =>
    trs.map((tr) => {
      const tds = [...tr.querySelectorAll('td')];
      return {
        cells: tds.map((td) => td.textContent),
        timeTitle: tds[6] ? tds[6].getAttribute('title') : null,
        badge: tds[5] && tds[5].querySelector('.badge')
          ? tds[5].querySelector('.badge').textContent
          : null,
      };
    }),
  );
}

function readFormState(page) {
  return page.evaluate(() => ({
    name: document.getElementById('name').value,
    game: document.getElementById('game').value,
    capacity: document.getElementById('capacity').value,
    capacityDisabled: document.getElementById('capacity').disabled,
    turnSeconds: document.getElementById('turnSeconds').value,
    submitDisabled: document.getElementById('submit').disabled,
  }));
}

function readMessage(page) {
  return page.evaluate(() => {
    const el = document.getElementById('form-msg');
    return { className: el.className, text: el.textContent };
  });
}

function readListArea(page) {
  return page.evaluate(() => ({
    text: document.getElementById('list-area').textContent,
    hasTable: !!document.querySelector('#list-area table'),
    errorText: document.querySelector('#list-area .list-error')
      ? document.querySelector('#list-area .list-error').textContent
      : null,
    emptyText: document.querySelector('#list-area .empty')
      ? document.querySelector('#list-area .empty').textContent
      : null,
  }));
}

const SUCCESS_PREFIX = '房间已创建，编号：';

// 断言两条种子房间渲染正确（内容、次序、附带字段不影响展示）。
function assertSeedRows(rows) {
  assert.deepEqual(
    rows.map((r) => r.cells.slice(0, 6)),
    [
      ['seed-alpha', '晨间飞行棋', '飞行棋', '4 人', '30 秒', 'playing'],
      ['seed-beta', '午夜五子棋', '五子棋', '2 人', '不限时', '未开始'],
    ],
    '种子房间的展示内容或次序不符合预期',
  );
  assert.equal(rows[0].timeTitle, '2026-01-01T08:00:00Z');
  assert.equal(rows[1].timeTitle, '2026-01-02T23:00:00Z');
  assert.equal(rows[1].badge, '未开始');
}

// 填写五子棋表单：人数固定 2 人由页面自动选中，无需手选。
async function fillGomokuForm(page, rawName, turnSeconds) {
  await page.type('#name', rawName);
  await page.select('#game', 'gomoku');
  await page.waitForFunction(
    () => !document.getElementById('capacity').disabled &&
      document.getElementById('capacity').value === '2',
    { timeout: 5000 },
  );
  await page.type('#turnSeconds', String(turnSeconds));
}

// 完整成功路径：提示展示新编号、表单复位、列表在原有房间之后追加新记录，
// 且页面上的编号与配置必须来自本次创建结果，而不是仅仅多了一行。
test('创建成功：显示新编号、表单复位、列表在原有房间后追加与创建结果一致的新记录', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t);

  // 捕获本次创建请求的请求体与响应体（创建结果），与页面展示逐项对照。
  const postBodies = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/rooms')) {
      postBodies.push(req.postData());
    }
  });
  const createdPromise = new Promise((resolve, reject) => {
    page.on('response', (resp) => {
      if (resp.request().method() === 'POST' && resp.url().endsWith('/api/rooms')) {
        resp.json().then(resolve, reject);
      }
    });
  });

  const initialRows = await readRows(page);
  assertSeedRows(initialRows);

  // 名称首尾带空白、内部带空格；五子棋固定 2 人；0 秒表示不限时。
  const rawName = '  周末 五子棋 友谊赛  ';
  await fillGomokuForm(page, rawName, 0);
  await page.click('#submit');

  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  // 创建请求只发出一次，且提交的内容与用户填写一致（名称未在页面侧被裁剪）。
  assert.equal(postBodies.length, 1, '应只发出一次创建请求');
  assert.deepEqual(JSON.parse(postBodies[0]), {
    name: rawName,
    game: 'gomoku',
    capacity: 2,
    turnSeconds: 0,
  });

  // 创建结果本身：服务生成编号，名称去掉首尾空白、保留内部空格。
  assert.ok(created.id, '创建结果应包含新房间编号');
  assert.equal(created.name, '周末 五子棋 友谊赛');
  assert.equal(created.game, 'gomoku');
  assert.equal(created.capacity, 2);
  assert.equal(created.turnSeconds, 0);
  assert.equal(created.status, 'waiting');

  // 成功提示展示本次创建返回的编号。
  const msg = await readMessage(page);
  assert.ok(msg.className.includes('ok'), `应显示成功提示，实际 class: ${msg.className}`);
  assert.ok(msg.text.startsWith(SUCCESS_PREFIX), `成功提示应包含编号，实际: ${msg.text}`);
  const shownId = msg.text.slice(SUCCESS_PREFIX.length);
  assert.equal(shownId, created.id, '页面展示的编号应与创建结果一致');

  // 表单恢复到初始填写状态。
  assert.deepEqual(await readFormState(page), {
    name: '',
    game: '',
    capacity: '',
    capacityDisabled: true,
    turnSeconds: '',
    submitDisabled: false,
  });

  // 列表刷新后：原有房间内容与次序不变，新记录追加在其后，
  // 且新记录每一格都与本次创建结果相符（不只是多了一行）。
  await waitForRowCount(page, 3);
  const rows = await readRows(page);
  assert.deepEqual(rows.slice(0, 2), initialRows, '原有房间的内容或次序被改变');
  const added = rows[2];
  assert.equal(added.cells[0], created.id, '新行编号应与创建结果一致');
  assert.equal(added.cells[1], '周末 五子棋 友谊赛', '新行名称应去掉首尾空白并保留内部空格');
  assert.equal(added.cells[1], created.name, '新行名称应与创建结果一致');
  assert.equal(added.cells[2], '五子棋');
  assert.equal(added.cells[3], '2 人');
  assert.equal(added.cells[4], '不限时', '0 秒应显示为“不限时”');
  assert.equal(added.cells[5], '未开始');
  assert.equal(added.badge, '未开始', '状态应以徽标显示“未开始”');
  assert.equal(added.timeTitle, created.createdAt, '新行创建时间应与创建结果一致');

  // 完整成功后按钮恢复可用。
  assert.equal((await readFormState(page)).submitDisabled, false, '完成后创建按钮应恢复可用');
});

// 创建被服务拒绝：页面显示服务返回的具体原因，保留已填内容，
// 不显示成功提示、不向列表添加记录；用户可直接修改保留的内容再提交。
test('创建被拒绝：显示服务端原因、保留已填内容、列表不变，可直接修改后再提交', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t);
  const initialRows = await readRows(page);
  assertSeedRows(initialRows);

  // 第一次创建请求被“服务”拒绝并返回具体原因；其余请求（含重试）正常放行。
  const REASON = '服务端拒绝：房间数量已达本场赛事上限';
  let rejected = 0;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/rooms') && rejected === 0) {
      rejected++;
      req.respond({
        status: 400,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ error: REASON }),
      });
    } else {
      req.continue();
    }
  });

  const rawName = '  深夜 飞行棋 挑战赛  ';
  await page.type('#name', rawName);
  await page.select('#game', 'ludo');
  await page.select('#capacity', '3');
  await page.type('#turnSeconds', '60');
  await page.click('#submit');

  // 页面显示服务返回的具体原因，不显示成功提示。
  await waitForMessageKind(page, 'error');
  const msg = await readMessage(page);
  assert.equal(msg.text, REASON, '应原样显示服务返回的拒绝原因');
  assert.ok(!msg.className.includes('ok'), '被拒绝时不应显示成功提示');
  assert.ok(!msg.text.includes('已创建'), '被拒绝时不应出现成功文案');

  // 已填写的名称、规则、人数、时间全部保留，用户不必重新填写。
  assert.deepEqual(await readFormState(page), {
    name: rawName,
    game: 'ludo',
    capacity: '3',
    capacityDisabled: false,
    turnSeconds: '60',
    submitDisabled: false,
  }, '被拒绝后应保留已填写内容并恢复按钮可用');

  // 列表不添加本次房间，原有房间内容与次序不变。
  assert.deepEqual(await readRows(page), initialRows, '被拒绝时不应改动房间列表');

  // 用户只修改名称（其余字段保留）即可再次提交，本次放行到真实服务。
  await page.$eval('#name', (el) => { el.value = ''; });
  const newName = '改后的 飞行棋 房间';
  await page.type('#name', newName);
  await page.click('#submit');

  await waitForMessageKind(page, 'ok');
  const msg2 = await readMessage(page);
  assert.ok(msg2.text.startsWith(SUCCESS_PREFIX), `重试应成功，实际提示: ${msg2.text}`);

  // 新记录使用保留的规则、人数与时间，追加在原有房间之后。
  await waitForRowCount(page, 3);
  const rows = await readRows(page);
  assert.deepEqual(rows.slice(0, 2), initialRows, '原有房间的内容或次序被改变');
  const added = rows[2];
  assert.equal(added.cells[1], newName, '重试时保留后修改的名称应生效');
  assert.equal(added.cells[2], '飞行棋', '重试应沿用保留的游戏规则');
  assert.equal(added.cells[3], '3 人', '重试应沿用保留的人数上限');
  assert.equal(added.cells[4], '60 秒', '重试应沿用保留的时间限制');
  assert.equal(added.badge, '未开始');
  assert.equal((await readFormState(page)).submitDisabled, false, '重试完成后按钮应恢复可用');
});

// 创建已成功、仅列表刷新失败：成功提示与编号保留，表单按成功处理；
// 列表区域明确显示加载失败，不得显示“还没有房间记录”，也不得把创建说成失败。
test('创建成功但列表刷新失败：保留成功提示与编号，列表区域显示加载失败', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);

  // 放行创建请求，仅让紧随其后的列表读取失败。
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.method() === 'GET' && req.url().endsWith('/api/rooms')) {
      req.respond({
        status: 500,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ error: '模拟列表读取失败' }),
      });
    } else {
      req.continue();
    }
  });

  await fillGomokuForm(page, '  周末 五子棋 友谊赛  ', 0);
  await page.click('#submit');

  // 创建成功提示与编号仍然展示。
  await waitForMessageKind(page, 'ok');
  const msg = await readMessage(page);
  assert.ok(msg.text.startsWith(SUCCESS_PREFIX), `应保留创建成功提示，实际: ${msg.text}`);
  const shownId = msg.text.slice(SUCCESS_PREFIX.length);
  assert.ok(shownId, '成功提示中应包含新房间编号');

  // 表单仍按成功处理（恢复初始填写状态）。
  const form = await readFormState(page);
  assert.deepEqual(form, {
    name: '',
    game: '',
    capacity: '',
    capacityDisabled: true,
    turnSeconds: '',
    submitDisabled: false,
  }, '列表刷新失败不应影响已成功创建的表单处理与按钮恢复');

  // 列表区域明确显示加载失败，而不是空列表提示或旧内容。
  await page.waitForFunction(
    () => !!document.querySelector('#list-area .list-error'),
    { timeout: 10000 },
  );
  const list = await readListArea(page);
  assert.equal(list.errorText, '房间列表加载失败，请稍后刷新重试。已有数据不会因此丢失。');
  assert.equal(list.emptyText, null, '列表刷新失败时不得显示“还没有房间记录”');
  assert.ok(!list.text.includes('还没有房间记录'), '列表刷新失败时不得显示空列表文案');
  assert.ok(!list.hasTable, '列表刷新失败时不应展示旧表格冒充最新列表');

  // 成功提示不被覆盖为失败：创建没有被说成失败，用户无需再次创建。
  const msgAfter = await readMessage(page);
  assert.ok(msgAfter.className.includes('ok'), '列表刷新失败不应把已完成的创建说成失败');
  assert.equal(msgAfter.text, msg.text, '成功提示与编号应保留');

  // 服务端确实已保存本次创建（证明创建本身成功，只是刷新失败）。
  const res = await fetch(baseURL + '/api/rooms');
  assert.equal(res.status, 200);
  const data = await res.json();
  assert.equal(data.rooms.length, 3, '服务端应已保存新房间');
  assert.equal(data.rooms[2].id, shownId, '服务端保存的编号应与页面提示一致');
});

// 提交等待期间创建按钮暂时不可用，请求完成后恢复可用，页面不停在等待状态。
test('提交等待期间创建按钮不可用，请求完成后恢复', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t);

  // 挂起创建请求，直到测试手动放行，以观察等待期间的按钮状态。
  await page.setRequestInterception(true);
  let releasePost;
  const postHeld = new Promise((resolve) => { releasePost = resolve; });
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/rooms')) {
      postHeld.then(() => req.continue());
    } else {
      req.continue();
    }
  });

  await fillGomokuForm(page, '等待中的房间', 0);
  await page.click('#submit');

  // 等待期间按钮不可用，且不是瞬间恢复。
  await page.waitForFunction(
    () => document.getElementById('submit').disabled,
    { timeout: 5000 },
  );
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal((await readFormState(page)).submitDisabled, true, '提交等待期间按钮应保持不可用');

  // 放行请求：完整成功后按钮恢复可用，不停在等待状态。
  releasePost();
  await waitForMessageKind(page, 'ok');
  await waitForRowCount(page, 3);
  await page.waitForFunction(
    () => !document.getElementById('submit').disabled,
    { timeout: 10000 },
  );
  assert.equal((await readFormState(page)).submitDisabled, false, '完成后按钮应恢复可用');
});
