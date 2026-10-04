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
// 列表查询交错（“只允许最新一次查询更新列表”）另有一组用例：打开首页会读取一次
// 列表（查询①），创建成功后再读取一次（查询②）；若①尚未返回，两次查询会同时在途。
// 页面用递增序号保证只有最新发起的查询（②）可以更新列表，较早查询（①）迟到的结果
// （旧列表、空列表或读取失败）一律忽略。这组用例精确控制两次 GET 的返回时机与内容，
// 分别覆盖②先返回而①迟到（成功/空/失败）、②失败而①后到、①在②在途时先完成却不得
// 抢先更新，以及没有交错时的基线展示。
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

// ---------------------------------------------------------------------------
// 列表查询交错返回（listQuerySeq）回归测试
//
// 打开首页时页面读取一次房间列表（查询①）；创建房间成功后再读取一次（查询②）。
// 若①迟迟不返回，两次查询会同时在途。页面约定：只有最新发起的查询（②）允许更新
// 列表区域，较早查询（①）无论后到的是成功（旧列表/空列表）还是失败，都必须忽略。
//
// 下面的用例用请求拦截把两次列表 GET 都挂起，再按用例需要精确控制各自的返回时机与
// 内容：列表 GET 捕获后挂起（由测试显式放行），创建 POST 与其他请求一律放行到真实
// 服务，保证创建真实落库；需要“本次查询成功”时对挂起的 GET 调用 continue() 走真实
// 服务（能读到创建后的最新数据），需要模拟特定快照/失败时用 respond() 合成响应。
// ---------------------------------------------------------------------------

const SEED_OBJECTS = [JSON.parse(SEED_ALPHA), JSON.parse(SEED_BETA)];

// 列表查询成功/失败的合成响应。
function listOK(rooms) {
  return {
    status: 200,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify({ rooms }),
  };
}
const LIST_FAIL_RESPONSE = {
  status: 500,
  contentType: 'application/json; charset=utf-8',
  body: JSON.stringify({ error: '模拟列表读取失败' }),
};
const LIST_ERROR_TEXT = '房间列表加载失败，请稍后刷新重试。已有数据不会因此丢失。';
const EMPTY_TEXT = '还没有房间记录。';

// setupHeldPage 启动独立服务并打开首页，但在页面脚本发出列表查询之前开启拦截：
// 所有 GET /api/rooms 被捕获后挂起（推入 gets，等待测试放行），POST 与其他请求放行到
// 真实服务。seedRaw 为创建前数据文件中的房间记录（原始 JSON 字符串数组），传 [] 表示
// 原本没有房间。返回首次查询的请求对象 req1 与全部被挂起的 GET 列表。
async function setupHeldPage(t, seedRaw = [SEED_ALPHA, SEED_BETA]) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'score-arena-uiheld-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(
    path.join(dataDir, 'rooms.json'),
    seedRaw.length ? '[\n' + seedRaw.join(',\n') + '\n]\n' : '[]\n',
  );
  const baseURL = await startServer(t, dataDir);
  const page = await browser.newPage();
  t.after(() => page.close());

  const gets = [];
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.method() === 'GET' && req.url().endsWith('/api/rooms')) {
      gets.push(req); // 挂起：等待测试决定何时、以何种结果放行。
      return;
    }
    req.continue().catch(() => {});
  });

  await page.goto(baseURL, { waitUntil: 'load' });
  const req1 = await waitForHeldGet(gets, 0);
  return { page, baseURL, gets, req1 };
}

// waitForHeldGet 等待第 index 次列表查询被页面发出并被拦截挂起。
async function waitForHeldGet(gets, index) {
  for (let i = 0; i < 1000; i++) {
    if (gets[index]) return gets[index];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`等待第 ${index + 1} 次列表查询发出超时`);
}

// settle 等待一小段时间，让被放行查询的响应穿过页面的 then/catch 处理，
// 以便断言“迟到结果已被接收但按序号规则忽略”，而不是尚未返回。
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 300));
}

// 表单成功提交后断言成功提示含本次编号、表单恢复初始状态、按钮恢复可用。
async function assertSuccessUI(page, created) {
  const msg = await readMessage(page);
  assert.ok(msg.className.includes('ok'), `应显示创建成功提示，实际 class: ${msg.className}`);
  assert.equal(msg.text, SUCCESS_PREFIX + created.id, '成功提示中的编号应与创建结果一致');
  assert.deepEqual(await readFormState(page), {
    name: '',
    game: '',
    capacity: '',
    capacityDisabled: true,
    turnSeconds: '',
    submitDisabled: false,
  }, '创建成功后表单应恢复初始填写状态，按钮恢复可用');
}

// 断言列表当前既没有房间表格，也没有加载失败提示（即没有任何查询结果抢先上屏）。
// 注意：两次查询都在途时，列表区域仍保留静态的初始空提示，因此这里只校验
// “没有表格 / 没有失败提示”，不校验空提示（那是加载前的既有初始状态）。
async function assertListUntouched(page, note) {
  const list = await readListArea(page);
  assert.equal(list.hasTable, false, `${note}：较早查询不得抢先用旧结果填充房间表格`);
  assert.equal(list.errorText, null, `${note}：较早查询不得抢先显示它的加载失败提示`);
}

// 创建成功 → 查询②先成功返回（创建后快照）→ 查询①迟到旧列表（有原有房间）。
// 页面应展示②包含的原有房间与新房间、保持次序；①的旧列表随后必须被忽略。
test('交错：创建后的查询先返回含新房间的列表，较早查询迟到的旧列表被忽略', { timeout: 60000 }, async (t) => {
  const { page, gets, req1 } = await setupHeldPage(t);

  const createdPromise = nextCreated(page);
  await fillGomokuForm(page, '  交错 五子棋 房间 ', 0);
  await page.click('#submit');
  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  // 创建成功后页面发出查询②；两次查询此时同时在途。
  const req2 = await waitForHeldGet(gets, 1);

  // 查询②先放行到真实服务：此时创建已落库，返回“原有 2 间 + 新房间”。
  await req2.continue();
  await waitForRowCount(page, 3);
  const rowsAfterSecond = await readRows(page);

  // 原有房间内容与次序不变，新房间各列与创建结果逐项一致。
  assert.deepEqual(
    rowsAfterSecond.map((r) => r.cells.slice(0, 6)),
    [
      ['seed-alpha', '晨间飞行棋', '飞行棋', '4 人', '30 秒', 'playing'],
      ['seed-beta', '午夜五子棋', '五子棋', '2 人', '不限时', '未开始'],
      [created.id, '交错 五子棋 房间', '五子棋', '2 人', '不限时', '未开始'],
    ],
    '查询②返回后应按其次序展示原有房间与新房间',
  );
  assert.equal(rowsAfterSecond[2].badge, '未开始');
  assert.equal(rowsAfterSecond[2].timeTitle, created.createdAt, '新房间创建时间应与创建结果一致');

  await assertSuccessUI(page, created);

  // 查询①随后才返回：它读到的是创建前的旧列表（只有 2 间）。
  await req1.respond(listOK(SEED_OBJECTS));
  await settle();

  // 旧列表必须被忽略：仍是查询②展示的 3 行，新房间不消失。
  const rowsAfterLateFirst = await readRows(page);
  assert.deepEqual(rowsAfterLateFirst, rowsAfterSecond, '较早查询的旧列表不得覆盖已展示的新列表');
  const list = await readListArea(page);
  assert.ok(list.hasTable, '应继续展示新列表表格');
  assert.equal(list.errorText, null);
  assert.equal(list.emptyText, null, '不得因较早查询的旧结果重新出现空列表提示');
  assert.ok(
    rowsAfterLateFirst.some((r) => r.cells[0] === created.id),
    '新房间不得因较早查询的迟到结果消失',
  );
});

// 创建成功 → 查询②先成功（创建后只有新房间）→ 查询①迟到空列表（创建前没有房间）。
// 空列表同样是“较早查询的旧结果”，必须忽略，不能让新房间消失或重现空提示。
test('交错：原本无房间，较早查询迟到返回空列表也不能让新房间消失或重现空提示', { timeout: 60000 }, async (t) => {
  const { page, gets, req1 } = await setupHeldPage(t, []);

  const createdPromise = nextCreated(page);
  await page.type('#name', ' 空房后 新建 飞行棋 ');
  await page.select('#game', 'ludo');
  await page.waitForFunction(() => !document.getElementById('capacity').disabled, { timeout: 5000 });
  await page.select('#capacity', '3');
  await page.type('#turnSeconds', '60');
  await page.click('#submit');
  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  const req2 = await waitForHeldGet(gets, 1);
  await req2.continue(); // 查询②走真实服务，返回创建后的唯一房间。
  await waitForRowCount(page, 1);
  const rowsAfterSecond = await readRows(page);
  assert.deepEqual(
    rowsAfterSecond.map((r) => r.cells.slice(0, 6)),
    [[created.id, '空房后 新建 飞行棋', '飞行棋', '3 人', '60 秒', '未开始']],
    '查询②应展示新房间，编号与配置与创建结果一致',
  );
  assert.equal(rowsAfterSecond[0].badge, '未开始');
  assert.equal(rowsAfterSecond[0].timeTitle, created.createdAt);
  await assertSuccessUI(page, created);

  // 查询①迟到返回创建前的空列表。
  await req1.respond(listOK([]));
  await settle();

  const rowsAfterLateFirst = await readRows(page);
  assert.deepEqual(rowsAfterLateFirst, rowsAfterSecond, '较早查询的空列表不得覆盖已展示的新房间');
  const list = await readListArea(page);
  assert.equal(list.emptyText, null, '不得因较早查询的空结果重新出现“还没有房间记录”');
  assert.ok(!list.text.includes(EMPTY_TEXT), '列表区域不得出现空列表文案');
  assert.ok(list.hasTable, '应继续展示新房间表格');
  assert.equal(rowsAfterLateFirst[0].cells[0], created.id, '新房间不得消失');
});

// 创建成功 → 查询②先成功 → 查询①最后读取失败。已显示的新列表必须保留，
// 较早查询的失败不得把列表区域换成加载失败提示。
test('交错：较早查询最后读取失败，已显示的新列表保留不被失败提示替换', { timeout: 60000 }, async (t) => {
  const { page, gets, req1 } = await setupHeldPage(t);

  const createdPromise = nextCreated(page);
  await fillGomokuForm(page, '迟到失败也忽略', 120);
  await page.click('#submit');
  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  const req2 = await waitForHeldGet(gets, 1);
  await req2.continue();
  await waitForRowCount(page, 3);
  const rowsAfterSecond = await readRows(page);
  assert.equal(rowsAfterSecond[2].cells[0], created.id);

  // 查询①最后以读取失败返回。
  await req1.respond(LIST_FAIL_RESPONSE);
  await settle();

  assert.deepEqual(await readRows(page), rowsAfterSecond, '较早查询失败不得改动已展示的新列表');
  const list = await readListArea(page);
  assert.equal(list.errorText, null, '较早查询的失败不得显示为加载失败提示');
  assert.ok(list.hasTable, '应继续展示新列表表格');
  assert.ok(!list.text.includes(LIST_ERROR_TEXT), '列表区域不得出现加载失败文案');
});

// 创建成功 → 查询②（本次刷新）读取失败 → 查询①随后成功返回创建前的旧房间。
// 列表必须保留“本次加载失败”，不能拿较早查询的旧记录冒充刷新成功，也不能把失败
// 解释成没有房间；创建成功与列表失败是两回事：成功提示、编号、表单复位与按钮照常。
test('交错：创建后的查询失败、较早查询随后成功，保留本次失败提示且不用旧记录冒充', { timeout: 60000 }, async (t) => {
  const { page, baseURL, gets, req1 } = await setupHeldPage(t);

  const createdPromise = nextCreated(page);
  await fillGomokuForm(page, '本次刷新失败的房间', 0);
  await page.click('#submit');
  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  // 查询②（最新一次）先返回读取失败。
  const req2 = await waitForHeldGet(gets, 1);
  await req2.respond(LIST_FAIL_RESPONSE);
  await page.waitForFunction(
    () => !!document.querySelector('#list-area .list-error'),
    { timeout: 10000 },
  );
  let list = await readListArea(page);
  assert.equal(list.errorText, LIST_ERROR_TEXT, '最新查询失败应显示本次加载失败提示');
  assert.equal(list.hasTable, false, '加载失败时不应展示房间表格');
  assert.equal(list.emptyText, null, '不得把读取失败解释成没有房间');

  // 查询①随后成功返回创建前的旧房间（2 间）。
  await req1.respond(listOK(SEED_OBJECTS));
  await settle();

  list = await readListArea(page);
  assert.equal(list.errorText, LIST_ERROR_TEXT, '较早查询成功不得替换本次加载失败提示');
  assert.equal(list.hasTable, false, '不得拿较早查询的旧房间记录冒充这次刷新成功');
  assert.equal(list.emptyText, null, '不得转成空列表提示');
  assert.ok(!list.text.includes('seed-alpha'), '较早查询的旧房间记录不得显示出来');

  // 创建成功与列表读取失败是两个独立结果：成功侧的 UI 一律保留。
  await assertSuccessUI(page, created);

  // 服务端确实已保存新房间，证明创建本身成功，仅列表刷新失败。
  const res = await fetch(baseURL + '/api/rooms');
  assert.equal(res.status, 200);
  const serverRooms = (await res.json()).rooms;
  assert.equal(serverRooms.length, 3, '服务端应已保存新房间');
  assert.equal(serverRooms[2].id, created.id);
});

// 查询①在查询②已发起但尚未返回时先成功返回（旧列表）：不得抢先更新列表；
// 之后查询②成功，页面由②的结果决定。
test('交错：较早查询在较晚查询在途时先成功返回不抢先，之后由较晚查询结果决定', { timeout: 60000 }, async (t) => {
  const { page, gets, req1 } = await setupHeldPage(t);

  const createdPromise = nextCreated(page);
  await fillGomokuForm(page, '先后次序之争', 0);
  await page.click('#submit');
  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  // 查询②已发起，两次查询同在途。
  const req2 = await waitForHeldGet(gets, 1);

  // 查询①先完成并返回创建前的旧列表——此时它已不是最新查询，必须被忽略。
  await req1.respond(listOK(SEED_OBJECTS));
  await settle();
  await assertListUntouched(page, '较早查询成功返回时不得抢先上屏');

  // 查询②随后成功：页面改由②的结果决定（原有 2 间 + 新房间）。
  await req2.continue();
  await waitForRowCount(page, 3);
  assert.deepEqual(
    (await readRows(page)).map((r) => r.cells.slice(0, 6)),
    [
      ['seed-alpha', '晨间飞行棋', '飞行棋', '4 人', '30 秒', 'playing'],
      ['seed-beta', '午夜五子棋', '五子棋', '2 人', '不限时', '未开始'],
      [created.id, '先后次序之争', '五子棋', '2 人', '不限时', '未开始'],
    ],
    '较晚查询成功后应展示其返回的列表',
  );
  const list = await readListArea(page);
  assert.ok(list.hasTable);
  assert.equal(list.errorText, null);
});

// 查询①在查询②在途时先返回失败：不得抢先显示它的失败提示；查询②成功后正常展示。
test('交错：较早查询在较晚查询在途时先失败不抢先提示，较晚查询成功后正常展示', { timeout: 60000 }, async (t) => {
  const { page, gets, req1 } = await setupHeldPage(t);

  const createdPromise = nextCreated(page);
  await fillGomokuForm(page, '较早失败被忽略', 30);
  await page.click('#submit');
  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  const req2 = await waitForHeldGet(gets, 1);

  // 查询①先失败返回，不得抢先显示失败提示。
  await req1.respond(LIST_FAIL_RESPONSE);
  await settle();
  await assertListUntouched(page, '较早查询失败时不得抢先显示失败提示');

  // 查询②成功：展示房间表格，不残留任何失败提示。
  await req2.continue();
  await waitForRowCount(page, 3);
  const rows = await readRows(page);
  assert.equal(rows[2].cells[0], created.id, '较晚查询成功后应展示新房间');
  const list = await readListArea(page);
  assert.equal(list.errorText, null, '较晚查询成功后不得残留较早查询的失败提示');
  assert.ok(list.hasTable);
});

// 无交错基线：服务端原本没有房间，首次查询正常返回空列表，显示空列表提示。
test('无交错基线：原本没有房间时首页显示空列表提示', { timeout: 60000 }, async (t) => {
  const { page, req1 } = await setupHeldPage(t, []);
  await req1.continue(); // 只有首次查询，且正常返回。
  await page.waitForFunction(
    () => !!document.querySelector('#list-area .empty'),
    { timeout: 10000 },
  );
  const list = await readListArea(page);
  assert.equal(list.emptyText, EMPTY_TEXT);
  assert.equal(list.hasTable, false);
  assert.equal(list.errorText, null);
});

// 无交错基线：首次查询读取失败时显示加载失败，而不是空列表提示或房间表格。
test('无交错基线：首次查询读取失败时显示加载失败而非空列表', { timeout: 60000 }, async (t) => {
  const { page, req1 } = await setupHeldPage(t);
  await req1.respond(LIST_FAIL_RESPONSE);
  await page.waitForFunction(
    () => !!document.querySelector('#list-area .list-error'),
    { timeout: 10000 },
  );
  const list = await readListArea(page);
  assert.equal(list.errorText, LIST_ERROR_TEXT);
  assert.equal(list.hasTable, false, '读取失败时不应展示房间表格');
  assert.equal(list.emptyText, null, '读取失败不得显示为空列表');
  assert.ok(!list.text.includes(EMPTY_TEXT));
});
