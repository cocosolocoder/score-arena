// 首页“房间列表按名称关键词筛选”的界面回归测试。
//
// 与其他浏览器回归文件的分工：
//   - ui.test.mjs：创建成功/被拒、成功后列表竞态刷新、名称整理与长度边界；
//   - ui-mixed-records.test.mjs：混合记录与异常字段的列表展示；
//   - ui-list-read-error.test.mjs：列表正文不可用时的加载失败提示；
//   - 本文件只盯住“按名称关键词筛选”：输入关键词立即只显示名称包含该关键词
//     的房间，清空恢复当前已加载的全部房间，筛选不触碰接口数据、服务端保存
//     与创建表单。
//
// 保护的已有行为（本文件不修改任何产品代码，只补回归保障）：
//   - 筛选只对当前已加载的列表重新渲染，不重新请求接口、不提交创建请求，
//     不改变名称、规则、人数或时间的填写，也不修改服务端保存的任何房间；
//   - 关键词沿用房间名称的首尾空白整理规则（内部空格保留，整理后为空等同
//     未筛选），只对接口返回的名称字符串做连续文字匹配，区分英文大小写；
//     中文、表情、尖括号与类似字符实体的文字按原样匹配，编号、规则等其他
//     列不参与；同名房间分别保留，命中行按接口中的相对次序展示；
//   - 名称缺失、为 null 或不是字符串的记录不参与非空关键词的匹配，清空
//     关键词后仍按原有方式展示，不被删除或补写名称；
//   - 有房间对象但没有名称命中时显示“没有符合名称关键词的房间”；真正的
//     空列表仍显示空列表提示，全部记录都无法展示时仍保留全部跳过说明；
//     跳过提示按本次完整返回内容统计，被关键词隐藏的房间不计为异常记录；
//   - 保留关键词创建房间时成功提示与真实编号照常，列表刷新完成时继续按
//     当前（最新）关键词筛选，新房间只有名称命中才出现，表单复位不清空
//     关键词；列表加载失败时修改或清空关键词不改变失败提示。
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

// 名称各异的正常房间，覆盖：内部空格、表情、尖括号与实体样式文字、
// 英文大小写、完全同名（alpha 与 delta 同名不同房）。
const R_ALPHA =
  '{"id":"f-alpha","name":"周末 五子棋 友谊赛","game":"gomoku","capacity":2,' +
  '"turnSeconds":0,"status":"waiting","visibility":"public","createdAt":"2026-04-01T08:00:00Z"}';
const R_BETA =
  '{"id":"f-beta","name":"深夜飞行棋🎲","game":"ludo","capacity":4,"turnSeconds":60,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-04-02T09:00:00Z"}';
const R_GAMMA =
  '{"id":"f-gamma","name":"五子棋<b>加粗</b>&lt;实体&gt;","game":"gomoku","capacity":2,' +
  '"turnSeconds":10,"status":"waiting","visibility":"public","createdAt":"2026-04-03T10:00:00Z"}';
const R_DELTA =
  '{"id":"f-delta","name":"周末 五子棋 友谊赛","game":"ludo","capacity":3,"turnSeconds":30,' +
  '"status":"playing","visibility":"public","createdAt":"2026-04-04T11:00:00Z"}';
// 名称为 null、缺失、非字符串（对象）的历史记录：不参与非空关键词匹配，
// 但清空关键词后仍按原有方式展示，不被删除或补写名称。
const R_EPSILON =
  '{"id":"f-epsilon","name":null,"game":"gomoku","capacity":2,"turnSeconds":0,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-04-05T12:00:00Z"}';
const R_ZETA =
  '{"id":"f-zeta","game":"ludo","capacity":2,"turnSeconds":20,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-04-06T13:00:00Z"}';
const R_ETA =
  '{"id":"f-eta","name":{"toString":"伪名称"},"game":"gomoku","capacity":2,' +
  '"turnSeconds":0,"status":"waiting","visibility":"public","createdAt":"2026-04-07T14:00:00Z"}';
const R_THETA =
  '{"id":"f-theta","name":"ABC 房间","game":"ludo","capacity":2,"turnSeconds":600,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-04-08T15:00:00Z"}';

// 全量种子：8 个房间对象与 3 条非对象记录（null、含“五子棋”的字符串、0）
// 交错排列。字符串记录里的“五子棋”绝不参与名称匹配。
const FULL_RECORDS = [
  R_ALPHA,
  'null',
  R_BETA,
  '"五子棋字符串"',
  R_GAMMA,
  R_DELTA,
  R_EPSILON,
  '0',
  R_ZETA,
  R_ETA,
  R_THETA,
];
const FULL_ROOM_COUNT = 8;
const FULL_SKIPPED = 3;
const SKIP_NOTICE =
  '有 ' + FULL_SKIPPED + ' 条房间记录无法作为房间显示，已跳过；' +
  '原始数据仍保留在服务端，未被删除或改写。';

const EMPTY_TEXT = '还没有房间记录。';
const NO_MATCH_TEXT = '没有符合名称关键词的房间。';
const LIST_ERROR_TEXT = '房间列表加载失败，请稍后刷新重试。已有数据不会因此丢失。';
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
// 供“筛选不改写文件”的逐字节比对使用。
async function seedRecords(dataDir, records) {
  const content = '[\n' + records.join(',\n') + '\n]\n';
  await writeFile(path.join(dataDir, 'rooms.json'), content);
  return content;
}

async function setupPage(t, records) {
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

function readRows(page) {
  return page.$$eval('#list-area table tbody tr', (trs) =>
    trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent)),
  );
}

function readRowIds(page) {
  return page.$$eval('#list-area table tbody tr', (trs) =>
    trs.map((tr) => tr.querySelector('td').textContent),
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
    errorText: document.querySelector('#list-area .list-error')
      ? document.querySelector('#list-area .list-error').textContent
      : null,
    emptyTexts: [...document.querySelectorAll('#list-area .empty')].map((el) => el.textContent),
  }));
}

function readFilterValue(page) {
  return page.evaluate(() => document.getElementById('name-filter').value);
}

// 以实际输入事件设置关键词（页面监听 input 事件立即重展）。
async function setFilter(page, keyword) {
  await page.evaluate((value) => {
    const el = document.getElementById('name-filter');
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, keyword);
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

// 统计页面发出的列表查询与创建请求次数，用于证明筛选不重新请求接口、
// 也不提交创建请求。
function watchApiRequests(page) {
  const counts = { get: 0, post: 0 };
  page.on('request', (req) => {
    if (!req.url().endsWith('/api/rooms')) return;
    if (req.method() === 'GET') counts.get++;
    if (req.method() === 'POST') counts.post++;
  });
  return counts;
}

// 输入关键词立即只显示名称命中行（同名房间分别保留、按接口相对次序），
// 清空恢复当前已加载的全部房间；全程不重新请求接口、不发创建请求，
// 跳过提示仍按完整返回统计。
test('输入关键词立即筛选、清空恢复全部，不重新请求接口，跳过提示按完整返回统计', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t, FULL_RECORDS);
  // 监听器在首次加载后挂上：之后筛选不应再产生任何接口请求。
  const api = watchApiRequests(page);

  await waitForRowCount(page, FULL_ROOM_COUNT);

  // 输入“五子棋”：alpha、gamma、delta 三个名称命中，同名房间分别保留，
  // 按接口中的相对次序排列；其余房间（含 null/缺失/对象名称）不显示。
  await setFilter(page, '五子棋');
  await waitForRowCount(page, 3);
  assert.deepEqual(await readRowIds(page), ['f-alpha', 'f-gamma', 'f-delta']);

  let list = await readListArea(page);
  assert.equal(list.skipText, SKIP_NOTICE, '跳过提示仍按本次完整返回内容统计');
  assert.equal(list.errorText, null);
  assert.deepEqual(list.emptyTexts, [], '有命中时不显示任何空提示');

  // 命中行的各列显示方式不变（以 alpha 行为例）。
  const rows = await readRows(page);
  assert.deepEqual(rows[0].slice(0, 6), [
    'f-alpha', '周末 五子棋 友谊赛', '五子棋', '2 人', '不限时', '未开始',
  ]);

  // 筛选只是重新渲染已加载数据：不再查询列表，也绝不发出创建请求。
  assert.equal(api.get, 0, '筛选不能重新请求房间列表接口');
  assert.equal(api.post, 0, '筛选不能提交创建请求');

  // 清空关键词：当前已加载的全部房间恢复，相对次序不变，不需要重新打开页面。
  await setFilter(page, '');
  await waitForRowCount(page, FULL_ROOM_COUNT);
  assert.deepEqual(
    await readRowIds(page),
    ['f-alpha', 'f-beta', 'f-gamma', 'f-delta', 'f-epsilon', 'f-zeta', 'f-eta', 'f-theta'],
    '清空关键词后应恢复当前已加载的全部房间且相对次序不变',
  );
  list = await readListArea(page);
  assert.equal(list.skipText, SKIP_NOTICE);
  assert.equal(api.get, 0, '清空关键词同样不重新请求接口');
  assert.equal(api.post, 0);
});

// 匹配规则：连续文字、区分英文大小写、只匹配名称列；首尾空白按房间名称
// 的整理规则去掉（含 U+00A0），内部空格保留，整理后为空等同未筛选。
test('匹配规则：连续文字、区分大小写、只匹配名称，首尾空白整理、内部空格保留', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t, FULL_RECORDS);
  await waitForRowCount(page, FULL_ROOM_COUNT);

  // 内部空格保留：“棋 友”只命中名称内部带空格的 alpha 与 delta，
  // 不命中名称中“五子棋”后紧跟“<b>”的 gamma。
  await setFilter(page, '棋 友');
  await waitForRowCount(page, 2);
  assert.deepEqual(await readRowIds(page), ['f-alpha', 'f-delta']);

  // 首尾空白（含 U+00A0、U+3000）按名称整理规则去掉后再匹配。
  await setFilter(page, ' 周末 ');
  await waitForRowCount(page, 2);
  assert.deepEqual(await readRowIds(page), ['f-alpha', 'f-delta']);

  // 整理后为空等同未筛选：全部房间恢复。
  await setFilter(page, '    ');
  await waitForRowCount(page, FULL_ROOM_COUNT);

  // 区分英文大小写：小写 abc 不命中“ABC 房间”。
  await setFilter(page, 'abc');
  await page.waitForFunction(
    (text) => document.getElementById('list-area').textContent.includes(text),
    { timeout: 5000 },
    NO_MATCH_TEXT,
  );
  let list = await readListArea(page);
  assert.deepEqual(list.emptyTexts, [NO_MATCH_TEXT]);
  assert.equal(list.hasTable, false);

  await setFilter(page, 'ABC');
  await waitForRowCount(page, 1);
  assert.deepEqual(await readRowIds(page), ['f-theta']);

  // 编号列不参与匹配：关键词是某房间的完整编号也无命中。
  await setFilter(page, 'f-alpha');
  await page.waitForFunction(
    (text) => document.getElementById('list-area').textContent.includes(text),
    { timeout: 5000 },
    NO_MATCH_TEXT,
  );
  list = await readListArea(page);
  assert.deepEqual(list.emptyTexts, [NO_MATCH_TEXT]);

  // 规则列的原始值不参与匹配：没有名称含 “ludo”。
  await setFilter(page, 'ludo');
  await page.waitForFunction(
    (text) => document.getElementById('list-area').textContent.includes(text),
    { timeout: 5000 },
    NO_MATCH_TEXT,
  );
  list = await readListArea(page);
  assert.deepEqual(list.emptyTexts, [NO_MATCH_TEXT]);

  // 规则列的中文映射不参与匹配：只有名称里真有“飞行棋”的 beta 命中。
  await setFilter(page, '飞行棋');
  await waitForRowCount(page, 1);
  assert.deepEqual(await readRowIds(page), ['f-beta']);

  // 被跳过字符串记录里的文字不参与匹配：没有名称含“五子棋字符串”。
  await setFilter(page, '五子棋字符串');
  await page.waitForFunction(
    (text) => document.getElementById('list-area').textContent.includes(text),
    { timeout: 5000 },
    NO_MATCH_TEXT,
  );
  list = await readListArea(page);
  assert.deepEqual(list.emptyTexts, [NO_MATCH_TEXT]);
  assert.equal(list.skipText, SKIP_NOTICE, '无命中时跳过提示仍按完整返回统计');
});

// 中文、表情、尖括号与类似字符实体的文字都按原样匹配：命中后名称逐字
// 显示为纯文本，不被解释成网页内容或特殊表达式。
test('尖括号、实体样式文字与表情按原样匹配，命中内容仍为纯文本展示', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t, FULL_RECORDS);
  await waitForRowCount(page, FULL_ROOM_COUNT);

  // 尖括号按普通文字匹配，不被当成标签。
  await setFilter(page, '<b>');
  await waitForRowCount(page, 1);
  assert.deepEqual(await readRowIds(page), ['f-gamma']);
  let rows = await readRows(page);
  assert.equal(rows[0][1], '五子棋<b>加粗</b>&lt;实体&gt;', '名称应逐字显示');
  const boldCount = await page.evaluate(
    () => document.querySelectorAll('#list-area b').length,
  );
  assert.equal(boldCount, 0, '名称中的尖括号文字不能变成网页元素');

  // 类似字符实体的文字按原有写法匹配，不解释成另一种字符。
  await setFilter(page, '&lt;');
  await waitForRowCount(page, 1);
  assert.deepEqual(await readRowIds(page), ['f-gamma']);

  // “<”被当作普通字符，不是表达式或通配符。
  await setFilter(page, '<');
  await waitForRowCount(page, 1);
  assert.deepEqual(await readRowIds(page), ['f-gamma']);

  // 表情按原样匹配。
  await setFilter(page, '🎲');
  await waitForRowCount(page, 1);
  assert.deepEqual(await readRowIds(page), ['f-beta']);
  rows = await readRows(page);
  assert.equal(rows[0][1], '深夜飞行棋🎲');
});

// 名称缺失、为 null 或不是字符串的记录不参与非空关键词的匹配；清空关键词
// 后这些房间仍按原有方式展示，不能因筛选被删除或补写名称；筛选全程不改
// 服务端保存的任何房间。
test('名称缺失/null/非字符串的记录不参与匹配，清空后原样展示，服务端记录不变', { timeout: 60000 }, async (t) => {
  const { page, baseURL, dataDir, seedText } = await setupPage(t, FULL_RECORDS);
  await waitForRowCount(page, FULL_ROOM_COUNT);

  // “伪名称”只存在于 eta 的对象名称内部：对象名称不是字符串，不参与匹配。
  await setFilter(page, '伪名称');
  await page.waitForFunction(
    (text) => document.getElementById('list-area').textContent.includes(text),
    { timeout: 5000 },
    NO_MATCH_TEXT,
  );
  let list = await readListArea(page);
  assert.deepEqual(list.emptyTexts, [NO_MATCH_TEXT]);
  assert.ok(!list.text.includes('f-eta'), '对象名称的房间不应因内部文字命中');

  // 非空关键词下，null/缺失/对象名称的房间不显示。
  await setFilter(page, '五子棋');
  await waitForRowCount(page, 3);
  assert.deepEqual(await readRowIds(page), ['f-alpha', 'f-gamma', 'f-delta']);

  // 清空后这些房间回到原位置：名称单元格保持原有兜底（留空/异常文案），
  // 不被删除，也不被补写名称。
  await setFilter(page, '');
  await waitForRowCount(page, FULL_ROOM_COUNT);
  const rows = await readRows(page);
  assert.equal(rows[4][0], 'f-epsilon');
  assert.equal(rows[4][1], '', 'null 名称清空关键词后仍留空，不补写名称');
  assert.equal(rows[5][0], 'f-zeta');
  assert.equal(rows[5][1], '', '缺失名称清空关键词后仍留空，不补写名称');
  assert.equal(rows[6][0], 'f-eta');
  assert.equal(rows[6][1], '字段格式异常', '对象名称清空关键词后仍按原有异常展示');

  // 筛选是只读操作：接口原始记录与本地文件逐字节不变。
  const expected = FULL_RECORDS.map((rec) => JSON.parse(rec));
  assert.deepEqual(await readServerRooms(baseURL), expected, '筛选不能改动接口返回的原始记录');
  const onDisk = await readFile(path.join(dataDir, 'rooms.json'), 'utf8');
  assert.equal(onDisk, seedText, '筛选不能改写本地保存的房间记录');
});

// 有房间对象但没有名称命中时显示固定的无匹配提示，关键词可直接修改或
// 清空；真正的空列表仍显示空列表提示，全部记录都无法展示时仍保留全部
// 跳过说明，都不能说成“没有符合名称关键词的房间”或“还没有房间记录”。
test('无命中显示无匹配提示；真正空列表与全部跳过保持原有提示', { timeout: 60000 }, async (t) => {
  // 有房间对象但无命中：显示无匹配提示，不出表格，不显示空列表提示；
  // 关键词输入框保留当前输入，可直接修改或清空。
  const { page } = await setupPage(t, FULL_RECORDS);
  await waitForRowCount(page, FULL_ROOM_COUNT);

  await setFilter(page, '不存在的关键词');
  await page.waitForFunction(
    (text) => document.getElementById('list-area').textContent.includes(text),
    { timeout: 5000 },
    NO_MATCH_TEXT,
  );
  let list = await readListArea(page);
  assert.deepEqual(list.emptyTexts, [NO_MATCH_TEXT]);
  assert.equal(list.hasTable, false, '无命中时不显示表格');
  assert.ok(!list.text.includes(EMPTY_TEXT), '无命中不能把已有房间说成尚未创建');
  assert.equal(list.skipText, SKIP_NOTICE, '被关键词隐藏的房间不计为异常记录');
  assert.equal(await readFilterValue(page), '不存在的关键词', '无命中时关键词保留可继续编辑');

  // 直接修改关键词即可看到命中行，无需重新打开页面。
  await setFilter(page, '五子棋');
  await waitForRowCount(page, 3);
  assert.deepEqual(await readRowIds(page), ['f-alpha', 'f-gamma', 'f-delta']);

  // 真正的空列表：输入任何关键词都仍显示原有空列表提示，不出现无匹配提示。
  const empty = await setupPage(t, []);
  await empty.page.waitForFunction(
    (text) => document.getElementById('list-area').textContent.includes(text),
    { timeout: 10000 },
    EMPTY_TEXT,
  );
  await setFilter(empty.page, '五子棋');
  await new Promise((resolve) => setTimeout(resolve, 300));
  list = await readListArea(empty.page);
  assert.deepEqual(list.emptyTexts, [EMPTY_TEXT], '真正的空列表仍显示空列表提示');
  assert.ok(!list.text.includes(NO_MATCH_TEXT), '空列表不显示无匹配提示');

  // 全部记录都无法作为房间展示：保留原有全部跳过说明，关键词不改变它。
  const allSkipped = await setupPage(t, ['null', '"字符串"', '0']);
  await allSkipped.page.waitForFunction(
    () => !!document.querySelector('#list-area .skip-notice'),
    { timeout: 10000 },
  );
  await setFilter(allSkipped.page, '五子棋');
  await new Promise((resolve) => setTimeout(resolve, 300));
  list = await readListArea(allSkipped.page);
  assert.equal(
    list.skipText,
    '没有可展示的房间。本次返回的房间记录中有 3 条无法作为房间显示，已全部跳过；' +
      '原始数据仍保留在服务端，未被删除或改写。',
    '全部跳过时保留原有说明',
  );
  assert.deepEqual(list.emptyTexts, [], '全部跳过时不显示空列表或有无匹配提示');
});

// 保留关键词创建房间：成功提示与真实编号照常显示，列表刷新完成时继续按
// 当前关键词筛选，新房间只有名称命中才出现；创建表单复位不能清空关键词。
test('保留关键词创建房间：成功提示照常，列表继续按关键词筛选，表单复位不清空关键词', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t, [R_ALPHA, R_DELTA]);
  await waitForRowCount(page, 2);

  await setFilter(page, '友谊赛');
  await waitForRowCount(page, 2);

  // 名称命中关键词的新房间：创建成功后出现在筛选结果中。
  const createdPromise = nextCreated(page);
  await fillGomokuForm(page, '新的友谊赛🏆房间', 0);
  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;
  assert.ok(created.id, '创建结果应包含真实编号');

  const okText = await page.evaluate(
    () => document.getElementById('form-msg').textContent,
  );
  assert.ok(
    okText.includes(SUCCESS_PREFIX + created.id),
    '成功提示与真实编号照常显示',
  );

  await waitForRowCount(page, 3);
  assert.deepEqual(await readRowIds(page), ['f-alpha', 'f-delta', created.id]);
  const rows = await readRows(page);
  assert.equal(rows[2][1], '新的友谊赛🏆房间');

  // 表单按现有行为复位，但关键词保持原样，列表继续按关键词筛选。
  assert.equal(await readFilterValue(page), '友谊赛', '创建表单复位不能清空关键词');
  const formValues = await page.evaluate(() => ({
    name: document.getElementById('name').value,
    game: document.getElementById('game').value,
    turnSeconds: document.getElementById('turnSeconds').value,
  }));
  assert.deepEqual(formValues, { name: '', game: '', turnSeconds: '' }, '表单仍按成功行为复位');

  // 名称不命中当前关键词的新房间：成功提示与编号照常，但新房间不出现在
  // 筛选后的列表中；清空关键词后它按接口次序出现在最后。
  await setFilter(page, '不存在');
  await page.waitForFunction(
    (text) => document.getElementById('list-area').textContent.includes(text),
    { timeout: 5000 },
    NO_MATCH_TEXT,
  );

  const created2Promise = nextCreated(page);
  await fillGomokuForm(page, '普通新房', 30);
  await waitForMessageKind(page, 'ok');
  const created2 = await created2Promise;
  const okText2 = await page.evaluate(
    () => document.getElementById('form-msg').textContent,
  );
  assert.ok(okText2.includes(SUCCESS_PREFIX + created2.id), '无命中时成功提示与编号仍照常');

  // 列表刷新完成后仍按当前关键词筛选：新房间未命中，不出现在列表中，
  // 也不能因此把已有房间说成尚未创建。
  await new Promise((resolve) => setTimeout(resolve, 300));
  let list = await readListArea(page);
  assert.deepEqual(list.emptyTexts, [NO_MATCH_TEXT]);
  assert.equal(list.hasTable, false);
  assert.ok(!list.text.includes(created2.id), '未命中关键词的新房间不出现在筛选结果中');

  await setFilter(page, '');
  await waitForRowCount(page, 4);
  assert.deepEqual(
    await readRowIds(page),
    ['f-alpha', 'f-delta', created.id, created2.id],
    '清空关键词后全部房间按接口相对次序展示',
  );

  // 服务端记录完整：两间新房间依次追加，旧记录不变。
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, 4);
  assert.deepEqual(serverRooms.slice(0, 2), [JSON.parse(R_ALPHA), JSON.parse(R_DELTA)]);
  assert.equal(serverRooms[2].id, created.id);
  assert.equal(serverRooms[3].id, created2.id);
});

// 创建成功后等待列表回应期间改过关键词：列表以最新输入为准渲染。
test('等待列表回应期间改过关键词，列表刷新以最新输入为准', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t, [R_ALPHA]);
  await waitForRowCount(page, 1);

  // 拦下创建成功后的那一次列表查询，等关键词改完再放行。
  await page.setRequestInterception(true);
  let holdList = false;
  let held = null;
  page.on('request', (req) => {
    if (holdList && req.method() === 'GET' && req.url().endsWith('/api/rooms')) {
      held = req;
      return;
    }
    req.continue();
  });

  await setFilter(page, '友谊赛');
  await waitForRowCount(page, 1);

  holdList = true;
  const createdPromise = nextCreated(page);
  await fillGomokuForm(page, '飞行棋新房', 0);
  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  // 列表查询已发出但被扣住：此时把关键词改成“飞行棋”。
  while (!held) await new Promise((resolve) => setTimeout(resolve, 20));
  await setFilter(page, '飞行棋');
  held.continue();

  // 最新关键词“飞行棋”：只有新房间命中，旧房间“周末 五子棋 友谊赛”不显示。
  // （若按提交时的旧关键词“友谊赛”渲染，结果会恰好相反。）
  await waitForRowCount(page, 1);
  assert.deepEqual(await readRowIds(page), [created.id]);
  const rows = await readRows(page);
  assert.equal(rows[0][1], '飞行棋新房');
});

// 列表加载失败时，修改或清空关键词不能把失败改成空列表、无匹配结果或
// 恢复旧表格；既有失败提示保持原样。
test('列表加载失败时修改或清空关键词不改变失败提示', { timeout: 60000 }, async (t) => {
  // 情形一：首次打开即失败（数据文件内容损坏）。
  const brokenDir = await mkdtemp(path.join(tmpdir(), 'score-arena-uidata-'));
  t.after(() => rm(brokenDir, { recursive: true, force: true }));
  await writeFile(path.join(brokenDir, 'rooms.json'), '[{"id":"x"');
  const brokenURL = await startServer(t, brokenDir);
  const brokenPage = await browser.newPage();
  t.after(() => brokenPage.close());
  await brokenPage.goto(brokenURL, { waitUntil: 'load' });
  await brokenPage.waitForFunction(
    (text) => document.getElementById('list-area').textContent.includes(text),
    { timeout: 10000 },
    '房间列表加载失败',
  );

  await setFilter(brokenPage, '五子棋');
  await new Promise((resolve) => setTimeout(resolve, 300));
  let list = await readListArea(brokenPage);
  assert.equal(list.errorText, LIST_ERROR_TEXT, '输入关键词不能把加载失败改成别的提示');
  assert.equal(list.hasTable, false);
  assert.deepEqual(list.emptyTexts, [], '失败时不能显示空列表或有无匹配提示');

  await setFilter(brokenPage, '');
  await new Promise((resolve) => setTimeout(resolve, 300));
  list = await readListArea(brokenPage);
  assert.equal(list.errorText, LIST_ERROR_TEXT, '清空关键词不能把加载失败改成别的提示');
  assert.deepEqual(list.emptyTexts, []);

  // 情形二：已展示过房间，随后刷新遇到失败——修改关键词不能恢复旧表格。
  const { page, dataDir } = await setupPage(t, [R_ALPHA, R_DELTA]);
  await waitForRowCount(page, 2);
  await writeFile(path.join(dataDir, 'rooms.json'), '[{"id":"x"');
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(
    (text) => document.getElementById('list-area').textContent.includes(text),
    { timeout: 10000 },
    '房间列表加载失败',
  );

  await setFilter(page, '友谊赛');
  await new Promise((resolve) => setTimeout(resolve, 300));
  list = await readListArea(page);
  assert.equal(list.errorText, LIST_ERROR_TEXT);
  assert.equal(list.hasTable, false, '修改关键词不能恢复旧表格');
  assert.deepEqual(list.emptyTexts, []);
});

// 筛选与创建房间的填写互不影响：修改关键词不改变名称、规则、人数或时间
// 的填写，也不会提交创建请求。
test('筛选与创建表单互不影响：修改关键词不改填写、不发创建请求', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t, FULL_RECORDS);
  const api = watchApiRequests(page);
  await waitForRowCount(page, FULL_ROOM_COUNT);

  // 先填好创建表单四项（飞行棋 3 人 45 秒）。
  await page.type('#name', '填写中的飞行棋房间');
  await page.select('#game', 'ludo');
  await page.select('#capacity', '3');
  await page.type('#turnSeconds', '45');

  // 输入并修改关键词：列表正常筛选，表单四项保持原样。
  await setFilter(page, '五子棋');
  await waitForRowCount(page, 3);
  await setFilter(page, '友谊赛');
  await waitForRowCount(page, 2);

  const formValues = await page.evaluate(() => ({
    name: document.getElementById('name').value,
    game: document.getElementById('game').value,
    capacity: document.getElementById('capacity').value,
    turnSeconds: document.getElementById('turnSeconds').value,
  }));
  assert.deepEqual(formValues, {
    name: '填写中的飞行棋房间',
    game: 'ludo',
    capacity: '3',
    turnSeconds: '45',
  }, '修改关键词不能改变名称、规则、人数或时间的填写');

  assert.equal(api.post, 0, '修改关键词不能提交创建请求');
  assert.equal(api.get, 0, '修改关键词不能重新查询列表');

  // 关键词也不被表单提交影响：直接提交创建，关键词保留。
  const createdPromise = nextCreated(page);
  await page.click('#submit');
  await waitForMessageKind(page, 'ok');
  await createdPromise;
  assert.equal(await readFilterValue(page), '友谊赛', '提交创建不能清空或改动关键词');
});
