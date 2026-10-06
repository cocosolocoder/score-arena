// 首页房间列表“创建时间显示”的界面回归测试。
//
// 页面已经把接口返回的创建时间换算成浏览器本地时间显示，本文件不改动任何
// 产品代码，只固定现有显示约定：
//   - 能识别的创建时间显示为 YYYY-MM-DD HH:mm:ss，月/日/时/分/秒不足两位
//     补零；带时区偏移的原文按它表示的实际时刻换算，跨日、跨月、跨年的
//     日期必须对应当地时间，而不是直接照抄原串里的日历字段；
//   - 同一时刻的两种原文写法（如结尾 Z 与显式 +08:00 偏移）在同一浏览器
//     时区下必须显示相同的本地日期时间；鼠标悬浮（title）仍各自是接口返回
//     的完整原文，悬浮内容不被换算，也不被统一成同一种写法；
//   - 无法识别的非空字符串按原文显示在这一格：不补当前时间、不出现
//     Invalid Date、不附悬浮说明，其中尖括号等内容只作为文字；
//   - createdAt 缺失、为 null 或空字符串时这一格保持空白且没有悬浮说明；
//   - 上述任何记录仍留在列表原来的位置，同一行其他配置与前后房间照常显示，
//     不能因为时间不可识别就跳过整条房间或把列表显示成加载失败；
//   - 创建房间成功、列表随之更新时，新房间的创建时间遵守同一套约定，
//     悬浮原文来自本次创建结果；换算只影响页面显示，接口返回与本地
//     rooms.json 里的原始 createdAt 不被查看或列表更新改写。
//
// 时区用 puppeteer 的 page.emulateTimezone 逐页固定（与真实用户“浏览器处于
// 某个时区”等价），测试结果不依赖运行机器自身的时区。
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

// 同一个实际时刻的两种原文写法：2026-01-01T00:30:05Z 与
// 2026-01-01T08:30:05+08:00 都是 UTC 2026-01-01 00:30:05。
const INSTANT_Z = '2026-01-01T00:30:05Z';
const INSTANT_PLUS8 = '2026-01-01T08:30:05+08:00';

// 另一个带偏移的同一时刻写法（UTC 前一日 19:30:05 的西五区写法），
// 与前两条一起证明换算只认实际时刻、不认原串的日历字段。
const INSTANT_MINUS5 = '2025-12-31T19:30:05-05:00';

// 恰好落在各时间单位边界的时刻（UTC）：秒与分为 05、小时 00、日期为 1 号、
// 月份为 1 月——换算后若补零或日历进位出错会立刻暴露。
const PAD_UTC = '2026-01-01T00:05:05Z';

// 无法被 new Date 识别的历史创建时间（Chrome 实测均返回 Invalid Date）。
const BAD_TIME_TEXT = '2026-13-45 99:99:99';
const BAD_TIME_TAGS = '<img src=x onerror=window.__badTimeMarker=1>创建于<b>很久以前</b>';

const LOCAL_TIME_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function room(partial) {
  return JSON.stringify({
    id: 'r',
    name: '房间',
    game: 'gomoku',
    capacity: 2,
    turnSeconds: 0,
    status: 'waiting',
    visibility: 'public',
    ...partial,
  });
}

// 生成一条创建时间为 createdAt 的房间 JSON（其余字段为正常默认值）。
function timeRoom(id, createdAt, extra) {
  return room({ id, name: '时间房-' + id, createdAt, ...(extra || {}) });
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

// seedRecords 以原始 JSON 片段写 rooms.json，返回写入的确切文本，
// 供“查看不改写文件”的逐字节比对使用。
async function seedRecords(dataDir, records) {
  const content = '[\n' + records.join(',\n') + '\n]\n';
  await writeFile(path.join(dataDir, 'rooms.json'), content);
  return content;
}

// 每个用例使用独立的数据目录、服务进程与页面；timezone 缺省时沿用运行环境
// 时区（本文件主要用例都显式固定为指定 IANA 时区）。
async function setupPage(t, records, timezone) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'score-arena-uidata-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const seedText = await seedRecords(dataDir, records);
  const baseURL = await startServer(t, dataDir);
  const page = await browser.newPage();
  t.after(() => page.close());
  if (timezone) await page.emulateTimezone(timezone);
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

// readRows 读取每行单元格文本、创建时间格（第 7 列）的 title 与状态徽标。
function readRows(page) {
  return page.$$eval('#list-area table tbody tr', (trs) =>
    trs.map((tr) => {
      const tds = [...tr.querySelectorAll('td')];
      return {
        cells: tds.map((td) => td.textContent),
        timeText: tds[6] ? tds[6].textContent : null,
        timeTitle: tds[6] ? tds[6].getAttribute('title') : null,
        timeHtml: tds[6] ? tds[6].innerHTML : null,
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
    errorText: document.querySelector('#list-area .list-error')
      ? document.querySelector('#list-area .list-error').textContent
      : null,
    skipCount: document.querySelectorAll('#list-area .skip-notice').length,
  }));
}

async function readServerRooms(baseURL) {
  const res = await fetch(baseURL + '/api/rooms');
  assert.equal(res.status, 200);
  return (await res.json()).rooms;
}

// formatInZone 在 Node 侧独立按 IANA 时区把同一时刻格式化为
// YYYY-MM-DD HH:mm:ss，作为页面显示的期望值。它与页面的 Date 换算相互
// 独立（Intl vs getFullYear/getHours），两边一致才能证明页面换算准确。
function formatInZone(iso, timeZone) {
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(d).filter((p) => p.type !== 'literal').map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

// 任务中给出的两个固定换算样例：东八区与固定西五区（用不带 DST 的
// Pacific/Honolulu 以西十区覆盖“向西跨过日期”的样例，另在
// America/New_York 上覆盖西五区与跨年）。
test('带 Z 的时刻按浏览器本地时区换算：东八区同日 +8 小时，西五区跨回上一年', { timeout: 60000 }, async (t) => {
  const records = [
    timeRoom('shanghai-view', INSTANT_Z),
    timeRoom('pad-view', PAD_UTC),
  ];

  // 东八区：UTC 2026-01-01 00:30:05 → 2026-01-01 08:30:05。
  {
    const { page } = await setupPage(t, records, 'Asia/Shanghai');
    await waitForRowCount(page, 2);
    const rows = await readRows(page);

    assert.equal(rows[0].timeText, '2026-01-01 08:30:05', '东八区应显示换算后的本地日期时间');
    assert.match(rows[0].timeText, LOCAL_TIME_RE);
    assert.equal(rows[0].timeTitle, INSTANT_Z, '悬浮内容必须仍是接口返回的 Z 字原文');

    // 边界时刻补零：UTC 00:05:05 → 08:05:05，月/日/时/分/秒均为两位。
    assert.equal(rows[1].timeText, '2026-01-01 08:05:05', '分钟与秒不足两位必须补零');
    assert.equal(rows[1].timeTitle, PAD_UTC);
  }

  // 固定西五区（纽约 1 月为标准时 EST，UTC-5，无夏令时干扰）：
  // UTC 2026-01-01 00:30:05 → 当地 2025-12-31 19:30:05，日期跨年。
  {
    const { page } = await setupPage(t, records, 'America/New_York');
    await waitForRowCount(page, 2);
    const rows = await readRows(page);

    assert.equal(
      rows[0].timeText,
      '2025-12-31 19:30:05',
      '西五区必须按实际时刻换算成当地 2025-12-31 19:30:05（跨年）',
    );
    assert.equal(rows[0].timeTitle, INSTANT_Z, '跨年换算后悬浮仍是 Z 字原文');
    assert.equal(rows[1].timeText, '2025-12-31 19:05:05', '西五区边界时刻换算与补零应正确');
    assert.equal(rows[1].timeTitle, PAD_UTC);
  }
});

// 同一时刻的三种原文（Z、+08:00、-05:00）在同一浏览器时区下必须显示完全
// 相同的本地日期时间；悬浮 title 各自保留原文，互不统一。
test('同一时刻不同偏移原文显示一致，悬浮各自保留完整原文', { timeout: 60000 }, async (t) => {
  const records = [
    timeRoom('same-z', INSTANT_Z),
    timeRoom('same-plus8', INSTANT_PLUS8),
    timeRoom('same-minus5', INSTANT_MINUS5),
  ];

  for (const timezone of ['Asia/Shanghai', 'America/New_York', 'UTC']) {
    const { page } = await setupPage(t, records, timezone);
    await waitForRowCount(page, 3);
    const rows = await readRows(page);

    const expected = formatInZone(INSTANT_Z, timezone);
    for (const row of rows) assert.match(row.timeText, LOCAL_TIME_RE);
    assert.deepEqual(
      rows.map((r) => r.timeText),
      [expected, expected, expected],
      `${timezone}：三种偏移原文表示同一时刻，应显示相同的本地日期时间`,
    );

    // 悬浮不换算、不归一：三种写法逐字保留为接口返回的原文。
    assert.deepEqual(
      rows.map((r) => r.timeTitle),
      [INSTANT_Z, INSTANT_PLUS8, INSTANT_MINUS5],
      `${timezone}：悬浮说明必须各自保留接口原文，不能统一成同一种写法`,
    );
    // 显式断言两条任务点名的记录显示相同、原文不同。
    assert.equal(rows[0].timeText, rows[1].timeText, 'Z 与 +08:00 两条记录显示应相同');
    assert.notEqual(rows[0].timeTitle, rows[1].timeTitle, '两条记录的悬浮原文不能被统一');
  }
});

// 换算后的日历字段必须对应当地时间：跨日、跨月、跨年都不能照抄原串字段。
test('跨日/跨月/跨年的换算日期对应当地时间，各字段补零', { timeout: 60000 }, async (t) => {
  const cases = [
    // UTC 月末 20:00 → 东八区次月 1 号 04:00（跨月）。
    { zone: 'Asia/Shanghai', iso: '2026-01-31T20:00:05Z' },
    // UTC 月初 02:00 → 纽约（EST）上月末 21:00（跨月、补零）。
    { zone: 'America/New_York', iso: '2026-03-01T02:00:00Z' },
    // 向西跨过国际日期变更线：UTC+14 的新年元旦下午，对应 UTC 前一日。
    { zone: 'Pacific/Kiritimati', iso: '2025-12-31T10:00:00Z' },
    // 东十区跨日且分秒补零。
    { zone: 'Australia/Sydney', iso: '2026-06-15T15:07:09Z' },
  ];
  const records = cases.map((c, i) => timeRoom('cross-' + i, c.iso));

  // 每个时区独立打开页面（一个页面只能处于一个模拟时区）。
  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const { page } = await setupPage(t, [records[i]], c.zone);
    await waitForRowCount(page, 1);
    const rows = await readRows(page);
    assert.equal(
      rows[0].timeText,
      formatInZone(c.iso, c.zone),
      `${c.zone} 查看 ${c.iso} 的换算日期应对应当地时间`,
    );
    assert.match(rows[0].timeText, LOCAL_TIME_RE, '显示必须固定为 YYYY-MM-DD HH:mm:ss');
    assert.equal(rows[0].timeTitle, c.iso, '悬浮仍保留原文');
  }
});

// 无法识别的非空字符串：单元格按原文显示，不补当前时间、不出现 Invalid
// Date，不附悬浮说明；尖括号等内容只作为文字（不产生元素、不执行脚本）。
test('无法识别的非空创建时间按原文显示，无 Invalid Date、无悬浮，尖括号只作文字', { timeout: 60000 }, async (t) => {
  const records = [
    timeRoom('bad-text', BAD_TIME_TEXT),
    timeRoom('bad-tags', BAD_TIME_TAGS),
  ];
  const { page } = await setupPage(t, records, 'Asia/Shanghai');
  await waitForRowCount(page, 2);

  // 若注入字符串被当成 HTML 解析，标记会挂到 window 上。
  const marker = await page.evaluate(() => window.__badTimeMarker === 1);
  const list = await readListArea(page);
  const rows = await readRows(page);

  assert.equal(marker, false, '创建时间中的事件属性绝不能执行');
  assert.equal(list.errorText, null, '不可识别时间不能让列表加载失败');
  assert.equal(list.skipCount, 0, '时间不可识别不能跳过整条房间');

  assert.equal(rows[0].timeText, BAD_TIME_TEXT, '不可识别字符串应在格内按原文显示');
  assert.equal(rows[0].timeTitle, null, '不可识别字符串不应附悬浮说明');
  assert.ok(!list.text.includes('Invalid Date'), '页面上不能出现 Invalid Date');

  // 尖括号逐字可读但 innerHTML 中不存在 img/b 元素（textContent 赋值）。
  assert.equal(rows[1].timeText, BAD_TIME_TAGS, '含尖括号的原文必须逐字显示');
  assert.equal(rows[1].timeTitle, null, '含尖括号的不可识别字符串也不应有悬浮说明');
  // textContent 赋值后尖括号在 innerHTML 中必须是转义文本，不能存在真标签。
  assert.ok(rows[1].timeHtml.includes('&lt;'), '尖括号应被转义为文字而不是标签');
  assert.ok(!rows[1].timeHtml.includes('<img'), '不能生成 img 元素');
  assert.ok(!rows[1].timeHtml.includes('<b>'), '不能生成 b 元素');
  assert.equal(
    await page.$$eval('#list-area td:nth-child(7) img, #list-area td:nth-child(7) b', (els) => els.length),
    0,
    '创建时间格内不能出现由原文解析出的元素',
  );
  assert.ok(list.text.includes('很久以前'), '标签内文字应作为普通文字可读');
});

// createdAt 缺失、为 null 或空字符串：这一格空白且无悬浮；同一行其他配置
// 与前后房间照常显示，记录仍在原位置，不跳过、不加载失败。
test('创建时间缺失/null/空字符串：格内空白且无悬浮，行与相邻房间不受影响', { timeout: 60000 }, async (t) => {
  const before = timeRoom('ok-before', INSTANT_Z, { name: '前房' });
  const after = timeRoom('ok-after', '2026-02-02T02:02:02Z', { name: '后房' });
  const records = [
    before,
    room({ id: 'missing-time', name: '缺时间房' }),
    timeRoom('null-time', null, { name: 'null 时间房' }),
    timeRoom('empty-time', '', { name: '空串时间房' }),
    after,
  ];
  const { page } = await setupPage(t, records, 'Asia/Shanghai');
  await waitForRowCount(page, 5);
  const list = await readListArea(page);
  const rows = await readRows(page);

  assert.equal(list.errorText, null);
  assert.equal(list.skipCount, 0, '缺时间的房间不能被跳过');

  assert.deepEqual(
    rows.map((r) => r.cells[0]),
    ['ok-before', 'missing-time', 'null-time', 'empty-time', 'ok-after'],
    '缺时间的记录必须留在列表原来的位置',
  );

  for (const i of [1, 2, 3]) {
    assert.equal(rows[i].timeText, '', `第 ${i} 行创建时间格应保持空白`);
    assert.equal(rows[i].timeTitle, null, `第 ${i} 行不应附带悬浮说明`);
    // 同一行其他列照常显示。
    assert.equal(rows[i].cells[1], ['缺时间房', 'null 时间房', '空串时间房'][i - 1]);
    assert.equal(rows[i].cells[2], '五子棋');
    assert.equal(rows[i].cells[3], '2 人');
    assert.equal(rows[i].badge, '未开始');
  }

  // 前后房间照常换算显示。
  assert.equal(rows[0].timeText, '2026-01-01 08:30:05');
  assert.equal(rows[0].timeTitle, INSTANT_Z);
  assert.equal(rows[4].timeText, '2026-02-02 10:02:02');
  assert.equal(rows[4].timeTitle, '2026-02-02T02:02:02Z');
});

// 合法时间与不可识别时间混排：每条记录的显示互不干扰，悬浮只挂在可识别的
// 行上；整条列表既不跳过房间也不加载失败。
test('合法/不可识别/空白创建时间混排：各行独立显示，悬浮各归各、列表不失败', { timeout: 60000 }, async (t) => {
  const records = [
    timeRoom('m-good-1', INSTANT_Z),
    timeRoom('m-bad', BAD_TIME_TEXT),
    timeRoom('m-good-2', INSTANT_PLUS8),
    timeRoom('m-empty', ''),
  ];
  const { page } = await setupPage(t, records, 'America/New_York');
  await waitForRowCount(page, 4);
  const list = await readListArea(page);
  const rows = await readRows(page);

  assert.equal(list.rowCount, 4);
  assert.equal(list.errorText, null);
  assert.equal(list.skipCount, 0);
  assert.ok(!list.text.includes('Invalid Date'));

  const expected = formatInZone(INSTANT_Z, 'America/New_York');
  assert.equal(rows[0].timeText, expected);
  assert.equal(rows[0].timeTitle, INSTANT_Z);

  assert.equal(rows[1].timeText, BAD_TIME_TEXT, '不可识别行按原文显示');
  assert.equal(rows[1].timeTitle, null);

  assert.equal(rows[2].timeText, expected, '同一时刻的 +08:00 原文显示与 Z 行一致');
  assert.equal(rows[2].timeTitle, INSTANT_PLUS8, '悬浮仍是 +08:00 原文');

  assert.equal(rows[3].timeText, '');
  assert.equal(rows[3].timeTitle, null);
});

// 创建房间成功、列表随之更新：新房间的创建时间按同一约定换算显示，悬浮原文
// 来自本次创建结果（服务端 RFC3339 原文）；东八区与西五区各验证一次。
test('创建成功后新行创建时间按本地时区显示，悬浮原文来自本次创建结果', { timeout: 60000 }, async (t) => {
  for (const timezone of ['Asia/Shanghai', 'America/New_York']) {
    const records = [timeRoom('seed-1', INSTANT_Z, { name: '种子房间' })];
    const { page, baseURL } = await setupPage(t, records, timezone);
    await waitForRowCount(page, 1);

    const createdPromise = new Promise((resolve, reject) => {
      page.on('response', (resp) => {
        if (resp.request().method() === 'POST' && resp.url().endsWith('/api/rooms')) {
          resp.json().then(resolve, reject);
        }
      });
    });

    await page.type('#name', '新建的时间房');
    await page.select('#game', 'ludo');
    await page.select('#capacity', '3');
    await page.type('#turnSeconds', '45');
    await page.click('#submit');

    await page.waitForFunction(
      () => document.getElementById('form-msg').classList.contains('ok'),
      { timeout: 10000 },
    );
    const created = await createdPromise;
    assert.ok(created.createdAt, '创建结果应包含服务端生成的 createdAt');

    await waitForRowCount(page, 2);
    const rows = await readRows(page);

    // 种子行原样保留显示约定。
    assert.equal(rows[0].cells[0], 'seed-1');
    assert.equal(rows[0].timeText, formatInZone(INSTANT_Z, timezone));
    assert.equal(rows[0].timeTitle, INSTANT_Z);

    // 新行：编号与配置来自本次创建结果，时间按本地时区换算，悬浮原文逐字
    // 等于创建响应里的 createdAt。
    const added = rows[1];
    assert.equal(added.cells[0], created.id);
    assert.equal(added.cells[1], '新建的时间房');
    assert.equal(added.timeText, formatInZone(created.createdAt, timezone),
      `${timezone}：新房间创建时间应按本地时区换算显示`);
    assert.match(added.timeText, LOCAL_TIME_RE);
    assert.equal(added.timeTitle, created.createdAt, '新行悬浮原文必须来自本次创建结果');

    // 服务端保存的 createdAt 与创建结果一致。
    const serverRooms = await readServerRooms(baseURL);
    assert.equal(serverRooms[1].createdAt, created.createdAt, '保存记录的创建时间应与创建结果一致');
  }
});

// 时间换算只影响页面显示：查看列表、页面刷新与创建后列表更新都不得改写
// 接口返回与本地 rooms.json 中任何记录的原始 createdAt（合法原文写法、
// 不可识别原文与缺字段都保持原样）。
test('查看与列表更新不改写原始创建时间：接口记录与 rooms.json 逐字节保留', { timeout: 60000 }, async (t) => {
  const records = [
    timeRoom('raw-z', INSTANT_Z),
    timeRoom('raw-plus8', INSTANT_PLUS8, { note: '附带字段保留' }),
    timeRoom('raw-bad', BAD_TIME_TEXT),
    room({ id: 'raw-missing', name: '缺字段房' }),
  ];
  const { page, baseURL, dataDir, seedText } = await setupPage(t, records, 'Pacific/Honolulu');
  await waitForRowCount(page, 4);

  // 第一次查看：接口返回的原始 createdAt（含不可识别原文）原样不变。
  assert.deepEqual(
    (await readServerRooms(baseURL)).map((r) => r && r.createdAt),
    [INSTANT_Z, INSTANT_PLUS8, BAD_TIME_TEXT, undefined],
    '查看列表不应改写接口返回的原始创建时间',
  );

  // 页面上看到的是换算/原文兜底后的显示，但悬浮仍保留两种不同写法。
  let rows = await readRows(page);
  assert.equal(rows[0].timeText, formatInZone(INSTANT_Z, 'Pacific/Honolulu'));
  assert.equal(rows[1].timeText, formatInZone(INSTANT_PLUS8, 'Pacific/Honolulu'));
  assert.equal(rows[0].timeTitle, INSTANT_Z);
  assert.equal(rows[1].timeTitle, INSTANT_PLUS8, '两种原文写法不能在显示层被归一后回写');
  assert.equal(rows[2].timeText, BAD_TIME_TEXT);

  // 刷新页面再次查看：显示一致，接口与本地文件仍逐字节保留种子内容。
  await page.reload({ waitUntil: 'load' });
  await waitForRowCount(page, 4);
  rows = await readRows(page);
  assert.equal(rows[0].timeText, formatInZone(INSTANT_Z, 'Pacific/Honolulu'));
  assert.equal(rows[2].timeText, BAD_TIME_TEXT);

  const serverRooms = await readServerRooms(baseURL);
  assert.deepEqual(
    serverRooms.map((r) => ({ id: r.id, createdAt: r.createdAt, note: r.note })),
    [
      { id: 'raw-z', createdAt: INSTANT_Z, note: undefined },
      { id: 'raw-plus8', createdAt: INSTANT_PLUS8, note: '附带字段保留' },
      { id: 'raw-bad', createdAt: BAD_TIME_TEXT, note: undefined },
      { id: 'raw-missing', createdAt: undefined, note: undefined },
    ],
    '刷新查看后接口原始创建时间与附带字段必须保持不变',
  );
  assert.equal(
    await readFile(path.join(dataDir, 'rooms.json'), 'utf8'),
    seedText,
    '查看列表不应改写本地保存的原始记录',
  );

  // 创建导致列表更新后：旧记录的原始创建时间仍逐字保留，新记录只追加在后。
  const createdPromise = new Promise((resolve, reject) => {
    page.on('response', (resp) => {
      if (resp.request().method() === 'POST' && resp.url().endsWith('/api/rooms')) {
        resp.json().then(resolve, reject);
      }
    });
  });
  await page.type('#name', '更新后的新房');
  await page.select('#game', 'gomoku');
  await page.waitForFunction(
    () => !document.getElementById('capacity').disabled &&
      document.getElementById('capacity').value === '2',
    { timeout: 5000 },
  );
  await page.type('#turnSeconds', '0');
  await page.click('#submit');
  const created = await createdPromise;
  await page.waitForFunction(
    (cls) => document.getElementById('form-msg').classList.contains(cls),
    { timeout: 10000 },
    'ok',
  );
  await waitForRowCount(page, 5);

  const afterRooms = await readServerRooms(baseURL);
  assert.equal(afterRooms.length, 5, '新房间只追加一条，旧记录一条不少');
  assert.deepEqual(
    afterRooms.slice(0, 4).map((r) => r.createdAt),
    [INSTANT_Z, INSTANT_PLUS8, BAD_TIME_TEXT, undefined],
    '列表更新后已有房间的原始创建时间不能被改写',
  );
  assert.equal(afterRooms[4].id, created.id);
  assert.equal(afterRooms[4].createdAt, created.createdAt);

  // 本地文件中旧记录原文仍逐字存在（文件被新建动作整体重写，但旧记录
  // 内容必须保持），不可识别原文与两种偏移写法都没有被替换成本地时间。
  const onDisk = await readFile(path.join(dataDir, 'rooms.json'), 'utf8');
  assert.ok(onDisk.includes(INSTANT_Z), '本地文件应保留 Z 字原文');
  assert.ok(onDisk.includes(INSTANT_PLUS8), '本地文件应保留 +08:00 原文');
  assert.ok(onDisk.includes(BAD_TIME_TEXT), '本地文件应保留不可识别原文');
  assert.ok(!onDisk.includes('2025-12-31 14:30:05'), '本地文件不能写入换算后的本地时间');
});
