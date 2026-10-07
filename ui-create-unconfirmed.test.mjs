// 首页“创建公开房间”在服务已返回 201、但创建结果未能确认时的界面回归测试。
//
// 与其他浏览器回归文件的分工：
//   - ui.test.mjs：创建成功/被拒、成功后列表竞态刷新、名称整理与长度边界；
//   - ui-pending-edit.test.mjs：正常成功/被拒路径下等待期间的编辑与表单保留；
//   - ui-create-connection-failure.test.mjs：创建请求未送达服务的连接失败，
//     以及“已确认成功但列表刷新连接失败”的既有区分；
//   - 本文件只盯住“服务已返回成功状态（201），但页面没能拿到有效创建结果”
//     这一条容易误导用户重复创建的分支：响应正文未能完整读出/不是合法 JSON，
//     或正文可解析但没有非空字符串编号（缺失、空字符串或类型不符）。此时房间
//     可能已经在服务端保存，页面只能表达不确定，必须显示“创建结果未能确认”
//     提醒，不能显示“房间已创建”及编号，也不能换成输入错误或“无法连接服务”。
//
// 覆盖的产品行为：
//   1. 提醒文案固定为“创建结果未能确认：……请先刷新页面查看房间列表，确认是否
//      已创建后，再决定是否重新提交。”，以提醒（warn）样式显示在表单区域；
//      不出现成功编号、不从名称或已有列表猜编号、不显示成输入错误或连接失败；
//   2. 名称、规则、人数、每步时间四项整体保留：名称首尾空白保持输入原貌；
//      等待期间未编辑也不能沿用正常成功的清空行为；等待期间改成另一份配置时
//      保留结果到达时的最新填写，人数选择状态仍与当前规则一致；
//   3. 房间列表维持提交前已展示的内容与次序，不凭提交内容拼出新行，不自动
//      刷新列表，也不再次发送创建请求；处理结束后创建按钮恢复可用、仍可编辑；
//   4. 房间确实已保存但页面未取得有效编号的情形：服务端记录确认已新增一条，
//      页面只表达不确定；用户按提醒刷新页面后看到这次已保存的房间及真实编号，
//      此前等待期间的编辑没有自动生成另一间房；
//   5. 对照：同一转发机制下完整合法的 201 响应仍按正常成功处理（显示编号、
//      复位表单、刷新列表），证明上述分支不是转发环境造成的假象。
//
// 模拟方式：请求拦截把页面的创建请求挂起，放行后由测试进程把同一份请求体
// 转发给真实服务（房间真实保存、真实编号可知），再把“页面看到的响应”替换为
// 被截断/编号无效的正文。服务端因此恰好新增一条记录，页面面对的则是
// “201 已收到但结果未能确认”的情形。
//
// 运行：npm test（需要系统 Chrome，可用 CHROME_PATH 指定路径）。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer-core';

const repoRoot = import.meta.dirname;
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let serverBin;
let browser;

// 与其他界面回归文件相同的种子记录：创建前后用来比对列表内容、次序与附带字段。
const SEED_ALPHA =
  '{"id":"seed-alpha","name":"晨间飞行棋","game":"ludo","capacity":4,"turnSeconds":30,' +
  '"status":"playing","visibility":"public","createdAt":"2026-01-01T08:00:00Z","note":"保留我","tags":["老友","周赛"]}';
const SEED_BETA =
  '{"id":"seed-beta","name":"午夜五子棋","game":"gomoku","capacity":2,"turnSeconds":0,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-01-02T23:00:00Z","extra":{"rank":3}}';

const SUCCESS_PREFIX = '房间已创建，编号：';
const CONN_FAILURE_TEXT = '无法连接服务，请确认服务仍在运行后重试。';
// 结果未能确认的固定提醒文案（须与 index.html 完全一致）。
const UNCONFIRMED_TEXT =
  '创建结果未能确认：服务已返回成功状态，但回应内容未能完整读取，' +
  '房间可能已经保存。请先刷新页面查看房间列表，确认是否已创建后，再决定是否重新提交。';

// 创建成功后的表单复位状态：名称/规则/时间清空，人数恢复禁用占位，按钮可用。
const RESET_FORM = {
  name: '',
  game: '',
  capacity: '',
  capacityDisabled: true,
  turnSeconds: '',
  submitDisabled: false,
};

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

// 每个用例使用独立的数据目录、服务进程与页面；打开页面时已有两条种子房间。
async function setupPage(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'score-arena-uidata-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await seedRooms(dataDir, SEED_ALPHA, SEED_BETA);
  const baseURL = await startServer(t, dataDir);
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(baseURL, { waitUntil: 'load' });
  await waitForRowCount(page, 2);
  return { page, baseURL };
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

// readServerRooms 直接读接口，确认服务端实际保存的记录（绕过页面展示）。
async function readServerRooms(baseURL) {
  const res = await fetch(baseURL + '/api/rooms');
  assert.equal(res.status, 200);
  return (await res.json()).rooms;
}

function assertSeedRows(rows) {
  assert.deepEqual(
    rows.map((r) => r.cells.slice(0, 6)),
    [
      ['seed-alpha', '晨间飞行棋', '飞行棋', '4 人', '30 秒', 'playing'],
      ['seed-beta', '午夜五子棋', '五子棋', '2 人', '不限时', '未开始'],
    ],
    '种子房间的展示内容或次序不符合预期',
  );
  assert.equal(rows[0].timeTitle, '2026-01-01T08:00:00Z');
  assert.equal(rows[1].timeTitle, '2026-01-02T23:00:00Z');
  assert.equal(rows[1].badge, '未开始');
}

// installCreateGateway 拦截页面的创建请求：每次 POST /api/rooms 先挂起（等待
// 期间的观察窗口），由测试显式 release 放行；放行后把同一份请求体转发给真实
// 服务（房间真实保存，真实响应原文记入 entry.realBody），再把页面看到的响应
// 替换为 transform(realBody) 给出的内容。其余请求照常放行，并统计拦截开启后
// 的 GET /api/rooms 次数以验证“结果未确认时不自动刷新列表”（页面初次加载的
// 列表查询发生在拦截开启之前，不计入）。
function installCreateGateway(page, transform) {
  const posts = [];
  const state = { gets: 0 };
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/rooms')) {
      const entry = { body: req.postData() };
      posts.push(entry);
      entry.whenReleased = new Promise((resolve) => { entry.release = () => resolve(); });
      entry.whenForwarded = new Promise((resolve, reject) => {
        entry.whenReleased.then(async () => {
          try {
            const resp = await fetch(req.url(), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: entry.body,
            });
            entry.realStatus = resp.status;
            entry.realBody = await resp.text();
            await req.respond({
              status: resp.status,
              contentType: 'application/json; charset=utf-8',
              body: transform(entry.realBody),
            });
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      });
    } else {
      if (req.method() === 'GET' && req.url().endsWith('/api/rooms')) state.gets++;
      req.continue();
    }
  });
  return {
    posts,
    state,
    async waitFor(count) {
      const deadline = Date.now() + 10000;
      while (posts.length < count) {
        if (Date.now() > deadline) {
          throw new Error(`等待第 ${count} 次创建请求超时（实际 ${posts.length} 次）`);
        }
        await sleep(10);
      }
    },
  };
}

// 页面看到的响应正文替换方式：
//   truncateToPage   —— 正文未能完整读出（截断的 JSON，无法解析）；
//   dropId/emptyId/numericId —— 正文可解析但编号缺失、为空字符串、类型不符；
//   passthrough      —— 对照：完整合法的创建结果原样交给页面。
const truncateToPage = (realBody) => realBody.slice(0, 12);
const dropId = (realBody) => {
  const o = JSON.parse(realBody);
  delete o.id;
  return JSON.stringify(o);
};
const emptyId = (realBody) => {
  const o = JSON.parse(realBody);
  o.id = '';
  return JSON.stringify(o);
};
const numericId = (realBody) => {
  const o = JSON.parse(realBody);
  o.id = 12345;
  return JSON.stringify(o);
};
const passthrough = (realBody) => realBody;

// 替换名称输入框的全部内容。
async function setName(page, value) {
  await page.$eval('#name', (el) => { el.value = ''; });
  if (value !== '') await page.type('#name', value);
}

// 替换每步时间输入框的全部内容（'' 表示清空）。
async function setTurnSeconds(page, value) {
  await page.$eval('#turnSeconds', (el) => { el.value = ''; });
  if (value !== '') await page.type('#turnSeconds', value);
}

async function chooseGame(page, game) {
  await page.select('#game', game);
  if (game === 'gomoku') {
    await page.waitForFunction(
      () => !document.getElementById('capacity').disabled &&
        document.getElementById('capacity').value === '2',
      { timeout: 5000 },
    );
  } else if (game === 'ludo') {
    await page.waitForFunction(
      () => !document.getElementById('capacity').disabled,
      { timeout: 5000 },
    );
  }
}

// 合法的飞行棋配置：4 人、60 秒，名称含首尾空格、内部空格与表情。
const RAW_NAME = '  周末 飞行棋 🎲 友谊赛  ';
const TRIMMED_NAME = '周末 飞行棋 🎲 友谊赛';

async function fillLudoForm(page) {
  await page.type('#name', RAW_NAME);
  await chooseGame(page, 'ludo');
  await page.select('#capacity', '4');
  await page.type('#turnSeconds', '60');
}

// 断言表单区域显示的是“创建结果未能确认”提醒，而不是成功、输入错误或
// 连接失败；提醒中不出现本次真实编号、房间名称或已有房间编号（不猜编号）。
function assertUnconfirmedMessage(msg, realId) {
  assert.ok(msg.className.includes('warn'), '结果未能确认时应以提醒样式显示');
  assert.ok(!msg.className.includes('ok'), '结果未能确认时不应显示成功样式');
  assert.ok(!msg.className.includes('error'), '结果未能确认时不应显示为错误');
  assert.equal(msg.text, UNCONFIRMED_TEXT, '应显示固定的“创建结果未能确认”提醒');
  assert.ok(!msg.text.includes(SUCCESS_PREFIX), '不应出现“房间已创建”及编号');
  assert.ok(!msg.text.includes(CONN_FAILURE_TEXT), '不应换成连接失败提示');
  assert.ok(!msg.text.includes(realId), '不应显示本次创建的真实编号');
  assert.ok(!msg.text.includes('seed-alpha') && !msg.text.includes('seed-beta'),
    '不应从已有列表猜编号');
}

// 主用例：201 已收到但正文未能完整读出（截断 JSON），等待期间未编辑。
// 房间真实保存但页面未取得编号 → 只表达不确定；四项整体保留（名称首尾空白
// 原貌），列表不刷新、不重发请求；用户按提醒刷新页面后看到真实编号的新房间。
test('201 但正文未能完整读出：提醒结果未确认、四项保留、列表不变，刷新页面后看到真实编号', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const initialRows = await readRows(page);
  assertSeedRows(initialRows);
  const seedRooms = await readServerRooms(baseURL);
  assert.equal(seedRooms.length, 2);

  const gateway = installCreateGateway(page, truncateToPage);
  await page.setRequestInterception(true);

  await fillLudoForm(page);
  await page.click('#submit');

  // 请求在途：按钮不可用，且不是瞬间恢复；请求体为点击时的原始配置。
  await gateway.waitFor(1);
  assert.deepEqual(JSON.parse(gateway.posts[0].body), {
    name: RAW_NAME,
    game: 'ludo',
    capacity: 4,
    turnSeconds: 60,
  }, '请求体应为用户提交的原始配置（名称不预先整理）');
  assert.equal((await readFormState(page)).submitDisabled, true, '等待期间创建按钮应不可用');
  await sleep(300);
  assert.equal((await readFormState(page)).submitDisabled, true, '等待期间按钮不应瞬间恢复');

  // 放行：服务真实保存房间并返回 201，但页面收到的正文被截断、无法解析。
  gateway.posts[0].release();
  await gateway.posts[0].whenForwarded;
  const entry = gateway.posts[0];
  assert.equal(entry.realStatus, 201, '服务端应已确认创建成功');
  const created = JSON.parse(entry.realBody);
  assert.ok(created.id, '服务端返回的真实结果应包含非空编号');

  await waitForMessageKind(page, 'warn');
  const msg = await readMessage(page);
  assertUnconfirmedMessage(msg, created.id);
  assert.ok(!msg.text.includes(TRIMMED_NAME), '不应从房间名称猜编号');

  // 等待期间未编辑也不能沿用正常成功的清空行为：四项整体保留，
  // 名称首尾空白保持输入原貌，人数选择仍可用；按钮恢复可用。
  assert.deepEqual(await readFormState(page), {
    name: RAW_NAME,
    game: 'ludo',
    capacity: '4',
    capacityDisabled: false,
    turnSeconds: '60',
    submitDisabled: false,
  }, '结果未确认时四项应整体保留（含名称首尾空白），按钮恢复可用');

  // 列表维持提交前的内容与次序：不凭提交内容拼出新行，不自动刷新列表，
  // 也不再次发送创建请求。
  assert.deepEqual(await readRows(page), initialRows, '结果未确认时不应改动房间列表');
  await sleep(400);
  assert.deepEqual(await readRows(page), initialRows, '列表不应随后被自动刷新');
  assert.equal(gateway.state.gets, 0, '结果未确认后不应自动再次查询房间列表');
  assert.equal(gateway.posts.length, 1, '结果未确认后不应自动重发创建请求');

  // 服务端确实已保存本次创建（页面只能表达不确定，不能当成没有新增）：
  // 已有记录及附带字段保持原值，新记录追加在最后。
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, 3, '服务端应已保存本次创建的房间');
  assert.deepEqual(serverRooms.slice(0, 2), seedRooms, '已有记录及附带字段应保持原值');
  assert.equal(serverRooms[2].id, created.id);
  assert.equal(serverRooms[2].name, TRIMMED_NAME, '名称应仅去掉首尾空白，保留内部空格与表情');
  assert.equal(serverRooms[2].game, 'ludo');
  assert.equal(serverRooms[2].capacity, 4);
  assert.equal(serverRooms[2].turnSeconds, 60);
  assert.equal(serverRooms[2].status, 'waiting');
  assert.equal(serverRooms[2].visibility, 'public');

  // 用户按提醒刷新页面：看到这次已保存的房间及真实编号，原有记录不变，
  // 且没有因为此前的提交或刷新自动生成另一间房。
  await page.reload({ waitUntil: 'load' });
  await waitForRowCount(page, 3);
  const rows = await readRows(page);
  assert.deepEqual(rows.slice(0, 2), initialRows, '刷新后原有房间的内容或次序不应改变');
  const added = rows[2];
  assert.equal(added.cells[0], created.id, '刷新后应看到本次保存的真实编号');
  assert.equal(added.cells[1], TRIMMED_NAME);
  assert.equal(added.cells[2], '飞行棋');
  assert.equal(added.cells[3], '4 人');
  assert.equal(added.cells[4], '60 秒');
  assert.equal(added.cells[5], '未开始');
  assert.equal(added.badge, '未开始');
  assert.equal(added.timeTitle, created.createdAt, '创建时间悬浮应保留接口原文');
  assert.equal((await readServerRooms(baseURL)).length, 3, '刷新页面不应新增任何记录');
});

// 正文可解析但编号缺失、为空字符串或类型不符：与正文无法读取同一处理。
// 每个变体都验证：固定提醒、未编辑也不清空表单、列表不变、不重发请求、
// 服务端真实保存（页面不因此认定没有新增）。
const INVALID_ID_VARIANTS = [
  { label: '缺失', transform: dropId },
  { label: '为空字符串', transform: emptyId },
  { label: '类型不符（数字）', transform: numericId },
];

for (const variant of INVALID_ID_VARIANTS) {
  test(`201 正文可解析但编号${variant.label}：与正文无法读取同一处理`, { timeout: 60000 }, async (t) => {
    const { page, baseURL } = await setupPage(t);
    const initialRows = await readRows(page);
    assertSeedRows(initialRows);

    const gateway = installCreateGateway(page, variant.transform);
    await page.setRequestInterception(true);

    const submittedName = '  编号' + variant.label + '的房间  ';
    await page.type('#name', submittedName);
    await chooseGame(page, 'gomoku');
    await setTurnSeconds(page, '30');
    await page.click('#submit');

    await gateway.waitFor(1);
    gateway.posts[0].release();
    await gateway.posts[0].whenForwarded;
    const entry = gateway.posts[0];
    assert.equal(entry.realStatus, 201, '服务端应已确认创建成功');
    const created = JSON.parse(entry.realBody);
    assert.ok(created.id, '服务端返回的真实结果应包含非空编号');

    await waitForMessageKind(page, 'warn');
    const msg = await readMessage(page);
    assertUnconfirmedMessage(msg, created.id);

    // 未编辑也不沿用正常成功的清空行为：四项整体保留，名称首尾空白原貌。
    assert.deepEqual(await readFormState(page), {
      name: submittedName,
      game: 'gomoku',
      capacity: '2',
      capacityDisabled: false,
      turnSeconds: '30',
      submitDisabled: false,
    }, '编号' + variant.label + '时四项应整体保留，按钮恢复可用');

    // 列表不变、不自动刷新、不重发请求；页面任何位置都不应出现真实编号
    // 拼出的新行。
    assert.deepEqual(await readRows(page), initialRows, '列表应维持提交前的内容与次序');
    await sleep(400);
    assert.equal(gateway.state.gets, 0, '不应自动再次查询房间列表');
    assert.equal(gateway.posts.length, 1, '不应自动重发创建请求');
    const listText = await page.evaluate(
      () => document.getElementById('list-area').textContent,
    );
    assert.ok(!listText.includes(created.id), '列表不应凭提交内容或真实结果拼出新行');

    // 房间确实已保存：服务端新增一条，编号为真实编号。
    const serverRooms = await readServerRooms(baseURL);
    assert.equal(serverRooms.length, 3, '服务端应已保存本次创建');
    assert.equal(serverRooms[2].id, created.id);
    assert.equal(serverRooms[2].name, submittedName.trim(), '名称应仅去掉首尾空白');
    assert.equal(serverRooms[2].game, 'gomoku');
    assert.equal(serverRooms[2].capacity, 2);
    assert.equal(serverRooms[2].turnSeconds, 30);
  });
}

// 等待期间改成另一份配置：结果未确认时保留结果到达时的最新填写，人数选择
// 状态仍与当前规则一致；本次创建仍按提交时配置保存，等待期间的编辑没有
// 自动生成另一间房。
test('等待期间改成另一份配置后结果未确认：保留最新填写，本次仍按提交时配置保存', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const initialRows = await readRows(page);
  assertSeedRows(initialRows);

  const gateway = installCreateGateway(page, truncateToPage);
  await page.setRequestInterception(true);

  // 提交时：五子棋/2 人/30 秒，名称带首尾空白。
  await page.type('#name', '  结果未确认的五子棋  ');
  await chooseGame(page, 'gomoku');
  await setTurnSeconds(page, '30');
  await page.click('#submit');
  await gateway.waitFor(1);
  assert.deepEqual(JSON.parse(gateway.posts[0].body), {
    name: '  结果未确认的五子棋  ',
    game: 'gomoku',
    capacity: 2,
    turnSeconds: 30,
  }, '已发出的请求应固定为点击提交时的配置');

  // 等待期间改成另一份完整配置：飞行棋/3 人/90 秒，名称也换掉。
  await setName(page, '等待中改成的飞行棋');
  await chooseGame(page, 'ludo');
  await page.select('#capacity', '3');
  await setTurnSeconds(page, '90');

  // 放行：服务按提交时的五子棋配置真实保存，页面收到截断正文。
  gateway.posts[0].release();
  await gateway.posts[0].whenForwarded;
  const created = JSON.parse(gateway.posts[0].realBody);
  assert.equal(created.game, 'gomoku', '本次创建仍应使用提交时的五子棋配置');
  assert.equal(created.capacity, 2);
  assert.equal(created.turnSeconds, 30);
  assert.equal(created.name, '结果未确认的五子棋');

  await waitForMessageKind(page, 'warn');
  assertUnconfirmedMessage(await readMessage(page), created.id);

  // 保留结果到达时的最新填写：四项整体为等待期间改成的飞行棋配置，
  // 人数选择状态与当前规则一致（飞行棋 3 人、可选择），不回退提交时内容。
  assert.deepEqual(await readFormState(page), {
    name: '等待中改成的飞行棋',
    game: 'ludo',
    capacity: '3',
    capacityDisabled: false,
    turnSeconds: '90',
    submitDisabled: false,
  }, '结果未确认时应保留结果到达时的最新填写，人数选择仍与当前规则一致');

  // 列表维持提交前内容；服务端只有提交时配置的那一间新房间，
  // 等待期间的编辑没有自动生成另一间房。
  assert.deepEqual(await readRows(page), initialRows, '列表应维持提交前的内容与次序');
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, 3, '等待期间的编辑不应自动生成另一间房');
  assert.equal(serverRooms[2].id, created.id);
  assert.equal(serverRooms[2].game, 'gomoku');
  assert.equal(serverRooms[2].capacity, 2);
  assert.equal(serverRooms[2].turnSeconds, 30);

  // 刷新页面后看到的是提交时配置保存的房间及真实编号，仍只有这一间新增。
  await page.reload({ waitUntil: 'load' });
  await waitForRowCount(page, 3);
  const rows = await readRows(page);
  assert.deepEqual(rows.slice(0, 2), initialRows);
  assert.equal(rows[2].cells[0], created.id);
  assert.equal(rows[2].cells[1], '结果未确认的五子棋');
  assert.equal(rows[2].cells[2], '五子棋');
  assert.equal(rows[2].cells[3], '2 人');
  assert.equal(rows[2].cells[4], '30 秒');
  assert.equal((await readServerRooms(baseURL)).length, 3, '刷新后仍应只有本次保存的一间新房间');
});

// 对照：同一转发机制下，完整合法的 201 响应原样交给页面时仍按正常成功
// 处理——显示返回编号、复位表单、刷新列表，证明“结果未确认”分支由响应
// 内容触发，而非转发环境破坏了正常成功路径。
test('对照：完整创建结果经同一转发仍按正常成功处理', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const initialRows = await readRows(page);
  assertSeedRows(initialRows);

  const gateway = installCreateGateway(page, passthrough);
  await page.setRequestInterception(true);

  await fillLudoForm(page);
  await page.click('#submit');
  await gateway.waitFor(1);
  gateway.posts[0].release();
  await gateway.posts[0].whenForwarded;
  const created = JSON.parse(gateway.posts[0].realBody);
  assert.ok(created.id);

  // 正常成功：显示返回编号，表单复位，列表刷新出新房间。
  await waitForMessageKind(page, 'ok');
  const msg = await readMessage(page);
  assert.equal(msg.text, SUCCESS_PREFIX + created.id, '完整创建结果应显示成功提示及编号');
  assert.ok(!msg.text.includes(UNCONFIRMED_TEXT), '完整结果不应显示未确认提醒');
  await waitForRowCount(page, 3);
  assert.deepEqual(await readFormState(page), RESET_FORM, '正常成功后表单应恢复初始状态');
  const rows = await readRows(page);
  assert.deepEqual(rows.slice(0, 2), initialRows, '原有房间的内容或次序被改变');
  assert.equal(rows[2].cells[0], created.id);
  assert.equal(rows[2].cells[1], TRIMMED_NAME);
  assert.equal(rows[2].cells[2], '飞行棋');
  assert.equal(rows[2].cells[3], '4 人');
  assert.equal(rows[2].cells[4], '60 秒');
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, 3);
  assert.equal(serverRooms[2].id, created.id);
});
