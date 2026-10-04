// 首页“房间列表”对混合记录的展示回归测试。
//
// 与另外三个浏览器回归文件的分工：
//   - ui.test.mjs：创建成功/被拒、成功后列表竞态刷新、名称整理与长度边界；
//   - ui-capacity-linkage.test.mjs：游戏规则与人数上限的联动；
//   - ui-turn-seconds.test.mjs：每步时间限制的填写、提交与展示；
//   - 本文件只盯住“查看房间列表”：接口返回的数组里混有非对象记录时，
//     页面只把 JSON 对象展示成房间行，null、字符串、数字、布尔值和数组
//     一律跳过并向用户说明跳过数量；原始记录仍保存在服务端，不被删除或改写。
//
// 覆盖的产品行为（不改动任何现有代码与接口约定）：
//   - 混合列表：所有房间对象照常显示，相对次序与返回数组中对象的次序一致；
//     编号、名称、规则中文名（五子棋/飞行棋）、人数上限、0 显示“不限时”、
//     waiting 显示“未开始”、创建时间均按现有方式展示；跳过条数准确，并说明
//     原始数据仍保留在服务端；被跳过的内容不成为房间行，也不拖垮整份列表；
//   - “能否作为房间行”只看是不是 JSON 对象，与创建表单的配置校验无关：
//     带额外字段的对象照常展示；缺少部分字段的对象也计入房间行（不计入
//     跳过数量），各单元格沿用现有兜底显示；
//   - 空数组、内部装着房间对象的数组都属于非对象记录，不展开成新房间行；
//     空字符串、数字 0、布尔值 false 不因内容为空或值为假而漏计；
//   - 返回数组非空但所有元素都被跳过：说明没有可展示的房间与全部跳过数量，
//     不出现房间表格，也不显示“还没有房间记录”；只有真正的空数组才显示
//     空列表提示，且没有跳过警告；
//   - 查看列表后，接口返回的原始记录与本地保存内容保持原有数量、次序和
//     附带字段；在混合数据之上创建公开房间的既有行为不变，新房间追加在
//     原有记录之后，被跳过的记录原样保留。
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

// 混合列表中的房间对象（含额外字段与残缺字段两类，均必须照常成为房间行）：
// - ROOM_ALPHA / ROOM_BETA / ROOM_EXTRA：完整房间记录，附带各自额外字段；
// - ROOM_PARTIAL：只有 id 与 name 的残缺对象，仍是房间行，不计入跳过数量，
//   其余单元格沿用页面现有的兜底显示。
const ROOM_ALPHA =
  '{"id":"seed-alpha","name":"晨间飞行棋","game":"ludo","capacity":4,"turnSeconds":30,' +
  '"status":"playing","visibility":"public","createdAt":"2026-01-01T08:00:00Z","note":"保留我","tags":["老友","周赛"]}';
const ROOM_BETA =
  '{"id":"seed-beta","name":"午夜五子棋","game":"gomoku","capacity":2,"turnSeconds":0,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-01-02T23:00:00Z","extra":{"rank":3}}';
const ROOM_EXTRA =
  '{"id":"seed-gamma","name":"附加字段房","game":"ludo","capacity":3,"turnSeconds":120,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-01-03T10:00:00Z",' +
  '"extraField":"anything","another":123}';
const ROOM_PARTIAL = '{"id":"seed-partial","name":"残缺记录"}';

// 非对象记录：null、字符串、数字、布尔值、空数组、装着房间对象的数组、
// 空字符串、数字 0——全部必须计入跳过数量，且不得展开或显示成房间行。
const REC_NULL = 'null';
const REC_STRING = '"纯文本记录"';
const REC_NUMBER = '42';
const REC_EMPTY_ARRAY = '[]';
const REC_FALSE = 'false';
const REC_NESTED_ROOM =
  '[{"id":"nested-room","name":"不应展开","game":"gomoku","capacity":2,' +
  '"turnSeconds":10,"status":"waiting","createdAt":"2026-01-04T00:00:00Z"}]';
const REC_EMPTY_STRING = '""';
const REC_ZERO = '0';

// 混合列表：4 个房间对象散布在 8 条非对象记录之间。
const MIXED_RECORDS = [
  ROOM_ALPHA,
  REC_NULL,
  REC_STRING,
  ROOM_BETA,
  REC_NUMBER,
  REC_EMPTY_ARRAY,
  REC_FALSE,
  REC_NESTED_ROOM,
  REC_EMPTY_STRING,
  REC_ZERO,
  ROOM_EXTRA,
  ROOM_PARTIAL,
];
const MIXED_SKIPPED = 8;

// 页面侧列表提示文案（与 index.html 中的现有文案一致）。
const EMPTY_TIP = '还没有房间记录。';
const LIST_ERROR_TEXT = '房间列表加载失败，请稍后刷新重试。已有数据不会因此丢失。';
const skipNoticeText = (n) =>
  `有 ${n} 条房间记录无法作为房间显示，已跳过；原始数据仍保留在服务端，未被删除或改写。`;
const ALL_SKIPPED_TEXT = (n) =>
  `没有可展示的房间。本次返回的房间记录中有 ${n} 条无法作为房间显示，已全部跳过；` +
  '原始数据仍保留在服务端，未被删除或改写。';

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

// 每个用例使用独立的数据目录、服务进程与页面，互不影响。records 为原始 JSON
// 片段，逐条写入 rooms.json 顶层数组；返回播种后的文件内容用于事后逐字节比对。
async function setupPage(t, records) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'score-arena-uidata-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const fileContent = '[\n' + records.join(',\n') + '\n]\n';
  await writeFile(path.join(dataDir, 'rooms.json'), fileContent);
  const baseURL = await startServer(t, dataDir);
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(baseURL, { waitUntil: 'load' });
  return { page, baseURL, dataDir, fileContent };
}

function waitForRowCount(page, n) {
  return page.waitForFunction(
    (want) => document.querySelectorAll('#list-area table tbody tr').length === want,
    { timeout: 10000 },
    n,
  );
}

function waitForSkipNotice(page) {
  return page.waitForFunction(
    () => document.querySelector('#list-area .skip-notice') !== null,
    { timeout: 10000 },
  );
}

// readListArea 读取列表区域的完整状态：子元素类别次序、跳过提示文案、
// 空列表提示、加载失败提示，以及每一行房间的内容。
function readListArea(page) {
  return page.evaluate(() => {
    const area = document.getElementById('list-area');
    const notice = area.querySelector('.skip-notice');
    const empty = area.querySelector('.empty');
    const error = area.querySelector('.list-error');
    return {
      childKinds: [...area.children].map((el) =>
        el.tagName.toLowerCase() + (el.className ? '.' + el.className : '')),
      noticeText: notice ? notice.textContent : null,
      noticeCount: area.querySelectorAll('.skip-notice').length,
      emptyText: empty ? empty.textContent : null,
      errorText: error ? error.textContent : null,
      text: area.textContent,
      rows: [...area.querySelectorAll('table tbody tr')].map((tr) => {
        const tds = [...tr.querySelectorAll('td')];
        return {
          cells: tds.map((td) => td.textContent),
          timeTitle: tds[6] ? tds[6].getAttribute('title') : null,
          badge: tds[5] && tds[5].querySelector('.badge')
            ? tds[5].querySelector('.badge').textContent
            : null,
        };
      }),
    };
  });
}

// readServerRooms 直接读接口，确认服务端实际保存的记录（绕过页面展示）。
async function readServerRooms(baseURL) {
  const res = await fetch(baseURL + '/api/rooms');
  assert.equal(res.status, 200);
  return (await res.json()).rooms;
}

// 混合列表中 4 个房间对象应有的展示内容（相对次序与返回数组一致）。
// 残缺对象 seed-partial 的其余单元格沿用页面现有兜底显示：空规则、
// 人数“ 人”、时间“undefined 秒”、空状态徽标，创建时间单元格为
// “undefined”且 title 同为“undefined”（formatTime 对空值原样返回字符串）。
const EXPECTED_MIXED_ROWS = [
  {
    cells: ['seed-alpha', '晨间飞行棋', '飞行棋', '4 人', '30 秒', 'playing'],
    badge: 'playing', timeTitle: '2026-01-01T08:00:00Z',
  },
  {
    cells: ['seed-beta', '午夜五子棋', '五子棋', '2 人', '不限时', '未开始'],
    badge: '未开始', timeTitle: '2026-01-02T23:00:00Z',
  },
  {
    cells: ['seed-gamma', '附加字段房', '飞行棋', '3 人', '120 秒', '未开始'],
    badge: '未开始', timeTitle: '2026-01-03T10:00:00Z',
  },
  {
    cells: ['seed-partial', '残缺记录', '', ' 人', 'undefined 秒', ''],
    badge: '', timeTitle: 'undefined',
  },
];

function assertMixedRows(rows) {
  assert.equal(rows.length, EXPECTED_MIXED_ROWS.length, '房间行数应等于对象记录数');
  rows.forEach((row, i) => {
    const want = EXPECTED_MIXED_ROWS[i];
    assert.deepEqual(row.cells.slice(0, 6), want.cells, `第 ${i + 1} 行的单元格内容不符`);
    assert.equal(row.badge, want.badge, `第 ${i + 1} 行的状态徽标不符`);
    assert.equal(row.timeTitle, want.timeTitle, `第 ${i + 1} 行的创建时间 title 不符`);
  });
}

// assertMixedServerIntact 断言查看列表后服务端记录与本地文件均未受影响：
// 接口返回的原始记录数量、次序、附带字段不变，rooms.json 逐字节保持播种内容。
async function assertMixedServerIntact(baseURL, dataDir, fileContent) {
  const rooms = await readServerRooms(baseURL);
  assert.deepEqual(
    rooms,
    MIXED_RECORDS.map((r) => JSON.parse(r)),
    '接口返回的原始记录应保持原有数量、次序与附带字段',
  );
  const onDisk = await readFile(path.join(dataDir, 'rooms.json'), 'utf8');
  assert.equal(onDisk, fileContent, '仅查看列表不应改写本地保存内容');
}

// =============================================================================
// 混合列表：房间对象与非对象记录交错。所有对象照常成行且保持相对次序，
// 跳过条数准确并说明原始数据保留在服务端；被跳过内容不成为房间行，
// 也不导致整份列表加载失败。
// =============================================================================

test('混合列表：对象全部成行且次序不变，跳过 8 条并说明原始数据保留在服务端', { timeout: 60000 }, async (t) => {
  const { page, baseURL, dataDir, fileContent } = await setupPage(t, MIXED_RECORDS);
  await waitForRowCount(page, EXPECTED_MIXED_ROWS.length);

  const list = await readListArea(page);

  // 所有房间对象照常展示，相对次序与返回数组中对象的次序一致；
  // 五子棋/飞行棋中文名、0 显示“不限时”、waiting 显示“未开始”都保留。
  assertMixedRows(list.rows);

  // 跳过警告准确：8 条非对象记录（null、字符串、数字、布尔、空数组、
  // 装着房间对象的数组、空字符串、数字 0），并说明原始数据仍在服务端。
  assert.equal(list.noticeCount, 1, '应只有一条跳过警告');
  assert.equal(list.noticeText, skipNoticeText(MIXED_SKIPPED));

  // 跳过警告位于表格之前；不出现空列表提示或加载失败提示。
  assert.deepEqual(
    list.childKinds,
    ['p.skip-notice', 'table'],
    '列表区域应先显示跳过警告，再显示房间表格',
  );
  assert.equal(list.emptyText, null, '有房间可显示时不应出现空列表提示');
  assert.equal(list.errorText, null, '一条非对象记录不应导致整份列表加载失败');
  assert.ok(!list.text.includes(LIST_ERROR_TEXT));

  // 被跳过的内容不成为房间行：嵌套数组里的房间不被展开，文本记录不上屏。
  assert.ok(!list.text.includes('nested-room'), '数组内的房间对象不应被展开成房间行');
  assert.ok(!list.text.includes('不应展开'));
  assert.ok(!list.text.includes('纯文本记录'), '字符串记录不应显示为房间行');

  // 查看之后，接口原始记录与本地保存内容保持原有数量、次序和附带字段。
  await assertMixedServerIntact(baseURL, dataDir, fileContent);
});

// =============================================================================
// 返回数组非空但所有元素都被跳过：说明没有可展示的房间与全部跳过数量，
// 不出现房间表格，也不显示“还没有房间记录”。
// =============================================================================

test('全部跳过：说明没有可展示的房间与跳过数量，不出现表格或空列表提示', { timeout: 60000 }, async (t) => {
  const records = [REC_NULL, REC_STRING, REC_ZERO, REC_FALSE, REC_EMPTY_ARRAY, REC_NESTED_ROOM];
  const { page, baseURL, dataDir, fileContent } = await setupPage(t, records);
  await waitForSkipNotice(page);

  const list = await readListArea(page);
  assert.equal(list.noticeCount, 1);
  assert.equal(list.noticeText, ALL_SKIPPED_TEXT(records.length));
  assert.equal(list.rows.length, 0, '全部被跳过时不应出现任何房间行');
  assert.ok(!list.childKinds.includes('table'), '全部被跳过时不应出现房间表格');
  assert.equal(list.emptyText, null, '非空数组全部被跳过时不应显示“还没有房间记录”');
  assert.ok(!list.text.includes(EMPTY_TIP));
  assert.equal(list.errorText, null, '记录被跳过不等于列表加载失败');

  // 查看之后服务端与本地文件保持原样。
  const rooms = await readServerRooms(baseURL);
  assert.deepEqual(rooms, records.map((r) => JSON.parse(r)));
  assert.equal(await readFile(path.join(dataDir, 'rooms.json'), 'utf8'), fileContent);
});

// =============================================================================
// 真正的空数组：显示空列表提示，没有跳过警告，也没有表格。
// =============================================================================

test('空数组：显示“还没有房间记录”，没有跳过警告', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t, []);
  await page.waitForFunction(
    () => document.querySelector('#list-area .empty') !== null,
    { timeout: 10000 },
  );

  const list = await readListArea(page);
  assert.equal(list.emptyText, EMPTY_TIP, '空数组应显示空列表提示');
  assert.equal(list.noticeCount, 0, '空数组没有任何被跳过的记录，不应出现跳过警告');
  assert.equal(list.rows.length, 0);
  assert.equal(list.errorText, null);

  const rooms = await readServerRooms(baseURL);
  assert.deepEqual(rooms, [], '空数组应保持为空');
});

// =============================================================================
// 在混合数据之上创建公开房间：既有创建行为不变，新房间追加在原有对象之后，
// 被跳过的非对象记录原样保留在服务端与本地文件中。
// =============================================================================

test('混合数据上创建公开房间：成功追加新行，跳过记录与新房间都完整保存', { timeout: 60000 }, async (t) => {
  const { page, baseURL, dataDir } = await setupPage(t, MIXED_RECORDS);
  await waitForRowCount(page, EXPECTED_MIXED_ROWS.length);
  const initialList = await readListArea(page);
  assertMixedRows(initialList.rows);

  // 按既有行为填写并提交创建表单（五子棋固定 2 人，0 表示不限时）。
  await page.type('#name', '混合数据新房');
  await page.select('#game', 'gomoku');
  await page.waitForFunction(
    () => !document.getElementById('capacity').disabled &&
      document.getElementById('capacity').value === '2',
    { timeout: 5000 },
  );
  await page.type('#turnSeconds', '0');
  const createdPromise = new Promise((resolve, reject) => {
    page.on('response', (resp) => {
      if (resp.request().method() === 'POST' && resp.url().endsWith('/api/rooms')) {
        resp.json().then(resolve, reject);
      }
    });
  });
  await page.click('#submit');
  const created = await createdPromise;

  // 创建成功提示与编号保留既有行为。
  await page.waitForFunction(
    () => document.getElementById('form-msg').classList.contains('ok'),
    { timeout: 10000 },
  );
  const msg = await page.evaluate(() => document.getElementById('form-msg').textContent);
  assert.equal(msg, '房间已创建，编号：' + created.id);

  // 列表刷新后：原有 4 行内容与次序不变，新房间追加在最后；
  // 跳过警告仍准确反映 8 条非对象记录。
  await waitForRowCount(page, EXPECTED_MIXED_ROWS.length + 1);
  const list = await readListArea(page);
  assertMixedRows(list.rows.slice(0, EXPECTED_MIXED_ROWS.length));
  const added = list.rows[list.rows.length - 1];
  assert.deepEqual(added.cells.slice(0, 6), [
    created.id, '混合数据新房', '五子棋', '2 人', '不限时', '未开始',
  ]);
  assert.equal(added.badge, '未开始');
  assert.equal(added.timeTitle, created.createdAt);
  assert.equal(list.noticeText, skipNoticeText(MIXED_SKIPPED), '创建后跳过警告仍应准确');

  // 服务端记录：原有 12 条（含全部非对象记录）原样保留，新房间追加在末尾。
  const rooms = await readServerRooms(baseURL);
  assert.equal(rooms.length, MIXED_RECORDS.length + 1);
  assert.deepEqual(
    rooms.slice(0, MIXED_RECORDS.length),
    MIXED_RECORDS.map((r) => JSON.parse(r)),
    '创建后原有记录（含被跳过的非对象记录）应保持数量、次序与附带字段',
  );
  assert.equal(rooms[rooms.length - 1].id, created.id);
  assert.equal(rooms[rooms.length - 1].turnSeconds, 0);

  // 本地文件同样保留全部原始记录与新房间（创建会重写文件，按内容比对）。
  const onDisk = JSON.parse(await readFile(path.join(dataDir, 'rooms.json'), 'utf8'));
  assert.deepEqual(onDisk, rooms, '本地保存内容应与接口返回一致');
});
