// 首页“创建公开房间”中“每步时间限制（turnSeconds）”的界面回归测试。
//
// 与另外两个浏览器回归文件的分工：
//   - ui.test.mjs：创建成功/被拒、成功后列表竞态刷新、名称整理与长度边界；
//   - ui-capacity-linkage.test.mjs：游戏规则与人数上限的联动；
//   - 本文件只盯住每步时间限制，把“时间输入 → 提交的请求体 → 创建结果 →
//     房间列表查询记录 → 新列表行展示”串起来断言。名称、规则与人数在每个
//     用例里都先填写合法值，由时间输入本身决定本次创建是否被允许。
//
// 覆盖的产品行为（五子棋与飞行棋共用同一套时间规则，人数仍按各自规则选择；
// 不改变名称整理、人数联动与其他已公开行为）：
//   - 明确填 0：成功创建不限时房间，提交 0（不是缺省），创建结果与列表查询
//     记录保存相同的 0，页面新行显示“不限时”；
//   - 10、600 两个端点以及区间内的整数（如 300）：都允许创建，三处保存相同
//     秒数，页面显示“N 秒”；端点必须包含在允许范围内；
//   - 成功提示中的编号与新增列表行、创建结果一致；原有房间内容与次序不变，
//     不能只凭出现成功提示就认定时间配置正确；
//   - 未填写：明确提示需要填写，绝不自动当成 0；
//   - 负数、1 至 9 的整数、超过 600 的整数：页面按允许范围拒绝；
//     带小数的输入：页面提示必须是整数秒，不得取整或改成邻近合法值；
//   - 被拦截的提交不发出创建请求，服务端房间列表不增加记录，页面既有列表
//     不变化；名称、规则、人数与已填写的时间保留，创建按钮保持可用，不显示
//     成功提示或新编号——必须区分“页面直接拦截”与“请求发出后被服务端拒绝”；
//   - 用户看到时间错误后只修改时间这一项：修正为合法值后按修正后的秒数
//     创建，先前被拒绝的值不进入记录，原先填好的名称、规则、人数继续沿用，
//     成功后按现有行为清空表单、恢复未选规则时的人数状态并刷新列表，错误
//     提示被本次成功结果替换。
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let serverBin;
let browser;

// 与 ui.test.mjs / ui-capacity-linkage.test.mjs 相同的种子记录：
// 验证时间用例创建房间时，原有房间（含一条 30 秒、一条不限时）的内容与
// 次序保持不变，新房间按原方式追加。
const SEED_ALPHA =
  '{"id":"seed-alpha","name":"晨间飞行棋","game":"ludo","capacity":4,"turnSeconds":30,' +
  '"status":"playing","visibility":"public","createdAt":"2026-01-01T08:00:00Z","note":"保留我","tags":["老友","周赛"]}';
const SEED_BETA =
  '{"id":"seed-beta","name":"午夜五子棋","game":"gomoku","capacity":2,"turnSeconds":0,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-01-02T23:00:00Z","extra":{"rank":3}}';

const SUCCESS_PREFIX = '房间已创建，编号：';

// 页面侧三类时间提示文案（与服务端文案不同，可据此断言拦截发生在页面）。
const MSG_TURN_REQUIRED = '请填写每步时间限制（0 表示不限时）。';
const MSG_TURN_INTEGER = '时间限制必须是整数秒，不能含小数。';
const MSG_TURN_RANGE = '每步时间限制只能填 0（不限时）或 10 至 600 之间的整数秒。';

// 创建成功后的表单复位状态：名称/规则/时间清空，人数恢复“未选择规则”时的
// 禁用占位状态，创建按钮恢复可用。
const RESET_FORM = {
  name: '',
  game: '',
  capacity: '',
  capacityDisabled: true,
  turnSeconds: '',
  submitDisabled: false,
};

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

// 每个用例使用独立的数据目录、服务进程与页面，互不影响；打开页面时已有两条
// 种子房间，用于比对创建前后的列表内容与次序。
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

// readRows 读取列表每一行的单元格文本、创建时间 title 与状态徽标，
// 用于逐格比对内容与次序。
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

function assertSeedRows(rows) {
  assert.deepEqual(
    rows.map((r) => r.cells.slice(0, 6)),
    [
      ['seed-alpha', '晨间飞行棋', '飞行棋', '4 人', '30 秒', 'playing'],
      ['seed-beta', '午夜五子棋', '五子棋', '2 人', '不限时', '未开始'],
    ],
    '种子房间的展示内容或次序不符合预期',
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

// trackRoomPosts 记录页面发出的每一次创建请求体，用于断言“页面直接拦截时
// 没有发出创建请求”以及“提交的 turnSeconds 就是用户选定值”。
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

// readServerRooms 直接读接口，确认服务端实际保存的记录（绕过页面展示）。
async function readServerRooms(baseURL) {
  const res = await fetch(baseURL + '/api/rooms');
  assert.equal(res.status, 200);
  return (await res.json()).rooms;
}

// fillForm 按用例配置模拟用户填写：名称原样输入，规则按各自规则选择人数
// （五子棋由页面自动固定 2 人，飞行棋显式选择 2/3/4），时间输入用户看到的
// 原始文本；rawTurn 为 '' 时刻意留空。
async function fillForm(page, c) {
  await page.type('#name', c.name);
  await page.select('#game', c.game);
  if (c.game === 'gomoku') {
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
    await page.select('#capacity', String(c.capacity));
  }
  if (c.rawTurn !== '') await page.type('#turnSeconds', c.rawTurn);
}

// 只改时间输入这一项：清空后输入新的原始文本，其余字段一律不触碰。
async function replaceTurn(page, rawTurn) {
  await page.$eval('#turnSeconds', (el) => { el.value = ''; });
  if (rawTurn !== '') await page.type('#turnSeconds', rawTurn);
}

// expectBlocked 断言一次提交被“页面”直接拦截：显示页面自己的错误提示、
// 没有成功文案；不发出创建请求；服务端不增记录且编号集合不变；页面既有
// 列表逐格不变。返回拦截提示文本供后续比对。
async function expectBlocked(page, baseURL, postBodies, initialRows, expectedMsg) {
  await page.click('#submit');
  await waitForMessageKind(page, 'error');
  const msg = await readMessage(page);
  assert.equal(msg.text, expectedMsg, '应显示页面侧的时间错误提示');
  assert.ok(!msg.className.includes('ok'), '被拦截时不应显示成功提示');
  assert.ok(!msg.text.includes(SUCCESS_PREFIX), '被拦截时不应出现成功编号');
  assert.ok(!msg.text.includes('已创建'), '被拦截时不应出现成功文案');

  // 关键区分：页面直接拦截，必须没有发出任何创建请求；
  // 若请求被发出、仅靠服务端拒绝，本断言会失败。
  await sleep(300);
  assert.equal(postBodies.length, 0, '页面拦截时不应发出创建请求');

  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, 2, '服务端房间列表不应增加记录');
  assert.deepEqual(
    serverRooms.map((r) => r.id),
    ['seed-alpha', 'seed-beta'],
    '服务端不得出现任何新编号',
  );
  assert.deepEqual(await readRows(page), initialRows, '页面上的既有列表不应变化');
  return msg.text;
}

// =============================================================================
// 合法时间值：0（不限时）、端点 10/600、区间内整数。五子棋与飞行棋各覆盖，
// 证明两种规则共用同一套时间规则；每个用例都逐项核对请求体、创建结果、
// 房间列表查询记录三处秒数一致，以及页面展示与成功编号。
// =============================================================================

const VALID_CASES = [
  {
    title: '五子棋明确填 0：创建不限时房间，三处均为 0，页面显示“不限时”',
    name: '零秒不限五子棋', game: 'gomoku', capacity: 2,
    gameText: '五子棋', capText: '2 人',
    rawTurn: '0', turn: 0, turnText: '不限时',
  },
  {
    title: '五子棋填下端点 10：创建 10 秒房间，三处秒数一致并显示“10 秒”',
    name: '下限十秒五子棋', game: 'gomoku', capacity: 2,
    gameText: '五子棋', capText: '2 人',
    rawTurn: '10', turn: 10, turnText: '10 秒',
  },
  {
    title: '五子棋填上端点 600：创建 600 秒房间，三处秒数一致并显示“600 秒”',
    name: '上限六百秒五子棋', game: 'gomoku', capacity: 2,
    gameText: '五子棋', capText: '2 人',
    rawTurn: '600', turn: 600, turnText: '600 秒',
  },
  {
    title: '飞行棋（3 人）填下端点 10：与五子棋同一套时间规则',
    name: '下限十秒飞行棋', game: 'ludo', capacity: 3,
    gameText: '飞行棋', capText: '3 人',
    rawTurn: '10', turn: 10, turnText: '10 秒',
  },
  {
    title: '飞行棋（4 人）填上端点 600：端点包含在允许范围内',
    name: '上限六百秒飞行棋', game: 'ludo', capacity: 4,
    gameText: '飞行棋', capText: '4 人',
    rawTurn: '600', turn: 600, turnText: '600 秒',
  },
  {
    title: '飞行棋（2 人）填区间内整数 300：创建对应秒数房间',
    name: '区间整数飞行棋', game: 'ludo', capacity: 2,
    gameText: '飞行棋', capText: '2 人',
    rawTurn: '300', turn: 300, turnText: '300 秒',
  },
];

for (const c of VALID_CASES) {
  test(c.title, { timeout: 60000 }, async (t) => {
    const { page, baseURL } = await setupPage(t);
    const postBodies = trackRoomPosts(page);
    const createdPromise = nextCreated(page);

    const initialRows = await readRows(page);
    assertSeedRows(initialRows);

    await fillForm(page, c);
    await page.click('#submit');

    await waitForMessageKind(page, 'ok');
    const created = await createdPromise;

    // 提交的 turnSeconds 必须是用户选定的数值本身：0 就是数字 0（不是缺省、
    // 不是 null），其余值不被取整或改写；请求只发出一次。
    assert.equal(postBodies.length, 1, '应只发出一次创建请求');
    assert.deepEqual(
      JSON.parse(postBodies[0]),
      { name: c.name, game: c.game, capacity: c.capacity, turnSeconds: c.turn },
      '请求体应携带用户选定的秒数',
    );

    // 创建结果（服务端保存后返回的房间）保存相同秒数。
    assert.ok(created.id, '创建结果应包含非空编号');
    assert.equal(created.turnSeconds, c.turn, '创建结果必须保存用户选定的秒数');
    assert.equal(created.game, c.game);
    assert.equal(created.capacity, c.capacity);
    assert.equal(created.status, 'waiting');

    // 成功提示中的编号必须与新增列表行、创建结果对应，不能只看到成功提示
    // 就认定时间配置正确。
    const msg = await readMessage(page);
    assert.ok(msg.className.includes('ok'), `应显示成功提示，实际 class: ${msg.className}`);
    assert.ok(msg.text.startsWith(SUCCESS_PREFIX), `成功提示应包含编号，实际: ${msg.text}`);
    assert.equal(msg.text.slice(SUCCESS_PREFIX.length), created.id, '提示编号应与创建结果一致');

    // 列表在原有房间之后追加新记录，原有房间逐格保持不变；新行编号、规则、
    // 人数与时间展示都与创建结果相符。
    await waitForRowCount(page, 3);
    const rows = await readRows(page);
    assert.deepEqual(rows.slice(0, 2), initialRows, '原有房间的内容或次序被改变');
    const added = rows[2];
    assert.equal(added.cells[0], created.id, '新增行编号应与成功提示、创建结果一致');
    assert.equal(added.cells[1], c.name);
    assert.equal(added.cells[2], c.gameText);
    assert.equal(added.cells[3], c.capText);
    assert.equal(added.cells[4], c.turnText, '0 应显示“不限时”，其余合法值显示对应秒数');
    assert.equal(added.badge, '未开始');
    assert.equal(added.timeTitle, created.createdAt, '新行创建时间应与创建结果一致');

    // 房间列表查询得到的记录必须与创建结果保存相同秒数（而不只是页面显示对）。
    const serverRooms = await readServerRooms(baseURL);
    assert.equal(serverRooms.length, 3);
    const saved = serverRooms[2];
    assert.equal(saved.id, created.id, '列表查询的末条记录应是本次新增房间');
    assert.equal(saved.turnSeconds, c.turn, '列表查询记录应保存用户选定的秒数');
    assert.equal(saved.turnSeconds, created.turnSeconds, '创建结果与列表记录的秒数必须一致');

    // 成功后仍按现有行为清空表单、恢复未选择规则时的人数状态。
    assert.deepEqual(await readFormState(page), RESET_FORM, '成功后表单应复位');
  });
}

// =============================================================================
// 非法/缺失时间值：名称、规则、人数都合法，由时间输入单独决定必须被页面
// 拦截。逐类核对提示文案，且不发请求、不增记录、列表不变、内容保留、按钮可用。
// =============================================================================

const INVALID_CASES = [
  {
    title: '时间留空：明确提示需要填写，不自动当成 0，不发请求、不增房间',
    name: '未填时间五子棋', game: 'gomoku', capacity: 2,
    rawTurn: '', expectedMsg: MSG_TURN_REQUIRED,
  },
  {
    title: '负数（-5）：按允许范围拒绝，不取整或改成邻近合法值',
    name: '负数时间飞行棋', game: 'ludo', capacity: 3,
    rawTurn: '-5', expectedMsg: MSG_TURN_RANGE,
  },
  {
    title: '1 至 9 之间的整数（9）：按允许范围拒绝，不得就近当成 10',
    name: '九秒时间五子棋', game: 'gomoku', capacity: 2,
    rawTurn: '9', expectedMsg: MSG_TURN_RANGE,
  },
  {
    title: '超过 600 的整数（601）：按允许范围拒绝，不得就近当成 600',
    name: '超限时间飞行棋', game: 'ludo', capacity: 4,
    rawTurn: '601', expectedMsg: MSG_TURN_RANGE,
  },
  {
    title: '带小数的输入（30.5）：提示必须是整数秒，不得取整',
    name: '小数时间五子棋', game: 'gomoku', capacity: 2,
    rawTurn: '30.5', expectedMsg: MSG_TURN_INTEGER,
  },
];

for (const c of INVALID_CASES) {
  test(c.title, { timeout: 60000 }, async (t) => {
    const { page, baseURL } = await setupPage(t);
    const postBodies = trackRoomPosts(page);

    const initialRows = await readRows(page);
    assertSeedRows(initialRows);

    await fillForm(page, c);
    await expectBlocked(page, baseURL, postBodies, initialRows, c.expectedMsg);

    // 名称、规则、人数与已填写的时间原样保留，创建按钮保持可用，
    // 用户可以直接修改后再次提交。
    assert.deepEqual(
      await readFormState(page),
      {
        name: c.name,
        game: c.game,
        capacity: String(c.capacity),
        capacityDisabled: false,
        turnSeconds: c.rawTurn,
        submitDisabled: false,
      },
      '被拦截后应保留名称、规则、人数与已填时间，且按钮保持可用',
    );
  });
}

// =============================================================================
// 看到时间错误后“只修改时间这一项”再提交：修正为合法值后按修正后的秒数
// 创建，先前被拒绝的值不进入记录，原先填好的名称、规则、人数继续沿用；
// 成功后按现有行为复位表单并刷新列表，错误提示被成功结果替换。
// =============================================================================

// 范围错误（9）→ 仅把时间改为上端点 600，五子棋固定 2 人沿用。
test('范围错误后只把时间改为 600：按 600 创建，被拒的 9 不进入记录，其余配置沿用', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const postBodies = trackRoomPosts(page);

  const initialRows = await readRows(page);
  assertSeedRows(initialRows);

  const c = {
    name: '修正时间五子棋', game: 'gomoku', capacity: 2, rawTurn: '9',
  };
  await fillForm(page, c);
  const blockedMsg = await expectBlocked(page, baseURL, postBodies, initialRows, MSG_TURN_RANGE);

  // 拦截后名称/规则/人数/时间均保留。
  assert.deepEqual(await readFormState(page), {
    name: c.name, game: 'gomoku', capacity: '2',
    capacityDisabled: false, turnSeconds: '9', submitDisabled: false,
  });

  // 用户只修改时间这一项（名称、规则、人数完全不触碰）为合法的 600。
  await replaceTurn(page, '600');
  const createdPromise = nextCreated(page);
  await page.click('#submit');

  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  // 拦截时不发请求，修正后只发出一次请求，且请求体沿用原名称/规则/人数、
  // 携带修正后的秒数 600（先前被拒的 9 不得进入请求或记录）。
  assert.equal(postBodies.length, 1, '拦截时不发请求，修正后应只发出一次创建请求');
  assert.deepEqual(JSON.parse(postBodies[0]), {
    name: c.name, game: 'gomoku', capacity: 2, turnSeconds: 600,
  }, '请求体必须沿用原名称/规则/人数并使用修正后的秒数');
  assert.equal(created.turnSeconds, 600, '创建结果必须按修正后的 600 秒保存');
  assert.equal(created.game, 'gomoku');
  assert.equal(created.capacity, 2);

  // 错误提示被本次成功结果替换：展示成功编号，旧的范围错误文案消失。
  const msg = await readMessage(page);
  assert.ok(msg.className.includes('ok'), '修正成功后应显示成功提示而非错误提示');
  assert.ok(msg.text.startsWith(SUCCESS_PREFIX));
  assert.equal(msg.text.slice(SUCCESS_PREFIX.length), created.id);
  assert.ok(!msg.text.includes(blockedMsg), '修正成功后旧的时间错误提示应被替换');

  // 列表追加新房间并显示 600 秒；原有房间内容与次序不变。
  await waitForRowCount(page, 3);
  const rows = await readRows(page);
  assert.deepEqual(rows.slice(0, 2), initialRows, '原有房间的内容或次序被改变');
  assert.deepEqual(rows[2].cells.slice(0, 5), [
    created.id, c.name, '五子棋', '2 人', '600 秒',
  ], '新增行应沿用原名称/规则/人数并显示修正后的秒数');

  // 服务端只多出本次一条记录，秒数为 600；先前被拒的 9 不存在于任何记录。
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, 3);
  assert.equal(serverRooms[2].id, created.id);
  assert.equal(serverRooms[2].turnSeconds, 600, '列表记录应保存修正后的秒数');
  assert.ok(
    !serverRooms.some((r) => r.turnSeconds === 9),
    '先前被拒绝的 9 秒不得进入任何房间记录',
  );

  // 成功后按现有行为清空表单、恢复未选择规则时的人数状态。
  assert.deepEqual(await readFormState(page), RESET_FORM, '成功后表单应复位');
});

// 小数错误（30.5）→ 仅把时间改为 0，飞行棋 3 人与原名称沿用，结果为不限时。
test('小数错误后只把时间改为 0：按不限时创建，30.5 不进入记录，飞行棋 3 人沿用', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const postBodies = trackRoomPosts(page);

  const initialRows = await readRows(page);
  assertSeedRows(initialRows);

  const c = {
    name: '修正小数飞行棋', game: 'ludo', capacity: 3, rawTurn: '30.5',
  };
  await fillForm(page, c);
  const blockedMsg = await expectBlocked(page, baseURL, postBodies, initialRows, MSG_TURN_INTEGER);

  // 拦截后已填内容保留（含飞行棋规则与 3 人）。
  assert.deepEqual(await readFormState(page), {
    name: c.name, game: 'ludo', capacity: '3',
    capacityDisabled: false, turnSeconds: '30.5', submitDisabled: false,
  });

  // 只改时间为 0（不限时），其余不触碰。
  await replaceTurn(page, '0');
  const createdPromise = nextCreated(page);
  await page.click('#submit');

  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  assert.equal(postBodies.length, 1, '拦截时不发请求，修正后应只发出一次创建请求');
  assert.deepEqual(JSON.parse(postBodies[0]), {
    name: c.name, game: 'ludo', capacity: 3, turnSeconds: 0,
  }, '请求体必须沿用飞行棋 3 人与原名称，并提交修正后的 0');
  assert.equal(created.turnSeconds, 0, '创建结果必须按修正后的 0（不限时）保存');
  assert.equal(created.capacity, 3, '原先选好的飞行棋 3 人应继续用于本次创建');

  const msg = await readMessage(page);
  assert.ok(msg.className.includes('ok'));
  assert.equal(msg.text.slice(SUCCESS_PREFIX.length), created.id);
  assert.ok(!msg.text.includes(blockedMsg), '修正成功后旧的小数错误提示应被替换');

  await waitForRowCount(page, 3);
  const rows = await readRows(page);
  assert.deepEqual(rows.slice(0, 2), initialRows, '原有房间的内容或次序被改变');
  assert.deepEqual(rows[2].cells.slice(0, 5), [
    created.id, c.name, '飞行棋', '3 人', '不限时',
  ], '修正为 0 后新行应显示“不限时”，规则与人数沿用');

  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, 3);
  const saved = serverRooms[2];
  assert.equal(saved.id, created.id);
  assert.equal(saved.turnSeconds, 0, '列表记录应保存修正后的 0');
  assert.equal(saved.capacity, 3);

  // 成功后按现有行为复位表单（人数重新禁用，等待下一次选择规则）。
  assert.deepEqual(await readFormState(page), RESET_FORM, '成功后表单应复位');
});
