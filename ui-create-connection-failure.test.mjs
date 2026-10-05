// 首页“创建公开房间”在“创建请求尚未送达服务就连接失败”时的界面回归测试。
//
// 与其他浏览器回归文件的分工：
//   - ui.test.mjs：创建成功/被拒、成功后列表竞态刷新、名称整理与长度边界
//     （含“创建成功但列表刷新失败仍保留成功提示与编号”的既有区分，本文件不重复）；
//   - ui-capacity-linkage.test.mjs / ui-turn-seconds.test.mjs / ui-mixed-records.test.mjs：
//     人数联动、时间限制与混合记录展示；
//   - 本文件只盯住“连接失败”这一类失败：请求根本没有送达服务（没有服务端返回的
//     业务拒绝原因，也没有已确认的新房间编号），页面必须沿用现有的连接失败反馈
//     “无法连接服务，请确认服务仍在运行后重试。”，既不能显示成输入错误，也不能
//     显示成房间列表读取失败。
//
// 覆盖的完整链路（同一用例内按时间顺序断言实际页面变化，不只看错误文案）：
//   1. 已有房间正常加载后，填写一份合法配置（飞行棋 4 人、60 秒，名称含首尾空格、
//      内部空格与表情）并提交：等待期间创建按钮暂时不可用；
//   2. 请求在送达服务之前被中止（模拟连接失败，服务对此一无所知）：表单区域显示
//      连接失败提示，按钮恢复可用；名称保持输入原貌，规则/人数/时间全部保留，
//      人数选择仍然可用（不恢复成未选规则的初始状态）；房间列表保留提交前的内容
//      与次序，不出现新房间、成功提示或虚假编号；服务端记录不增加、原值不变；
//   3. 连接恢复后不刷新页面、不重新填写，直接再次提交：按保留的配置正常创建，
//      名称仅去掉首尾空白（内部空格与表情保留），成功提示编号与服务端返回一致，
//      列表在已有记录之后追加新行且原有记录不变，连接失败提示被成功结果替换，
//      表单恢复初始填写状态，创建按钮仍可使用。
//
// 失败条件严格限定为“请求未送达服务”：本文件通过请求拦截在请求发出前将其挂起、
// 再中止，保证服务从未收到该请求；响应途中断开时房间是否已保存不在此作同样判断。
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

// 与其他界面回归文件相同的种子记录（含附带字段 note/tags/extra）：
// 连接失败与恢复后创建时，原有房间的内容、附带字段与次序都必须保持不变。
const SEED_ALPHA =
  '{"id":"seed-alpha","name":"晨间飞行棋","game":"ludo","capacity":4,"turnSeconds":30,' +
  '"status":"playing","visibility":"public","createdAt":"2026-01-01T08:00:00Z","note":"保留我","tags":["老友","周赛"]}';
const SEED_BETA =
  '{"id":"seed-beta","name":"午夜五子棋","game":"gomoku","capacity":2,"turnSeconds":0,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-01-02T23:00:00Z","extra":{"rank":3}}';

const SUCCESS_PREFIX = '房间已创建，编号：';
// 现有的连接失败反馈文案：本类失败必须沿用它，不得换成输入错误或列表读取失败。
const CONN_FAIL_TEXT = '无法连接服务，请确认服务仍在运行后重试。';

// 用户填写的合法配置：名称含首尾空格、内部空格与表情；飞行棋 4 人、60 秒。
const RAW_NAME = '  周末 飞行棋 🎲 友谊赛  ';
const TRIMMED_NAME = '周末 飞行棋 🎲 友谊赛';
const EXPECTED_PAYLOAD = { name: RAW_NAME, game: 'ludo', capacity: 4, turnSeconds: 60 };

// 连接失败后被保留的表单状态（名称保持输入原貌，人数选择仍然可用）。
const PRESERVED_FORM = {
  name: RAW_NAME,
  game: 'ludo',
  capacity: '4',
  capacityDisabled: false,
  turnSeconds: '60',
  submitDisabled: false,
};

// 创建成功后的表单复位状态：名称/规则/时间清空，人数恢复“未选择规则”时的
// 禁用占位状态，创建按钮恢复可用。
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

// 独立的数据目录、服务进程与页面；打开页面时已有两条种子房间正常加载。
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

function assertSeedRows(rows) {
  assert.deepEqual(
    rows.map((r) => r.cells.slice(0, 6)),
    [
      ['seed-alpha', '晨间飞行棋', '飞行棋', '4 人', '30 秒', 'playing'],
      ['seed-beta', '午夜五子棋', '五子棋', '2 人', '不限时', '未开始'],
    ],
    '种子房间的展示内容或次序不符合预期',
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

// trackRoomPosts 记录页面发出的每一次创建请求体：连接失败（未送达）与恢复后
// 重试的请求体必须一致，且都带着用户输入的原始名称。
function trackRoomPosts(page) {
  const bodies = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/rooms')) {
      bodies.push(req.postData());
    }
  });
  return bodies;
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

// readServerRooms 直接读接口，确认服务端实际保存的记录（绕过页面展示）。
async function readServerRooms(baseURL) {
  const res = await fetch(baseURL + '/api/rooms');
  assert.equal(res.status, 200);
  return (await res.json()).rooms;
}

// =============================================================================
// 完整链路：等待 → 连接失败（请求未送达服务）→ 保留内容 → 恢复后直接再次提交成功。
// =============================================================================

test('创建请求未送达服务的连接失败：保留填写内容，恢复后直接再次提交成功创建', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const postBodies = trackRoomPosts(page);

  // 用户先看到正常加载的已有房间。
  const initialRows = await readRows(page);
  assertSeedRows(initialRows);

  // 填写合法配置：名称含首尾空格、内部空格与表情；飞行棋 4 人；每步 60 秒。
  await page.type('#name', RAW_NAME);
  await page.select('#game', 'ludo');
  await page.waitForFunction(
    () => !document.getElementById('capacity').disabled,
    { timeout: 5000 },
  );
  await page.select('#capacity', '4');
  await page.type('#turnSeconds', '60');

  // 拦截创建请求并挂起：既不送达服务，也不立即失败，以便观察提交等待状态。
  let intercepting = true;
  let postSeen;
  const postArrived = new Promise((resolve) => { postSeen = resolve; });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (!intercepting) return;
    if (req.method() === 'POST' && req.url().endsWith('/api/rooms')) {
      postSeen(req); // 挂起，由测试决定何时中止
    } else {
      req.continue();
    }
  });

  await page.click('#submit');
  const heldReq = await postArrived;

  // 提交进入等待：创建按钮暂时不可用，且不是瞬间恢复；此时没有任何结果提示。
  assert.equal((await readFormState(page)).submitDisabled, true, '提交等待期间按钮应不可用');
  await sleep(300);
  assert.equal((await readFormState(page)).submitDisabled, true, '等待期间按钮应保持不可用');
  assert.deepEqual(await readMessage(page), { className: 'msg', text: '' }, '等待期间不应显示任何结果提示');

  // 连接失败：请求在送达服务之前被中止，服务从未收到该请求。
  await heldReq.abort();
  await waitForMessageKind(page, 'error');

  // 表单区域显示现有的连接失败反馈：不是输入错误，也不是列表读取失败。
  const failMsg = await readMessage(page);
  assert.equal(failMsg.text, CONN_FAIL_TEXT, '应沿用现有的连接失败提示');
  assert.ok(failMsg.className.includes('error'), '连接失败提示应为错误样式');
  assert.ok(!failMsg.className.includes('ok'), '连接失败不应显示成功提示');
  assert.ok(!failMsg.text.includes(SUCCESS_PREFIX), '连接失败不应出现新房间编号');
  assert.ok(!failMsg.text.includes('已创建'), '连接失败不应出现创建成功文案');

  // 已填内容全部保留：名称保持输入原貌，规则/人数/时间不变，人数选择仍然可用，
  // 不能因失败恢复成未选择规则的初始状态；按钮恢复可用。
  assert.deepEqual(await readFormState(page), PRESERVED_FORM, '连接失败后应保留全部已填内容并恢复按钮可用');

  // 房间列表保留提交前的内容与排列次序：不出现新房间，也不显示列表读取失败。
  assert.deepEqual(await readRows(page), initialRows, '连接失败不应改动房间列表');
  assert.equal(
    await page.evaluate(() => !!document.querySelector('#list-area .list-error')),
    false,
    '连接失败不应被显示成房间列表读取失败',
  );

  // 服务端查询到的房间记录没有增加，已有记录及其附带字段保持原值。
  const roomsAfterFailure = await readServerRooms(baseURL);
  assert.deepEqual(
    roomsAfterFailure,
    [JSON.parse(SEED_ALPHA), JSON.parse(SEED_BETA)],
    '请求未送达服务时服务端不得增加或改动任何记录',
  );

  // 连接恢复：放行后续请求。用户不刷新页面、不重新填写，直接再次提交。
  intercepting = false;
  await page.setRequestInterception(false);
  const createdPromise = nextCreated(page);
  await page.click('#submit');

  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  // 两次提交的请求体一致：保留的配置被原样再次送出，名称仍是输入时的原貌。
  assert.equal(postBodies.length, 2, '失败与重试应各发出一次创建请求');
  assert.deepEqual(JSON.parse(postBodies[0]), EXPECTED_PAYLOAD, '失败前提交的应是用户填写的配置');
  assert.deepEqual(JSON.parse(postBodies[1]), EXPECTED_PAYLOAD, '重试应沿用保留的配置，无需重新填写');

  // 新房间使用保留的飞行棋、4 人、60 秒配置；名称仅去掉首尾空白，
  // 内部空格与表情保留。
  assert.ok(created.id, '创建结果应包含非空编号');
  assert.equal(created.name, TRIMMED_NAME, '名称应仅去掉首尾空白，保留内部空格与表情');
  assert.equal(created.game, 'ludo');
  assert.equal(created.capacity, 4);
  assert.equal(created.turnSeconds, 60);
  assert.equal(created.status, 'waiting');
  assert.equal(created.visibility, 'public');

  // 连接失败提示被成功结果替换：成功提示中的非空编号与服务端返回的新房间一致。
  const okMsg = await readMessage(page);
  assert.ok(okMsg.className.includes('ok'), '重试成功后应显示成功提示');
  assert.ok(okMsg.text.startsWith(SUCCESS_PREFIX), `成功提示应包含编号，实际: ${okMsg.text}`);
  assert.equal(okMsg.text.slice(SUCCESS_PREFIX.length), created.id, '提示编号应与服务端返回的新房间一致');
  assert.ok(!okMsg.text.includes(CONN_FAIL_TEXT), '连接失败提示应被成功结果替换');

  // 列表刷新后在已有记录之后展示新房间，原有记录的内容和次序不变。
  await waitForRowCount(page, 3);
  const rows = await readRows(page);
  assert.deepEqual(rows.slice(0, 2), initialRows, '原有房间的内容或次序被改变');
  const added = rows[2];
  assert.equal(added.cells[0], created.id, '新行编号应与成功提示、创建结果一致');
  assert.equal(added.cells[1], TRIMMED_NAME, '新行名称应去掉首尾空白并保留内部空格与表情');
  assert.equal(added.cells[2], '飞行棋');
  assert.equal(added.cells[3], '4 人');
  assert.equal(added.cells[4], '60 秒');
  assert.equal(added.badge, '未开始');
  assert.equal(added.timeTitle, created.createdAt, '新行创建时间应与创建结果一致');

  // 服务端只在原有记录之后追加这一条，已有记录及其附带字段保持原值。
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, 3, '服务端应只新增本次创建的一条记录');
  assert.deepEqual(
    serverRooms.slice(0, 2),
    [JSON.parse(SEED_ALPHA), JSON.parse(SEED_BETA)],
    '已有记录及其附带字段应保持原值',
  );
  assert.deepEqual(serverRooms[2], created, '列表查询的末条记录应与创建结果一致');

  // 成功后表单恢复初始填写状态：名称和时间为空，规则未选择，人数不可填写；
  // 请求完成后创建按钮仍可使用。
  assert.deepEqual(await readFormState(page), RESET_FORM, '成功后表单应恢复初始填写状态');
});
