// 首页房间列表“规则与状态文字展示”的界面回归测试。
//
// 列表把已知值映射成中文：gomoku→五子棋、ludo→飞行棋、waiting→未开始（徽标）。
// 历史房间里不属于这些已知值的字符串按原文逐字显示，其中最容易遗漏的是
// "constructor"、"toString"、"__proto__" 这类恰好是对象原型成员的字符串——
// 它们落在规则列或状态列时都只是普通文字：
//   - 不能变成函数源码（function Object() { ... }）、对象说明（[object Object]）
//     或“字段格式异常”，也不能导致整份列表加载失败；
//   - 同一份列表里正常房间与带未知值的历史房间同时展示：一个房间可以只有规则
//     未知、只有状态未知，也可以两项都未知且内容不同，两列各自按自己的值显示，
//     不串用另一列的文字；未知状态仍放在原有徽标里；
//   - 未知字符串不是无法展示的记录：不增加跳过条数、不出现“没有房间”的提示，
//     房间保持接口返回的相对次序，其余各列照常展示；
//   - 未知值含尖括号标签或类似 &lt; 的文字时按原有写法显示（纯文本），不生成
//     网页元素、不再解释成其他字符；字段缺失、为 null 或空字符串时规则与状态
//     单元格沿用留空行为，不出现 undefined 或 null 字样。
//
// 保障范围覆盖首次打开首页，以及在同一页面成功创建合法房间后重新展示的列表：
// 旧房间的原文与相对次序不变，新房间追加并显示所选中文规则与“未开始”，成功
// 提示及编号可见；查看与创建都不改写旧房间的未知值，接口与本地保存中的原始
// 字段及附带内容继续保留。未知值的原文展示只用于兼容历史记录，创建房间仍
// 遵守已有的规则与配置限制（表单只提供 gomoku/ludo 及各自合法人数）。
//
// 与 ui-mixed-records.test.mjs 的分工：该文件覆盖非对象记录的跳过与对象/数组
// 字段的“字段格式异常”；本文件专门覆盖“字符串未知值（含原型成员名）逐字回显”。
//
// 运行：npm install && npm test（需要系统 Chrome，可用 CHROME_PATH 指定路径）。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer-core';

const repoRoot = import.meta.dirname;
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';

let serverBin;
let browser;

// 种子记录覆盖：正常映射、只有规则未知（constructor）、只有状态未知
// （toString）、两项都未知且内容不同（__proto__ / constructor）、含尖括号与
// 实体样式文字的未知值、字段缺失与 null、空字符串。记录带有备注、数组、
// 嵌套对象等附带字段，用于验证查看与创建都不改写它们。
const SEED_NORMAL =
  '{"id":"seed-normal","name":"周赛 五子棋","game":"gomoku","capacity":2,"turnSeconds":0,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-01-01T08:00:00Z",' +
  '"note":"保留我","tags":["老友","周赛"],"extra":{"rank":3}}';
const SEED_CTOR_GAME =
  '{"id":"seed-ctor-game","name":"构造棋室","game":"constructor","capacity":4,"turnSeconds":30,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-01-02T09:00:00Z","note":"别动我"}';
const SEED_TOSTRING_STATUS =
  '{"id":"seed-tostring-status","name":"字符串状态房","game":"ludo","capacity":3,"turnSeconds":45,' +
  '"status":"toString","visibility":"public","createdAt":"2026-01-03T10:00:00Z"}';
const SEED_PROTO_BOTH =
  '{"id":"seed-proto-both","name":"双未知房","game":"__proto__","capacity":2,"turnSeconds":600,' +
  '"status":"constructor","visibility":"public","createdAt":"2026-01-04T11:00:00Z","extra":[1,2]}';
const SEED_HTMLISH =
  '{"id":"seed-htmlish","name":"标记棋室","game":"<b>chess</b>","capacity":2,"turnSeconds":10,' +
  '"status":"&lt;em&gt;paused&lt;/em&gt;","visibility":"public","createdAt":"2026-01-05T12:00:00Z"}';
const SEED_MISSING =
  '{"id":"seed-missing","name":"缺字段房","capacity":2,"turnSeconds":0,' +
  '"status":null,"visibility":"public","createdAt":"2026-01-06T13:00:00Z"}';
const SEED_EMPTY =
  '{"id":"seed-empty","name":"空串房","game":"","capacity":4,"turnSeconds":60,' +
  '"status":"","visibility":"public","createdAt":"2026-01-07T14:00:00Z"}';

const SEEDS = [
  SEED_NORMAL,
  SEED_CTOR_GAME,
  SEED_TOSTRING_STATUS,
  SEED_PROTO_BOTH,
  SEED_HTMLISH,
  SEED_MISSING,
  SEED_EMPTY,
];

// 七条种子记录的预期展示（编号、名称、规则、人数、时间、状态）与状态徽标文本。
// 未知值逐字等于原始字符串——恰好证明没有变成函数源码、[object Object]
// 或“字段格式异常”；缺失、null 与空字符串的规则/状态都留空。
const EXPECTED_ROWS = [
  { cells: ['seed-normal', '周赛 五子棋', '五子棋', '2 人', '不限时', '未开始'], badge: '未开始' },
  { cells: ['seed-ctor-game', '构造棋室', 'constructor', '4 人', '30 秒', '未开始'], badge: '未开始' },
  { cells: ['seed-tostring-status', '字符串状态房', '飞行棋', '3 人', '45 秒', 'toString'], badge: 'toString' },
  { cells: ['seed-proto-both', '双未知房', '__proto__', '2 人', '600 秒', 'constructor'], badge: 'constructor' },
  { cells: ['seed-htmlish', '标记棋室', '<b>chess</b>', '2 人', '10 秒', '&lt;em&gt;paused&lt;/em&gt;'], badge: '&lt;em&gt;paused&lt;/em&gt;' },
  { cells: ['seed-missing', '缺字段房', '', '2 人', '不限时', ''], badge: '' },
  { cells: ['seed-empty', '空串房', '', '4 人', '60 秒', ''], badge: '' },
];

const EXPECTED_TIME_TITLES = [
  '2026-01-01T08:00:00Z',
  '2026-01-02T09:00:00Z',
  '2026-01-03T10:00:00Z',
  '2026-01-04T11:00:00Z',
  '2026-01-05T12:00:00Z',
  '2026-01-06T13:00:00Z',
  '2026-01-07T14:00:00Z',
];

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

function seededContent() {
  return '[\n' + SEEDS.join(',\n') + '\n]\n';
}

// 每个用例使用独立的数据目录、服务进程与页面，互不影响。
async function setupPage(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'score-arena-uidata-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(path.join(dataDir, 'rooms.json'), seededContent());
  const baseURL = await startServer(t, dataDir);
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(baseURL, { waitUntil: 'load' });
  await waitForRowCount(page, SEEDS.length);
  return { page, baseURL, dataDir };
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

// readCell 读取指定行指定列单元格的纯文本内容、innerHTML 与子元素数量，
// 用于断言未知值按纯文本展示：textContent 逐字等于原文，且标签样式文字
// 没有变成真正的网页元素。
function readCell(page, rowIndex, colIndex) {
  return page.evaluate(
    ({ row, col }) => {
      const td = document
        .querySelectorAll('#list-area table tbody tr')[row]
        .querySelectorAll('td')[col];
      return {
        text: td.textContent,
        innerHTML: td.innerHTML,
        childElements: td.childElementCount,
      };
    },
    { row: rowIndex, col: colIndex },
  );
}

// readBadge 读取指定行状态徽标的纯文本内容、innerHTML 与子元素数量。
function readBadge(page, rowIndex) {
  return page.evaluate((row) => {
    const badge = document
      .querySelectorAll('#list-area table tbody tr')[row]
      .querySelectorAll('td')[5]
      .querySelector('.badge');
    return {
      text: badge.textContent,
      innerHTML: badge.innerHTML,
      childElements: badge.childElementCount,
    };
  }, rowIndex);
}

// countListAreaElements 统计列表区域内某类元素的数量。未知值是纯文本，
// 不应在列表区域产生加粗、斜体、图片、脚本等任何额外元素。
function countListAreaElements(page, selector) {
  return page.evaluate(
    (sel) => document.querySelectorAll('#list-area ' + sel).length,
    selector,
  );
}

// readListAreaState 读取列表区域的整体状态：可见文本、是否有跳过提示、
// 空列表提示与加载失败提示。
function readListAreaState(page) {
  return page.evaluate(() => ({
    text: document.getElementById('list-area').textContent,
    skipNotices: document.querySelectorAll('#list-area .skip-notice').length,
    emptyTips: document.querySelectorAll('#list-area .empty').length,
    listErrors: document.querySelectorAll('#list-area .list-error').length,
    tables: document.querySelectorAll('#list-area table').length,
  }));
}

function readMessage(page) {
  return page.evaluate(() => {
    const el = document.getElementById('form-msg');
    return { className: el.className, text: el.textContent };
  });
}

const SUCCESS_PREFIX = '房间已创建，编号：';

// trackRoomPosts 记录页面发出的每一次创建请求体。
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

// 断言七条种子记录全部成行、内容与次序符合预期：已知值显示中文，未知值
// （含 constructor、toString、__proto__）逐字回显在各自列，未知状态仍在
// 徽标里，缺失/null/空字符串留空，创建时间悬浮保留接口原文。
function assertSeedRows(rows) {
  assert.equal(rows.length, EXPECTED_ROWS.length, '所有种子记录都应成行，未知值不应被跳过');
  rows.forEach((row, i) => {
    assert.deepEqual(
      row.cells.slice(0, 6),
      EXPECTED_ROWS[i].cells,
      `第 ${i + 1} 行（${EXPECTED_ROWS[i].cells[0]}）的展示内容不符合预期`,
    );
    assert.equal(row.badge, EXPECTED_ROWS[i].badge, `第 ${i + 1} 行的状态徽标文本不符合预期`);
    assert.equal(row.timeTitle, EXPECTED_TIME_TITLES[i], `第 ${i + 1} 行的创建时间悬浮原文不符合预期`);
  });
}

// 断言列表区域整体状态正常：有表格、没有跳过提示（未知字符串不是无法展示
// 的记录）、没有空列表提示、没有加载失败提示，也没有把未知值渲染成函数
// 源码、对象说明或“字段格式异常”。
async function assertListAreaHealthy(page) {
  const state = await readListAreaState(page);
  assert.equal(state.tables, 1, '房间表格应正常展示');
  assert.equal(state.skipNotices, 0, '未知字符串不应增加跳过条数');
  assert.equal(state.emptyTips, 0, '有未知值记录时不应出现空列表提示');
  assert.equal(state.listErrors, 0, '未知值不应导致列表加载失败');
  assert.ok(!state.text.includes('字段格式异常'), '未知字符串不是格式异常的字段');
  assert.ok(!state.text.includes('[object Object]'), '未知值不应显示成对象说明');
  assert.ok(!state.text.includes('native code'), '未知值不应显示成函数源码');
  assert.ok(!state.text.includes('undefined'), '缺失字段不应显示 undefined 字样');
}

// 填写飞行棋表单（合法配置：3 人、45 秒），名称保留用户原始输入。
async function fillLudoForm(page, rawName, capacity, turnSeconds) {
  await page.type('#name', rawName);
  await page.select('#game', 'ludo');
  await page.waitForFunction(
    () => !document.getElementById('capacity').disabled,
    { timeout: 5000 },
  );
  await page.select('#capacity', String(capacity));
  await page.type('#turnSeconds', String(turnSeconds));
}

// 首次打开首页：正常房间与带未知值的历史房间在同一份列表里展示，已知值
// 显示中文，constructor/toString/__proto__ 等未知字符串在规则列与状态列
// 都逐字回显，两列各按自己的值显示，次序保持接口返回的相对次序。
test('首次打开：已知值中文映射与未知值原文同表展示，不跳过、不加载失败', { timeout: 60000 }, async (t) => {
  const { page, baseURL, dataDir } = await setupPage(t);

  const rows = await readRows(page);
  assertSeedRows(rows);
  await assertListAreaHealthy(page);

  // 两列分别按自己的值显示：只有规则未知的行状态仍是“未开始”，只有状态
  // 未知的行规则仍是中文，两项都未知的行两列各自回显、互不串用。
  assert.equal(rows[1].cells[2], 'constructor', '规则列应逐字显示 constructor');
  assert.equal(rows[1].cells[5], '未开始', '规则未知不影响状态列的中文映射');
  assert.equal(rows[2].cells[2], '飞行棋', '状态未知不影响规则列的中文映射');
  assert.equal(rows[2].cells[5], 'toString', '状态列应逐字显示 toString');
  assert.equal(rows[3].cells[2], '__proto__', '规则列应逐字显示 __proto__');
  assert.equal(rows[3].cells[5], 'constructor', '状态列应逐字显示自己的值，不串用规则列文字');

  // 未知状态仍放在原有徽标元素里，而不是散落成普通文字。
  assert.equal(rows[2].badge, 'toString');
  assert.equal(rows[3].badge, 'constructor');

  // 仅仅查看这些记录不改写本地数据：文件与写入时逐字节一致。
  assert.equal(
    await readFile(path.join(dataDir, 'rooms.json'), 'utf8'),
    seededContent(),
    '查看含未知值的记录不应改写本地文件',
  );
  const serverRooms = await readServerRooms(baseURL);
  assert.deepEqual(
    serverRooms,
    SEEDS.map((s) => JSON.parse(s)),
    '查看后接口返回的原始记录应保持不变',
  );
});

// 在同一页面成功创建合法房间后重新展示列表：旧房间的原文与相对次序不变，
// 新房间追加并显示所选中文规则与“未开始”，成功提示及编号可见；创建不
// 改写旧房间的未知值，接口与本地保存中的原始字段及附带内容继续保留。
test('创建合法房间后：旧房间原文与次序不变，新房间追加显示中文规则与未开始', { timeout: 60000 }, async (t) => {
  const { page, baseURL, dataDir } = await setupPage(t);
  const postBodies = trackRoomPosts(page);

  const initialRows = await readRows(page);
  assertSeedRows(initialRows);

  // 创建仍遵守已有的规则与配置限制：规则选择只提供 gomoku/ludo，
  // 未知值的原文展示只是历史记录的兼容行为，不作为可创建的新规则出现。
  const gameOptions = await page.$$eval('#game option', (opts) => opts.map((o) => o.value));
  assert.deepEqual(gameOptions, ['', 'gomoku', 'ludo'], '可创建的游戏规则不应因历史未知值而增加');

  const createdPromise = nextCreated(page);
  const rawName = '  新 棋室 🀄  ';
  const trimmedName = '新 棋室 🀄';
  await fillLudoForm(page, rawName, 3, 45);
  await page.click('#submit');

  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  // 页面按既有校验发出合法请求，创建结果沿用所选配置。
  assert.equal(postBodies.length, 1, '合法创建请求应正常发出');
  assert.deepEqual(JSON.parse(postBodies[0]), {
    name: rawName,
    game: 'ludo',
    capacity: 3,
    turnSeconds: 45,
  });
  assert.ok(created.id, '创建结果应包含新房间编号');
  assert.equal(created.name, trimmedName);
  assert.equal(created.game, 'ludo');
  assert.equal(created.capacity, 3);
  assert.equal(created.turnSeconds, 45);
  assert.equal(created.status, 'waiting');

  // 成功提示及编号仍可见。
  const msg = await readMessage(page);
  assert.ok(msg.className.includes('ok'), `应显示成功提示，实际 class: ${msg.className}`);
  assert.ok(msg.text.startsWith(SUCCESS_PREFIX), `成功提示应包含编号，实际: ${msg.text}`);
  assert.equal(msg.text.slice(SUCCESS_PREFIX.length), created.id, '提示编号应与创建结果一致');

  // 列表刷新后：旧房间的原文与相对次序不变，新房间追加在最后，
  // 显示所选中文规则与“未开始”。
  await waitForRowCount(page, SEEDS.length + 1);
  const rows = await readRows(page);
  assert.deepEqual(
    rows.slice(0, SEEDS.length),
    initialRows,
    '创建后旧房间的展示内容或相对次序不应改变',
  );
  const added = rows[SEEDS.length];
  assert.equal(added.cells[0], created.id, '新行编号应与创建结果一致');
  assert.equal(added.cells[1], trimmedName, '新行名称应与整理后的原文一致');
  assert.equal(added.cells[2], '飞行棋', '新行规则应显示所选中文规则');
  assert.equal(added.cells[3], '3 人');
  assert.equal(added.cells[4], '45 秒');
  assert.equal(added.cells[5], '未开始', '新行状态应显示“未开始”');
  assert.equal(added.badge, '未开始');
  assert.equal(added.timeTitle, created.createdAt);
  await assertListAreaHealthy(page);

  // 创建不改写旧房间的未知值：接口与本地保存中的原始字段及附带内容
  // （备注、数组、嵌套对象）继续保留，新房间只追加一条正常记录。
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, SEEDS.length + 1, '服务端应只追加一条新记录');
  assert.deepEqual(
    serverRooms.slice(0, SEEDS.length),
    SEEDS.map((s) => JSON.parse(s)),
    '接口中的旧记录（含未知值与附带字段）不应被改写',
  );
  assert.equal(serverRooms[SEEDS.length].id, created.id);
  assert.equal(serverRooms[SEEDS.length].status, 'waiting');
  assert.equal(serverRooms[SEEDS.length].visibility, 'public');

  const savedRooms = JSON.parse(await readFile(path.join(dataDir, 'rooms.json'), 'utf8'));
  assert.equal(savedRooms.length, SEEDS.length + 1, '本地文件应只追加一条新记录');
  assert.deepEqual(
    savedRooms.slice(0, SEEDS.length),
    SEEDS.map((s) => JSON.parse(s)),
    '本地保存的旧记录（含未知值与附带字段）不应被改写',
  );
  assert.equal(savedRooms[SEEDS.length].id, created.id);
});

// 未知值的纯文本回显：含尖括号标签或类似 &lt; 的文字按原有写法显示，
// 不生成网页元素、不再解释成其他字符；字段缺失、为 null 或空字符串时
// 规则与状态单元格留空，不出现 undefined 或 null 字样。首次打开与创建
// 导致的列表刷新后都成立。
test('未知值按纯文本回显，缺失与空值留空，列表刷新后仍成立', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t);

  // 含尖括号标签的未知规则：逐字可读，单元格内没有任何子元素——
  // 没有变成加粗元素；innerHTML 中是转义写法，证明浏览器把它当文字。
  const htmlishRow = 4;
  let gameCell = await readCell(page, htmlishRow, 2);
  assert.equal(gameCell.text, '<b>chess</b>', '含标签的未知规则应逐字可读');
  assert.equal(gameCell.childElements, 0, '未知规则不应变成任何网页元素');
  assert.ok(gameCell.innerHTML.includes('&lt;b&gt;'), '标签样式文字应以转义形式存在于页面中');

  // 类似 &lt; 的未知状态：显示原有写法（&lt; 显示为四个字符），不再
  // 解释成 <em>；双重转义的 innerHTML 恰好证明只被当作普通文字。
  let badge = await readBadge(page, htmlishRow);
  assert.equal(badge.text, '&lt;em&gt;paused&lt;/em&gt;', '实体样式文字应按原有写法显示');
  assert.ok(!badge.text.includes('<em>'), '实体样式文字不应被再次解释成标签');
  assert.equal(badge.childElements, 0, '未知状态不应变成任何网页元素');
  assert.ok(badge.innerHTML.includes('&amp;lt;'), '实体写法在页面中应再转义一层以保持原文显示');
  assert.equal(await countListAreaElements(page, 'b'), 0, '未知值不应变成加粗文字');
  assert.equal(await countListAreaElements(page, 'em'), 0, '未知值不应变成斜体文字');
  assert.equal(await countListAreaElements(page, 'img'), 0, '未知值不应变成图片');
  assert.equal(await countListAreaElements(page, 'script'), 0, '未知值不应产生脚本元素');

  // 字段缺失、为 null 或空字符串：规则与状态单元格留空，
  // 不出现 undefined 或 null 字样（状态列的空徽标不含任何文字）。
  for (const row of [5, 6]) {
    gameCell = await readCell(page, row, 2);
    assert.equal(gameCell.text, '', `第 ${row + 1} 行规则单元格应留空`);
    assert.equal(gameCell.childElements, 0);
    const statusCell = await readCell(page, row, 5);
    assert.equal(statusCell.text, '', `第 ${row + 1} 行状态单元格应留空`);
    assert.ok(!statusCell.text.includes('undefined'), '状态单元格不应出现 undefined 字样');
    assert.ok(!statusCell.text.includes('null'), '状态单元格不应出现 null 字样');
  }

  // 创建合法房间导致列表刷新后，未知值仍按纯文本回显、空值仍留空。
  const createdPromise = nextCreated(page);
  await page.type('#name', '刷新校验房');
  await page.select('#game', 'gomoku');
  await page.waitForFunction(
    () => !document.getElementById('capacity').disabled &&
      document.getElementById('capacity').value === '2',
    { timeout: 5000 },
  );
  await page.type('#turnSeconds', '0');
  await page.click('#submit');
  await waitForMessageKind(page, 'ok');
  await createdPromise;
  await waitForRowCount(page, SEEDS.length + 1);

  gameCell = await readCell(page, htmlishRow, 2);
  assert.equal(gameCell.text, '<b>chess</b>', '列表刷新后未知规则仍应逐字显示');
  assert.equal(gameCell.childElements, 0);
  badge = await readBadge(page, htmlishRow);
  assert.equal(badge.text, '&lt;em&gt;paused&lt;/em&gt;', '列表刷新后实体样式状态仍应保持原文');
  assert.equal(badge.childElements, 0);
  assert.equal(await countListAreaElements(page, 'b'), 0, '列表刷新后未知值仍不应变成网页元素');
  assert.equal(await countListAreaElements(page, 'em'), 0);
  for (const row of [5, 6]) {
    const refreshedGame = await readCell(page, row, 2);
    assert.equal(refreshedGame.text, '', `列表刷新后第 ${row + 1} 行规则单元格仍应留空`);
    const refreshedStatus = await readCell(page, row, 5);
    assert.equal(refreshedStatus.text, '', `列表刷新后第 ${row + 1} 行状态单元格仍应留空`);
  }
  await assertListAreaHealthy(page);
});
