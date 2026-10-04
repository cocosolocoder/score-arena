// 首页“创建公开房间”中“每步时间限制”输入的界面回归测试。
//
// 与 ui.test.mjs、ui-capacity-linkage.test.mjs 的分工：ui.test.mjs 覆盖成功/失败、
// 列表刷新与名称整理；ui-capacity-linkage.test.mjs 覆盖规则与人数联动；本文件只盯住
// 时间输入本身——从填写、提交前校验、请求体、创建结果到房间列表展示的完整链路。
// 所有用例中名称、规则、人数都先填合法值，让时间输入单独决定能否创建；
// 五子棋与飞行棋共用同一套时间规则，两种规则都要走到。
//
// 覆盖的产品行为（保持现有公开入口与产品行为不变）：
//   - 明确填 0 创建不限时房间，列表显示“不限时”；
//   - 10、600（两个端点，含边界）与区间内整数按所填秒数创建，
//     请求体、创建结果、服务端保存、列表展示四处一致；
//   - 成功提示中的编号与新增列表行对应，原有房间内容与次序不变；
//   - 未填写时明确提示需要填写，不能自动当成 0；
//   - 负数、1–9、超过 600 的整数被页面拒绝并提示允许范围；
//     带小数的输入被页面拒绝并提示必须填整数秒——都不能取整或改成邻近合法值；
//   - 被页面拦截时不发创建请求、服务端不增记录、列表不变、已填内容保留、
//     创建按钮保持可用、不显示成功提示或新编号；
//   - 用户看到时间错误后只修改时间再提交：按修正后的秒数创建，被拒绝的值
//     不进入任何记录，名称/规则/人数沿用，成功后表单复位、错误提示被成功结果替换。
//
// 运行：npm test（需要系统 Chrome，可用 CHROME_PATH 指定路径）。

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

// 与 ui.test.mjs 相同的种子记录：验证时间用例创建房间时，
// 原有房间的内容与次序保持不变、新房间按原方式追加。
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

function readRows(page) {
  return page.$$eval('#list-area table tbody tr', (trs) =>
    trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent)),
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

async function readServerRooms(baseURL) {
  const res = await fetch(baseURL + '/api/rooms');
  assert.equal(res.status, 200);
  return (await res.json()).rooms;
}

// trackRoomPosts 记录页面发出的每一次创建请求体：据此确认提交的 turnSeconds
// 就是用户选定的数值，以及被页面拦截时没有任何创建请求发出。
function trackRoomPosts(page) {
  const bodies = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/rooms')) {
      bodies.push(req.postData());
    }
  });
  return bodies;
}

function nextCreated(page) {
  return new Promise((resolve, reject) => {
    page.on('response', (resp) => {
      if (resp.request().method() === 'POST' && resp.url().endsWith('/api/rooms')) {
        resp.json().then(resolve, reject);
      }
    });
  });
}

const SUCCESS_PREFIX = '房间已创建，编号：';
const RANGE_ERROR = '每步时间限制只能填 0（不限时）或 10 至 600 之间的整数秒。';
const INTEGER_ERROR = '时间限制必须是整数秒，不能含小数。';
const MISSING_ERROR = '请填写每步时间限制（0 表示不限时）。';

// 两条种子房间的期望展示（时间列：30 秒 / 不限时），用于确认原有房间不变。
const SEED_ROWS = [
  ['seed-alpha', '晨间飞行棋', '飞行棋', '4 人', '30 秒', 'playing'],
  ['seed-beta', '午夜五子棋', '五子棋', '2 人', '不限时', '未开始'],
];

function assertSeedRows(rows) {
  assert.deepEqual(
    rows.slice(0, 2).map((r) => r.slice(0, 6)),
    SEED_ROWS,
    '种子房间的展示内容或次序不符合预期',
  );
}

// 填写除时间外的合法字段：五子棋人数自动固定 2 人，飞行棋需手选人数。
async function fillValidBase(page, { name, game, capacity }) {
  await page.type('#name', name);
  await page.select('#game', game);
  if (game === 'gomoku') {
    await page.waitForFunction(
      () => !document.getElementById('capacity').disabled &&
        document.getElementById('capacity').value === '2',
      { timeout: 5000 },
    );
  } else {
    await page.waitForFunction(
      () => !document.getElementById('capacity').disabled,
      { timeout: 5000 },
    );
    await page.select('#capacity', String(capacity));
  }
}

// createWithTurnSeconds 在已加载好种子房间的页面上完成一次创建并做全链路断言：
// 请求体 turnSeconds 为用户选定值、创建结果与服务端保存一致、成功提示编号对应
// 新增列表行、时间列按现有含义展示（0 → 不限时，其余 → N 秒）、原有房间不变、
// 表单复位。expectTurnText 为时间列期望文案。
async function createWithTurnSeconds(t, page, baseURL, opts) {
  const { name, game, capacity, turnSeconds, expectTurnText } = opts;
  const postBodies = trackRoomPosts(page);
  const createdPromise = nextCreated(page);

  const initialRows = await readRows(page);
  assertSeedRows(initialRows);

  await fillValidBase(page, { name, game, capacity });
  await page.type('#turnSeconds', String(turnSeconds));
  await page.click('#submit');

  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  // 只发出一次创建请求，且请求体中的时间就是用户选定的数值。
  assert.equal(postBodies.length, 1, '应只发出一次创建请求');
  const sent = JSON.parse(postBodies[0]);
  assert.equal(sent.turnSeconds, turnSeconds, '请求体的 turnSeconds 应是用户选定的数值');
  assert.equal(sent.game, game);
  assert.equal(sent.capacity, game === 'gomoku' ? 2 : capacity);

  // 创建结果保存相同秒数。
  assert.ok(created.id, '创建结果应包含新房间编号');
  assert.equal(created.turnSeconds, turnSeconds, '创建结果应保存用户选定的秒数');
  assert.equal(created.status, 'waiting');

  // 成功提示中的编号与创建结果一致。
  const msg = await readMessage(page);
  assert.ok(msg.className.includes('ok'), `应显示成功提示，实际 class: ${msg.className}`);
  assert.ok(msg.text.startsWith(SUCCESS_PREFIX), `成功提示应包含编号，实际: ${msg.text}`);
  assert.equal(msg.text.slice(SUCCESS_PREFIX.length), created.id, '提示编号应与创建结果一致');

  // 服务端房间列表查询得到的记录保存相同秒数。
  const saved = (await readServerRooms(baseURL)).find((r) => r.id === created.id);
  assert.ok(saved, '服务端应已保存本次创建的房间');
  assert.equal(saved.turnSeconds, turnSeconds, '服务端保存的秒数应与创建结果一致');

  // 列表在既有房间之后追加新行；成功提示中的编号与新增列表行对应；
  // 时间列按现有含义展示；既有房间内容与次序不变。
  const wantRows = initialRows.length + 1;
  await waitForRowCount(page, wantRows);
  const rows = await readRows(page);
  assert.deepEqual(rows.slice(0, initialRows.length), initialRows, '既有房间的内容或次序被改变');
  const added = rows[rows.length - 1];
  assert.equal(added[0], created.id, '新增列表行的编号应与成功提示中的编号对应');
  assert.equal(added[1], name);
  assert.equal(added[2], game === 'gomoku' ? '五子棋' : '飞行棋');
  assert.equal(added[3], (game === 'gomoku' ? 2 : capacity) + ' 人');
  assert.equal(added[4], expectTurnText, '时间限制列展示不符合现有含义');
  assert.equal(added[5], '未开始');

  // 成功后按现有行为复位表单：人数回到未选择规则时的禁用状态，按钮恢复可用。
  assert.deepEqual(await readFormState(page), {
    name: '',
    game: '',
    capacity: '',
    capacityDisabled: true,
    turnSeconds: '',
    submitDisabled: false,
  }, '创建成功后表单应复位、创建按钮应恢复可用');

  return created;
}

// 明确填写 0：创建不限时房间（五子棋），列表时间列显示“不限时”。
test('填写 0：成功创建不限时房间，列表显示“不限时”（五子棋）', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  await createWithTurnSeconds(t, page, baseURL, {
    name: '不限时的五子棋',
    game: 'gomoku',
    turnSeconds: 0,
    expectTurnText: '不限时',
  });
});

// 两个端点与区间内整数：10 与 600 都在允许范围内，区间内整数（300）同样合法；
// 五子棋与飞行棋共用同一套时间规则，轮流用两种规则各创建一间，
// 每一间的请求体、创建结果、服务端保存与列表展示都按所填秒数一致。
test('端点与区间内整数：10、600、300 均按所填秒数创建（两种规则同一套时间规则）', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);

  // 下端点 10：飞行棋。
  const c1 = await createWithTurnSeconds(t, page, baseURL, {
    name: '十秒飞行棋',
    game: 'ludo',
    capacity: 3,
    turnSeconds: 10,
    expectTurnText: '10 秒',
  });

  // 上端点 600：五子棋（页面在成功后会复位表单，需重新填写）。
  const c2 = await createWithTurnSeconds(t, page, baseURL, {
    name: '六百秒五子棋',
    game: 'gomoku',
    turnSeconds: 600,
    expectTurnText: '600 秒',
  });

  // 区间内整数 300：飞行棋。
  const c3 = await createWithTurnSeconds(t, page, baseURL, {
    name: '三百秒飞行棋',
    game: 'ludo',
    capacity: 4,
    turnSeconds: 300,
    expectTurnText: '300 秒',
  });

  // 三次创建各自独立成功，服务端按创建次序保存，秒数与各自所填一致。
  const rooms = await readServerRooms(baseURL);
  assert.deepEqual(
    rooms.map((r) => r.id),
    ['seed-alpha', 'seed-beta', c1.id, c2.id, c3.id],
    '服务端应在原有房间之后按次序保存三次创建',
  );
  assert.deepEqual(
    rooms.slice(2).map((r) => r.turnSeconds),
    [10, 600, 300],
    '服务端保存的秒数应与各次所填一致',
  );
});

// 时间没有填写：页面明确提示需要填写，不能自动当成 0；不发创建请求、
// 服务端不增记录、列表不变、已填内容保留、按钮保持可用、不出现成功提示。
test('未填写时间被页面拦截：明确提示需要填写，不按 0 处理，不发请求、内容保留', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const postBodies = trackRoomPosts(page);

  const initialRows = await readRows(page);
  assertSeedRows(initialRows);

  await fillValidBase(page, { name: '忘了填时间的房间', game: 'ludo', capacity: 2 });
  // 刻意不填写每步时间限制。
  await page.click('#submit');

  await waitForMessageKind(page, 'error');
  const msg = await readMessage(page);
  assert.equal(msg.text, MISSING_ERROR, '应明确提示需要填写时间');
  assert.ok(!msg.className.includes('ok'), '被拦截时不应显示成功提示');
  assert.ok(!msg.text.includes(SUCCESS_PREFIX), '被拦截时不应出现成功编号');

  // 页面直接拦截：没有发出任何创建请求，服务端不增记录，列表不变。
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(postBodies.length, 0, '未填写时间时不应发出创建请求');
  const rooms = await readServerRooms(baseURL);
  assert.equal(rooms.length, 2, '服务端不应新增记录');
  assert.ok(!rooms.some((r) => r.name === '忘了填时间的房间'), '未填写时间不能按 0 创建出房间');
  assert.deepEqual(await readRows(page), initialRows, '页面上的既有列表不应变化');

  // 名称、规则、人数保留，时间仍为空，创建按钮保持可用。
  assert.deepEqual(await readFormState(page), {
    name: '忘了填时间的房间',
    game: 'ludo',
    capacity: '2',
    capacityDisabled: false,
    turnSeconds: '',
    submitDisabled: false,
  }, '被拦截后应保留已填内容并保持按钮可用');
});

// 超出允许范围的整数：负数、1–9、超过 600 都被页面拒绝，提示允许范围；
// 不能取整或改成邻近合法值——不发请求、不增记录、列表不变、内容保留。
test('范围外整数被页面拦截：负数、1–9、超过 600 提示允许范围，不取整、不发请求', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const postBodies = trackRoomPosts(page);

  const initialRows = await readRows(page);
  assertSeedRows(initialRows);

  await fillValidBase(page, { name: '时间越界的房间', game: 'gomoku' });

  // 依次尝试负数、1–9 之间、超过 600：每次都被页面以同一范围提示拒绝。
  for (const bad of ['-5', '1', '9', '601']) {
    await page.$eval('#turnSeconds', (el) => { el.value = ''; });
    await page.type('#turnSeconds', bad);
    await page.click('#submit');

    // 页面校验在提交事件内同步完成，点击返回后提示已更新。
    await waitForMessageKind(page, 'error');
    const msg = await readMessage(page);
    assert.equal(msg.text, RANGE_ERROR, `填写 ${bad} 时应提示允许范围`);
    assert.ok(!msg.className.includes('ok'), `填写 ${bad} 时不应显示成功提示`);
    assert.ok(!msg.text.includes(SUCCESS_PREFIX), `填写 ${bad} 时不应出现成功编号`);
  }

  // 全部被页面拦截：没有任何创建请求发出，服务端不增记录，
  // 不存在被取整或改成邻近合法值（0、10、600）后创建的房间。
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(postBodies.length, 0, '范围外的时间不应发出任何创建请求');
  const rooms = await readServerRooms(baseURL);
  assert.equal(rooms.length, 2, '服务端不应新增记录');
  assert.ok(!rooms.some((r) => r.name === '时间越界的房间'), '被拒绝的值不能进入任何记录');
  assert.deepEqual(await readRows(page), initialRows, '页面上的既有列表不应变化');

  // 已填内容（含最后一次填写的时间）保留，按钮保持可用。
  const form = await readFormState(page);
  assert.equal(form.name, '时间越界的房间');
  assert.equal(form.game, 'gomoku');
  assert.equal(form.capacity, '2');
  assert.equal(form.turnSeconds, '601', '最后一次填写的时间应原样保留，不被改成合法值');
  assert.equal(form.submitDisabled, false, '创建按钮应保持可用');
});

// 带小数的输入：页面拒绝并明确提示必须填整数秒；不能取整为邻近合法值——
// 不发请求、不增记录、列表不变、内容保留。
test('小数输入被页面拦截：提示必须填整数秒，不取整、不发请求、内容保留', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const postBodies = trackRoomPosts(page);

  const initialRows = await readRows(page);
  assertSeedRows(initialRows);

  await fillValidBase(page, { name: '小数时间的房间', game: 'ludo', capacity: 4 });

  // 10.5 与 0.5 取整后都落在合法值上，必须被拦截而不是被取整放行。
  for (const bad of ['10.5', '0.5']) {
    await page.$eval('#turnSeconds', (el) => { el.value = ''; });
    await page.type('#turnSeconds', bad);
    await page.click('#submit');

    await waitForMessageKind(page, 'error');
    const msg = await readMessage(page);
    assert.equal(msg.text, INTEGER_ERROR, `填写 ${bad} 时应提示必须填整数秒`);
    assert.ok(!msg.className.includes('ok'), `填写 ${bad} 时不应显示成功提示`);
    assert.ok(!msg.text.includes(SUCCESS_PREFIX), `填写 ${bad} 时不应出现成功编号`);
  }

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(postBodies.length, 0, '小数时间不应发出任何创建请求');
  const rooms = await readServerRooms(baseURL);
  assert.equal(rooms.length, 2, '服务端不应新增记录');
  assert.ok(!rooms.some((r) => r.name === '小数时间的房间'), '小数不能被取整成 10 或 0 后创建');
  assert.deepEqual(await readRows(page), initialRows, '页面上的既有列表不应变化');

  const form = await readFormState(page);
  assert.equal(form.name, '小数时间的房间');
  assert.equal(form.game, 'ludo');
  assert.equal(form.capacity, '4');
  assert.equal(form.turnSeconds, '0.5', '最后一次填写的小数应原样保留，不被取整');
  assert.equal(form.submitDisabled, false);
});

// 用户看到时间错误后只修改这一项再提交：按修正后的秒数创建，先前被拒绝的值
// 不进入任何记录；原先填好的名称、规则、人数继续用于本次创建；成功后表单复位、
// 错误提示被本次成功结果替换、列表更新。
test('时间被拦截后仅修改时间再提交：按修正后的秒数创建，其余填写沿用', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const postBodies = trackRoomPosts(page);

  const initialRows = await readRows(page);
  assertSeedRows(initialRows);

  // 名称、规则、人数均合法，仅时间（5 秒，落在 1–9 禁区）不合法。
  await fillValidBase(page, { name: '改时间再提交的房间', game: 'ludo', capacity: 3 });
  await page.type('#turnSeconds', '5');
  await page.click('#submit');

  await waitForMessageKind(page, 'error');
  const errMsg = await readMessage(page);
  assert.equal(errMsg.text, RANGE_ERROR, '应先看到时间范围错误提示');

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(postBodies.length, 0, '被拒绝时不应发出创建请求');
  assert.equal((await readServerRooms(baseURL)).length, 2, '被拒绝时不应新增记录');

  // 用户只修改时间这一项，其余字段不动。
  const createdPromise = nextCreated(page);
  await page.$eval('#turnSeconds', (el) => { el.value = ''; });
  await page.type('#turnSeconds', '30');
  await page.click('#submit');

  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  // 只发出修正后的这一次请求，且按修正后的秒数创建；被拒绝的 5 不在其中。
  assert.equal(postBodies.length, 1, '拦截后再提交应只发出修正后的这一次创建请求');
  const sent = JSON.parse(postBodies[0]);
  assert.deepEqual(sent, {
    name: '改时间再提交的房间',
    game: 'ludo',
    capacity: 3,
    turnSeconds: 30,
  }, '请求体应沿用原先填好的名称、规则、人数，时间为修正后的值');
  assert.equal(created.turnSeconds, 30, '创建结果应保存修正后的秒数');

  // 错误提示被本次成功结果替换，成功提示中的编号与创建结果一致。
  const msg = await readMessage(page);
  assert.ok(msg.className.includes('ok'), '成功提示应替换之前的错误提示');
  assert.ok(msg.text.startsWith(SUCCESS_PREFIX), `应显示成功提示，实际: ${msg.text}`);
  assert.equal(msg.text.slice(SUCCESS_PREFIX.length), created.id);
  assert.ok(!msg.text.includes(RANGE_ERROR), '成功结果不应残留错误提示');

  // 服务端保存的是修正后的 30 秒，被拒绝的 5 不进入任何记录。
  const rooms = await readServerRooms(baseURL);
  assert.equal(rooms.length, 3, '只应新增修正后的这一间');
  const saved = rooms.find((r) => r.id === created.id);
  assert.equal(saved.turnSeconds, 30, '服务端应保存修正后的秒数');
  assert.ok(!rooms.some((r) => r.turnSeconds === 5), '被拒绝的 5 秒不能进入任何记录');

  // 列表在原有房间之后追加新行，时间列显示修正后的 30 秒；原有房间不变。
  await waitForRowCount(page, 3);
  const rows = await readRows(page);
  assert.deepEqual(rows.slice(0, 2), initialRows, '原有房间的内容或次序被改变');
  assert.deepEqual(rows[2].slice(0, 5), [
    created.id, '改时间再提交的房间', '飞行棋', '3 人', '30 秒',
  ], '新行应使用保留的名称、规则、人数与修正后的时间');

  // 成功后按现有行为复位表单：人数恢复未选择规则时的禁用状态，按钮可用。
  assert.deepEqual(await readFormState(page), {
    name: '',
    game: '',
    capacity: '',
    capacityDisabled: true,
    turnSeconds: '',
    submitDisabled: false,
  }, '成功后表单应复位、人数恢复未选择规则时的状态');
});
