// 首页房间列表“规则列与状态列未知值原文展示”的界面回归测试。
//
// 已知映射只有：规则 gomoku→五子棋、ludo→飞行棋；状态 waiting→未开始。
// 历史房间里可能存着任何其他字符串，它们不是无法展示的记录：
//   - "constructor"、"toString"、"__proto__" 这类恰好撞名原型链的字符串，
//     无论出现在规则列还是状态列，都只是普通文字，按原文显示——不能沿原型链
//     查出函数源码、[object Object] 之类的对象说明，不能显示“字段格式异常”，
//     也不能让列表加载失败；
//   - 一个房间可以只有规则未知、只有状态未知，也可以两项都未知且内容不同；
//     两列各自按自己的值显示，绝不串用另一列的文字（规则值 "waiting" 不能
//     变成“未开始”，状态值 "gomoku" 不能变成“五子棋”）；
//   - 未知状态仍放在原有的徽标里，规则的未知值是规则格里的纯文本；
//   - 未知值遵守页面已有的纯文本行为：含尖括号标签或类似 &lt; 的文字按原有
//     写法显示，不生成网页元素、不再解释成别的字符；
//   - 字段缺失、为 null 或空字符串时两格沿用留空行为，不出现 undefined/null；
//   - 未知字符串不计跳过条数、不出现“没有房间”提示，房间保持接口返回的
//     相对次序，前后正常房间的中文映射与其余各列照常展示。
//
// 同时覆盖“首次打开首页”和“同一页创建合法房间后列表重新展示”：创建后
// 旧房间的原文与次序不变，新房间追加并显示所选中文规则与“未开始”，成功
// 提示及编号仍可见；查看与创建都不改写旧房间的未知值，接口与本地保存中的
// 原始字段及附带内容继续保留。未知值的原文回显只用于兼容历史记录：创建房间
// 仍遵守已有规则与配置限制（页面选不到未知规则、非法配置被页面拦截，
// 直接向接口提交未知规则或非法配置仍返回 400 且不写入）。
//
// 与其他浏览器回归文件的分工：
//   - ui-mixed-records.test.mjs：非对象记录跳过与对象/数组型异常字段；
//   - ui-name-plain-text.test.mjs：名称列的纯文本展示；
//   - ui-created-time.test.mjs：创建时间列；
//   - 本文件只盯住规则列与状态列的字符串回显。
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

const BAD_FIELD_TEXT = '字段格式异常';
const SUCCESS_PREFIX = '房间已创建，编号：';

// 首次打开用的十类记录（全部是对象，不应产生任何跳过）：
//   A0 正常前房间：gomoku/waiting——两个已知中文映射的基准；
//   A1 只有规则未知，值恰好撞名原型链 "constructor"，状态仍是已知 waiting；
//   A2 只有状态未知 "constructor"，规则仍是已知 ludo；
//   A3 两列交叉撞名：规则值是 "waiting"、状态值是 "gomoku"——若两列串用
//      映射，规则格会错显“未开始”、徽标会错显“五子棋”；
//   A4 两列都未知且同为 "toString"；A5 同为 "__proto__"；
//   A6 两列都未知且内容不同（中文未知值）；
//   A7 只有规则未知（普通英文未知值），状态 waiting；
//   A8 只有状态未知 "paused"，规则 gomoku；
//   A9 正常后房间：ludo/playing——非 waiting 状态本来就按原文显示。
const A0 =
  '{"id":"ok-before","name":"正常前房间","game":"gomoku","capacity":2,"turnSeconds":0,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-04-01T08:00:00Z"}';
const A1 =
  '{"id":"g-ctor","name":"规则名为原型链名字","game":"constructor","capacity":2,"turnSeconds":0,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-04-02T08:00:00Z","note":"保留备注一"}';
const A2 =
  '{"id":"s-ctor","name":"状态名为原型链名字","game":"ludo","capacity":4,"turnSeconds":30,' +
  '"status":"constructor","visibility":"public","createdAt":"2026-04-03T08:00:00Z"}';
const A3 =
  '{"id":"cross-columns","name":"两列交叉值","game":"waiting","capacity":3,"turnSeconds":30,' +
  '"status":"gomoku","createdAt":"2026-04-04T08:00:00Z"}';
const A4 =
  '{"id":"g-tostr","name":"两列都是toString","game":"toString","capacity":2,"turnSeconds":0,' +
  '"status":"toString","createdAt":"2026-04-05T08:00:00Z"}';
const A5 =
  '{"id":"g-proto","name":"两列都是proto","game":"__proto__","capacity":2,"turnSeconds":10,' +
  '"status":"__proto__","createdAt":"2026-04-06T08:00:00Z"}';
const A6 =
  '{"id":"both-diff","name":"两列未知且不同","game":"自定义规则甲","capacity":4,"turnSeconds":600,' +
  '"status":"自定义状态乙","createdAt":"2026-04-07T08:00:00Z","tags":["历史","附带"]}';
const A7 =
  '{"id":"g-only","name":"只有规则未知","game":"obscure-rule","capacity":2,"turnSeconds":0,' +
  '"status":"waiting","createdAt":"2026-04-08T08:00:00Z"}';
const A8 =
  '{"id":"s-only","name":"只有状态未知","game":"gomoku","capacity":2,"turnSeconds":0,' +
  '"status":"paused","createdAt":"2026-04-09T08:00:00Z"}';
const A9 =
  '{"id":"ok-after","name":"正常后房间","game":"ludo","capacity":3,"turnSeconds":300,' +
  '"status":"playing","visibility":"public","createdAt":"2026-04-10T08:00:00Z"}';

const INITIAL_RECORDS = [A0, A1, A2, A3, A4, A5, A6, A7, A8, A9];

// 每行的前六格预期（第七格创建时间随时区格式化，单独用正则与 title 断言）。
const INITIAL_FRONT_CELLS = [
  ['ok-before', '正常前房间', '五子棋', '2 人', '不限时', '未开始'],
  ['g-ctor', '规则名为原型链名字', 'constructor', '2 人', '不限时', '未开始'],
  ['s-ctor', '状态名为原型链名字', '飞行棋', '4 人', '30 秒', 'constructor'],
  ['cross-columns', '两列交叉值', 'waiting', '3 人', '30 秒', 'gomoku'],
  ['g-tostr', '两列都是toString', 'toString', '2 人', '不限时', 'toString'],
  ['g-proto', '两列都是proto', '__proto__', '2 人', '10 秒', '__proto__'],
  ['both-diff', '两列未知且不同', '自定义规则甲', '4 人', '600 秒', '自定义状态乙'],
  ['g-only', '只有规则未知', 'obscure-rule', '2 人', '不限时', '未开始'],
  ['s-only', '只有状态未知', '五子棋', '2 人', '不限时', 'paused'],
  ['ok-after', '正常后房间', '飞行棋', '3 人', '300 秒', 'playing'],
];

// 尖括号/实体样式的未知值：规则与状态各放一个标签样式串与一个实体样式串。
const TAGGED_RECORDS = [
  '{"id":"tag-1","name":"标签样式未知值","game":"<script>alert(1)</script>","capacity":2,' +
    '"turnSeconds":0,"status":"<img src=x onerror=\\"window.__ruleStatusPwned=1\\">",' +
    '"createdAt":"2026-05-01T08:00:00Z"}',
  '{"id":"ent-1","name":"实体样式未知值","game":"&lt;规则&gt;","capacity":4,"turnSeconds":30,' +
    '"status":"&amp;状态乙","createdAt":"2026-05-02T08:00:00Z","note":"实体原样保留"}',
  '{"id":"ent-2","name":"实体样式后的正常房","game":"gomoku","capacity":2,"turnSeconds":0,' +
    '"status":"waiting","createdAt":"2026-05-03T08:00:00Z"}',
];

// 规则/状态缺失、为 null 或空字符串的四种组合（其余字段给全，避免别的列
// 兜底文案干扰“不能出现 undefined/null”的整区检查），末尾放一个正常房间。
const EMPTYISH_RECORDS = [
  '{"id":"miss-game-null-status","name":"规则缺失状态为null","capacity":2,"turnSeconds":0,' +
    '"status":null,"createdAt":"2026-06-01T08:00:00Z"}',
  '{"id":"null-game-empty-status","name":"规则为null状态为空串","game":null,"capacity":2,' +
    '"turnSeconds":10,"status":"","createdAt":"2026-06-02T08:00:00Z"}',
  '{"id":"empty-game-miss-status","name":"规则为空串状态缺失","game":"","capacity":4,' +
    '"turnSeconds":30,"createdAt":"2026-06-03T08:00:00Z"}',
  '{"id":"miss-both","name":"两列都缺失","capacity":3,"turnSeconds":60,' +
    '"createdAt":"2026-06-04T08:00:00Z"}',
  '{"id":"normal-tail","name":"留空组合后的正常房","game":"ludo","capacity":3,"turnSeconds":0,' +
    '"status":"waiting","createdAt":"2026-06-05T08:00:00Z"}',
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

// readRows 读取每行单元格文本、创建时间 title（接口原文）与状态徽标文本。
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

// readRuleStatusDetail 单独读取规则格（第 3 列）与状态格（第 6 列）的 DOM
// 细节：未知规则值应是规则格里的纯文本（无子元素）；未知状态值应仍包在
// 原有的单个 .badge 徽标里，状态格不另生文字。
function readRuleStatusDetail(page) {
  return page.$$eval('#list-area table tbody tr', (trs) =>
    trs.map((tr) => {
      const tds = [...tr.querySelectorAll('td')];
      const game = tds[2];
      const status = tds[5];
      const badges = [...status.querySelectorAll('.badge')];
      return {
        gameText: game.textContent,
        gameChildren: game.childElementCount,
        gameInnerHTML: game.innerHTML,
        statusText: status.textContent,
        statusChildren: status.childElementCount,
        badgeCount: badges.length,
        badgeClass: badges[0] ? badges[0].className : null,
        badgeInnerHTML: badges[0] ? badges[0].innerHTML : null,
      };
    }),
  );
}

function readListArea(page) {
  return page.evaluate(() => ({
    text: document.getElementById('list-area').textContent,
    hasTable: !!document.querySelector('#list-area table'),
    tableCount: document.querySelectorAll('#list-area table').length,
    rowCount: document.querySelectorAll('#list-area table tbody tr').length,
    skipText: document.querySelector('#list-area .skip-notice')
      ? document.querySelector('#list-area .skip-notice').textContent
      : null,
    skipCount: document.querySelectorAll('#list-area .skip-notice').length,
    errorText: document.querySelector('#list-area .list-error')
      ? document.querySelector('#list-area .list-error').textContent
      : null,
    emptyCount: document.querySelectorAll('#list-area .empty').length,
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

function nextCreated(page) {
  return new Promise((resolve, reject) => {
    page.on('response', (resp) => {
      if (resp.request().method() === 'POST' && resp.url().endsWith('/api/rooms')) {
        resp.json().then(resolve, reject);
      }
    });
  });
}

function trackRoomPosts(page) {
  const bodies = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/rooms')) {
      bodies.push(req.postData());
    }
  });
  return bodies;
}

async function fillLudoForm(page, rawName, capacity, turnSeconds) {
  await page.type('#name', rawName);
  await page.select('#game', 'ludo');
  await page.waitForFunction(
    () => !document.getElementById('capacity').disabled &&
      document.getElementById('capacity').value === '',
    { timeout: 5000 },
  );
  await page.select('#capacity', String(capacity));
  await page.type('#turnSeconds', String(turnSeconds));
}

// 首次打开首页：constructor/toString/__proto__ 与普通未知值在规则列、状态列
// 都按原文逐字显示，不变成函数内容、对象说明或“字段格式异常”，不导致加载
// 失败；两列各自独立，不串用对方的映射；正常房间中文映射、徽标、其余各列
// 与接口相对次序全部保持；没有跳过条数与空列表提示。
test('首次打开：规则列与状态列的原型链名字及未知值按原文显示，两列不串用映射', { timeout: 60000 }, async (t) => {
  const { page, dataDir } = await setupPage(t, INITIAL_RECORDS);

  await waitForRowCount(page, INITIAL_RECORDS.length);
  const list = await readListArea(page);

  // 全部是对象记录：未知字符串不是无法展示的记录。
  assert.equal(list.errorText, null, '未知值不能导致列表加载失败');
  assert.equal(list.hasTable, true, '存在未知值的房间仍应显示表格');
  assert.equal(list.rowCount, INITIAL_RECORDS.length, '未知值房间不能被跳过');
  assert.equal(list.skipCount, 0, '未知字符串不应计入跳过条数');
  assert.equal(list.skipText, null);
  assert.equal(list.emptyCount, 0, '未知字符串不应触发空列表提示');

  // 原型链被误用时会泄露的典型文字一律不能上屏。
  assert.ok(!list.text.includes('function'), '不能把原型链上的函数内容显示为规则或状态');
  assert.ok(!list.text.includes('[object'), '不能把对象说明显示为规则或状态');
  assert.ok(!list.text.includes('native code'), '不能泄露内置函数的字符串形式');
  assert.ok(!list.text.includes(BAD_FIELD_TEXT), '字符串未知值不是字段格式异常');
  assert.ok(!list.text.includes('undefined'), '页面任何位置都不应出现 undefined');

  const rows = await readRows(page);
  assert.deepEqual(
    rows.map((r) => r.cells.slice(0, 6)),
    INITIAL_FRONT_CELLS,
    '规则列与状态列的展示或房间相对次序不符合预期',
  );

  // 房间严格保持接口返回的相对次序。
  assert.deepEqual(
    rows.map((r) => r.cells[0]),
    INITIAL_RECORDS.map((rec) => JSON.parse(rec).id),
    '房间行次序应与接口返回的相对次序一致',
  );

  // 创建时间列照常展示：格式化时间与悬浮原文都不受未知规则/状态影响。
  for (const [i, rec] of INITIAL_RECORDS.entries()) {
    assert.match(rows[i].cells[6], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(rows[i].timeTitle, JSON.parse(rec).createdAt);
  }

  const detail = await readRuleStatusDetail(page);

  // 规则列：未知值是规则格里的纯文本，单元格内没有任何子元素。
  // 状态列：未知值仍放在原有单个徽标中，已知 waiting 显示“未开始”。
  const expectedGameTexts = INITIAL_FRONT_CELLS.map((c) => c[2]);
  const expectedStatusTexts = INITIAL_FRONT_CELLS.map((c) => c[5]);
  detail.forEach((d, i) => {
    assert.equal(d.gameText, expectedGameTexts[i], `第 ${i + 1} 行规则格文本不符`);
    assert.equal(d.gameChildren, 0, `第 ${i + 1} 行未知规则值应是纯文本，不生成子元素`);
    assert.equal(d.statusText, expectedStatusTexts[i], `第 ${i + 1} 行状态格文本不符`);
    assert.equal(d.statusChildren, 1, `第 ${i + 1} 行状态格应只含原有徽标`);
    assert.equal(d.badgeCount, 1, `第 ${i + 1} 行状态应仍在原有徽标中显示`);
    assert.equal(d.badgeClass, 'badge', `第 ${i + 1} 行徽标样式应保持不变`);
  });

  // 重点：撞名原型链的三个字符串逐字可读，而不是函数源码/对象说明。
  assert.equal(detail[1].gameText, 'constructor');
  assert.equal(detail[1].gameInnerHTML, 'constructor', 'constructor 只能作为普通文字写入规则格');
  assert.equal(detail[2].badgeInnerHTML, 'constructor', 'constructor 只能作为普通文字写入状态徽标');
  assert.equal(detail[4].gameText, 'toString');
  assert.equal(detail[4].badgeInnerHTML, 'toString');
  assert.equal(detail[5].gameText, '__proto__');
  assert.equal(detail[5].badgeInnerHTML, '__proto__');

  // 重点：两列交叉值——规则 "waiting" 不得映射成“未开始”，
  // 状态 "gomoku" 不得映射成“五子棋”，两列分别按自己的值显示。
  assert.equal(detail[3].gameText, 'waiting', '规则列的 "waiting" 是未知规则，应按原文显示');
  assert.notEqual(detail[3].gameText, '未开始', '规则列不能串用状态列的中文映射');
  assert.equal(detail[3].badgeInnerHTML, 'gomoku', '状态列的 "gomoku" 是未知状态，应按原文显示');
  assert.notEqual(detail[3].statusText, '五子棋', '状态列不能串用规则列的中文映射');

  // 前后正常房间的中文映射保持正确，未知状态仍在徽标里。
  assert.equal(detail[0].gameText, '五子棋');
  assert.equal(detail[0].badgeInnerHTML, '未开始');
  assert.equal(detail[9].gameText, '飞行棋');
  assert.equal(detail[9].badgeInnerHTML, 'playing', '非 waiting 的已知房间状态本就按原文显示');

  // 仅仅查看列表不改写本地原始字段与附带内容。
  assert.equal(
    await readFile(path.join(dataDir, 'rooms.json'), 'utf8'),
    '[\n' + INITIAL_RECORDS.join(',\n') + '\n]\n',
    '首次查看不应改写本地保存的原始记录',
  );
});

// 未知值里的尖括号标签与类似 &lt; 的文字，遵守页面已有的纯文本行为：
// 显示原有写法，不生成网页元素，不再次解释成别的字符，也不执行其中内容。
test('未知规则值与状态值中的标签样式、实体样式文字按原文纯文本显示', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t, TAGGED_RECORDS);

  const dialogs = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    dialog.dismiss().catch(() => {});
  });

  await waitForRowCount(page, TAGGED_RECORDS.length);
  const list = await readListArea(page);
  assert.equal(list.errorText, null);
  assert.equal(list.skipCount, 0);

  const rows = await readRows(page);
  assert.equal(rows[0].cells[2], '<script>alert(1)</script>', '标签样式规则值应逐字显示');
  assert.equal(rows[0].badge, '<img src=x onerror="window.__ruleStatusPwned=1">', '标签样式状态值应逐字显示');
  assert.equal(rows[1].cells[2], '&lt;规则&gt;', '实体样式规则值应按原有写法显示');
  assert.equal(rows[1].badge, '&amp;状态乙', '实体样式状态值应按原有写法显示');

  // 任何标签样式文字都没有变成真正的网页元素。
  assert.equal(list.tableCount, 1, '房间表格之外不应因未知值多出任何表格元素');
  for (const sel of ['script', 'img', 'b', 'i']) {
    const n = await page.evaluate((s) => document.querySelectorAll('#list-area ' + s).length, sel);
    assert.equal(n, 0, `未知值中的标签样式文字不应生成 ${sel} 元素`);
  }

  const detail = await readRuleStatusDetail(page);
  // 规则格无子元素；尖括号在 innerHTML 中是转义写法，证明浏览器只当文字。
  assert.equal(detail[0].gameChildren, 0);
  assert.ok(detail[0].gameInnerHTML.includes('&lt;script&gt;'), '尖括号应以转义形式存在于规则格');
  assert.equal(detail[0].statusChildren, 1);
  assert.ok(detail[0].badgeInnerHTML.includes('&lt;img'), '尖括号应以转义形式存在于状态徽标');
  // &lt; 是值本身的文字：页面再转义一层（&amp;lt;）才能逐字显示原有写法，
  // 不能解释成 <规则>，&amp; 同理不能解释成 &。
  assert.equal(detail[1].gameText, '&lt;规则&gt;');
  assert.ok(!detail[1].gameText.includes('<规则'), '实体样式文字不能被再次解释');
  assert.equal(detail[1].gameInnerHTML, '&amp;lt;规则&amp;gt;');
  assert.equal(detail[1].badgeInnerHTML, '&amp;amp;状态乙');
  assert.equal(detail[1].badgeCount, 1, '实体样式未知状态仍在原有徽标中');

  // 给潜在的脚本/事件内容留出执行窗口：无弹窗、无标记写入、无跳转。
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(dialogs, [], '未知值中的脚本样式内容不应引发弹窗');
  assert.equal(
    await page.evaluate(() => window.__ruleStatusPwned),
    undefined,
    '未知值中的事件样式内容不应被执行',
  );
  assert.equal(page.url(), baseURL + '/', '未知值中的内容不应引发页面跳转');

  // 后续正常房间照常显示中文映射。
  assert.equal(detail[2].gameText, '五子棋');
  assert.equal(detail[2].badgeInnerHTML, '未开始');

  // 接口原始字段仍是写入时的字符串原文。
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms[0].game, '<script>alert(1)</script>');
  assert.equal(serverRooms[0].status, '<img src=x onerror="window.__ruleStatusPwned=1">');
  assert.equal(serverRooms[1].game, '&lt;规则&gt;');
  assert.equal(serverRooms[1].status, '&amp;状态乙');
  assert.equal(serverRooms[1].note, '实体原样保留', '附带内容应继续保留');
});

// 规则或状态字段缺失、为 null 或空字符串时，两个单元格沿用留空行为，
// 绝不由页面生成 undefined/null 字样；这些记录仍成行、不跳过、不拖垮列表。
test('规则/状态缺失、为 null 或空串：两格留空且无 undefined/null，记录仍成行', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t, EMPTYISH_RECORDS);

  await waitForRowCount(page, EMPTYISH_RECORDS.length);
  const list = await readListArea(page);
  assert.equal(list.errorText, null);
  assert.equal(list.rowCount, EMPTYISH_RECORDS.length, '缺字段记录不能被跳过');
  assert.equal(list.skipCount, 0);
  assert.equal(list.emptyCount, 0);

  const rows = await readRows(page);
  const emptyishFront = [
    ['miss-game-null-status', '规则缺失状态为null', '', '2 人', '不限时', ''],
    ['null-game-empty-status', '规则为null状态为空串', '', '2 人', '10 秒', ''],
    ['empty-game-miss-status', '规则为空串状态缺失', '', '4 人', '30 秒', ''],
    ['miss-both', '两列都缺失', '', '3 人', '60 秒', ''],
  ];
  assert.deepEqual(rows.slice(0, 4).map((r) => r.cells.slice(0, 6)), emptyishFront);

  // 名称列用名字描述场景（其中含 “null” 字样），所以 undefined/null 的检查
  // 只针对其他各格：任何单元格都不能冒出 undefined，规则格与状态格也不能
  // 把 null 当成文字显示。
  for (const [i, r] of rows.entries()) {
    assert.ok(
      !r.cells.some((c) => c.includes('undefined')),
      `第 ${i + 1} 行不应出现 undefined 字样`,
    );
    assert.notEqual(r.cells[2], 'null', `第 ${i + 1} 行规则格不能显示 null`);
    assert.notEqual(r.cells[5], 'null', `第 ${i + 1} 行状态格不能显示 null`);
  }

  // 状态格留空但仍是原有徽标（空徽标），不另生文字；规则格是纯空文本。
  const detail = await readRuleStatusDetail(page);
  for (let i = 0; i < 4; i++) {
    assert.equal(detail[i].gameText, '', `第 ${i + 1} 行规则格应留空`);
    assert.equal(detail[i].gameChildren, 0);
    assert.equal(detail[i].statusText, '', `第 ${i + 1} 行状态格应留空`);
    assert.equal(detail[i].badgeCount, 1, '留空状态仍沿用原有徽标容器');
    assert.equal(detail[i].badgeInnerHTML, '');
  }

  // 末尾正常房间不受影响。
  assert.deepEqual(rows[4].cells.slice(0, 6), [
    'normal-tail', '留空组合后的正常房', '飞行棋', '3 人', '不限时', '未开始',
  ]);
  assert.equal(rows[4].badge, '未开始');
});

// 同一页面成功创建合法房间后重新展示列表：旧房间的未知值原文与相对次序
// 保持不变，新房间追加在最后并显示所选中文规则与“未开始”；成功提示及编号
// 仍可见；接口与本地保存中旧记录的原始字段、附带内容不被改写。
test('创建合法房间后：旧未知值原文与次序不变，新房间追加显示中文映射与未开始', { timeout: 60000 }, async (t) => {
  // 取首批记录中最有代表性的 6 条：正常房、规则/状态各自撞名、交叉值、
  // 标签/实体样式、两列未知且不同（含附带字段）。
  const seed = [A0, A1, A2, A3, A5, TAGGED_RECORDS[1], A6];
  const { page, baseURL, dataDir, seedText } = await setupPage(t, seed);

  await waitForRowCount(page, seed.length);
  const rowsBefore = await readRows(page);
  const detailBefore = await readRuleStatusDetail(page);

  // 创建前的只读查看已确认不改写文件。
  assert.equal(await readFile(path.join(dataDir, 'rooms.json'), 'utf8'), seedText);

  const postBodies = trackRoomPosts(page);
  const createdPromise = nextCreated(page);
  await fillLudoForm(page, '  新飞行棋房间  ', 3, 45);
  await page.click('#submit');

  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  // 创建请求仍只提交既有四个配置字段，未知值兼容不影响创建侧约定。
  assert.equal(postBodies.length, 1);
  assert.deepEqual(Object.keys(JSON.parse(postBodies[0])).sort(), [
    'capacity', 'game', 'name', 'turnSeconds',
  ]);
  assert.deepEqual(JSON.parse(postBodies[0]), {
    name: '  新飞行棋房间  ', game: 'ludo', capacity: 3, turnSeconds: 45,
  });

  // 成功提示及编号仍可见，且编号与创建结果一致。
  const msg = await readMessage(page);
  assert.ok(msg.className.includes('ok'), `应显示成功提示，实际 class: ${msg.className}`);
  assert.ok(created.id, '创建结果应带非空编号');
  assert.equal(msg.text, SUCCESS_PREFIX + created.id, '成功提示应保留编号');
  assert.equal(created.game, 'ludo');
  assert.equal(created.capacity, 3);
  assert.equal(created.turnSeconds, 45);
  assert.equal(created.status, 'waiting');
  assert.equal(created.visibility, 'public');

  // 列表重新展示：旧房间内容与次序逐行不变，新房间追加为最后一行。
  await waitForRowCount(page, seed.length + 1);
  const list = await readListArea(page);
  assert.equal(list.errorText, null);
  assert.equal(list.skipCount, 0);

  const rowsAfter = await readRows(page);
  assert.deepEqual(rowsAfter.slice(0, seed.length), rowsBefore, '创建后旧房间的展示内容或次序被改变');
  const detailAfter = await readRuleStatusDetail(page);
  assert.deepEqual(detailAfter.slice(0, seed.length), detailBefore, '创建后旧房间的未知值展示被改变');

  // 不依赖创建前快照，独立核对旧未知值创建后仍逐字在原位。
  assert.equal(detailAfter[1].gameText, 'constructor', '创建后旧的未知规则值仍按原文显示');
  assert.equal(detailAfter[2].statusText, 'constructor', '创建后旧的未知状态值仍按原文显示');
  assert.equal(detailAfter[3].gameText, 'waiting', '创建后两列仍不能串用映射');
  assert.equal(detailAfter[3].statusText, 'gomoku');
  assert.equal(detailAfter[4].gameText, '__proto__');
  assert.equal(detailAfter[4].statusText, '__proto__');
  assert.equal(detailAfter[5].gameText, '&lt;规则&gt;');
  assert.equal(detailAfter[5].statusText, '&amp;状态乙');
  assert.equal(detailAfter[6].gameText, '自定义规则甲');
  assert.equal(detailAfter[6].statusText, '自定义状态乙');

  const added = rowsAfter[seed.length];
  assert.equal(added.cells[0], created.id, '新行编号应与创建结果一致');
  assert.equal(added.cells[1], '新飞行棋房间', '名称应按现有规则仅去首尾空白');
  assert.equal(added.cells[2], '飞行棋', '新房间应显示所选中文规则');
  assert.equal(added.cells[3], '3 人');
  assert.equal(added.cells[4], '45 秒');
  assert.equal(added.cells[5], '未开始', '新房间状态应显示“未开始”');
  assert.equal(added.badge, '未开始', '新房间状态仍在原有徽标中');
  assert.equal(added.timeTitle, created.createdAt, '新房间创建时间悬浮原文来自本次创建结果');
  assert.equal(detailAfter[seed.length].badgeCount, 1);

  // 接口：旧记录（原始字段与附带内容）逐条原样保留，新对象只追加在最后。
  const expectedOld = seed.map((rec) => JSON.parse(rec));
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, seed.length + 1, '服务端应只追加一条新记录');
  assert.deepEqual(serverRooms.slice(0, seed.length), expectedOld, '接口中的旧记录被改写');
  assert.equal(serverRooms[1].note, '保留备注一', '旧记录附带内容应继续保留');
  assert.equal(serverRooms[5].game, '&lt;规则&gt;', '实体样式未知规则原文应继续保留');
  assert.equal(serverRooms[5].status, '&amp;状态乙');
  assert.equal(serverRooms[5].note, '实体原样保留');
  assert.deepEqual(serverRooms[6].tags, ['历史', '附带'], '旧记录附带数组应继续保留');
  assert.equal(serverRooms[seed.length].id, created.id, '新房间应位于列表最后');
  assert.equal(serverRooms[seed.length].status, 'waiting');

  // 本地保存：旧记录的未知值原文仍逐字在文件里，新记录追加其后。
  const savedRooms = JSON.parse(await readFile(path.join(dataDir, 'rooms.json'), 'utf8'));
  assert.equal(savedRooms.length, seed.length + 1, '本地文件应只追加一条新记录');
  assert.deepEqual(savedRooms.slice(0, seed.length), expectedOld, '本地保存的旧记录被改写');
  assert.equal(savedRooms[seed.length].id, created.id);
  // Go 落盘会把 & < > 转义成 &/</>，因此按解析后的值核对
  // 未知值原文：原型链名字、交叉值与实体样式文字都仍在旧记录里。
  assert.equal(savedRooms[1].game, 'constructor');
  assert.equal(savedRooms[2].status, 'constructor');
  assert.equal(savedRooms[3].game, 'waiting');
  assert.equal(savedRooms[3].status, 'gomoku');
  assert.equal(savedRooms[4].game, '__proto__');
  assert.equal(savedRooms[4].status, '__proto__');
  assert.equal(savedRooms[5].game, '&lt;规则&gt;');
  assert.equal(savedRooms[5].status, '&amp;状态乙');
  assert.equal(savedRooms[6].game, '自定义规则甲');
  assert.equal(savedRooms[6].status, '自定义状态乙');
});

// 未知值的原文展示只用于兼容历史记录：创建房间仍遵守已有规则与配置限制。
// 接口直接提交未知规则（含三个原型链名字）或非法人数一律 400 且不写入；
// 页面上选不到未知规则，非法时间在页面侧拦截、不发请求，旧记录保持不变。
test('创建仍受既有规则与配置限制：接口拒绝未知规则/非法配置，页面拦截非法输入', { timeout: 60000 }, async (t) => {
  const seed = [A1, A3, A6];
  const { page, baseURL } = await setupPage(t, seed);
  await waitForRowCount(page, seed.length);
  const rowsBefore = await readRows(page);

  const postError = async (payload) => {
    const res = await fetch(baseURL + '/api/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 400, `${JSON.stringify(payload.game)} 应被拒绝`);
    return (await res.json()).error;
  };

  // 原型链名字与其他未知字符串一样，只是历史值，不能作为新建规则。
  for (const badGame of ['constructor', 'toString', '__proto__', 'obscure-rule']) {
    const err = await postError({ name: '接口尝试未知规则', game: badGame, capacity: 2, turnSeconds: 0 });
    assert.ok(err.includes('未知游戏规则'), `未知规则 ${badGame} 的错误原因不明确：${err}`);
  }
  // 已有的规则/人数配置限制继续有效。
  const capErr = await postError({ name: '接口尝试非法人数', game: 'gomoku', capacity: 3, turnSeconds: 0 });
  assert.ok(capErr.includes('五子棋的人数上限固定为 2 人'), `非法人数错误原因不明确：${capErr}`);

  // 被拒请求不占任何记录，接口中的旧未知值原样保留。
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, seed.length, '被拒创建不应写入记录');
  assert.deepEqual(serverRooms, seed.map((rec) => JSON.parse(rec)), '被拒创建不应改写旧记录');

  // 页面侧：规则下拉只有空值与两个已知规则，历史未知值不是可选项。
  const gameOptions = await page.$$eval('#game option', (opts) => opts.map((o) => o.value));
  assert.deepEqual(gameOptions, ['', 'gomoku', 'ludo']);

  // 非法时间（小数）在页面拦截：不发请求、不增房间、列表不变，按钮恢复可用。
  const postBodies = trackRoomPosts(page);
  await fillLudoForm(page, '应被拦截的房间', 4, '12.5');
  await page.click('#submit');
  await waitForMessageKind(page, 'error');
  const msg = await readMessage(page);
  assert.equal(msg.text, '时间限制必须是整数秒，不能含小数。');
  assert.equal(postBodies.length, 0, '非法配置不应发出创建请求');

  await new Promise((resolve) => setTimeout(resolve, 300));
  const list = await readListArea(page);
  assert.equal(list.rowCount, seed.length, '被拦截的提交不应增加房间行');
  assert.deepEqual(await readRows(page), rowsBefore, '被拦截的提交不应改变列表内容');
  assert.equal(
    await page.evaluate(() => document.getElementById('submit').disabled),
    false,
    '拦截后创建按钮应恢复可用',
  );
});
