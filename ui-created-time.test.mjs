// 首页房间列表“创建时间显示”的界面回归测试。
//
// 与其他浏览器回归文件的分工：
//   - ui.test.mjs：创建成功/被拒、成功后列表竞态刷新、名称整理与长度边界；
//   - ui-capacity-linkage.test.mjs：游戏规则与人数上限的联动；
//   - ui-turn-seconds.test.mjs：每步时间限制的填写、提交与展示；
//   - ui-mixed-records.test.mjs：非对象记录跳过与对象/数组异常字段的单元格兜底；
//   - ui-create-connection-failure.test.mjs：创建请求连接失败；
//   - ui-name-plain-text.test.mjs：房间名称的纯文本展示；
//   - 本文件只盯住“创建时间这一格”：跨时区本地换算、悬浮原文与不可识别值兜底。
//
// 保护的已有行为（本文件不修改任何产品代码，只补回归保障）：
//   - 能识别的创建时间一律显示“YYYY-MM-DD HH:mm:ss”，月、日、时、分、秒不足
//     两位补零；带时区偏移（Z、+08:00、+05:30、-03:00 等）的原文按它表示的
//     实际时刻换算成浏览器当地时间，跨日、跨月、跨年时显示的日期对应当地日历，
//     而不是把原串里的年月日时分秒直接当本地时间；
//   - 同一时刻的不同写法（如 …T00:30:05Z 与 …T08:30:05+08:00）在同一浏览器
//     时区里必须显示成相同的日期和时间；
//   - 鼠标悬浮（title）显示的是接口返回的完整原文：不替换成本地时间，同一时刻
//     的两种原文也不被统一成同一种写法；
//   - 无法识别的非空字符串按原文显示在这一格：不补当前时间、不出现
//     “Invalid Date”、不附悬浮说明；尖括号等内容只是文字（不产生元素、不执行）；
//     字段缺失、为 null 或空字符串时单元格留空且没有悬浮说明。这两类记录都
//     仍在列表原位，本行其他配置与前后房间照常显示，不跳过整行、不显示加载失败；
//   - 时间换算只影响页面显示：GET /api/rooms 的原始值与本地 rooms.json 不被改写，
//     创建成功后新房间的悬浮原文来自本次创建结果，保存的仍是服务端原始时间。
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

// 题目约定的同一时刻两种原文：均表示 2026-01-01T00:30:05Z。
const T_SPEC_Z = '2026-01-01T00:30:05Z';
const T_SPEC_PLUS8 = '2026-01-01T08:30:05+08:00';

// 构造一条完整房间记录的 JSON 片段。createdAt 传 undefined 时键直接缺失，
// 传 null 时保留 null，用来模拟各类历史数据。
function room(id, createdAt, name) {
  return JSON.stringify({
    id,
    name: name || '时间回归-' + id,
    game: 'gomoku',
    capacity: 2,
    turnSeconds: 0,
    status: 'waiting',
    visibility: 'public',
    createdAt,
  });
}

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

// 每个用例独立数据目录、服务进程与页面；timezone 固定该“用户浏览器”的当地时区。
async function setupPage(t, records, timezone) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'score-arena-uidata-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const seedText = await seedRecords(dataDir, records);
  const baseURL = await startServer(t, dataDir);
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.emulateTimezone(timezone);
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

function waitForMessageKind(page, kind) {
  return page.waitForFunction(
    (cls) => document.getElementById('form-msg').classList.contains(cls),
    { timeout: 10000 },
    kind,
  );
}

// readRows 读取每行全部单元格文本、创建时间格的 title（悬浮原文）、内部 HTML
// （验证尖括号只被当文字）与状态徽标。
function readRows(page) {
  return page.$$eval('#list-area table tbody tr', (trs) =>
    trs.map((tr) => {
      const tds = [...tr.querySelectorAll('td')];
      return {
        cells: tds.map((td) => td.textContent),
        timeTitle: tds[6] ? tds[6].getAttribute('title') : null,
        timeHTML: tds[6] ? tds[6].innerHTML : null,
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
    imgCount: document.querySelectorAll('#list-area img').length,
    errorText: document.querySelector('#list-area .list-error')
      ? document.querySelector('#list-area .list-error').textContent
      : null,
    skipCount: document.querySelectorAll('#list-area .skip-notice').length,
  }));
}

function rowById(rows, id) {
  const r = rows.find((row) => row.cells[0] === id);
  assert.ok(r, '应能找到房间行：' + id);
  return r;
}

// 与页面完全独立的一份期望实现：用 Intl 按目标时区算出本地墙钟时间，
// 固定宽度的断言（正则）再额外保证补零。hour12:false 在午夜会给出 "24"，
// 需归一化成 "00"。
const TIME_TEXT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
function expectedLocalText(iso, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(iso));
  const get = (type) => parts.find((p) => p.type === type).value;
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}:${get('second')}`;
}

async function readServerRooms(baseURL) {
  const res = await fetch(baseURL + '/api/rooms');
  assert.equal(res.status, 200);
  return (await res.json()).rooms;
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

// 东八区：题目样例、补零、跨月与跨年，以及带非零时区偏移的原文按“实际时刻”
// 换算（原串墙钟时间不得直接当本地时间）。
test('东八区：创建时间按实际时刻换算为本地 YYYY-MM-DD HH:mm:ss，跨月跨年日期正确且悬浮保留原文', { timeout: 60000 }, async (t) => {
  const records = [
    room('tz-spec', T_SPEC_Z),                                   // 题目样例
    room('tz-pad', '2026-09-05T00:01:02Z'),                     // 月/日/时/分/秒补零
    room('tz-month', '2026-01-31T16:05:09Z'),                   // 北京时间跨到 2 月 1 日
    room('tz-year', '2025-12-31T20:00:00Z'),                    // 北京时间跨年到 2026
    room('tz-plus530', '2026-03-29T12:00:00+05:30'),            // UTC 06:30 → 北京 14:30
    room('tz-minus3', '2026-08-01T03:30:00-03:00'),             // UTC 06:30 → 北京 14:30
  ];
  const { page } = await setupPage(t, records, 'Asia/Shanghai');
  await waitForRowCount(page, records.length);

  const rows = await readRows(page);
  const want = {
    'tz-spec': ['2026-01-01 08:30:05', T_SPEC_Z],
    'tz-pad': ['2026-09-05 08:01:02', '2026-09-05T00:01:02Z'],
    'tz-month': ['2026-02-01 00:05:09', '2026-01-31T16:05:09Z'],
    'tz-year': ['2026-01-01 04:00:00', '2025-12-31T20:00:00Z'],
    'tz-plus530': ['2026-03-29 14:30:00', '2026-03-29T12:00:00+05:30'],
    'tz-minus3': ['2026-08-01 14:30:00', '2026-08-01T03:30:00-03:00'],
  };
  for (const [id, [text, raw]] of Object.entries(want)) {
    const r = rowById(rows, id);
    assert.equal(r.cells[6], text, id + ' 的本地日期时间不正确');
    assert.match(r.cells[6], TIME_TEXT_RE, id + ' 的显示不是固定宽度的补零格式');
    assert.equal(r.timeTitle, raw, id + ' 的悬浮内容必须是接口原文，不能换成本地时间');
  }

  // 关键反例：+05:30 原文里的“12:00:00”绝不能被直接当成本地时分。
  assert.notEqual(rowById(rows, 'tz-plus530').cells[6], '2026-03-29 12:00:00');
});

// 固定西五区（Etc/GMT+5，IANA 符号与习惯相反，全年固定 UTC-5）：题目样例必须
// 显示成前一天的晚上；东八区里跨年的同一时刻在西五区仍落在前一年。
test('固定西五区：UTC 时刻换算成当地前一天日期，与题目样例逐字一致', { timeout: 60000 }, async (t) => {
  const records = [
    room('tz-spec', T_SPEC_Z),
    room('tz-year', '2025-12-31T20:00:00Z'),
    room('tz-month', '2026-01-31T16:05:09Z'),
  ];
  const { page } = await setupPage(t, records, 'Etc/GMT+5');
  await waitForRowCount(page, records.length);

  const rows = await readRows(page);
  assert.equal(rowById(rows, 'tz-spec').cells[6], '2025-12-31 19:30:05', '题目样例在西五区的显示不正确');
  assert.equal(rowById(rows, 'tz-spec').timeTitle, T_SPEC_Z);
  assert.equal(rowById(rows, 'tz-year').cells[6], '2025-12-31 15:00:00', '西五区仍应落在 2025 年');
  assert.equal(rowById(rows, 'tz-year').timeTitle, '2025-12-31T20:00:00Z');
  assert.equal(rowById(rows, 'tz-month').cells[6], '2026-01-31 11:05:09', '同一时刻在西五区不跨月');
  assert.equal(rowById(rows, 'tz-month').timeTitle, '2026-01-31T16:05:09Z');
});

// 带夏令时的时区：换算必须跟随时区规则（多伦多冬季 UTC-5、夏季 UTC-4），
// 而不是对所有日期套用固定偏移。
test('夏令时时区：同一偏移方向在冬夏按不同偏移换算，日期随之正确回退', { timeout: 60000 }, async (t) => {
  const records = [
    room('tz-winter', '2026-01-01T00:30:05Z'),    // EST UTC-5 → 前一天 19:30:05
    room('tz-summer', '2026-09-05T00:01:02Z'),    // EDT UTC-4 → 前一天 20:01:02
  ];
  const { page } = await setupPage(t, records, 'America/Toronto');
  await waitForRowCount(page, records.length);

  const rows = await readRows(page);
  assert.equal(rowById(rows, 'tz-winter').cells[6], '2025-12-31 19:30:05');
  assert.equal(rowById(rows, 'tz-summer').cells[6], '2026-09-04 20:01:02');
  assert.equal(rowById(rows, 'tz-summer').timeTitle, '2026-09-05T00:01:02Z');
});

// 半小时偏移时区：分钟部分也要按实际偏移换算。
test('半小时偏移时区：分钟部分同样按实际时刻换算', { timeout: 60000 }, async (t) => {
  const records = [
    room('tz-kolkata-z', T_SPEC_Z),                       // +05:30 → 06:00:05
    room('tz-kolkata-offset', '2026-03-29T12:00:00+05:30'),
  ];
  const { page } = await setupPage(t, records, 'Asia/Kolkata');
  await waitForRowCount(page, records.length);

  const rows = await readRows(page);
  assert.equal(rowById(rows, 'tz-kolkata-z').cells[6], '2026-01-01 06:00:05');
  assert.equal(rowById(rows, 'tz-kolkata-z').timeTitle, T_SPEC_Z);
  assert.equal(rowById(rows, 'tz-kolkata-offset').cells[6], '2026-03-29 12:00:00');
  assert.equal(rowById(rows, 'tz-kolkata-offset').timeTitle, '2026-03-29T12:00:00+05:30');
});

// 同一时刻的两种原文在同一浏览器时区必须显示相同的日期和时间；悬浮仍分别显示
// 各自原文，不能统一成同一种写法。在东八区与固定西五区各开一个页面复核。
test('同一时刻的 Z 与 +08:00 两种原文：显示相同本地时间，悬浮各自保留不同原文', { timeout: 60000 }, async (t) => {
  const records = [room('same-z', T_SPEC_Z), room('same-plus8', T_SPEC_PLUS8)];

  for (const [timezone, localText] of [
    ['Asia/Shanghai', '2026-01-01 08:30:05'],
    ['Etc/GMT+5', '2025-12-31 19:30:05'],
  ]) {
    const { page } = await setupPage(t, records, timezone);
    await waitForRowCount(page, 2);
    const rows = await readRows(page);

    const zRow = rowById(rows, 'same-z');
    const plus8Row = rowById(rows, 'same-plus8');
    assert.equal(zRow.cells[6], localText, timezone + ' 下 Z 原文的本地显示不正确');
    assert.equal(plus8Row.cells[6], localText, timezone + ' 下 +08:00 原文的本地显示应与 Z 原文一致');
    // 悬浮内容必须仍是两条不同的接口原文。
    assert.equal(zRow.timeTitle, T_SPEC_Z, timezone + ' 下悬浮内容被替换或统一');
    assert.equal(plus8Row.timeTitle, T_SPEC_PLUS8, timezone + ' 下悬浮内容被替换或统一');
    assert.notEqual(zRow.timeTitle, plus8Row.timeTitle, '两种原文不能在悬浮中被统一写法');
  }
});

// 无法识别的非空字符串：原文留在格内、无悬浮、无 Invalid Date、不补当前时间；
// 尖括号只作为文字（不生成元素、不触发弹窗）；纯空白但非空的字符串也按原文
// 显示。异常时间不拖垮本行其他配置与前后房间，查看与刷新不改写服务端数据。
test('无法识别的非空创建时间：原文显示、无悬浮、无 Invalid Date、尖括号为纯文本，行与相邻房间照常', { timeout: 60000 }, async (t) => {
  const tagString = '<img src=x onerror=alert(1)>';
  const records = [
    room('ok-before', '2026-05-01T06:00:00Z'),
    room('bad-tag', tagString),
    room('bad-text', 'not-a-real-date'),
    room('bad-shape', '2026-13-45T99:99:99Z'),
    room('bad-spaces', '   '),
    room('ok-after', '2026-05-02T06:00:00Z'),
  ];
  const { page, baseURL, dataDir, seedText } = await setupPage(t, records, 'Etc/UTC');

  // 脏名称若被当成 HTML 注入，alert 会触发对话框；记录下来用于最后断言。
  const dialogs = [];
  page.on('dialog', (d) => { dialogs.push(d.message()); d.dismiss(); });

  await waitForRowCount(page, records.length);
  const list = await readListArea(page);
  assert.equal(list.errorText, null, '不可识别的创建时间不能让列表加载失败');
  assert.equal(list.skipCount, 0, '含不可识别创建时间的对象不能被整行跳过');
  assert.equal(list.imgCount, 0, '尖括号内容不能生成任何 HTML 元素');
  assert.ok(!list.text.includes('Invalid Date'), '页面不能出现 Invalid Date');
  assert.ok(!list.text.includes('NaN'), '页面不能出现 NaN 之类的失败痕迹');

  const rows = await readRows(page);
  assert.deepEqual(
    rows.map((r) => r.cells[0]),
    ['ok-before', 'bad-tag', 'bad-text', 'bad-shape', 'bad-spaces', 'ok-after'],
    '记录必须保留在列表原来的位置',
  );

  // 尖括号脏串：逐字显示、转义为文字、不附悬浮说明。
  const tagRow = rowById(rows, 'bad-tag');
  assert.equal(tagRow.cells[6], tagString, '不可识别字符串必须按原文显示');
  assert.equal(tagRow.timeTitle, null, '不可识别字符串不能附日期悬浮说明');
  assert.ok(tagRow.timeHTML.includes('&lt;img'), '尖括号必须被转义成文字');
  assert.ok(!tagRow.timeHTML.includes('<img'), '尖括号不能成为真实元素');

  // 其他不可识别字符串同样原文显示、无悬浮。
  assert.equal(rowById(rows, 'bad-text').cells[6], 'not-a-real-date');
  assert.equal(rowById(rows, 'bad-text').timeTitle, null);
  assert.equal(rowById(rows, 'bad-shape').cells[6], '2026-13-45T99:99:99Z');
  assert.equal(rowById(rows, 'bad-shape').timeTitle, null);

  // 非空的纯空白字符串不是“空字符串”：仍按原文显示（三个空格），但也无悬浮。
  const spacesRow = rowById(rows, 'bad-spaces');
  assert.equal(spacesRow.cells[6], '   ', '非空空白字符串应按原文显示，不能与空字符串混淆');
  assert.equal(spacesRow.timeTitle, null);

  // 本行其他配置照常：异常创建时间只影响这一格。
  assert.equal(tagRow.cells[1], '时间回归-bad-tag');
  assert.equal(tagRow.cells[2], '五子棋');
  assert.equal(tagRow.badge, '未开始');

  // 前后正常房间照常显示（UTC 页面下 Z 原文的当地时间与UTC一致）。
  assert.equal(rowById(rows, 'ok-before').cells[6], '2026-05-01 06:00:00');
  assert.equal(rowById(rows, 'ok-before').timeTitle, '2026-05-01T06:00:00Z');
  assert.equal(rowById(rows, 'ok-after').cells[6], '2026-05-02 06:00:00');

  assert.deepEqual(dialogs, [], '尖括号内容不能触发任何脚本对话框');

  // 刷新再看一次：仍然不崩、不改写。
  await page.reload({ waitUntil: 'load' });
  await waitForRowCount(page, records.length);
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms[2].createdAt, 'not-a-real-date', '接口返回的原始时间不能被改写');
  assert.equal(serverRooms[3].createdAt, '2026-13-45T99:99:99Z');
  const onDisk = await readFile(path.join(dataDir, 'rooms.json'), 'utf8');
  assert.equal(onDisk, seedText, '查看与刷新列表不能改写本地保存的原始创建时间');
});

// createdAt 缺失、为 null 或空字符串：这一格保持空白、没有悬浮说明；记录仍在
// 原位，本行其他配置与前后房间照常显示。
test('创建时间缺失/null/空字符串：单元格留空且无悬浮，房间仍在原位正常显示', { timeout: 60000 }, async (t) => {
  const records = [
    room('ok-before', '2026-05-01T06:00:00Z'),
    room('missing', undefined),
    room('null', null),
    room('empty', ''),
    room('ok-after', '2026-05-02T06:00:00Z'),
  ];
  const { page } = await setupPage(t, records, 'Etc/UTC');
  await waitForRowCount(page, records.length);

  const list = await readListArea(page);
  assert.equal(list.errorText, null);
  assert.equal(list.skipCount, 0);
  assert.ok(!list.text.includes('Invalid Date'));
  assert.ok(!list.text.includes('undefined'), '缺失字段不能生成 undefined 字样');

  const rows = await readRows(page);
  assert.deepEqual(
    rows.map((r) => r.cells[0]),
    ['ok-before', 'missing', 'null', 'empty', 'ok-after'],
    '缺时间的房间必须保留在列表原来的位置',
  );
  for (const id of ['missing', 'null', 'empty']) {
    const r = rowById(rows, id);
    assert.equal(r.cells[6], '', id + ' 的创建时间格必须保持空白');
    assert.equal(r.timeTitle, null, id + ' 不能附带悬浮说明');
    // 同一行其他配置照常显示。
    assert.equal(r.cells[1], '时间回归-' + id);
    assert.equal(r.cells[2], '五子棋');
    assert.equal(r.badge, '未开始');
  }
  assert.equal(rowById(rows, 'ok-before').cells[6], '2026-05-01 06:00:00');
  assert.equal(rowById(rows, 'ok-after').cells[6], '2026-05-02 06:00:00');
});

// 创建成功、列表随之更新时：新房间的创建时间遵守同一换算约定，悬浮原文来自
// 本次创建结果；换算只影响页面显示，接口返回与本地文件保存的仍是服务端原始
// 时间，已有房间不被改写。
test('创建成功后：新行按本地时区显示，悬浮原文等于本次创建结果，接口与本地文件保存原始时间', { timeout: 60000 }, async (t) => {
  const seed = [room('seed-room', T_SPEC_Z, '旧房间')];
  const { page, baseURL, dataDir } = await setupPage(t, seed, 'Asia/Shanghai');
  await waitForRowCount(page, 1);

  const createdPromise = nextCreated(page);
  await fillGomokuForm(page, '跨时区新建的房间', 0);
  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  assert.ok(created.id, '创建结果应包含房间编号');
  assert.match(created.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/,
    '服务端创建结果仍应是 UTC RFC3339 原文');

  await waitForRowCount(page, 2);
  const rows = await readRows(page);

  // 旧房间原位不变。
  const oldRow = rowById(rows, 'seed-room');
  assert.equal(oldRow.cells[6], '2026-01-01 08:30:05');
  assert.equal(oldRow.timeTitle, T_SPEC_Z);

  // 新房间追加在最后：本地显示按东八区换算，悬浮原文逐字来自创建结果。
  const newRow = rows[1];
  assert.equal(newRow.cells[0], created.id);
  assert.equal(newRow.timeTitle, created.createdAt, '新房间悬浮原文必须来自本次创建结果');
  assert.equal(
    newRow.cells[6],
    expectedLocalText(created.createdAt, 'Asia/Shanghai'),
    '新房间创建时间也必须按浏览器本地时区换算',
  );
  assert.match(newRow.cells[6], TIME_TEXT_RE, '新房间显示同样必须是补零的固定宽度格式');

  // 接口原始数据：旧记录原样、新记录保存服务端原始 UTC 时间（不是本地时间）。
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, 2);
  assert.deepEqual(serverRooms[0], JSON.parse(seed[0]), '已有房间不能因列表更新被改写');
  assert.equal(serverRooms[1].createdAt, created.createdAt, '接口保存的必须是原始创建时间');
  assert.equal(serverRooms[1].id, created.id);

  // 本地文件同样保存原始 UTC 时间，旧记录不变。
  const onDisk = JSON.parse(await readFile(path.join(dataDir, 'rooms.json'), 'utf8'));
  assert.equal(onDisk.length, 2);
  assert.deepEqual(onDisk[0], JSON.parse(seed[0]));
  assert.equal(onDisk[1].createdAt, created.createdAt, '本地保存的必须是原始创建时间，不是本地换算结果');
});
