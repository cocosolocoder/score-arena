// 首页“房间名称按纯文本展示”的界面回归测试。
//
// 用户可以给房间取包含尖括号、引号、与号的名称，也可能输入看起来像网页标签、
// 链接或带事件属性的文字。只要名称符合现有长度（去首尾空白后 1–40 个 Unicode
// 码点）与非空要求，这些内容就是名称的一部分。本文件用真实浏览器（系统 Chrome）
// 加载真实服务的首页，覆盖从填写名称并创建公开房间、到创建成功后列表更新的
// 实际使用过程，保障名称的文字含义在保存与页面展示之间保持一致：
//   - 创建响应与房间列表接口里的名称就是按现有规则整理（只去首尾空白）后的原文，
//     不把用于页面显示的转义写法（如 &lt;、&amp;、&#x3c;）保存成新的名称；
//   - 页面上的名称逐字可读：标签样式文字里的括号、引号都在，不变成加粗文字、
//     可点击链接、图片或额外按钮，不改变其他列或相邻房间的内容；
//   - 名称里类似网页字符实体的文字按原有写法显示，不被再次解释成另一种字符；
//   - 看似带事件处理内容的名称在列表出现后不引发弹窗、页面跳转或额外操作；
//   - 不为安全显示而删除标点、截断名称或增加“禁止标签样式名称”的校验；
//   - 已有房间记录中的字符串名称首次打开首页按原文展示，随后新建房间导致列表
//     更新时仍保持原文，已有行相对次序与其他配置不变；查看这样的名称不改写
//     已有记录，新房间仍只追加一条正常房间记录。
//
// 与另外五个浏览器回归文件的分工：ui.test.mjs 覆盖创建主流程、名称整理与长度
// 边界；本文件不重复长度边界，只盯住“标签/实体/事件样式的名称在保存接口、
// 创建响应与页面纯文本展示之间逐字一致且不被当成网页执行”。
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

// 两条普通种子房间：用于确认标签样式名称成行后不改变其他列、不影响相邻房间。
const SEED_ALPHA =
  '{"id":"plain-alpha","name":"晨间飞行棋","game":"ludo","capacity":4,"turnSeconds":30,' +
  '"status":"playing","visibility":"public","createdAt":"2026-01-01T08:00:00Z","note":"保留我"}';
const SEED_BETA =
  '{"id":"plain-beta","name":"午夜五子棋","game":"gomoku","capacity":2,"turnSeconds":0,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-01-02T23:00:00Z"}';

const SUCCESS_PREFIX = '房间已创建，编号：';

// 名称样例：覆盖尖括号、单双引号、与号、看似标签/链接/图片/加粗/按钮的文字、
// 看似字符实体的文字，以及看似带事件处理属性的文字。每个名称整理后都不超过
// 40 个 Unicode 码点，标点一个都不能为“安全显示”而被删除或转存。
const TAG_BOLD = '<b>友谊赛</b>';
const TAG_LINK = '点<a href="x">链接</a>';
const TAG_IMG = '<img src=x alt="海报">';
const TAG_BUTTON = '<button type="submit">点我</button>';
const QUOTES = '他说"周五开赛"还说\'别迟到\'';
const AMP_ENTITY = 'A & B &lt; C &amp; D &#60; &#x3c; E';
const SCRIPT_LIKE = '<script>alert(1)</script> 只是房间名';
const ON_ERROR_IMG = '<img src=x onerror=alert(1)>';
const ON_LOAD = '<svg onload="alert(\'xss\')">棋室';
const MIXED_PUNCT = '五子棋（&友谊"赛"）<a> &amp; 保留全部';
// 名称含补充平面表情与内部空格：证明标点与表情、内部空格同时原样保留。
const TAG_WITH_EMOJI = ' <b>麻将🀄房</b> 周末 ';
const TAG_WITH_EMOJI_TRIMMED = '<b>麻将🀄房</b> 周末';

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
  await writeFile(path.join(dataDir, 'rooms.json'), '[\n' + records.join(',\n') + '\n]\n');
}

// 每个用例使用独立的数据目录、服务进程与页面，互不影响。默认带两条普通种子房间。
async function setupPage(t, records = [SEED_ALPHA, SEED_BETA]) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'score-arena-uidata-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await seedRecords(dataDir, records);
  const baseURL = await startServer(t, dataDir);
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(baseURL, { waitUntil: 'load' });
  await waitForRowCount(page, records.length);
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

// fillGomoku 填写并提交五子棋公开房间（人数固定 2 人由页面自动选中），0 秒不限时。
// 用原生 setter 赋值，避免逐个按键输入特殊字符，也不改变任何校验路径。
async function fillGomoku(page, rawName, turnSeconds = 0) {
  await page.$eval('#name', (el, value) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, rawName);
  await page.select('#game', 'gomoku');
  await page.waitForFunction(
    () => !document.getElementById('capacity').disabled &&
      document.getElementById('capacity').value === '2',
    { timeout: 5000 },
  );
  await page.type('#turnSeconds', String(turnSeconds));
  await page.click('#submit');
}

// nameCellByText 返回名称文本恰为 name 的名称单元格（按编号行定位时改用 rowNameCell）。
function nameCellHandle(page, name) {
  return page.evaluateHandle((want) => {
    const tds = [...document.querySelectorAll('#list-area table tbody td:nth-child(2)')];
    return tds.find((td) => td.textContent === want) || null;
  }, name);
}

// assertNameIsPlainText 在浏览器内核对名称单元格：文本逐字一致、没有任何子元素
// （标签样式文字没有被解析成元素）、innerHTML 是浏览器对纯文本的安全转义写法，
// 且名称没有被以转义写法本身当文本显示（不出现二次转义）。
async function assertNameIsPlainText(page, name) {
  const handle = await nameCellHandle(page, name);
  const info = await handle.evaluate((td, want) => td ? {
    text: td.textContent,
    childElementCount: td.childElementCount,
    innerHTML: td.innerHTML,
    // 把单元格当成 HTML 重新解析一次：纯文本名称即使二次解析也不应产生任何元素。
    reparsedTagCount: new DOMParser().parseFromString('<td>' + td.innerHTML + '</td>', 'text/html')
      .querySelectorAll('td *').length,
    textIsWant: td.textContent === want,
  } : null, name);
  assert.ok(info, `列表中应存在名称逐字等于 ${JSON.stringify(name)} 的单元格`);
  assert.equal(info.text, name, '名称必须逐字显示为整理后的原文');
  assert.equal(info.childElementCount, 0,
    `名称不得被解析成网页元素，实际子元素数：${info.childElementCount}（${name}）`);
  assert.equal(info.reparsedTagCount, 0,
    `名称的 HTML 写法再次解析也不应出现元素（${name}）`);
  // 纯文本经 textContent 赋值后，浏览器转义后的 innerHTML 反向解回必须仍是原文：
  // 若页面曾把显示用转义写法（&lt; 等）当名称保存，这里解回的就会是转义写法本身，
  // 与原文不符；若名称本身含实体样式文字，解回仍是那段原有写法。
  const decoded = await page.evaluate((html) => {
    const d = document.createElement('div');
    d.innerHTML = html;
    return d.textContent;
  }, info.innerHTML);
  assert.equal(decoded, name, '名称的展示转义必须能还原为同一原文，且未把转义写法当名称保存');
  await handle.dispose();
}

// assertNoMarkupForName 断言整个名称单元格内不存在任何标签样式对应的元素，
// 名称里“看似标签”的部分没有以加粗、链接、图片、按钮等形式出现。
async function assertNoMarkupForName(page, name) {
  const handle = await nameCellHandle(page, name);
  const found = await handle.evaluate((td) => ({
    b: td.querySelectorAll('b,strong').length,
    a: td.querySelectorAll('a').length,
    img: td.querySelectorAll('img').length,
    button: td.querySelectorAll('button').length,
    script: td.querySelectorAll('script').length,
    svg: td.querySelectorAll('svg').length,
    any: td.querySelectorAll('*').length,
  }));
  assert.deepEqual(found, { b: 0, a: 0, img: 0, button: 0, script: 0, svg: 0, any: 0 },
    `名称中的标签样式文字不得变成网页元素（${name}）`);
  await handle.dispose();
}

// 弹窗（alert/confirm/prompt）出现即标记：名称里的事件样式内容绝不能执行。
function watchDialogs(page) {
  const seen = [];
  page.on('dialog', async (dialog) => {
    seen.push({ type: dialog.type(), message: dialog.message() });
    await dialog.dismiss();
  });
  return seen;
}

// 创建一个标签样式名称并核对：页面提示编号、创建响应/列表接口/本地保存三处名称
// 都是整理后的原文、列表按纯文本逐字展示、其他列与相邻房间不变。
async function assertCreatePlainTextName(t, page, baseURL, dataDir, rawName, trimmedName, dialogs) {
  const beforeRows = await page.$$eval('#list-area table tbody tr', (trs) =>
    trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent)));

  const createdPromise = nextCreated(page);
  await fillGomoku(page, rawName);

  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  // 成功提示仍显示本次房间编号，不显示错误/安全拦截文案。
  const msg = await readMessage(page);
  assert.ok(msg.className.includes('ok'), `标签样式名称应创建成功，实际提示：${msg.text}`);
  assert.ok(msg.text.startsWith(SUCCESS_PREFIX), `成功提示应包含编号，实际：${msg.text}`);
  assert.equal(msg.text.slice(SUCCESS_PREFIX.length), created.id, '提示编号应与创建结果一致');

  // 创建响应里的名称就是整理后的原文：不是 &lt; 这类页面显示转义写法，
  // 也没有删除标点；若原文本身含有实体样式文字（如 &lt;），则按原文保留。
  assert.equal(created.name, trimmedName, '创建响应必须保存整理后的原文名称，而非转义写法');
  assert.ok(!created.name.includes('&lt;') || trimmedName.includes('&lt;'),
    '尖括号不能被转义成 &lt; 保存');
  assert.ok(!created.name.includes('&gt;') || trimmedName.includes('&gt;'),
    '尖括号不能被转义成 &gt; 保存');
  assert.ok(!created.name.includes('&amp;') || trimmedName.includes('&amp;'),
    '与号不能被转义成 &amp; 保存');

  await waitForRowCount(page, beforeRows.length + 1);

  // 列表接口中的名称与创建响应、整理后原文一致。
  const serverRooms = await readServerRooms(baseURL);
  const saved = serverRooms.find((r) => r && r.id === created.id);
  assert.ok(saved, '服务端列表应能按本次编号找到新房间');
  assert.equal(saved.name, trimmedName, '房间列表接口中的名称应与整理后原文一致');
  assert.equal(saved.name, created.name, '列表接口名称应与创建响应一致');
  assert.equal(saved.status, 'waiting');
  assert.equal(saved.visibility, 'public');
  assert.equal(saved.game, 'gomoku');
  assert.equal(saved.capacity, 2);
  assert.equal(saved.turnSeconds, 0);

  // 本地 rooms.json 中保存的也是原文（JSON 标准转义除外），不是 HTML 转义写法。
  const onDisk = JSON.parse(await readFile(path.join(dataDir, 'rooms.json'), 'utf8'));
  const diskRecord = onDisk.find((r) => r && r.id === created.id);
  assert.ok(diskRecord, '本地文件应保存本次房间');
  assert.equal(diskRecord.name, trimmedName, '本地保存的名称必须是整理后原文');
  const rawDisk = await readFile(path.join(dataDir, 'rooms.json'), 'utf8');
  assert.ok(!rawDisk.includes('&lt;') && !rawDisk.includes('&gt;') && !rawDisk.includes('&amp;'),
    '本地文件不得出现 HTML 转义写法的名称');

  // 页面逐字读到名称，且名称没有变成网页元素。
  await assertNameIsPlainText(page, trimmedName);
  await assertNoMarkupForName(page, trimmedName);

  // 新行其他列沿用现有展示，编号对应本次房间，且不改变相邻房间与其他列。
  const rows = await page.$$eval('#list-area table tbody tr', (trs) =>
    trs.map((tr) => {
      const tds = [...tr.querySelectorAll('td')];
      return {
        id: tds[0].textContent,
        name: tds[1].textContent,
        cells: tds.map((td) => td.textContent),
        nameHtml: tds[1].innerHTML,
      };
    }));
  assert.equal(rows.length, beforeRows.length + 1);
  assert.deepEqual(rows.slice(0, beforeRows.length).map((r) => r.cells), beforeRows,
    '已有行的内容与次序不得因标签样式名称改变');
  const newRow = rows[rows.length - 1];
  assert.equal(newRow.id, created.id, '列表中对应编号的名称应与保存内容一致');
  assert.equal(newRow.name, trimmedName);
  assert.deepEqual(newRow.cells.slice(2, 6), ['五子棋', '2 人', '不限时', '未开始'],
    '新房间其他列应沿用现有展示');

  // 给事件样式内容一点触发时间，再确认全程没有弹窗。
  await new Promise((resolve) => setTimeout(resolve, 200));
  if (dialogs && dialogs.length) {
    assert.fail(`名称中看似可执行的内容引发了弹窗：${JSON.stringify(dialogs)}`);
  }

  return { created, saved };
}

// 各标签/实体/事件样式名称逐一走完整创建-展示流程。
const SPECIAL_NAMES = [
  ['加粗标签', TAG_BOLD],
  ['链接标签', TAG_LINK],
  ['图片标签', TAG_IMG],
  ['按钮标签', TAG_BUTTON],
  ['引号名称', QUOTES],
  ['字符实体样式', AMP_ENTITY],
  ['脚本样式名称', SCRIPT_LIKE],
  ['图片事件样式', ON_ERROR_IMG],
  ['SVG 事件样式', ON_LOAD],
  ['标点与标签混合', MIXED_PUNCT],
];

for (const [label, name] of SPECIAL_NAMES) {
  test(`标签样式名称按纯文本创建并展示：${label}`, { timeout: 60000 }, async (t) => {
    assert.ok([...name].length >= 1 && [...name].length <= 40,
      `样例名称整理后应在 1–40 码点内：${[...name].length}`);
    const { page, baseURL, dataDir } = await setupPage(t);
    const dialogs = watchDialogs(page);
    await assertCreatePlainTextName(t, page, baseURL, dataDir, name, name, dialogs);
  });
}

// 首尾空白仍按现有规则只去首尾空白：标签样式、表情与内部空格原样保留。
test('标签样式名称的首尾空白只去两端，标签文字、内部空格与表情原样展示', { timeout: 60000 }, async (t) => {
  const { page, baseURL, dataDir } = await setupPage(t);
  const dialogs = watchDialogs(page);
  assert.equal([...TAG_WITH_EMOJI_TRIMMED].length, 14);
  await assertCreatePlainTextName(t, page, baseURL, dataDir, TAG_WITH_EMOJI, TAG_WITH_EMOJI_TRIMMED, dialogs);
});

// 恰好 40 码点的标签样式名称：不得因为“看起来像标签”而增加禁止校验或截断。
test('恰好 40 码点的标签样式名称照常创建并逐字展示，不截断、不禁止', { timeout: 60000 }, async (t) => {
  const name40 = '<b>' + '棋'.repeat(33) + '</b>'; // 3 + 33 + 4 = 40
  assert.equal([...name40].length, 40);
  const { page, baseURL, dataDir } = await setupPage(t);
  const dialogs = watchDialogs(page);
  await assertCreatePlainTextName(t, page, baseURL, dataDir, name40, name40, dialogs);
});

// 名称里的字符实体样式文字必须显示原有写法，不能被解释成另一种字符：
// 页面上应读到字面的 &lt; / &amp; / &#60; / &#x3c;，而不是 < 或 &。
test('字符实体样式文字按原有写法显示，不被再次解释成另一种字符', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t);
  const dialogs = watchDialogs(page);
  await fillGomoku(page, AMP_ENTITY);
  await waitForMessageKind(page, 'ok');
  await waitForRowCount(page, 3);

  const handle = await nameCellHandle(page, AMP_ENTITY);
  const literal = await handle.evaluate((td) => ({
    text: td.textContent,
    html: td.innerHTML,
  }));
  await handle.dispose();

  assert.equal(literal.text, AMP_ENTITY, '页面必须逐字读到实体样式文字的原有写法');
  assert.ok(literal.text.includes('&lt;'), '应显示字面的 &lt;，而不是解释成 <');
  assert.ok(literal.text.includes('&amp;'), '应显示字面的 &amp;，而不是解释成 &');
  assert.ok(literal.text.includes('&#60;'), '应显示字面的 &#60;');
  assert.ok(literal.text.includes('&#x3c;'), '应显示字面的 &#x3c;');
  // innerHTML 中应为二次转义（&amp;lt; 等），证明 textContent 原样承载、未被当实体解析。
  assert.ok(literal.html.includes('&amp;lt;'), '实体样式文字应作为纯文本转义展示，未被解析');
  assert.ok(literal.html.includes('&amp;#60;') && literal.html.includes('&amp;#x3c;'));
  assert.equal(literal.text.split('<').length - 1, 0, '实体样式名称里不应真的出现尖括号元素');

  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(dialogs.length, 0, '实体样式名称不得触发弹窗');
});

// 列表区域整体不因标签样式名称出现任何活动元素：没有可点击链接、图片、按钮，
// 也没有名称诱导出的额外控件；事件样式名称不弹窗、不跳转。
test('多个标签/事件样式房间同列展示：无链接/图片/按钮/脚本元素，无弹窗无跳转', { timeout: 60000 }, async (t) => {
  const { page, baseURL, dataDir } = await setupPage(t);
  const dialogs = watchDialogs(page);
  const names = [TAG_LINK, TAG_IMG, TAG_BUTTON, SCRIPT_LIKE, ON_ERROR_IMG, ON_LOAD, MIXED_PUNCT];

  let createdCount = 0;
  for (const name of names) {
    const createdPromise = nextCreated(page);
    await fillGomoku(page, name);
    // 以本次新增行落定作为同步点（成功提示会一直保留，无法区分第几次创建）。
    await waitForRowCount(page, 2 + ++createdCount);
    await createdPromise;
  }

  const counts = await page.$$eval('#list-area', (areas) => {
    const area = areas[0];
    return {
      a: area.querySelectorAll('a').length,
      img: area.querySelectorAll('img').length,
      button: area.querySelectorAll('button').length,
      script: area.querySelectorAll('script').length,
      svg: area.querySelectorAll('svg').length,
      b: area.querySelectorAll('b,strong').length,
      rows: area.querySelectorAll('table tbody tr').length,
    };
  });
  assert.deepEqual(counts, { a: 0, img: 0, button: 0, script: 0, svg: 0, b: 0, rows: 2 + names.length },
    '列表区域不得因名称出现链接、图片、按钮、脚本或加粗元素');

  // 每个名称都逐字在对应行的名称列中。
  const shownNames = await page.$$eval('#list-area table tbody td:nth-child(2)', (tds) =>
    tds.map((td) => td.textContent));
  for (const name of names) {
    assert.ok(shownNames.includes(name), `名称应逐字出现在名称列：${name}`);
  }
  assert.deepEqual(shownNames.slice(0, 2), ['晨间飞行棋', '午夜五子棋'], '相邻房间名称不被改变');

  // 接口与本地保存：只有两条种子加本次新建，新房间逐条追加，名称都是原文。
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, 2 + names.length);
  assert.deepEqual(serverRooms.slice(0, 2).map((r) => r.id), ['plain-alpha', 'plain-beta']);
  assert.deepEqual(serverRooms.slice(2).map((r) => r.name), names, '接口名称应与原文逐一一致');
  const onDisk = JSON.parse(await readFile(path.join(dataDir, 'rooms.json'), 'utf8'));
  assert.equal(onDisk.length, 2 + names.length);
  assert.deepEqual(onDisk.slice(2).map((r) => r.name), names, '本地保存名称应与原文逐一一致');

  // 再停留片刻，等待图片加载/事件冒泡，确认无弹窗、无跳转。
  const urlBefore = page.url();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(dialogs.length, 0, `事件样式名称不得引发弹窗：${JSON.stringify(dialogs)}`);
  assert.equal(page.url(), urlBefore, '事件样式名称不得引发页面跳转');
});

// 已有房间记录中的字符串名称同样按纯文本展示：首次打开首页即按原文呈现；
// 随后新建房间导致列表更新时仍保持原文，已有行相对次序与其他配置不变；
// 查看这样的名称不改写已有记录，新房间只追加一条正常房间记录。
test('已有记录中的标签样式字符串名称：首次打开与新建刷新后均按原文展示，记录不被改写', { timeout: 60000 }, async (t) => {
  // 三条历史记录，名称分别是标签/事件/实体样式；附带各自正常的其他配置。
  const OLD_TAG =
    '{"id":"old-tag","name":' + JSON.stringify(SCRIPT_LIKE) + ',"game":"gomoku","capacity":2,' +
    '"turnSeconds":0,"status":"waiting","visibility":"public","createdAt":"2026-02-10T10:00:00Z"}';
  const OLD_IMG =
    '{"id":"old-img","name":' + JSON.stringify(ON_ERROR_IMG) + ',"game":"ludo","capacity":4,' +
    '"turnSeconds":60,"status":"playing","visibility":"public","createdAt":"2026-02-11T11:00:00Z","note":"旧备注"}';
  const OLD_ENTITY =
    '{"id":"old-entity","name":' + JSON.stringify(AMP_ENTITY) + ',"game":"ludo","capacity":3,' +
    '"turnSeconds":600,"status":"waiting","visibility":"public","createdAt":"2026-02-12T12:00:00Z"}';
  const oldRecords = [OLD_TAG, OLD_IMG, OLD_ENTITY];

  const { page, baseURL, dataDir } = await setupPage(t, oldRecords);
  const dialogs = watchDialogs(page);
  const seedText = await readFile(path.join(dataDir, 'rooms.json'), 'utf8');

  // 首次打开首页：三条历史名称逐字按纯文本展示，配置沿用现有中文/单位/状态展示。
  await waitForRowCount(page, 3);
  await assertNameIsPlainText(page, SCRIPT_LIKE);
  await assertNameIsPlainText(page, ON_ERROR_IMG);
  await assertNameIsPlainText(page, AMP_ENTITY);
  const initialRows = await page.$$eval('#list-area table tbody tr', (trs) =>
    trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent)));
  assert.deepEqual(initialRows.map((cells) => cells[0]), ['old-tag', 'old-img', 'old-entity'],
    '历史记录应按原有相对次序成行');
  assert.deepEqual(initialRows.map((cells) => cells.slice(2, 6)), [
    ['五子棋', '2 人', '不限时', '未开始'],
    ['飞行棋', '4 人', '60 秒', 'playing'],
    ['飞行棋', '3 人', '600 秒', '未开始'],
  ], '历史记录的其他列配置展示应保持不变');

  // 首次查看不改写本地文件，也不改写接口记录。
  assert.equal(await readFile(path.join(dataDir, 'rooms.json'), 'utf8'), seedText,
    '查看标签样式名称不应改写本地记录');
  const serverBefore = await readServerRooms(baseURL);
  assert.deepEqual(serverBefore.map((r) => r.name), [SCRIPT_LIKE, ON_ERROR_IMG, AMP_ENTITY],
    '接口中的历史名称应保持原文');

  // 新建一个普通房间，触发列表更新。
  const createdPromise = nextCreated(page);
  await fillGomoku(page, '新补录房间');
  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;
  await waitForRowCount(page, 4);

  // 列表更新后：三条历史名称仍按原文纯文本展示，相对次序不变，新房间只追加一条。
  await assertNameIsPlainText(page, SCRIPT_LIKE);
  await assertNameIsPlainText(page, ON_ERROR_IMG);
  await assertNameIsPlainText(page, AMP_ENTITY);
  const afterRows = await page.$$eval('#list-area table tbody tr', (trs) =>
    trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent)));
  assert.deepEqual(afterRows.slice(0, 3), initialRows, '新建房间后历史行的内容与相对次序必须不变');
  assert.equal(afterRows[3][0], created.id);
  assert.equal(afterRows[3][1], '新补录房间');

  // 历史记录在接口与本地文件中仍是原对象（含附带字段），新房间恰好追加一条。
  const serverAfter = await readServerRooms(baseURL);
  assert.equal(serverAfter.length, 4, '新房间应只追加一条记录');
  assert.deepEqual(serverAfter[0], JSON.parse(OLD_TAG), '历史标签样式记录必须原样保留');
  assert.deepEqual(serverAfter[1], JSON.parse(OLD_IMG), '历史事件样式记录及其备注必须原样保留');
  assert.deepEqual(serverAfter[2], JSON.parse(OLD_ENTITY), '历史实体样式记录必须原样保留');
  assert.equal(serverAfter[3].id, created.id, '新房间应追加在最后');
  assert.equal(serverAfter[3].name, '新补录房间');
  const onDisk = JSON.parse(await readFile(path.join(dataDir, 'rooms.json'), 'utf8'));
  assert.equal(onDisk.length, 4);
  assert.deepEqual(onDisk[0], JSON.parse(OLD_TAG));
  assert.deepEqual(onDisk[1], JSON.parse(OLD_IMG));

  // 全程无弹窗、无跳转。
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(dialogs.length, 0, `历史事件样式名称不得引发弹窗：${JSON.stringify(dialogs)}`);
});
