// 首页“房间列表混合记录展示”的界面回归测试。
//
// 与另外三个浏览器回归文件的分工：
//   - ui.test.mjs：创建成功/被拒、成功后列表竞态刷新、名称整理与长度边界；
//   - ui-capacity-linkage.test.mjs：游戏规则与人数上限的联动；
//   - ui-turn-seconds.test.mjs：每步时间限制的填写、提交与展示；
//   - 本文件只盯住“打开首页查看房间列表”：接口返回的数组里混着房间对象与
//     null、字符串、数字、布尔值、数组等非对象记录时，用户实际看到的列表。
//
// 保护的已有行为（本文件不修改任何产品代码，只补回归保障）：
//   - 只有 JSON 对象能成为房间行；null、字符串、数字、布尔值、数组一律跳过，
//     一条非对象记录不能拖累其他房间（它前后的房间对象都要照常显示），
//     也不能让整份列表显示加载失败；
//   - 房间行只按对象在返回数组中的相对次序排列，编号、名称、规则中文名
//     （五子棋/飞行棋）、人数、时间（0 显示“不限时”）、状态（waiting 显示
//     “未开始”）、创建时间沿用现有页面展示；
//   - “能否作为房间行”与创建房间时的配置校验无关：对象带额外字段照常展示，
//     缺少部分字段（乃至空对象）仍然成行且不计入跳过数量，单元格沿用现有
//     兜底显示；
//   - 空数组以及内部装着房间对象的数组都只是“一条数组记录”，跳过且不展开；
//     空字符串、数字 0、布尔值 false 不能因为内容为空或值为假而漏计；
//   - 列表区域必须给出准确跳过条数，并说明原始数据仍保留在服务端，未被删除
//     或改写；数组非空但全部被跳过时，说明“没有可展示的房间”与全部跳过的
//     数量，不出表格、不显示“还没有房间记录”；只有真正的空数组才显示空列表
//     提示且没有跳过警告；
//   - 查看列表本身是只读操作：接口返回的原始记录与本地 rooms.json 的数量、
//     次序、类型与附带字段保持不变；混排数据下创建房间，原始记录也原样保留，
//     新房间作为对象照常追加为最后一行。
//
// 运行：npm test（需要系统 Chrome，可用 CHROME_PATH 指定路径）。

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

// 两类正常房间：R1 飞行棋 4 人 30 秒 playing（非 waiting 状态原文展示），
// R2 五子棋 2 人 0 秒 waiting（“不限时”“未开始”两个关键中文映射）。
// R1 附带 note/tags 额外字段，与其他回归文件一样用于确认附带字段不影响展示。
const R1 =
  '{"id":"mix-alpha","name":"晨间混播飞行棋","game":"ludo","capacity":4,"turnSeconds":30,' +
  '"status":"playing","visibility":"public","createdAt":"2026-02-03T08:30:00Z",' +
  '"note":"原样保留","tags":["混排","回归"]}';
const R2 =
  '{"id":"mix-beta","name":"午夜混播五子棋","game":"gomoku","capacity":2,"turnSeconds":0,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-02-04T23:15:00Z"}';
// 带额外字段的完整房间：额外字段不得产生新列或影响既有列。
const R3_EXTRA =
  '{"id":"mix-extra","name":"多字段飞行棋","game":"ludo","capacity":3,"turnSeconds":600,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-02-05T12:00:00Z",' +
  '"weird":true,"nested":{"rank":1},"tail":[1,2,3]}';
// 缺少 turnSeconds/status/visibility/createdAt 的对象：仍是房间行，不计跳过，
// 缺字段的单元格沿用页面现有兜底显示。
const R4_PARTIAL = '{"id":"mix-partial","name":"缺字段五子棋","game":"gomoku","capacity":2}';
// 空对象同样是对象：必须成行、不计跳过，各单元格走兜底。
const R5_EMPTY = '{}';

// 装在数组里的房间对象：整个数组只算一条非对象记录，绝不能展开成房间行。
const INNER_ROOM =
  '{"id":"inside-array","name":"数组里的房间不应展开","game":"gomoku","capacity":2,' +
  '"turnSeconds":0,"status":"waiting","createdAt":"2026-02-06T00:00:00Z"}';

// 全类型混排：9 条非对象记录（含空串/0/false/空数组/装对象的数组）穿插在
// 房间对象之间，用来证明非对象记录既不拖累前一个房间，也不拖累后一个房间。
const MIXED_RECORDS = [
  R1,
  'null',
  '""',
  '"一段普通字符串"',
  '0',
  '42',
  'false',
  'true',
  '[]',
  '[' + INNER_ROOM + ']',
  R2,
  R3_EXTRA,
  R4_PARTIAL,
  R5_EMPTY,
];
const MIXED_SKIPPED = 9;
const MIXED_ROW_COUNT = 5;

const EMPTY_TEXT = '还没有房间记录。';
const SUCCESS_PREFIX = '房间已创建，编号：';

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

// seedRecords 以原始 JSON 片段写 rooms.json，返回写入的确切文本，
// 供“读取不改写文件”的逐字节比对使用。
async function seedRecords(dataDir, records) {
  const content = '[\n' + records.join(',\n') + '\n]\n';
  await writeFile(path.join(dataDir, 'rooms.json'), content);
  return content;
}

async function setupMixedPage(t, records) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'score-arena-uidata-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const seedText = await seedRecords(dataDir, records);
  const baseURL = await startServer(t, dataDir);
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(baseURL, { waitUntil: 'load' });
  return { page, baseURL, dataDir, seedText };
}

function waitForRowCount(page, n) {
  return page.waitForFunction(
    (want) => document.querySelectorAll('#list-area table tbody tr').length === want,
    { timeout: 10000 },
    n,
  );
}

// readRows 读取每行单元格文本、创建时间 title（原始 ISO）与状态徽标文本。
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

function readListArea(page) {
  return page.evaluate(() => ({
    text: document.getElementById('list-area').textContent,
    hasTable: !!document.querySelector('#list-area table'),
    rowCount: document.querySelectorAll('#list-area table tbody tr').length,
    skipText: document.querySelector('#list-area .skip-notice')
      ? document.querySelector('#list-area .skip-notice').textContent
      : null,
    skipCount: document.querySelectorAll('#list-area .skip-notice').length,
    errorText: document.querySelector('#list-area .list-error')
      ? document.querySelector('#list-area .list-error').textContent
      : null,
    emptyTexts: [...document.querySelectorAll('#list-area .empty')].map((el) => el.textContent),
  }));
}

function waitForSkipNotice(page) {
  return page.waitForFunction(
    () => !!document.querySelector('#list-area .skip-notice'),
    { timeout: 10000 },
  );
}

function waitForEmptyTip(page) {
  return page.waitForFunction(
    () => !!document.querySelector('#list-area .empty'),
    { timeout: 10000 },
  );
}

async function readServerRooms(baseURL) {
  const res = await fetch(baseURL + '/api/rooms');
  assert.equal(res.status, 200);
  return (await res.json()).rooms;
}

// 填写并提交五子棋表单（人数固定 2 人由页面自动选中）。
async function fillGomokuForm(page, name, turnSeconds) {
  await page.type('#name', name);
  await page.select('#game', 'gomoku');
  await page.waitForFunction(
    () => !document.getElementById('capacity').disabled &&
      document.getElementById('capacity').value === '2',
    { timeout: 5000 },
  );
  await page.type('#turnSeconds', String(turnSeconds));
  await page.click('#submit');
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

function waitForMessageKind(page, kind) {
  return page.waitForFunction(
    (cls) => document.getElementById('form-msg').classList.contains(cls),
    { timeout: 10000 },
    kind,
  );
}

// 全类型混排：所有房间对象按相对次序成行，9 条非对象记录（含空串/0/false/
// 空数组/装对象的数组）全部跳过且计数准确；跳过内容不成行、不展开、不导致
// 加载失败；跳过提示同时说明原始数据仍保留在服务端。
test('混合记录：房间对象全部按相对次序展示，非对象记录全部跳过并给出准确条数与保留说明', { timeout: 60000 }, async (t) => {
  const { page } = await setupMixedPage(t, MIXED_RECORDS);

  await waitForRowCount(page, MIXED_ROW_COUNT);
  await waitForSkipNotice(page);
  const list = await readListArea(page);

  // 只有对象成为房间行：5 个对象（含缺字段对象与空对象），非对象记录不展开成行。
  assert.equal(list.rowCount, MIXED_ROW_COUNT, '只有 JSON 对象应成为房间行');
  assert.equal(list.hasTable, true, '存在可展示房间时应显示房间表格');

  // 跳过条数准确：null、空串、普通字符串、0、42、false、true、空数组、
  // 装对象的数组各算一条，共 9 条。
  assert.equal(list.skipCount, 1, '列表区域应只有一条跳过提示');
  assert.equal(
    list.skipText,
    '有 ' + MIXED_SKIPPED + ' 条房间记录无法作为房间显示，已跳过；' +
      '原始数据仍保留在服务端，未被删除或改写。',
    '跳过提示的条数或保留说明不正确',
  );

  // 跳过的内容不能导致整份列表失败。
  assert.equal(list.errorText, null, '存在非对象记录不应导致列表加载失败');

  // 数组里的房间对象不能被展开：其编号与名称不出现在列表区域，
  // 普通字符串等原始内容也不应作为房间文本上屏。
  assert.ok(!list.text.includes('inside-array'), '数组内的房间记录不能被展开成房间行');
  assert.ok(!list.text.includes('数组里的房间不应展开'), '数组内容不能上屏');
  assert.ok(!list.text.includes('一段普通字符串'), '被跳过的字符串不能上屏');

  const rows = await readRows(page);
  // 房间行严格按对象在返回数组中的相对次序排列：
  // R1（最前）→ R2（跳过段之后）→ R3 → R4 → R5。
  assert.deepEqual(
    rows.map((r) => r.cells[0]),
    ['mix-alpha', 'mix-beta', 'mix-extra', 'mix-partial', ''],
    '房间行的排列次序应与对象在返回列表中的相对次序一致',
  );

  // R1：飞行棋中文名、4 人、30 秒、非 waiting 状态原文显示、创建时间保留原始 ISO。
  assert.deepEqual(rows[0].cells.slice(0, 6), [
    'mix-alpha', '晨间混播飞行棋', '飞行棋', '4 人', '30 秒', 'playing',
  ]);
  assert.equal(rows[0].badge, 'playing', '未知状态沿用原文展示');
  assert.equal(rows[0].timeTitle, '2026-02-03T08:30:00Z');
  assert.match(rows[0].cells[6], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

  // R2：五子棋中文名、0 秒显示“不限时”、waiting 显示“未开始”。
  assert.deepEqual(rows[1].cells.slice(0, 6), [
    'mix-beta', '午夜混播五子棋', '五子棋', '2 人', '不限时', '未开始',
  ]);
  assert.equal(rows[1].badge, '未开始', 'waiting 状态应以徽标显示“未开始”');
  assert.equal(rows[1].timeTitle, '2026-02-04T23:15:00Z');

  // R3：额外字段不产生新列、不改变既有列；600 秒端点正常显示。
  assert.deepEqual(rows[2].cells.slice(0, 6), [
    'mix-extra', '多字段飞行棋', '飞行棋', '3 人', '600 秒', '未开始',
  ]);
  assert.equal(rows[2].cells.length, 7, '额外字段不能导致列数变化');

  // R4：缺字段对象仍是房间行（不计跳过），缺的单元格沿用现有兜底显示。
  assert.deepEqual(rows[3].cells, [
    'mix-partial', '缺字段五子棋', '五子棋', '2 人', 'undefined 秒', '', '',
  ], '缺字段对象的单元格应沿用现有兜底显示');
  assert.equal(rows[3].badge, '');
  // 缺 createdAt 时单元格保持空白，且没有任何悬浮说明（不存在 title 属性）。
  assert.equal(rows[3].timeTitle, null);

  // R5：空对象也是对象，同样成行且不计跳过，各单元格走兜底。
  assert.deepEqual(rows[4].cells, [
    '', '', '', ' 人', 'undefined 秒', '', '',
  ], '空对象应作为房间行并沿用现有兜底显示');
  assert.equal(rows[4].badge, '');
  assert.equal(rows[4].timeTitle, null);
});

// 创建时间一列的三种展示必须互不混淆：
//   - 能解析的字符串按浏览器本地时区显示 YYYY-MM-DD HH:mm:ss（带偏移量的按
//     实际时刻换算到本地），悬浮说明保留接口返回的原始字符串；
//   - 非空但无法解析的字符串逐字按原文显示，不替换成当前时间或 Invalid Date，
//     也不附悬浮说明；原文含尖括号/引号/与号/实体样式文字时只作为文字；
//   - 字段缺失、null、空字符串时单元格空白且没有悬浮说明；
//   - 对象/数组仍统一显示“字段格式异常”，不展开、不附悬浮说明。
// 任何一种情况都不影响房间成行、行序与整份表格。
const T_OK_Z = '2026-02-03T08:30:00Z';
const T_OK_OFFSET = '2026-03-04T08:30:00+05:30';
const T_PENDING = '日期待补';
const T_TAGS = '<b>留待补录</b> &amp; "时间"';

const TIME_RECORDS = [
  { id: 'time-ok-z', name: 'UTC 时刻房', game: 'gomoku', capacity: 2, turnSeconds: 0,
    status: 'waiting', createdAt: T_OK_Z },
  { id: 'time-ok-offset', name: '带偏移时刻房', game: 'ludo', capacity: 3, turnSeconds: 60,
    status: 'waiting', createdAt: T_OK_OFFSET },
  { id: 'time-pending', name: '日期待补房', game: 'gomoku', capacity: 2, turnSeconds: 0,
    status: 'waiting', createdAt: T_PENDING },
  { id: 'time-tags', name: '标签样式原文房', game: 'ludo', capacity: 4, turnSeconds: 300,
    status: 'playing', createdAt: T_TAGS },
  { id: 'time-null', name: 'null 时间房', game: 'gomoku', capacity: 2, turnSeconds: 0,
    status: 'waiting', createdAt: null },
  { id: 'time-empty', name: '空串时间房', game: 'gomoku', capacity: 2, turnSeconds: 0,
    status: 'waiting', createdAt: '' },
  { id: 'time-missing', name: '缺字段时间房', game: 'ludo', capacity: 3, turnSeconds: 10,
    status: 'waiting' },
  { id: 'time-arr', name: '数组时间房', game: 'gomoku', capacity: 2, turnSeconds: 0,
    status: 'waiting', createdAt: [T_OK_Z] },
  { id: 'time-obj', name: '对象时间房', game: 'gomoku', capacity: 2, turnSeconds: 0,
    status: 'waiting', createdAt: { v: T_OK_Z } },
];

// 与页面同一浏览器时区下，独立按“解析时刻 → 本地分量”算出期望文本，
// 并校验把文本按本地时间解析回得到同一时刻（带偏移量的字符串不能把原串
// 里的时分直接当本地时间）。
function expectedLocalText(page, raw) {
  return page.evaluate((s) => {
    const d = new Date(s);
    const pad = (n) => String(n).padStart(2, '0');
    const text = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
    // 页面文本按本地时间解析回的时刻必须等于原字符串表示的时刻。
    const reparsed = new Date(text.replace(' ', 'T')).getTime();
    return { text, sameInstant: reparsed === d.getTime() };
  }, raw);
}

test('创建时间：有效日期本地化显示并保留原文悬浮，无效原文逐字显示，缺失留空，异常字段照旧', { timeout: 60000 }, async (t) => {
  const { page } = await setupMixedPage(t, TIME_RECORDS.map(JSON.stringify));

  await waitForRowCount(page, TIME_RECORDS.length);
  // 给页面足够时间，确认不会迟来跳过提示或加载失败。
  await new Promise((resolve) => setTimeout(resolve, 300));
  const list = await readListArea(page);
  assert.equal(list.hasTable, true, '无论创建时间能否解析都应照常显示房间表格');
  assert.equal(list.rowCount, TIME_RECORDS.length, '九种创建时间情况各占一行');
  assert.equal(list.errorText, null, '创建时间无法解析不是列表加载失败');
  assert.equal(list.skipText, null, '创建时间异常的对象不计入跳过');
  assert.ok(!list.text.includes('Invalid Date'), '页面不应生成 Invalid Date 字样');

  const rows = await readRows(page);
  assert.deepEqual(
    rows.map((r) => r.cells[0]),
    TIME_RECORDS.map((r) => r.id),
    '行的相对次序与接口一致',
  );

  // 1) 有效日期：本地格式化文本 + 原始字符串悬浮说明。
  for (const [i, raw] of [T_OK_Z, T_OK_OFFSET].entries()) {
    assert.match(rows[i].cells[6], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
      '可解析时间应显示为 YYYY-MM-DD HH:mm:ss');
    assert.equal(rows[i].timeTitle, raw, '悬浮说明应为接口返回的原始时间字符串');
    const expected = await expectedLocalText(page, raw);
    assert.equal(rows[i].cells[6], expected.text,
      '带时区信息的时间应显示其实际对应的本地时刻');
    assert.ok(expected.sameInstant, '展示文本按本地时区应对应原字符串的同一时刻');
  }

  // 2) 非空但无法解析的字符串：逐字原文显示，不附悬浮说明。
  assert.equal(rows[2].cells[6], T_PENDING, '“日期待补”应逐字显示在单元格中');
  assert.equal(rows[2].timeTitle, null, '无法解析的原文不应附带日期悬浮说明');
  assert.equal(rows[3].cells[6], T_TAGS, '含尖括号/与号/引号的原文应逐字显示');
  assert.equal(rows[3].timeTitle, null);

  // 标签样式文字必须只作为文字：不产生子元素，innerHTML 为转义写法。
  const tagCell = await page.$$eval('#list-area table tbody tr', (trs) => {
    const td = trs[3].querySelectorAll('td')[6];
    return { innerHTML: td.innerHTML, children: td.childElementCount };
  });
  assert.equal(tagCell.children, 0, '原文中的标签文字不能变成网页元素');
  assert.ok(tagCell.innerHTML.includes('&lt;b&gt;'), '尖括号应被转义为文字');
  assert.ok(tagCell.innerHTML.includes('&amp;amp;'),
    '与号应被转义为文字，类似字符实体的写法不再被解释');
  for (const tag of ['b', 'script', 'img', 'a']) {
    assert.equal(
      await page.$$eval('#list-area ' + tag, (els) => els.length),
      0,
      '创建时间原文不能产生 ' + tag + ' 元素',
    );
  }

  // 3) 缺失 / null / 空字符串：单元格空白且没有任何悬浮说明。
  for (const i of [4, 5, 6]) {
    assert.equal(rows[i].cells[6], '', '无创建时间的单元格应保持空白');
    assert.equal(rows[i].timeTitle, null, '无创建时间时不应存在 title 属性');
  }

  // 4) 对象/数组：沿用既有异常处理，只显示“字段格式异常”且无悬浮说明。
  for (const i of [7, 8]) {
    assert.equal(rows[i].cells[6], BAD_FIELD_TEXT);
    assert.equal(rows[i].timeTitle, null, '异常创建时间不应附带日期悬浮说明');
  }

  // 其他列不受影响（抽查首尾两行）。
  assert.equal(rows[0].cells[1], 'UTC 时刻房');
  assert.equal(rows[8].cells[0], 'time-obj');
  assert.equal(rows[8].badge, '未开始');
});

// 即使所有房间的创建时间都无法解析或缺失，房间表格也照常显示：
// 不显示加载失败、不计跳过、不出空列表提示，各行原文/空白各自明确。
test('所有创建时间都无法解析：照常显示房间表格与全部行，不算跳过、不算加载失败', { timeout: 60000 }, async (t) => {
  const records = [
    { id: 'all-bad-time-1', name: '房甲', game: 'gomoku', capacity: 2, turnSeconds: 0,
      status: 'waiting', createdAt: '日期待补' },
    { id: 'all-bad-time-2', name: '房乙', game: 'ludo', capacity: 4, turnSeconds: 30,
      status: 'playing', createdAt: '<span>not a date</span>' },
    { id: 'all-bad-time-3', name: '房丙', game: 'gomoku', capacity: 2, turnSeconds: 0,
      status: 'waiting' },
  ];
  const { page } = await setupMixedPage(t, records.map(JSON.stringify));

  await waitForRowCount(page, 3);
  const list = await readListArea(page);
  assert.equal(list.hasTable, true);
  assert.equal(list.rowCount, 3);
  assert.equal(list.errorText, null);
  assert.equal(list.skipText, null);
  assert.deepEqual(list.emptyTexts, []);
  assert.ok(!list.text.includes('Invalid Date'));

  const rows = await readRows(page);
  assert.equal(rows[0].cells[6], '日期待补');
  assert.equal(rows[0].timeTitle, null);
  assert.equal(rows[1].cells[6], '<span>not a date</span>');
  assert.equal(rows[1].timeTitle, null);
  assert.equal(rows[2].cells[6], '');
  assert.equal(rows[2].timeTitle, null);
});

// 数组非空但所有元素都是非对象（且刻意包含空串、0、false、空数组这些
// “空/假值”）：全部计入跳过，页面说明没有可展示的房间与全部跳过数量，
// 不出房间表格，也不显示“还没有房间记录”，更不是加载失败。
test('全部跳过：说明没有可展示房间与跳过总数，无表格、无空列表提示、无加载失败', { timeout: 60000 }, async (t) => {
  const allSkipped = ['null', '""', '0', 'false', '[]'];
  const { page } = await setupMixedPage(t, allSkipped);

  await waitForSkipNotice(page);
  // 给页面足够时间，确认不会迟来一个表格或空提示。
  await new Promise((resolve) => setTimeout(resolve, 300));
  const list = await readListArea(page);

  assert.equal(
    list.skipText,
    '没有可展示的房间。本次返回的房间记录中有 5 条无法作为房间显示，已全部跳过；' +
      '原始数据仍保留在服务端，未被删除或改写。',
    '全部跳过时应说明没有可展示的房间以及准确的全部跳过数量',
  );
  assert.equal(list.skipCount, 1);
  assert.equal(list.rowCount, 0, '非对象记录不能成为房间行');
  assert.equal(list.hasTable, false, '没有可展示房间时不应出现房间表格');
  assert.deepEqual(list.emptyTexts, [], '全部跳过时不应显示“还没有房间记录”');
  assert.ok(!list.text.includes(EMPTY_TEXT), '全部跳过时不能出现空列表文案');
  assert.equal(list.errorText, null, '跳过记录不是加载失败');
});

// 只有真正的空数组才显示空列表提示，且没有任何跳过警告。
test('真正的空数组：显示空列表提示，没有跳过警告与表格', { timeout: 60000 }, async (t) => {
  const { page } = await setupMixedPage(t, []);

  await waitForEmptyTip(page);
  const list = await readListArea(page);
  assert.deepEqual(list.emptyTexts, [EMPTY_TEXT], '只有真正的空数组才显示空列表提示');
  assert.equal(list.skipText, null, '空数组不应产生跳过警告');
  assert.equal(list.hasTable, false);
  assert.equal(list.errorText, null);
});

// 查看混合列表是只读操作：接口返回的原始记录保持数量、次序、原始类型与
// 附带字段；本地 rooms.json 逐字节不变。刷新页面再看一次结果完全一致。
test('查看混合列表后：接口原始记录与本地文件的数量、次序、类型、附带字段保持不变', { timeout: 60000 }, async (t) => {
  const { page, baseURL, dataDir, seedText } = await setupMixedPage(t, MIXED_RECORDS);

  await waitForRowCount(page, MIXED_ROW_COUNT);
  await waitForSkipNotice(page);

  // 接口返回与种子完全一致的结构（含 null/字符串/数字/布尔/数组的原始类型，
  // 以及对象的附带字段）。
  const expected = [
    JSON.parse(R1), null, '', '一段普通字符串', 0, 42, false, true, [], [JSON.parse(INNER_ROOM)],
    JSON.parse(R2), JSON.parse(R3_EXTRA), JSON.parse(R4_PARTIAL), {},
  ];
  const roomsOnce = await readServerRooms(baseURL);
  assert.deepEqual(roomsOnce, expected, '接口返回的原始记录（数量、次序、类型、附带字段）被改动');

  // 刷新页面再查看一次：用户看到的行与跳过提示保持一致。
  await page.reload({ waitUntil: 'load' });
  await waitForRowCount(page, MIXED_ROW_COUNT);
  const list = await readListArea(page);
  assert.equal(list.rowCount, MIXED_ROW_COUNT);
  assert.ok(list.skipText && list.skipText.includes('' + MIXED_SKIPPED));
  assert.deepEqual(
    (await readRows(page)).map((r) => r.cells[0]),
    ['mix-alpha', 'mix-beta', 'mix-extra', 'mix-partial', ''],
  );

  // 再次查询仍与原始结构一致；本地文件逐字节保持种子内容（读取不触发改写）。
  assert.deepEqual(await readServerRooms(baseURL), expected, '再次查看后接口记录被改动');
  const onDisk = await readFile(path.join(dataDir, 'rooms.json'), 'utf8');
  assert.equal(onDisk, seedText, '查看列表不应改写本地保存的原始记录');
});

// 两个完全正常的房间，分别放在异常记录前后，证明异常字段不会拖累相邻房间。
const OK_BEFORE =
  '{"id":"ok-before","name":"正常前房间","game":"gomoku","capacity":2,"turnSeconds":0,' +
  '"status":"waiting","createdAt":"2026-03-02T01:02:03Z"}';
const OK_AFTER =
  '{"id":"ok-after","name":"正常后房间","game":"ludo","capacity":3,"turnSeconds":300,' +
  '"status":"playing","createdAt":"2026-03-03T04:05:06Z"}';
// 名称被存成 {"toString":"旧名称"}：修复前它会让 new Date()/textContent 抛异常，
// 整份列表显示加载失败；修复后只影响名称单元格。
const BAD_NAME =
  '{"id":"bad-name","name":{"toString":"旧名称"},"game":"gomoku","capacity":2,' +
  '"turnSeconds":0,"status":"waiting","createdAt":"2026-03-04T07:08:09Z"}';
// 七个展示字段全部是对象或数组：每个单元格都只显示“字段格式异常”，
// 规则对象里即使带 "v":"ludo" 也不能映射出“飞行棋”，内部内容一律不展开。
const BAD_ALL =
  '{"id":{"v":"内嵌编号"},"name":["数组名称"],"game":{"v":"ludo"},' +
  '"capacity":{"v":4},"turnSeconds":[30],"status":{"v":"waiting"},' +
  '"createdAt":{"v":"2026-03-05T00:00:00Z"}}';
// 同一房间只有人数与时间两个字段异常：只替换这两个单元格，其余照常显示。
const BAD_MIX =
  '{"id":"bad-mix","name":"部分异常房","game":"ludo","capacity":[3],' +
  '"turnSeconds":{"v":60},"status":"waiting","createdAt":"2026-03-06T09:10:11Z",' +
  '"note":"附带字段保留"}';
const BAD_FIELD_TEXT = '字段格式异常';

// 异常字段只影响所在单元格：前后的正常房间行照常显示，异常对象仍是一行、
// 按相对次序排列且不计跳过；异常人数/时间不附“人/秒”，异常创建时间没有
// 悬浮说明，任何内部内容都不展开上屏。
test('异常字段（对象/数组）只替换所在单元格，不拖累同房间其他字段或其他房间行', { timeout: 60000 }, async (t) => {
  const { page } = await setupMixedPage(t, [OK_BEFORE, BAD_NAME, OK_AFTER, BAD_ALL, BAD_MIX]);

  await waitForRowCount(page, 5);
  // 含异常字段的对象仍然成行，不产生任何跳过计数，更不是加载失败。
  const list = await readListArea(page);
  assert.equal(list.errorText, null, '异常字段不能让整份列表加载失败');
  assert.equal(list.skipCount, 0, '含异常字段的对象不应被跳过或计数');
  assert.equal(list.skipText, null);

  const rows = await readRows(page);

  // 异常房间之前的正常房间不受影响。
  assert.deepEqual(rows[0].cells.slice(0, 6), [
    'ok-before', '正常前房间', '五子棋', '2 人', '不限时', '未开始',
  ]);
  assert.equal(rows[0].timeTitle, '2026-03-02T01:02:03Z');

  // 名称为 {"toString":"旧名称"} 的房间：只有名称单元格异常，其余字段照常；
  // “旧名称”绝不能被展开或经 toString 转换后上屏。
  assert.deepEqual(rows[1].cells.slice(0, 6), [
    'bad-name', BAD_FIELD_TEXT, '五子棋', '2 人', '不限时', '未开始',
  ]);
  assert.match(rows[1].cells[6], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(rows[1].badge, '未开始');
  assert.equal(rows[1].timeTitle, '2026-03-04T07:08:09Z');
  assert.ok(!list.text.includes('旧名称'), '异常名称的内部内容不能展开上屏');

  // 异常房间之后的正常房间同样不受影响（证明它前后的房间都能查看）。
  assert.deepEqual(rows[2].cells.slice(0, 6), [
    'ok-after', '正常后房间', '飞行棋', '3 人', '300 秒', 'playing',
  ]);

  // 七个字段全部异常：七个单元格全部只显示异常文案，状态徽标也不例外；
  // 规则对象不映射中文名，人数/时间不附单位，创建时间没有 title 悬浮说明。
  assert.deepEqual(rows[3].cells, [
    BAD_FIELD_TEXT, BAD_FIELD_TEXT, BAD_FIELD_TEXT, BAD_FIELD_TEXT,
    BAD_FIELD_TEXT, BAD_FIELD_TEXT, BAD_FIELD_TEXT,
  ]);
  assert.equal(rows[3].badge, BAD_FIELD_TEXT, '异常状态应显示字段格式异常');
  assert.equal(rows[3].timeTitle, null, '异常创建时间不应附带日期悬浮说明');

  // 只有部分字段异常的房间：其余字段（含中文规则名、未开始徽标、时间格式）照常。
  assert.deepEqual(rows[4].cells.slice(0, 6), [
    'bad-mix', '部分异常房', '飞行棋', BAD_FIELD_TEXT, BAD_FIELD_TEXT, '未开始',
  ]);
  assert.match(rows[4].cells[6], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(rows[4].badge, '未开始');
  assert.equal(rows[4].timeTitle, '2026-03-06T09:10:11Z');

  // 所有异常字段的内部内容都不能上屏。
  for (const leaked of ['内嵌编号', '数组名称', '"v"', '附带字段保留']) {
    assert.ok(!list.text.includes(leaked), '异常字段内部内容不应展开上屏：' + leaked);
  }
});

// 异常对象位于开头、中间或末尾，都不能导致其他对象行被省略。
test('异常对象位于开头/中间/末尾，其他房间行都不省略且次序不变', { timeout: 60000 }, async (t) => {
  const layouts = [
    [BAD_NAME, OK_BEFORE, OK_AFTER],
    [OK_BEFORE, BAD_NAME, OK_AFTER],
    [OK_BEFORE, OK_AFTER, BAD_NAME],
  ];
  for (const records of layouts) {
    const { page } = await setupMixedPage(t, records);
    await waitForRowCount(page, 3);
    const list = await readListArea(page);
    assert.equal(list.errorText, null);
    assert.equal(list.rowCount, 3, '异常对象位于任意位置都不能省略其他房间行');
    assert.deepEqual(
      (await readRows(page)).map((r) => r.cells[0]),
      records.map((rec, i) => JSON.parse(rec).id || ''),
      '房间行次序应与接口中对象的相对次序一致',
    );
  }
});

// 即使所有对象行都含异常字段，也要保留表格和这些行：不显示空列表提示，
// 也不显示“全部跳过”的说明（异常对象根本不计入跳过）。
test('所有房间行都含异常字段：保留表格与全部行，无空列表提示、无跳过提示、无加载失败', { timeout: 60000 }, async (t) => {
  const allBad = [
    BAD_NAME,
    '{"id":"all-bad-1","name":["名称甲"],"game":"gomoku","capacity":2,"turnSeconds":0,' +
      '"status":"waiting","createdAt":"2026-03-07T00:00:00Z"}',
    '{"id":"all-bad-2","name":{"x":"名称乙"},"game":{"v":"ludo"},"capacity":{"x":3},' +
      '"turnSeconds":[60],"status":["waiting"],"createdAt":["2026-03-08T00:00:00Z"]}',
  ];
  const { page } = await setupMixedPage(t, allBad);

  await waitForRowCount(page, 3);
  // 给页面足够时间，确认不会迟来一个空提示或跳过说明。
  await new Promise((resolve) => setTimeout(resolve, 300));
  const list = await readListArea(page);

  assert.equal(list.hasTable, true, '全部行含异常字段时仍应保留表格');
  assert.equal(list.rowCount, 3);
  assert.equal(list.errorText, null);
  assert.equal(list.skipText, null, '异常字段对象不计入跳过，不应出现跳过提示');
  assert.deepEqual(list.emptyTexts, [], '不能把含异常字段的房间当成空列表');
  assert.ok(!list.text.includes(EMPTY_TEXT));

  const rows = await readRows(page);
  assert.equal(rows[0].cells[1], BAD_FIELD_TEXT);
  assert.equal(rows[1].cells[1], BAD_FIELD_TEXT);
  assert.deepEqual(rows[1].cells.slice(2, 6), ['五子棋', '2 人', '不限时', '未开始']);
  assert.match(rows[1].cells[6], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  // 第三行除编号外的展示字段全部异常：逐格替换，编号仍正常显示。
  assert.equal(rows[2].cells[0], 'all-bad-2');
  assert.deepEqual(rows[2].cells.slice(1), [
    BAD_FIELD_TEXT, BAD_FIELD_TEXT, BAD_FIELD_TEXT, BAD_FIELD_TEXT,
    BAD_FIELD_TEXT, BAD_FIELD_TEXT,
  ]);
  assert.equal(rows[2].timeTitle, null);
});

// 异常旧记录不能妨碍新房间显示：创建成功提示不能变成失败，列表刷新后
// 旧异常记录原位保留、新房间照常追加，服务端原始记录不被删除、改写或展开。
test('异常旧记录下创建房间：成功提示保留、新房间追加、旧记录与附带字段原位保留', { timeout: 60000 }, async (t) => {
  const seed = [BAD_NAME, OK_BEFORE, 'null', '"误入的字符串"'];
  const { page, baseURL } = await setupMixedPage(t, seed);

  await waitForRowCount(page, 2);
  await waitForSkipNotice(page);

  const createdPromise = nextCreated(page);
  await fillGomokuForm(page, '异常数据下新建的房间', 0);
  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;
  assert.ok(created.id, '异常旧记录不能把创建成功变成失败');

  await waitForRowCount(page, 3);
  const list = await readListArea(page);
  assert.equal(list.rowCount, 3);
  assert.equal(list.errorText, null);
  assert.equal(
    list.skipText,
    '有 2 条房间记录无法作为房间显示，已跳过；原始数据仍保留在服务端，未被删除或改写。',
    '创建房间不应改变非对象记录的跳过计数',
  );

  const rows = await readRows(page);
  assert.deepEqual(
    rows.map((r) => r.cells[0]),
    ['bad-name', 'ok-before', created.id],
    '异常旧记录原位保留，新房间追加为最后一行',
  );
  assert.equal(rows[0].cells[1], BAD_FIELD_TEXT, '旧异常记录刷新后仍是异常单元格');
  assert.equal(rows[2].cells[1], created.name);
  assert.equal(rows[2].cells[4], '不限时');
  assert.equal(rows[2].badge, '未开始');

  // 服务端原始记录一条不少、原位保留：异常名称仍是同一个对象，非对象记录
  // 类型不变，新对象追加在最后；查看列表与创建都没有改写或展开旧记录。
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, 5, '两条对象记录、两条非对象记录与新房间合计 5 条');
  assert.deepEqual(serverRooms[0], JSON.parse(BAD_NAME), '异常名称对象必须原样保留');
  assert.deepEqual(serverRooms[1], JSON.parse(OK_BEFORE));
  assert.deepEqual(serverRooms.slice(2, 4), [null, '误入的字符串']);
  assert.equal(serverRooms[4].id, created.id, '新房间应保存在最后');
});

test('混合记录下创建房间：原始记录原位保留，新房间追加为最后一行，跳过计数不变', { timeout: 60000 }, async (t) => {
  const seed = [R1, 'null', '"误入的字符串"', 'false', R2];
  const { page, baseURL } = await setupMixedPage(t, seed);

  await waitForRowCount(page, 2);
  await waitForSkipNotice(page);
  let list = await readListArea(page);
  assert.equal(
    list.skipText,
    '有 3 条房间记录无法作为房间显示，已跳过；原始数据仍保留在服务端，未被删除或改写。',
  );

  const createdPromise = nextCreated(page);
  await fillGomokuForm(page, '混排中新建的房间', 0);
  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;
  assert.ok(created.id, '创建结果应包含新房间编号');

  // 列表刷新后：原有两个房间与新房间共 3 行，非对象记录仍跳过同样的 3 条。
  await waitForRowCount(page, 3);
  list = await readListArea(page);
  assert.equal(list.rowCount, 3);
  assert.equal(
    list.skipText,
    '有 3 条房间记录无法作为房间显示，已跳过；原始数据仍保留在服务端，未被删除或改写。',
    '创建房间不应改变跳过条数或保留说明',
  );
  const rows = await readRows(page);
  assert.deepEqual(
    rows.map((r) => r.cells[0]),
    ['mix-alpha', 'mix-beta', created.id],
    '新房间应作为对象追加在原有房间之后，原始次序不变',
  );
  assert.equal(rows[2].cells[1], created.name);
  assert.equal(rows[2].cells[4], '不限时');
  assert.equal(rows[2].badge, '未开始');

  // 服务端记录：5 条原始记录原位保留（含类型与附带字段），新对象追加在最后。
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, 6, '原始记录一条不少，另加新建房间');
  assert.deepEqual(serverRooms.slice(0, 5), [
    JSON.parse(R1), null, '误入的字符串', false, JSON.parse(R2),
  ], '原始记录的数量、次序、类型与附带字段必须原位保留');
  assert.equal(serverRooms[5].id, created.id, '新房间应保存在最后');
});
