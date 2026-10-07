// 首页“房间列表按名称关键词筛选”的界面回归测试。
//
// 保护的行为：
//   - 在名称筛选框输入文字后，列表立即（不重新打开页面、不重新请求接口）只
//     显示名称包含该关键词的房间行；清空输入恢复当前已加载的全部房间；
//   - 关键词首尾空白沿用现有房间名称的整理规则，内部空格保留；整理后为空
//     等同未筛选；只对接口返回的名称字符串做连续文字匹配并区分英文大小写，
//     中文、表情、尖括号和类似字符实体的文字都按原样匹配，编号、规则等
//     其他列不参与匹配；同名房间分别保留，命中行按接口相对次序展示；
//   - 历史记录名称缺失、为 null 或不是字符串时不参与非空关键词匹配，清空
//     关键词后仍按原有方式展示，筛选不删除或补写名称；
//   - 读到房间对象但没有名称命中时显示“没有符合名称关键词的房间”，且仍可
//     直接修改或清空关键词；真正的空列表仍显示“还没有房间记录。”；全部
//     记录无法作为房间展示时保留原有全部跳过说明；跳过提示按本次完整返回
//     统计，被关键词隐藏的房间不计异常；
//   - 筛选与创建房间的填写互不影响；保留关键词创建后，成功提示与真实编号
//     照常，列表刷新完成时继续按当前关键词筛选，表单复位不清空关键词；
//     等待列表回应期间改过关键词以最新输入为准；
//   - 列表加载失败时修改或清空关键词不能把失败提示改成空列表、无匹配或
//     旧表格；筛选不修改服务端保存的任何房间（本地 rooms.json 逐字节不变）。
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

function room(id, name, extra = {}) {
  return JSON.stringify({
    id,
    name,
    game: 'gomoku',
    capacity: 2,
    turnSeconds: 0,
    status: 'waiting',
    visibility: 'public',
    createdAt: '2026-04-01T08:00:00Z',
    ...extra,
  });
}

// 各类“名称不是可用字符串”的历史房间对象：非空关键词下都不参与匹配，
// 清空关键词后仍按现有兜底方式成行。
const ROOM_NULL_NAME = '{"id":"null-name","name":null,"game":"gomoku","capacity":2,' +
  '"turnSeconds":0,"status":"waiting","createdAt":"2026-04-02T08:00:00Z"}';
const ROOM_MISSING_NAME = '{"id":"missing-name","game":"ludo","capacity":3,' +
  '"turnSeconds":30,"status":"waiting","createdAt":"2026-04-03T08:00:00Z"}';
const ROOM_NUMBER_NAME = '{"id":"number-name","name":12345,"game":"gomoku",' +
  '"capacity":2,"turnSeconds":0,"status":"waiting","createdAt":"2026-04-04T08:00:00Z"}';
const ROOM_OBJECT_NAME = '{"id":"object-name","name":{"toString":"晚间五子棋"},' +
  '"game":"gomoku","capacity":2,"turnSeconds":0,"status":"waiting",' +
  '"createdAt":"2026-04-05T08:00:00Z"}';

const BASE_RECORDS = [
  room('r-alpha-up', 'Alpha Room'),
  room('r-alpha-low', 'alpha room'),
  room('r-evening-1', '晚间五子棋', { game: 'gomoku' }),
  room('r-spaces', 'a b  c'),
  room('r-special', '<tag> &lt; 名称😀'),
  // 与 r-evening-1 同名但编号不同：同名房间分别保留。
  room('r-evening-2', '晚间五子棋', { game: 'ludo', capacity: 3, turnSeconds: 30 }),
  // 编号里带关键词字样，但只有名称列参与匹配。
  room('evening-in-id', '白日场', { game: 'ludo', capacity: 4, turnSeconds: 60 }),
  ROOM_NULL_NAME,
  ROOM_MISSING_NAME,
  ROOM_NUMBER_NAME,
  ROOM_OBJECT_NAME,
  // 两条非对象记录：始终计入跳过，被关键词隐藏的房间绝不能混进这个数字。
  'null',
  '"误入的字符串"',
];
const BASE_ROW_COUNT = 11;
const BASE_SKIPPED = 2;

const NO_MATCH_TEXT = '没有符合名称关键词的房间。';
const EMPTY_TEXT = '还没有房间记录。';

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

// 通过与页面相同的 input 事件设置关键词（赋值不会触发监听）。
async function setFilter(page, value) {
  await page.$eval('#room-filter', (el, v) => {
    el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

function waitForRowCount(page, n) {
  return page.waitForFunction(
    (want) => document.querySelectorAll('#list-area table tbody tr').length === want,
    { timeout: 10000 },
    n,
  );
}

function readRowIds(page) {
  return page.$$eval('#list-area table tbody tr',
    (trs) => trs.map((tr) => tr.querySelector('td').textContent));
}
function readRowCount(page) {
  return page.$$eval('#list-area table tbody tr', (trs) => trs.length);
}

function readListArea(page) {
  return page.evaluate(() => ({
    rowCount: document.querySelectorAll('#list-area table tbody tr').length,
    hasTable: !!document.querySelector('#list-area table'),
    emptyTexts: [...document.querySelectorAll('#list-area .empty')].map((el) => el.textContent),
    noMatchText: document.querySelector('#list-area .no-match')
      ? document.querySelector('#list-area .no-match').textContent
      : null,
    skipText: document.querySelector('#list-area .skip-notice')
      ? document.querySelector('#list-area .skip-notice').textContent
      : null,
    errorText: document.querySelector('#list-area .list-error')
      ? document.querySelector('#list-area .list-error').textContent
      : null,
    filterValue: document.getElementById('room-filter').value,
    filterDisabled: document.getElementById('room-filter').disabled,
  }));
}

async function fillGomoku(page, name, turnSeconds) {
  await page.$eval('#name', (el) => { el.value = ''; });
  await page.type('#name', name);
  await page.select('#game', 'gomoku');
  await page.waitForFunction(
    () => !document.getElementById('capacity').disabled &&
      document.getElementById('capacity').value === '2',
    { timeout: 5000 },
  );
  await page.$eval('#turnSeconds', (el) => { el.value = ''; });
  await page.type('#turnSeconds', String(turnSeconds));
}

test('输入关键词立即只显示名称命中的房间，清空后恢复，且不重新请求接口', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t, BASE_RECORDS);
  await waitForRowCount(page, BASE_ROW_COUNT);

  let listGets = 0;
  page.on('request', (req) => {
    if (req.method() === 'GET' && req.url().includes('/api/rooms')) listGets++;
  });

  // 区分英文大小写：alpha 只命中小写那一条，Alpha 只命中大写那一条。
  await setFilter(page, 'alpha');
  assert.deepEqual(await readRowIds(page), ['r-alpha-low']);
  await setFilter(page, 'Alpha');
  assert.deepEqual(await readRowIds(page), ['r-alpha-up']);
  await setFilter(page, 'ALPHA');
  assert.equal(await readRowCount(page), 0);

  // 连续文字匹配：子串即可命中。
  await setFilter(page, 'oom');
  assert.deepEqual(await readRowIds(page), ['r-alpha-up', 'r-alpha-low']);

  // 中文关键词命中同名的两条房间，按接口相对次序分别保留。
  await setFilter(page, '晚间');
  assert.deepEqual(await readRowIds(page), ['r-evening-1', 'r-evening-2']);

  // 编号、规则等其他列不参与匹配：编号含 evening 不命中；没有任何房间名称
  // 含“飞行棋”三字（只有规则列会映射出这三个字），故结果应为空。
  await setFilter(page, 'evening-in-id');
  assert.equal(await readRowCount(page), 0, '编号列文字不参与匹配');
  await setFilter(page, '飞行棋');
  assert.equal(await readRowCount(page), 0, '规则列映射文字不参与匹配');

  // 首尾空白按名称整理规则去掉；整理后为空等同未筛选；内部空格保留。
  await setFilter(page, '  晚间  ');
  assert.deepEqual(await readRowIds(page), ['r-evening-1', 'r-evening-2']);
  await setFilter(page, 'a b  c');
  assert.deepEqual(await readRowIds(page), ['r-spaces']);
  await setFilter(page, 'a b c');
  assert.equal(await readRowCount(page), 0, '内部空格必须原样保留，不能折叠');
  await setFilter(page, '   ');
  assert.equal(await readRowCount(page), BASE_ROW_COUNT, '整理后为空等同未筛选');

  // 清空后恢复当前已加载的全部房间，相对次序不变。
  await setFilter(page, '');
  assert.deepEqual(await readRowIds(page), [
    'r-alpha-up', 'r-alpha-low', 'r-evening-1', 'r-spaces', 'r-special',
    'r-evening-2', 'evening-in-id',
    'null-name', 'missing-name', 'number-name', 'object-name',
  ]);

  await new Promise((r) => setTimeout(r, 200));
  assert.equal(listGets, 0, '筛选过程不应发起任何列表接口请求');
});

test('中文、表情、尖括号和类似字符实体的文字按原样连续匹配，单元格展示不变', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t, BASE_RECORDS);
  await waitForRowCount(page, BASE_ROW_COUNT);

  for (const kw of ['😀', '<tag>', '&lt;', '名称😀']) {
    await setFilter(page, kw);
    assert.deepEqual(await readRowIds(page), ['r-special'], '关键词应按原样匹配：' + kw);
  }

  // 命中后名称单元格仍是逐字纯文本，不解释成标签或实体，其他列也不变。
  const cells = await page.$$eval('#list-area table tbody tr td', (tds) =>
    tds.map((td) => ({ text: td.textContent, html: td.innerHTML })));
  const nameCell = cells[1];
  assert.equal(nameCell.text, '<tag> &lt; 名称😀');
  assert.equal(nameCell.html, '&lt;tag&gt; &amp;lt; 名称😀', '尖括号与&必须以纯文本转义渲染');
  assert.equal(cells.length, 7, '筛选不改变列数与各列显示方式');
});

test('有房间但无名称命中时显示固定无匹配提示，并可直接修改或清空关键词', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t, BASE_RECORDS);
  await waitForRowCount(page, BASE_ROW_COUNT);

  await setFilter(page, '完全不存在的关键词zzz');
  let list = await readListArea(page);
  assert.equal(list.rowCount, 0);
  assert.equal(list.hasTable, false);
  assert.equal(list.noMatchText, NO_MATCH_TEXT);
  assert.deepEqual(list.emptyTexts, [], '不能把无匹配说成还没有房间');
  assert.match(list.skipText, new RegExp('有 ' + BASE_SKIPPED + ' 条'),
    '跳过提示仍按本次完整返回统计');
  assert.equal(list.filterDisabled, false, '无匹配时仍应能直接修改关键词');

  // 直接修改关键词即可恢复命中房间，无需刷新页面。
  await setFilter(page, '晚间');
  assert.deepEqual(await readRowIds(page), ['r-evening-1', 'r-evening-2']);
  await setFilter(page, '还是不存在');
  list = await readListArea(page);
  assert.equal(list.noMatchText, NO_MATCH_TEXT);
  // 清空后恢复全部已加载房间。
  await setFilter(page, '');
  assert.equal(await readRowCount(page), BASE_ROW_COUNT);
  list = await readListArea(page);
  assert.equal(list.noMatchText, null);
  assert.equal(list.hasTable, true);
});

test('名称缺失、为 null 或不是字符串的历史记录不参与匹配，清空后原样成行', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t, BASE_RECORDS);
  await waitForRowCount(page, BASE_ROW_COUNT);

  // 对象名称的内部文字（“晚间五子棋”）不能经 toString 等方式参与匹配；
  // 数字名称按数字而非字符串命中；缺失/null 名称更不能命中任何关键词。
  await setFilter(page, '晚间五子棋');
  assert.deepEqual(await readRowIds(page), ['r-evening-1', 'r-evening-2']);
  await setFilter(page, '12345');
  assert.deepEqual(await readRowIds(page), [], '数字名称不按字符串参与匹配');
  await setFilter(page, 'null');
  assert.deepEqual(await readRowIds(page), []);

  // 清空关键词后这些记录仍按原有方式在原位成行，名称不被补写。
  await setFilter(page, '');
  const rows = await page.$$eval('#list-area table tbody tr', (trs) =>
    trs.map((tr) => {
      const tds = [...tr.querySelectorAll('td')];
      return { id: tds[0].textContent, name: tds[1].textContent };
    }));
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.name]));
  assert.equal(byId['null-name'], '', 'null 名称仍留空');
  assert.equal(byId['missing-name'], '', '缺失名称仍留空');
  assert.equal(byId['number-name'], '12345', '数字名称沿用原有数字展示，但不参与字符串匹配');
  assert.equal(byId['object-name'], '字段格式异常', '异常名称仍只显示异常文案');
});

test('真空列表与全部跳过时，关键词不改变原有空列表/全部跳过提示', { timeout: 60000 }, async (t) => {
  // 真正的空数组：输入或清空关键词都仍是“还没有房间记录。”。
  {
    const { page } = await setupPage(t, []);
    await page.waitForSelector('#list-area .empty');
    await setFilter(page, '任意关键词');
    let list = await readListArea(page);
    assert.deepEqual(list.emptyTexts, [EMPTY_TEXT]);
    assert.equal(list.noMatchText, null);
    assert.equal(list.hasTable, false);
    await setFilter(page, '');
    list = await readListArea(page);
    assert.deepEqual(list.emptyTexts, [EMPTY_TEXT]);
    assert.equal(list.noMatchText, null);
  }

  // 数组非空但全部跳过：保留原有“没有可展示的房间 + 全部跳过条数”说明，
  // 不能因为有关键词就显示无匹配或空列表。
  {
    const { page } = await setupPage(t, ['null', '42', '"一段字符串"']);
    await page.waitForSelector('#list-area .skip-notice');
    const allSkippedText = '没有可展示的房间。本次返回的房间记录中有 3 条无法作为房间显示，' +
      '已全部跳过；原始数据仍保留在服务端，未被删除或改写。';
    let list = await readListArea(page);
    assert.equal(list.skipText, allSkippedText);
    await setFilter(page, '字符串');
    list = await readListArea(page);
    assert.equal(list.skipText, allSkippedText, '跳过条数按完整返回统计，隐藏的不是异常记录');
    assert.equal(list.noMatchText, null);
    assert.equal(list.hasTable, false);
    assert.deepEqual(list.emptyTexts, []);
    await setFilter(page, '');
    list = await readListArea(page);
    assert.equal(list.skipText, allSkippedText);
    assert.equal(list.noMatchText, null);
  }
});

test('筛选与创建表单互不影响；保留关键词创建后刷新按当前关键词筛选', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t, [room('c1', '晚间五子棋')]);
  await waitForRowCount(page, 1);

  // 先在创建表单填写四项内容，再反复修改关键词：表单填写必须原样保留，
  // 修改关键词也绝不触发创建请求。
  let postCount = 0;
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().includes('/api/rooms')) postCount++;
  });
  await page.type('#name', '表单暂存名称');
  await page.select('#game', 'ludo');
  await page.waitForFunction(() => !document.getElementById('capacity').disabled);
  await page.select('#capacity', '3');
  await page.type('#turnSeconds', '45');
  await setFilter(page, '晚间');
  await setFilter(page, '不存在');
  await setFilter(page, '晚间');
  assert.deepEqual(await page.evaluate(() => ({
    name: document.getElementById('name').value,
    game: document.getElementById('game').value,
    capacity: document.getElementById('capacity').value,
    turnSeconds: document.getElementById('turnSeconds').value,
  })), { name: '表单暂存名称', game: 'ludo', capacity: '3', turnSeconds: '45' },
    '修改关键词不能改变名称、规则、人数或时间');
  assert.equal(postCount, 0, '筛选不能提交创建请求');

  // 保留关键词创建一间名称命中的房间。
  const createdPromise = new Promise((resolve) => page.on('response', (resp) => {
    if (resp.request().method() === 'POST' && resp.url().includes('/api/rooms')) {
      resp.json().then(resolve);
    }
  }));
  await page.$eval('#name', (el) => { el.value = ''; });
  await fillGomoku(page, '晚间新房间', 0);
  await page.click('#submit');
  const created = await createdPromise;
  assert.ok(created.id, '成功结果必须带真实编号');

  await waitForRowCount(page, 2);
  const msg = await page.$eval('#form-msg', (el) => el.textContent);
  assert.ok(msg.includes(created.id), '成功提示照常显示真实编号');
  assert.deepEqual(await readRowIds(page), ['c1', created.id]);
  const list = await readListArea(page);
  assert.equal(list.filterValue, '晚间', '表单复位不能清空关键词');
  const formAfter = await page.evaluate(() => ({
    name: document.getElementById('name').value,
    game: document.getElementById('game').value,
    turnSeconds: document.getElementById('turnSeconds').value,
  }));
  assert.deepEqual(formAfter, { name: '', game: '', turnSeconds: '' }, '创建表单仍正常复位');

  // 再创建一间名称不命中当前关键词的房间：真实保存，但刷新后被关键词隐藏；
  // 清空关键词后它出现在最后。
  const created2Promise = new Promise((resolve) => page.on('response', (resp) => {
    if (resp.request().method() === 'POST' && resp.url().includes('/api/rooms')) {
      resp.json().then(resolve);
    }
  }));
  await fillGomoku(page, '白日场新房间', 0);
  await page.click('#submit');
  const created2 = await created2Promise;
  await page.waitForFunction(
    (id) => document.getElementById('form-msg').textContent.includes(id),
    { timeout: 10000 },
    created2.id,
  );
  await new Promise((r) => setTimeout(r, 300));
  assert.deepEqual(await readRowIds(page), ['c1', created.id], '不命中新房间不能出现在筛选结果中');
  await setFilter(page, '');
  assert.deepEqual(await readRowIds(page), ['c1', created.id, created2.id], '清空后按接口次序全部展示');
});

test('列表刷新回应落定前修改关键词，以最新输入为准', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t, [room('w1', '晚间五子棋'), room('w2', '白日飞行局')]);
  await waitForRowCount(page, 2);

  // 挂住创建后触发的那次列表查询，在它返回前改关键词。
  let heldGet = null;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.method() === 'GET' && req.url().includes('/api/rooms') && !heldGet) {
      heldGet = req;
    } else {
      req.continue();
    }
  });

  await setFilter(page, '白日'); // 先放一个会被覆盖的旧关键词
  const createdPromise = new Promise((resolve) => page.on('response', (resp) => {
    if (resp.request().method() === 'POST' && resp.url().includes('/api/rooms')) {
      resp.json().then(resolve);
    }
  }));
  await fillGomoku(page, '晚间加开场', 0);
  await page.click('#submit');
  const created = await createdPromise;
  assert.ok(created.id);
  for (let i = 0; i < 200 && !heldGet; i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(heldGet, '创建后应触发一次列表查询');

  // 回应还在途时把关键词改成“晚间”：渲染必须以最新输入为准。
  await setFilter(page, '晚间');
  heldGet.continue();
  await page.waitForFunction(
    () => document.querySelectorAll('#list-area table tbody tr').length === 2,
    { timeout: 10000 },
  );
  assert.deepEqual(await readRowIds(page), ['w1', created.id], '刷新落定后按最新关键词展示');
  await setFilter(page, '');
  await waitForRowCount(page, 3);
});

test('列表加载失败时，修改或清空关键词不能改变失败提示', { timeout: 60000 }, async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'score-arena-uidata-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(path.join(dataDir, 'rooms.json'), '被截断无法解析的内容');
  const baseURL = await startServer(t, dataDir);
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(baseURL, { waitUntil: 'load' });
  await page.waitForSelector('#list-area .list-error');

  for (const kw of ['晚间', '']) {
    await setFilter(page, kw);
    await new Promise((r) => setTimeout(r, 100));
    const list = await readListArea(page);
    assert.ok(list.errorText, '加载失败提示必须保留');
    assert.equal(list.noMatchText, null, '不能把失败改成无匹配结果');
    assert.deepEqual(list.emptyTexts, [], '不能把失败改成空列表');
    assert.equal(list.hasTable, false, '不能恢复出旧表格');
  }
});

test('筛选全程不修改服务端返回与本地保存的任何房间', { timeout: 60000 }, async (t) => {
  const { page, baseURL, dataDir, seedText } = await setupPage(t, BASE_RECORDS);
  await waitForRowCount(page, BASE_ROW_COUNT);

  const before = await (await fetch(baseURL + '/api/rooms')).json();
  for (const kw of ['Alpha', '晚间', '😀', '&lt;', '不存在的关键词', '   ', '']) {
    await setFilter(page, kw);
    await new Promise((r) => setTimeout(r, 50));
  }
  const after = await (await fetch(baseURL + '/api/rooms')).json();
  assert.deepEqual(after, before, '筛选前后接口返回必须一致');
  const onDisk = await readFile(path.join(dataDir, 'rooms.json'), 'utf8');
  assert.equal(onDisk, seedText, '筛选不能改写本地 rooms.json');
});
