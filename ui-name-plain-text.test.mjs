// 首页房间名称“纯文本展示”的界面回归测试。
//
// 用户可以给房间取含尖括号、引号、与号的名称，也可能输入看起来像网页标签、
// 链接或带事件属性的文字。只要名称符合现有长度与非空要求（去掉首尾空白后
// 1 至 40 个 Unicode 码点），这些内容就是名称的一部分：
//   - 服务端按现有规则整理（仅去首尾空白）后原样保存，不能删除标点、截断
//     名称，也不能把用于页面显示的转义写法（如 &lt;）保存成新的名称；
//   - 页面把名称当纯文本展示：逐字可读，不变成加粗文字、可点击链接、图片
//     或额外按钮，看似可执行的内容（事件属性、脚本样式文字）不会执行，
//     看似字符实体的文字（如 &lt;）按原有写法显示、不再解释成另一种字符；
//   - 已有房间记录中的字符串名称适用同一规则：首次打开按原文展示，新建
//     房间导致列表更新后仍保持原文，已有行的相对次序与其他配置不变，
//     查看与新建都不改写已有记录，新房间只追加一条正常记录。
//
// 与 ui.test.mjs 的分工：ui.test.mjs 覆盖名称的首尾空白整理与长度边界；
// 本文件专门覆盖“名称的文字含义在保存与页面展示之间保持一致”，不扩展
// 其他字段的校验规则。
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

// 种子记录的名称本身就是“标签样式文字”与“实体样式文字”，用于验证已有
// 记录中的字符串名称同样按原文展示，且查看与新建都不改写它们。
const SEED_ALPHA_NAME = '<b>晨间</b> "飞行棋" & 老友';
const SEED_BETA_NAME = '&lt;img src=x&gt; 午夜五子棋';
const SEED_ALPHA =
  '{"id":"seed-alpha","name":"<b>晨间</b> \\"飞行棋\\" & 老友","game":"ludo","capacity":4,"turnSeconds":30,' +
  '"status":"playing","visibility":"public","createdAt":"2026-01-01T08:00:00Z","note":"保留我","tags":["老友","周赛"]}';
const SEED_BETA =
  '{"id":"seed-beta","name":"&lt;img src=x&gt; 午夜五子棋","game":"gomoku","capacity":2,"turnSeconds":0,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-01-02T23:00:00Z","extra":{"rank":3}}';

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

async function seedRooms(dataDir, ...records) {
  await writeFile(path.join(dataDir, 'rooms.json'), '[\n' + records.join(',\n') + '\n]\n');
}

// 每个用例使用独立的数据目录、服务进程与页面，互不影响。
async function setupPage(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'score-arena-uidata-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await seedRooms(dataDir, SEED_ALPHA, SEED_BETA);
  const baseURL = await startServer(t, dataDir);
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(baseURL, { waitUntil: 'load' });
  await waitForRowCount(page, 2);
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

// readNameCell 读取指定行名称单元格的纯文本内容、innerHTML 与子元素数量，
// 用于断言名称按纯文本展示：textContent 逐字等于名称原文，且名称里的
// 标签样式文字没有变成真正的网页元素（单元格内不应有任何子元素）。
function readNameCell(page, rowIndex) {
  return page.evaluate((i) => {
    const td = document
      .querySelectorAll('#list-area table tbody tr')[i]
      .querySelectorAll('td')[1];
    return {
      text: td.textContent,
      innerHTML: td.innerHTML,
      childElements: td.childElementCount,
    };
  }, rowIndex);
}

// countListAreaElements 统计列表区域内某类元素的数量。房间名称是纯文本，
// 不应在列表区域产生链接、图片、脚本、按钮等任何额外元素。
function countListAreaElements(page, selector) {
  return page.evaluate(
    (sel) => document.querySelectorAll('#list-area ' + sel).length,
    selector,
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

const SUCCESS_PREFIX = '房间已创建，编号：';

// trackRoomPosts 记录页面发出的每一次创建请求体，用于断言页面没有为了
// “安全展示”而拦截或改写合法名称：请求必须发出，且保留用户原始输入。
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

// 断言两条种子房间渲染正确：名称逐字等于原始字符串（标签样式与实体样式
// 文字都按原文显示），其余列沿用现有展示含义，次序不变。
function assertSeedRows(rows) {
  assert.deepEqual(
    rows.map((r) => r.cells.slice(0, 6)),
    [
      ['seed-alpha', SEED_ALPHA_NAME, '飞行棋', '4 人', '30 秒', 'playing'],
      ['seed-beta', SEED_BETA_NAME, '五子棋', '2 人', '不限时', '未开始'],
    ],
    '种子房间的展示内容或次序不符合预期',
  );
  assert.equal(rows[0].timeTitle, '2026-01-01T08:00:00Z');
  assert.equal(rows[1].timeTitle, '2026-01-02T23:00:00Z');
  assert.equal(rows[1].badge, '未开始');
}

// 填写五子棋表单：人数固定 2 人由页面自动选中，无需手选。
async function fillGomokuForm(page, rawName, turnSeconds) {
  await page.type('#name', rawName);
  await page.select('#game', 'gomoku');
  await page.waitForFunction(
    () => !document.getElementById('capacity').disabled &&
      document.getElementById('capacity').value === '2',
    { timeout: 5000 },
  );
  await page.type('#turnSeconds', String(turnSeconds));
}

// 从首页填写含尖括号、引号、与号与链接样式文字的名称并创建公开房间，
// 到创建成功后列表更新的完整过程：名称逐字保存、逐字展示，不变成网页元素。
test('标签样式与标点混合的名称：创建、保存与列表展示逐字一致，不变成网页元素', { timeout: 60000 }, async (t) => {
  const { page, baseURL, dataDir } = await setupPage(t);
  const postBodies = trackRoomPosts(page);
  const createdPromise = nextCreated(page);

  const initialRows = await readRows(page);
  assertSeedRows(initialRows);

  // 链接样式文字 + 引号 + 与号 + 中文 + 表情，首尾带空白（整理后 24 个码点，
  // 符合现有 1–40 码点要求，页面与服务端都不得拦截或改写其中的标点）。
  const rawName = '  <a href="x">棋室</a> & "🀄"  ';
  const trimmedName = '<a href="x">棋室</a> & "🀄"';
  assert.ok([...trimmedName].length <= 40);
  await fillGomokuForm(page, rawName, 0);
  await page.click('#submit');

  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  // 页面没有为了安全展示而拦截或改写名称：创建请求正常发出且只发一次，
  // 请求体保留用户原始输入（不在页面侧删除标点或截断）。
  assert.equal(postBodies.length, 1, '含标签样式文字的合法名称不应被页面拦截');
  assert.equal(JSON.parse(postBodies[0]).name, rawName, '请求体应保留用户原始输入');

  // 创建结果：名称仅按现有规则去掉首尾空白，标点、中文与表情原样保留；
  // 不能把页面显示用的转义写法（&lt; 等）保存成新的名称。
  assert.ok(created.id, '创建结果应包含新房间编号');
  assert.equal(created.name, trimmedName, '创建结果中的名称应与整理后的原文一致');
  assert.ok(!created.name.includes('&lt;'), '名称不应被保存成转义写法');
  assert.equal(created.game, 'gomoku');
  assert.equal(created.capacity, 2);
  assert.equal(created.turnSeconds, 0);
  assert.equal(created.status, 'waiting');

  // 成功提示仍显示本次房间编号，表单恢复初始填写状态。
  const msg = await readMessage(page);
  assert.ok(msg.className.includes('ok'), `应显示成功提示，实际 class: ${msg.className}`);
  assert.ok(msg.text.startsWith(SUCCESS_PREFIX), `成功提示应包含编号，实际: ${msg.text}`);
  assert.equal(msg.text.slice(SUCCESS_PREFIX.length), created.id, '提示编号应与创建结果一致');
  assert.deepEqual(await readFormState(page), {
    name: '',
    game: '',
    capacity: '',
    capacityDisabled: true,
    turnSeconds: '',
    submitDisabled: false,
  });

  // 列表更新后：原有房间内容与次序不变，新记录追加在其后。
  await waitForRowCount(page, 3);
  const rows = await readRows(page);
  assert.deepEqual(rows.slice(0, 2), initialRows, '原有房间的内容或次序被改变');
  const added = rows[2];
  assert.equal(added.cells[0], created.id, '新行编号应与创建结果一致');
  assert.equal(added.cells[1], trimmedName, '新行名称应逐字等于整理后的原文');
  assert.equal(added.cells[1], created.name, '新行名称应与创建结果一致');
  // 名称只是名称列的文字，不改变本行其他列的现有展示。
  assert.equal(added.cells[2], '五子棋');
  assert.equal(added.cells[3], '2 人');
  assert.equal(added.cells[4], '不限时');
  assert.equal(added.cells[5], '未开始');
  assert.equal(added.badge, '未开始');
  assert.equal(added.timeTitle, created.createdAt);

  // 名称按纯文本展示：单元格逐字可读（含尖括号与引号），没有任何子元素——
  // 没有变成可点击链接、加粗元素或其他网页元素；innerHTML 中是转义写法，
  // 恰好证明浏览器把它当文字而非标签。
  const nameCell = await readNameCell(page, 2);
  assert.equal(nameCell.text, trimmedName, '名称单元格应逐字可读');
  assert.equal(nameCell.childElements, 0, '名称不应变成任何网页元素');
  assert.notEqual(nameCell.innerHTML, trimmedName, '名称不应被当作网页标记解释');
  assert.ok(nameCell.innerHTML.includes('&lt;a href='), '标签样式文字应以转义形式存在于页面中');
  assert.equal(await countListAreaElements(page, 'a'), 0, '名称不应变成可点击链接');
  assert.equal(await countListAreaElements(page, 'img'), 0, '名称不应变成图片');
  assert.equal(await countListAreaElements(page, 'button'), 0, '名称不应变成额外按钮');
  assert.equal(await countListAreaElements(page, 'script'), 0, '名称不应产生脚本元素');

  // 创建响应与房间列表接口里的名称都与整理后的原文一致；本地保存同样如此，
  // 已有记录（含附带字段）保持原值。
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, 3, '服务端应只追加一条新记录');
  assert.deepEqual(serverRooms[0], JSON.parse(SEED_ALPHA), '已有记录不应被改写');
  assert.deepEqual(serverRooms[1], JSON.parse(SEED_BETA), '已有记录不应被改写');
  assert.equal(serverRooms[2].name, trimmedName, '列表接口中的名称应与整理后的原文一致');
  assert.equal(serverRooms[2].id, created.id);

  const savedRooms = JSON.parse(await readFile(path.join(dataDir, 'rooms.json'), 'utf8'));
  assert.equal(savedRooms.length, 3, '本地文件应只追加一条新记录');
  assert.deepEqual(savedRooms[0], JSON.parse(SEED_ALPHA), '本地已有记录不应被改写');
  assert.deepEqual(savedRooms[1], JSON.parse(SEED_BETA), '本地已有记录不应被改写');
  assert.equal(savedRooms[2].name, trimmedName, '本地保存的名称应与整理后的原文一致');
});

// 看似带有事件处理内容与脚本样式的名称：创建并展示后不引发弹窗、页面跳转
// 或额外操作，名称仍逐字可读。
test('看似可执行的名称：不引发弹窗、跳转或额外操作，仍按原文逐字展示', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);

  // 记录一切弹窗（alert/confirm 等）；名称若被当成网页元素解释，
  // 其事件属性或脚本样式内容会在这里露出马脚。
  const dialogs = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    dialog.dismiss().catch(() => {});
  });

  // 第一个名称带事件属性样式文字（36 个码点），若被当成图片元素，
  // 加载失败会触发其中的事件处理内容并设置 window.__pwned。
  const nameImg = '<img src=x onerror="window.__pwned=1">';
  assert.ok([...nameImg].length <= 40);
  let createdPromise = nextCreated(page);
  await fillGomokuForm(page, nameImg, 0);
  await page.click('#submit');
  await waitForMessageKind(page, 'ok');
  const createdImg = await createdPromise;
  assert.equal(createdImg.name, nameImg, '事件属性样式文字应作为名称原文保存');

  await waitForRowCount(page, 3);
  let nameCell = await readNameCell(page, 2);
  assert.equal(nameCell.text, nameImg, '事件属性样式名称应逐字可读');
  assert.equal(nameCell.childElements, 0, '名称不应变成图片等元素');

  // 第二个名称带脚本样式文字（27 个码点），若被当成脚本元素会尝试弹窗。
  const nameScript = '"><script>alert(1)</script>';
  assert.ok([...nameScript].length <= 40);
  createdPromise = nextCreated(page);
  await fillGomokuForm(page, nameScript, 0);
  await page.click('#submit');
  await waitForMessageKind(page, 'ok');
  const createdScript = await createdPromise;
  assert.equal(createdScript.name, nameScript, '脚本样式文字应作为名称原文保存');

  await waitForRowCount(page, 4);
  nameCell = await readNameCell(page, 3);
  assert.equal(nameCell.text, nameScript, '脚本样式名称应逐字可读');
  assert.equal(nameCell.childElements, 0, '名称不应变成脚本等元素');

  // 给潜在的事件处理与脚本留出执行窗口后统一断言：
  // 没有弹窗、没有标记变量被写入、页面没有跳转、列表区域没有多余元素。
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.deepEqual(dialogs, [], '名称中的内容不应引发任何弹窗');
  assert.equal(
    await page.evaluate(() => window.__pwned),
    undefined,
    '名称中的事件处理内容不应被执行',
  );
  assert.equal(page.url(), baseURL + '/', '名称中的内容不应引发页面跳转');
  assert.equal(await countListAreaElements(page, 'img'), 0, '名称不应变成图片');
  assert.equal(await countListAreaElements(page, 'script'), 0, '名称不应产生脚本元素');
  assert.equal(await countListAreaElements(page, 'iframe'), 0, '名称不应产生框架元素');
  assert.equal(await countListAreaElements(page, 'button'), 0, '名称不应变成额外按钮');

  // 两个新房间的名称在列表接口中同样逐字一致，已有房间行不受影响。
  const rows = await readRows(page);
  assertSeedRows(rows.slice(0, 2));
  assert.equal(rows[2].cells[1], nameImg);
  assert.equal(rows[3].cells[1], nameScript);
  const serverRooms = await readServerRooms(baseURL);
  assert.deepEqual(
    serverRooms.map((r) => r.name),
    [SEED_ALPHA_NAME, SEED_BETA_NAME, nameImg, nameScript],
    '列表接口中的名称应全部逐字一致',
  );
});

// 名称本来包含类似网页字符实体的文字（&lt;、&amp; 等）：显示这段文字原有
// 的写法，不能再次解释成另一种字符；普通标点与标签样式文字混在一起时同样
// 保留完整名称。已有记录中的实体样式名称在首次打开与列表更新后都保持原文。
test('实体样式文字按原有写法显示，不再解释成另一种字符', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);

  // 首次打开：已有记录里的实体样式名称按原有写法逐字显示，
  // 不能被解释成 <img src=x>，也不能变成图片元素。
  const initialRows = await readRows(page);
  assertSeedRows(initialRows);
  let seedBetaCell = await readNameCell(page, 1);
  assert.equal(seedBetaCell.text, '&lt;img src=x&gt; 午夜五子棋', '实体样式文字应按原有写法显示');
  assert.ok(!seedBetaCell.text.includes('<img'), '实体样式文字不应被解释成标签');
  assert.equal(seedBetaCell.childElements, 0, '实体样式名称不应变成任何网页元素');
  assert.equal(await countListAreaElements(page, 'img'), 0, '实体样式名称不应变成图片');

  // 新建名称：实体样式文字与普通标点、中文混合（整理后 26 个码点）。
  const createdPromise = nextCreated(page);
  const rawName = '  &lt;b&gt;棋&lt;/b&gt; &amp; "友"  ';
  const trimmedName = '&lt;b&gt;棋&lt;/b&gt; &amp; "友"';
  assert.ok([...trimmedName].length <= 40);
  await fillGomokuForm(page, rawName, 0);
  await page.click('#submit');

  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;
  // 创建结果中的名称与整理后的原文一致：&lt; 是名称内容本身，
  // 不是页面显示用的转义写法，服务端不得再加工。
  assert.equal(created.name, trimmedName, '实体样式文字应作为名称原文保存');

  const msg = await readMessage(page);
  assert.equal(msg.text.slice(SUCCESS_PREFIX.length), created.id, '成功提示应显示本次编号');

  // 列表更新后：新名称逐字显示原有的实体写法（&lt; 显示为四个字符 &lt;），
  // 不能再次解释成 <b> 或加粗元素；innerHTML 中的双重转义恰好证明
  // 浏览器只把它当普通文字。
  await waitForRowCount(page, 3);
  const nameCell = await readNameCell(page, 2);
  assert.equal(nameCell.text, trimmedName, '实体样式名称应逐字显示原有写法');
  assert.ok(!nameCell.text.includes('<b>'), '实体样式文字不应被再次解释成标签');
  assert.equal(nameCell.childElements, 0, '实体样式名称不应变成加粗等元素');
  assert.ok(nameCell.innerHTML.includes('&amp;lt;'), '实体写法在页面中应再转义一层以保持原文显示');
  assert.equal(await countListAreaElements(page, 'b'), 0, '实体样式名称不应变成加粗文字');

  // 列表更新后已有行的实体样式名称仍保持原文，相对次序与其他配置不变。
  const rows = await readRows(page);
  assertSeedRows(rows.slice(0, 2));
  seedBetaCell = await readNameCell(page, 1);
  assert.equal(seedBetaCell.text, '&lt;img src=x&gt; 午夜五子棋', '列表更新后已有名称仍应保持原文');
  assert.equal(seedBetaCell.childElements, 0);

  // 列表接口中的名称同样逐字一致。
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, 3);
  assert.equal(serverRooms[1].name, SEED_BETA_NAME, '已有记录的名称不应被改写');
  assert.equal(serverRooms[2].name, trimmedName);
});

// 已有房间记录中的标签样式字符串名称：首次打开首页按原文展示；随后新建
// 房间导致列表更新时仍保持原文，已有行的相对次序与其他配置不变；查看
// 这样的名称不改写已有记录，新房间只追加一条正常房间记录。
test('已有记录中的标签样式名称：查看与新建都不改写，列表更新后仍按原文展示', { timeout: 60000 }, async (t) => {
  const { page, baseURL, dataDir } = await setupPage(t);

  // 首次打开：已有名称逐字展示（含尖括号、引号、与号），不变成网页元素。
  const initialRows = await readRows(page);
  assertSeedRows(initialRows);
  const seedAlphaCell = await readNameCell(page, 0);
  assert.equal(seedAlphaCell.text, SEED_ALPHA_NAME, '已有标签样式名称应逐字展示');
  assert.equal(seedAlphaCell.childElements, 0, '已有名称不应变成加粗等元素');
  assert.equal(await countListAreaElements(page, 'b'), 0, '已有名称不应变成加粗文字');

  // 仅仅查看这样的名称不改写已有记录：本地文件与写入时逐字节一致。
  const seededContent = '[\n' + SEED_ALPHA + ',\n' + SEED_BETA + '\n]\n';
  assert.equal(
    await readFile(path.join(dataDir, 'rooms.json'), 'utf8'),
    seededContent,
    '查看已有名称不应改写本地记录',
  );

  // 新建一个普通名称的房间，触发列表更新。
  const createdPromise = nextCreated(page);
  await fillGomokuForm(page, '  新建 棋室  ', 0);
  await page.click('#submit');
  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;
  assert.equal(created.name, '新建 棋室');
  const msg = await readMessage(page);
  assert.equal(msg.text.slice(SUCCESS_PREFIX.length), created.id, '成功提示应显示本次编号');

  // 列表更新后：已有行仍按原文展示，相对次序与其他配置不变，新行追加在后。
  await waitForRowCount(page, 3);
  const rows = await readRows(page);
  assert.deepEqual(rows.slice(0, 2), initialRows, '已有行的内容或次序不应改变');
  const seedAlphaCellAfter = await readNameCell(page, 0);
  assert.equal(seedAlphaCellAfter.text, SEED_ALPHA_NAME, '列表更新后已有名称仍应逐字展示');
  assert.equal(seedAlphaCellAfter.childElements, 0);
  assert.equal(rows[2].cells[0], created.id);
  assert.equal(rows[2].cells[1], '新建 棋室');

  // 服务端与本地：已有记录（含附带字段）逐字保持原值，
  // 新房间只追加一条正常记录（编号非空、状态 waiting、公开范围 public）。
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, 3, '新房间应只追加一条记录');
  assert.deepEqual(serverRooms[0], JSON.parse(SEED_ALPHA), '已有记录不应被改写');
  assert.deepEqual(serverRooms[1], JSON.parse(SEED_BETA), '已有记录不应被改写');
  assert.equal(serverRooms[2].id, created.id);
  assert.equal(serverRooms[2].status, 'waiting');
  assert.equal(serverRooms[2].visibility, 'public');

  const savedRooms = JSON.parse(await readFile(path.join(dataDir, 'rooms.json'), 'utf8'));
  assert.equal(savedRooms.length, 3, '本地文件应只追加一条记录');
  assert.deepEqual(savedRooms[0], JSON.parse(SEED_ALPHA), '本地已有记录不应被改写');
  assert.deepEqual(savedRooms[1], JSON.parse(SEED_BETA), '本地已有记录不应被改写');
});
