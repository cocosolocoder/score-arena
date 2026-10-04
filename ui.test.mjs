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
// 名称处理另有一组用例：页面提交前按与服务端一致的规则整理名称
// （去掉首尾 Unicode 空白、保留 U+FEFF、长度按码点计），这些用例必须区分
// “页面直接拦截（不发出创建请求）”与“请求发出后被服务端拒绝”，防止页面
// 放行错误名称、仅靠服务端兜底的情况被误判为符合要求。
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

// trackRoomPosts 记录页面发出的每一次创建请求体，用于断言
// “页面直接拦截时没有发出任何创建请求”以及“发出的请求保留用户原始输入”。
function trackRoomPosts(page) {
  const bodies = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/rooms')) {
      bodies.push(req.postData());
    }
  });
  return bodies;
}

// nextCreated 在下一次创建响应到达时解析出创建结果（服务端保存后的房间）。
function nextCreated(page) {
  return new Promise((resolve, reject) => {
    page.on('response', (resp) => {
      if (resp.request().method() === 'POST' && resp.url().endsWith('/api/rooms')) {
        resp.json().then(resolve, reject);
      }
    });
  });
}

// readServerRooms 直接读接口，确认服务端实际保存的记录（绕过页面展示）。
async function readServerRooms(baseURL) {
  const res = await fetch(baseURL + '/api/rooms');
  assert.equal(res.status, 200);
  return (await res.json()).rooms;
}

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

// 名称整理规则（与服务端 strings.TrimSpace 一致）：普通空格、U+0085、U+00A0 位于
// 两端时去掉，位于内部时保留；U+FEFF 不属于应去掉的空白，在两端也保留并计入长度。
// 页面提交的请求体保留用户原始输入，创建结果与列表展示服务端整理后的名称。
test('名称整理：两端空白（含 U+0085、U+00A0）去掉，U+FEFF、内部空白与表情保留', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t);
  const postBodies = trackRoomPosts(page);
  const createdPromise = nextCreated(page);

  const initialRows = await readRows(page);
  assertSeedRows(initialRows);

  // 两端：普通空格 + U+0085 + U+00A0（应去掉），紧挨内容的 U+FEFF（应保留）；
  // 内部：U+00A0 与普通空格（应保留）；补充平面表情（应保留且只算 1 个码点）。
  const rawName = '\u00A0\u0085 \uFEFF周末\u00A0棋室🀄 \uFEFF \u0085\u00A0';
  const trimmedName = '\uFEFF周末\u00A0棋室🀄 \uFEFF';
  await fillGomokuForm(page, rawName, 0);
  await page.click('#submit');

  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  // 页面把用户原始输入原样提交（不在页面侧裁剪），只发出一次请求。
  assert.equal(postBodies.length, 1, '应只发出一次创建请求');
  assert.equal(JSON.parse(postBodies[0]).name, rawName, '请求体应保留用户原始输入');

  // 创建结果为服务端整理后的名称：两端空白去掉，U+FEFF、内部空白与表情完整保留。
  assert.equal(created.name, trimmedName, '服务端应去掉两端空白并保留 U+FEFF 与内部空白');

  // 成功提示展示本次编号，表单复位。
  const msg = await readMessage(page);
  assert.ok(msg.text.startsWith(SUCCESS_PREFIX), `应显示成功提示，实际: ${msg.text}`);
  assert.equal(msg.text.slice(SUCCESS_PREFIX.length), created.id, '提示编号应与创建结果一致');
  assert.deepEqual(await readFormState(page), {
    name: '',
    game: '',
    capacity: '',
    capacityDisabled: true,
    turnSeconds: '',
    submitDisabled: false,
  });

  // 列表在原有房间之后追加新记录，名称与创建结果一致且特殊字符完整保留。
  await waitForRowCount(page, 3);
  const rows = await readRows(page);
  assert.deepEqual(rows.slice(0, 2), initialRows, '原有房间的内容或次序被改变');
  assert.equal(rows[2].cells[0], created.id);
  assert.equal(rows[2].cells[1], trimmedName, '新行名称应完整保留 U+FEFF、内部空白与表情');
  assert.equal(rows[2].cells[1], created.name, '列表展示的名称应与创建结果一致');
});

// 只含一个 U+FEFF 的名称是合法的一字符名称：不能因看起来没有可见文字就判空。
test('仅含一个 U+FEFF 的名称是合法的一字符名称', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t);
  const postBodies = trackRoomPosts(page);
  const createdPromise = nextCreated(page);

  const initialRows = await readRows(page);
  assertSeedRows(initialRows);

  await fillGomokuForm(page, '\uFEFF', 0);
  await page.click('#submit');

  // 页面不得把 U+FEFF 当成空白判空，应正常发出创建请求并成功。
  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;
  assert.equal(postBodies.length, 1, 'U+FEFF 名称不应被页面拦截');
  assert.equal(JSON.parse(postBodies[0]).name, '\uFEFF');
  assert.equal(created.name, '\uFEFF', 'U+FEFF 应保留并计入长度');

  const msg = await readMessage(page);
  assert.equal(msg.text.slice(SUCCESS_PREFIX.length), created.id);

  await waitForRowCount(page, 3);
  const rows = await readRows(page);
  assert.deepEqual(rows.slice(0, 2), initialRows, '原有房间的内容或次序被改变');
  assert.equal(rows[2].cells[1], '\uFEFF', '列表应原样展示 U+FEFF 名称');
});

// 长度按 Unicode 码点计：中文与补充平面表情各算 1 个。整理后恰好 40 个码点可创建；
// 原始输入因两端空白超过 40 个码点时不应被页面提前拦截。
test('长度按码点计：恰好 40 码点（含表情）可创建，原始输入超长不提前拦截', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t);
  const postBodies = trackRoomPosts(page);
  const createdPromise = nextCreated(page);

  const initialRows = await readRows(page);
  assertSeedRows(initialRows);

  // 39 个中文 + 1 个补充平面表情 = 40 个码点（JS 字符串长度为 41，字节数更多，
  // 用来防止按浏览器字符串长度或字节数误判）。
  const name40 = '棋'.repeat(39) + '🀄';
  assert.equal([...name40].length, 40);
  // 两端再加空白（普通空格、U+00A0、U+0085），原始输入超过 40 个码点，
  // 但整理后恰好 40，必须放行。
  const rawName = ' \u00A0\u00A0' + name40 + '\u0085 ';
  assert.ok([...rawName].length > 40, '原始输入应因两端空白超过 40 个码点');

  await fillGomokuForm(page, rawName, 0);
  await page.click('#submit');

  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;
  assert.equal(postBodies.length, 1, '整理后恰好 40 码点不应被页面拦截');
  assert.equal(JSON.parse(postBodies[0]).name, rawName, '请求体应保留用户原始输入');
  assert.equal(created.name, name40, '服务端应去掉两端空白后保存 40 码点名称');
  assert.equal([...created.name].length, 40);

  const msg = await readMessage(page);
  assert.equal(msg.text.slice(SUCCESS_PREFIX.length), created.id);

  await waitForRowCount(page, 3);
  const rows = await readRows(page);
  assert.deepEqual(rows.slice(0, 2), initialRows, '原有房间的内容或次序被改变');
  assert.equal(rows[2].cells[1], name40, '新行名称应为整理后的 40 码点名称');
  assert.equal(rows[2].cells[1], created.name);
});

// 整理后为空的名称：页面直接拦截，明确提示不能为空，不发出创建请求、不显示
// 成功编号、不新增房间；已填内容保留，用户修正名称后按同一规则正常创建。
test('整理后为空的名称被页面拦截：不发请求、保留已填内容，修正后可创建', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const postBodies = trackRoomPosts(page);

  const initialRows = await readRows(page);
  assertSeedRows(initialRows);

  // 名称只含会被去掉的首尾空白（普通空格、U+00A0、U+0085），整理后为空。
  const blankName = ' \u00A0\u00A0\u0085 ';
  await fillGomokuForm(page, blankName, 0);
  await page.click('#submit');

  // 页面直接拦截：显示页面自己的提示（与服务端文案不同，可据此区分拦截方）。
  await waitForMessageKind(page, 'error');
  const msg = await readMessage(page);
  assert.equal(msg.text, '房间名称不能为空。', '应显示页面侧的空名称提示');
  assert.ok(!msg.className.includes('ok'), '被拦截时不应显示成功提示');
  assert.ok(!msg.text.includes(SUCCESS_PREFIX), '被拦截时不应出现成功编号');

  // 关键区分：这是页面直接拦截，必须没有发出任何创建请求；
  // 若请求被发出、仅靠服务端拒绝，本断言会失败。
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(postBodies.length, 0, '页面拦截时不应发出创建请求');
  assert.equal((await readServerRooms(baseURL)).length, 2, '服务端不应新增记录');

  // 已填写的名称与其他配置保留，按钮未被卡在等待状态，列表保持原样。
  assert.deepEqual(await readFormState(page), {
    name: blankName,
    game: 'gomoku',
    capacity: '2',
    capacityDisabled: false,
    turnSeconds: '0',
    submitDisabled: false,
  }, '被拦截后应保留已填内容');
  assert.deepEqual(await readRows(page), initialRows, '被拦截时不应改动房间列表');

  // 用户直接修正名称（新名称同样带两端空白，按同一规则整理）即可成功创建。
  const createdPromise = nextCreated(page);
  await page.$eval('#name', (el) => { el.value = ''; });
  await page.type('#name', '  补录 棋室  ');
  await page.click('#submit');

  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;
  assert.equal(created.name, '补录 棋室', '修正后的名称应按同一规则整理');
  await waitForRowCount(page, 3);
  const rows = await readRows(page);
  assert.deepEqual(rows.slice(0, 2), initialRows, '原有房间的内容或次序被改变');
  assert.equal(rows[2].cells[1], '补录 棋室');
});

// 整理后仍超过 40 个码点：页面直接拦截，明确提示超长，不发出创建请求、
// 不显示成功编号、不新增房间；已填内容保留，用户缩短名称后正常创建。
test('超过 40 码点的名称被页面拦截：不发请求、保留已填内容，修正后可创建', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const postBodies = trackRoomPosts(page);

  const initialRows = await readRows(page);
  assertSeedRows(initialRows);

  // 40 个中文 + 1 个补充平面表情 = 41 个码点（JS 字符串长度为 42），
  // 用来防止按浏览器字符串长度或字节数误判为未超长。
  const name41 = '棋'.repeat(40) + '🀄';
  assert.equal([...name41].length, 41);
  await fillGomokuForm(page, name41, 0);
  await page.click('#submit');

  // 页面直接拦截：显示页面自己的超长提示（与服务端文案不同，可据此区分拦截方）。
  await waitForMessageKind(page, 'error');
  const msg = await readMessage(page);
  assert.equal(msg.text, '房间名称去掉首尾空白后不能超过 40 个字符。', '应显示页面侧的超长提示');
  assert.ok(!msg.className.includes('ok'), '被拦截时不应显示成功提示');
  assert.ok(!msg.text.includes(SUCCESS_PREFIX), '被拦截时不应出现成功编号');

  // 关键区分：页面直接拦截，必须没有发出任何创建请求。
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(postBodies.length, 0, '页面拦截时不应发出创建请求');
  assert.equal((await readServerRooms(baseURL)).length, 2, '服务端不应新增记录');

  // 已填写的名称与其他配置保留，列表保持原样。
  assert.deepEqual(await readFormState(page), {
    name: name41,
    game: 'gomoku',
    capacity: '2',
    capacityDisabled: false,
    turnSeconds: '0',
    submitDisabled: false,
  }, '被拦截后应保留已填内容');
  assert.deepEqual(await readRows(page), initialRows, '被拦截时不应改动房间列表');

  // 用户把名称缩短到 40 个码点后即可正常创建。
  const createdPromise = nextCreated(page);
  const name40 = '棋'.repeat(40);
  await page.$eval('#name', (el) => { el.value = ''; });
  await page.type('#name', name40);
  await page.click('#submit');

  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;
  assert.equal(created.name, name40);
  assert.equal([...created.name].length, 40);
  await waitForRowCount(page, 3);
  const rows = await readRows(page);
  assert.deepEqual(rows.slice(0, 2), initialRows, '原有房间的内容或次序被改变');
  assert.equal(rows[2].cells[1], name40);
});

// 以下用例验证列表查询的“最近一次发起者为准”：打开首页的首次读取尚未结束时
// 用户完成创建，成功后又发起一次列表读取。两次查询无论以什么顺序、什么结果返回，
// 列表区域都只能被最近一次发起的查询改变；较早的查询不能覆盖、清空新列表，
// 也不能清除最近一次查询的加载失败提示。

// hold 返回一个可以在测试里手动放行的闸门。
function hold() {
  let release;
  const promise = new Promise((resolve) => { release = resolve; });
  return { promise, release };
}

const STALE_SEEDS = [JSON.parse(SEED_ALPHA), JSON.parse(SEED_BETA)];

function jsonBody(value) {
  return { status: 200, contentType: 'application/json; charset=utf-8', body: JSON.stringify(value) };
}

// setupControlledPage 在种子数据上启动服务，但先挂起首次列表读取：
// 页面 goto 后第一次 GET /api/rooms 不会返回，直到测试放行 firstGate；
// 放行时用 firstAnswer 构造它的最终响应（默认返回不含新房间的旧列表）。
// 首次读取之后的 GET 由 onLaterGet 决定（默认放行到真实服务）。
async function setupControlledPage(t, { firstAnswer, onLaterGet } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'score-arena-uidata-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await seedRooms(dataDir, SEED_ALPHA, SEED_BETA);
  const baseURL = await startServer(t, dataDir);
  const page = await browser.newPage();
  t.after(() => page.close());

  const firstGate = hold();
  let getCount = 0;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.method() === 'GET' && req.url().endsWith('/api/rooms')) {
      const idx = getCount++;
      if (idx === 0) {
        firstGate.promise.then(() => {
          if (firstAnswer) firstAnswer(req);
          else req.respond(jsonBody({ rooms: STALE_SEEDS }));
        });
      } else if (onLaterGet) {
        onLaterGet(req, idx);
      } else {
        req.continue();
      }
    } else {
      req.continue();
    }
  });

  await page.goto(baseURL, { waitUntil: 'load' });
  // 首次读取被挂起，列表不会出现表格，用户仍可照常填写并提交。
  return { page, baseURL, firstGate };
}

// 较早查询在新列表展示之后才返回时的各种形态：都不能改变列表区域。
const STALE_VARIANTS = [
  { label: '旧列表（不含新房间）', answer: (req) => req.respond(jsonBody({ rooms: STALE_SEEDS })) },
  { label: '空数组', answer: (req) => req.respond(jsonBody({ rooms: [] })) },
  { label: '错误状态 500', answer: (req) => req.respond({
    status: 500,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ error: '旧查询失败' }),
  }) },
  { label: '无法解析的响应体', answer: (req) => req.respond({
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: '这不是 JSON',
  }) },
  { label: '连接失败', answer: (req) => req.abort('failed') },
];

for (const variant of STALE_VARIANTS) {
  test('乱序返回：后一次查询已展示含新房间的列表，较早查询返回' + variant.label + '也不能改变列表', { timeout: 60000 }, async (t) => {
    const { page, firstGate } = await setupControlledPage(t, { firstAnswer: variant.answer });
    const createdPromise = nextCreated(page);

    // 首次列表读取仍在等待，用户照常填写并成功创建。
    await fillGomokuForm(page, '  周末 五子棋 友谊赛  ', 0);
    await page.click('#submit');

    await waitForMessageKind(page, 'ok');
    const created = await createdPromise;

    // 创建成功后的第二次读取放行到真实服务：先返回、先渲染，列表含 3 个房间。
    await waitForRowCount(page, 3);
    let rows = await readRows(page);
    assert.equal(rows[2].cells[0], created.id, '新房间应先由后一次查询展示出来');

    // 较早查询长期未结束期间，创建按钮已按既有流程恢复，不被旧查询拖住。
    assert.equal((await readFormState(page)).submitDisabled, false, '旧查询未结束不应让创建按钮一直不可用');

    // 此时较早的首次查询才返回（旧列表 / 空列表 / 错误 / 无法解析 / 连接失败）。
    firstGate.release();
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 列表仍是后一次查询的结果：3 行、次序不变、新房间没有消失，也没有退回
    // 空列表提示或加载失败提示。
    rows = await readRows(page);
    assert.equal(rows.length, 3, '较早查询返回' + variant.label + '后新房间不应消失');
    assert.equal(rows[0].cells[0], 'seed-alpha');
    assert.equal(rows[1].cells[0], 'seed-beta');
    assert.equal(rows[2].cells[0], created.id, '新房间必须保留在列表中');

    const list = await readListArea(page);
    assert.ok(list.hasTable, '不得用空提示或失败提示替换已展示的新列表');
    assert.equal(list.emptyText, null, '较早查询返回' + variant.label + '时不得显示空列表提示');
    assert.equal(list.errorText, null, '较早查询失败不得在新列表上显示加载失败');

    // 创建结果与列表结果分开：成功提示与编号保留。
    const msg = await readMessage(page);
    assert.ok(msg.className.includes('ok'), '列表查询的任何结果都不能把创建说成失败');
    assert.equal(msg.text, SUCCESS_PREFIX + created.id);
  });
}

// 后一次查询失败：显示既有加载失败提示；较早查询之后成功返回也不能清除它、
// 不能用旧表格冒充刷新结果，也不能把失败当成空列表。
test('乱序返回：后一次查询失败显示加载失败，较早查询随后成功也不能清除失败提示', { timeout: 60000 }, async (t) => {
  const secondGate = hold();
  const { page, firstGate } = await setupControlledPage(t, {
    onLaterGet: (req) => {
      // 创建后的第二次读取先按失败处理，但同样挂起，由测试控制先后。
      secondGate.promise.then(() => req.respond({
        status: 500,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify({ error: '模拟列表读取失败' }),
      }));
    },
  });
  const createdPromise = nextCreated(page);

  await fillGomokuForm(page, '  周末 五子棋 友谊赛  ', 0);
  await page.click('#submit');

  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  // 后一次查询先失败：显示明确的加载失败提示。
  secondGate.release();
  await page.waitForFunction(
    () => !!document.querySelector('#list-area .list-error'),
    { timeout: 10000 },
  );

  // 较早查询随后成功返回旧列表：失败提示不能被清除，旧表格不能顶上来。
  firstGate.release();
  await new Promise((resolve) => setTimeout(resolve, 500));

  const list = await readListArea(page);
  assert.equal(list.errorText, '房间列表加载失败，请稍后刷新重试。已有数据不会因此丢失。');
  assert.ok(!list.hasTable, '不得用较早查询的旧表格冒充刷新结果');
  assert.ok(!list.text.includes('还没有房间记录'), '不得把后一次查询失败当成空列表');

  // 创建结果不受列表失败影响。
  const msg = await readMessage(page);
  assert.ok(msg.className.includes('ok'), '列表失败不能把创建说成失败');
  assert.equal(msg.text, SUCCESS_PREFIX + created.id);
});

// 后一次查询仍在等待时，较早查询即使先成功返回，也不能接管列表；
// 后一次查询成功后完整展示它返回的房间与次序。
test('乱序返回：较早查询先成功也不能接管，后一次查询成功后以其结果为准', { timeout: 60000 }, async (t) => {
  const secondGate = hold();
  const { page, firstGate } = await setupControlledPage(t, {
    onLaterGet: (req) => {
      // 第二次读取放行到真实服务（此时已含新房间），但挂起由测试控制时机。
      secondGate.promise.then(() => req.continue());
    },
  });
  const createdPromise = nextCreated(page);

  await fillGomokuForm(page, '  周末 五子棋 友谊赛  ', 0);
  await page.click('#submit');
  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  // 较早查询先成功返回旧的两条种子房间：不能重新接管列表区域。
  firstGate.release();
  await new Promise((resolve) => setTimeout(resolve, 500));
  let list = await readListArea(page);
  assert.ok(!list.hasTable, '后一次查询等待中，较早查询的旧表格不能接管列表');
  assert.equal(list.errorText, null);

  // 后一次查询成功：展示它返回的全部房间（真实服务保存后的 3 条，含新房间）。
  secondGate.release();
  await waitForRowCount(page, 3);
  const rows = await readRows(page);
  assert.deepEqual(rows.slice(0, 2).map((r) => r.cells[0]), ['seed-alpha', 'seed-beta']);
  assert.equal(rows[2].cells[0], created.id, '以后一次查询返回的记录为准展示新房间');
  list = await readListArea(page);
  assert.equal(list.errorText, null);
  assert.equal(list.emptyText, null);
});

// 仅当当前有效查询成功返回空数组时，才显示既有的空列表提示：创建成功后的有效查询
// （较晚发起）先成功返回空数组，显示空提示；较早查询随后带回旧列表也不能替换它。
test('乱序返回：当前有效查询成功返回空数组才显示空列表提示，较早查询的旧列表不能替换它', { timeout: 60000 }, async (t) => {
  const { page, firstGate } = await setupControlledPage(t, {
    onLaterGet: (req) => {
      // 创建成功后的第二次读取即当前有效查询：返回空数组。
      req.respond(jsonBody({ rooms: [] }));
    },
  });
  const createdPromise = nextCreated(page);

  await fillGomokuForm(page, '  周末 五子棋 友谊赛  ', 0);
  await page.click('#submit');
  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  // 当前有效查询成功返回空数组：显示既有的空列表提示。
  await page.waitForFunction(
    () => !!document.querySelector('#list-area .empty') &&
      !document.querySelector('#list-area table'),
    { timeout: 10000 },
  );
  let list = await readListArea(page);
  assert.equal(list.emptyText, '还没有房间记录。');
  assert.equal(list.errorText, null);
  assert.ok(!list.hasTable);

  // 较早查询随后带回不含新房间的旧种子列表：空提示不能被旧表格替换。
  firstGate.release();
  await new Promise((resolve) => setTimeout(resolve, 500));
  list = await readListArea(page);
  assert.equal(list.emptyText, '还没有房间记录。', '空列表提示只能来自当前有效查询');
  assert.ok(!list.hasTable, '较早查询的旧表格不能替换有效查询的空结果');

  // 创建成功提示与编号仍独立保留，不被列表查询结果影响。
  const msg = await readMessage(page);
  assert.ok(msg.className.includes('ok'));
  assert.equal(msg.text, SUCCESS_PREFIX + created.id);
});
