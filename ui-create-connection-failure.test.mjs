// 首页“创建公开房间”在创建请求连接失败时的界面回归测试。
//
// 与其他浏览器回归文件的分工：
//   - ui.test.mjs：创建成功/被拒（服务返回业务原因）、成功后列表竞态刷新、
//     名称整理与长度边界；
//   - ui-capacity-linkage.test.mjs / ui-turn-seconds.test.mjs / ui-mixed-records.test.mjs：
//     人数联动、时间限制与混合记录展示；
//   - 本文件只盯住“创建请求尚未送达服务就连接失败”这一条路径：此时没有服务端
//     返回的业务拒绝原因，也没有已确认的新房间编号，页面必须沿用现有的连接失败
//     反馈（“无法连接服务，请确认服务仍在运行后重试。”），不能显示成输入错误
//     或房间列表读取失败。
//
// 覆盖的产品行为：
//   1. 用户先看到正常加载的已有房间，再填写一份合法的飞行棋配置（4 人、60 秒、
//      名称含首尾空格、内部空格与表情）；
//   2. 提交进入等待时创建按钮暂时不可用；连接失败后表单区域显示连接失败提示，
//      按钮恢复可用；名称保持输入时的原貌，规则、人数、时间全部保留，人数选择
//      仍然可用，不退回“未选择规则”的初始状态；
//   3. 房间列表保留提交前的内容与排列次序，不出现新房间、成功提示或虚假编号；
//      服务端查询到的房间记录没有增加，已有记录及其附带字段保持原值；
//   4. 连接恢复后用户不刷新页面、不重新填写，直接再次提交即可正常创建：新房间
//      使用保留的飞行棋/4 人/60 秒配置，名称仅去掉首尾空白（内部空格与表情保留），
//      成功提示中的非空编号与服务端返回一致，列表在已有记录之后展示新房间且原有
//      记录内容与次序不变；连接失败提示被成功结果替换，表单恢复初始填写状态
//      （名称/时间为空、规则未选择、人数不可填写），创建按钮仍可使用。
//
// 失败条件限定为“请求未送达服务”（用请求拦截在请求发出前中止来模拟，并以
// 服务端记录数不变佐证请求确实没有到达）；响应途中断开时房间是否已保存不在
// 本文件的判断范围内。既有区分继续保留：服务已确认创建成功、仅后续列表刷新
// 连接失败时，仍保留成功提示及编号，不按创建连接失败处理（本文件第二个用例
// 在连接层面覆盖这一区分，HTTP 层由 ui.test.mjs 覆盖）。
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

// 与其他界面回归文件相同的种子记录：带附带字段（note/tags/extra），
// 用于验证连接失败与恢复后成功创建的整个过程中，原有房间的内容、
// 次序与附带字段保持不变。
const SEED_ALPHA =
  '{"id":"seed-alpha","name":"晨间飞行棋","game":"ludo","capacity":4,"turnSeconds":30,' +
  '"status":"playing","visibility":"public","createdAt":"2026-01-01T08:00:00Z","note":"保留我","tags":["老友","周赛"]}';
const SEED_BETA =
  '{"id":"seed-beta","name":"午夜五子棋","game":"gomoku","capacity":2,"turnSeconds":0,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-01-02T23:00:00Z","extra":{"rank":3}}';

const SUCCESS_PREFIX = '房间已创建，编号：';
const CONN_FAILURE_TEXT = '无法连接服务，请确认服务仍在运行后重试。';
const LIST_ERROR_TEXT = '房间列表加载失败，请稍后刷新重试。已有数据不会因此丢失。';

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

// 每个用例使用独立的数据目录、服务进程与页面，互不影响；打开页面时已有两条
// 种子房间正常加载，用于比对连接失败前后的列表内容与次序。
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

function readListArea(page) {
  return page.evaluate(() => ({
    text: document.getElementById('list-area').textContent,
    hasTable: !!document.querySelector('#list-area table'),
    errorText: document.querySelector('#list-area .list-error')
      ? document.querySelector('#list-area .list-error').textContent
      : null,
    emptyText: document.querySelector('#list-area .empty')
      ? document.querySelector('#list-area .empty').textContent
      : null,
  }));
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

// 断言两条种子房间渲染正确（内容、次序、附带字段不影响展示）。
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

// 填写合法的飞行棋表单：4 人、60 秒，名称含首尾空格、内部空格与表情。
const RAW_NAME = '  周末 飞行棋 🎲 友谊赛  ';
const TRIMMED_NAME = '周末 飞行棋 🎲 友谊赛';

async function fillLudoForm(page) {
  await page.type('#name', RAW_NAME);
  await page.select('#game', 'ludo');
  await page.waitForFunction(
    () => !document.getElementById('capacity').disabled,
    { timeout: 5000 },
  );
  await page.select('#capacity', '4');
  await page.type('#turnSeconds', '60');
}

// 主用例：创建请求尚未送达服务就连接失败 → 保留填写内容 → 连接恢复后直接
// 再次提交成功。覆盖从等待、连接失败到恢复后成功提交的实际页面变化，
// 不能只确认错误文案出现。
test('创建请求未送达服务的连接失败：保留填写内容，恢复后不刷新页面直接重提交成功', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);

  // 用户先看到正常加载的已有房间。
  const initialRows = await readRows(page);
  assertSeedRows(initialRows);
  const seedRooms = await readServerRooms(baseURL);
  assert.equal(seedRooms.length, 2);

  // 记录页面尝试发出的每一次创建请求体（含将被中止的第一次），
  // 用于区分“页面尝试发送”与“请求真正送达服务”。
  const postBodies = [];
  // 第一次创建请求在送达服务前被中止（模拟连接失败），其余请求照常放行。
  let failFirstPost = true;
  let abortFirstPost;
  const firstPostInFlight = new Promise((resolve) => { abortFirstPost = resolve; });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/rooms')) {
      postBodies.push(req.postData());
      if (failFirstPost) {
        failFirstPost = false;
        // 挂起请求以观察等待状态，测试手动中止；中止发生在请求发出前，
        // 服务端不会收到这次创建。
        firstPostInFlight.then(() => req.abort());
        return;
      }
    }
    req.continue();
  });

  // 填写一份合法的飞行棋配置：4 人、60 秒，名称含首尾空格、内部空格与表情。
  await fillLudoForm(page);
  await page.click('#submit');

  // 提交进入等待：创建按钮暂时不可用，且不是瞬间恢复。
  await page.waitForFunction(
    () => document.getElementById('submit').disabled,
    { timeout: 5000 },
  );
  await sleep(300);
  assert.equal(
    (await readFormState(page)).submitDisabled,
    true,
    '提交等待期间创建按钮应保持不可用',
  );

  // 请求尚未送达服务就连接失败。
  abortFirstPost();

  // 表单区域显示现有的连接失败反馈：不是输入错误，也不是列表读取失败。
  await waitForMessageKind(page, 'error');
  const msg = await readMessage(page);
  assert.equal(msg.text, CONN_FAILURE_TEXT, '应显示现有的连接失败提示');
  assert.ok(msg.className.includes('error'), '连接失败提示应以错误样式显示在表单区域');
  assert.ok(!msg.className.includes('ok'), '连接失败时不应显示成功提示');
  assert.ok(!msg.text.includes(SUCCESS_PREFIX), '连接失败时不应出现成功编号');
  assert.ok(!msg.text.includes('已创建'), '连接失败时不应出现成功文案');

  // 名称保持输入时的原貌，规则、人数、时间全部保留，人数选择仍然可用，
  // 不因失败恢复成未选择规则的初始状态；按钮恢复可用。
  assert.deepEqual(await readFormState(page), {
    name: RAW_NAME,
    game: 'ludo',
    capacity: '4',
    capacityDisabled: false,
    turnSeconds: '60',
    submitDisabled: false,
  }, '连接失败后应保留全部已填内容并恢复按钮可用');

  // 房间列表保留提交前的内容和排列次序：不出现新房间，也不被换成加载失败。
  assert.deepEqual(await readRows(page), initialRows, '连接失败时不应改动房间列表');
  let list = await readListArea(page);
  assert.ok(list.hasTable, '连接失败时已有房间列表应保留');
  assert.equal(list.errorText, null, '创建连接失败不应显示成房间列表读取失败');
  assert.ok(!list.text.includes('加载失败'), '列表区域不应出现加载失败文案');

  // 服务端查询到的房间记录没有增加，已有记录及其附带字段保持原值
  // （同时佐证第一次创建请求确实没有送达服务）。
  assert.deepEqual(
    await readServerRooms(baseURL),
    seedRooms,
    '连接失败后服务端记录不应增加，已有记录及附带字段保持原值',
  );

  // 连接恢复：用户不刷新页面、不重新填写，直接再次提交。
  const createdPromise = nextCreated(page);
  await page.click('#submit');

  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  // 重试只使用保留的配置发出请求，名称仍是输入时的原貌（页面侧不裁剪）。
  assert.equal(postBodies.length, 2, '应先后尝试两次创建请求');
  assert.deepEqual(JSON.parse(postBodies[1]), {
    name: RAW_NAME,
    game: 'ludo',
    capacity: 4,
    turnSeconds: 60,
  }, '重试请求应沿用保留的填写内容');

  // 新房间使用保留的飞行棋、4 人、60 秒配置；名称仅去掉首尾空白，
  // 内部空格与表情保留。
  assert.ok(created.id, '创建结果应包含非空的新房间编号');
  assert.equal(created.name, TRIMMED_NAME, '名称应仅去掉首尾空白，保留内部空格与表情');
  assert.equal(created.game, 'ludo');
  assert.equal(created.capacity, 4);
  assert.equal(created.turnSeconds, 60);
  assert.equal(created.status, 'waiting');
  assert.equal(created.visibility, 'public');

  // 连接失败提示被成功结果替换，成功提示中的编号与服务端返回的新房间一致。
  const msg2 = await readMessage(page);
  assert.ok(msg2.className.includes('ok'), '连接失败提示应被成功结果替换');
  assert.ok(msg2.text.startsWith(SUCCESS_PREFIX), `应显示成功提示，实际: ${msg2.text}`);
  assert.ok(!msg2.text.includes(CONN_FAILURE_TEXT), '成功结果不应残留连接失败提示');
  assert.equal(
    msg2.text.slice(SUCCESS_PREFIX.length),
    created.id,
    '成功提示中的编号应与服务端返回的新房间一致',
  );

  // 表单恢复初始填写状态：名称和时间为空，规则未选择，人数不可填写。
  assert.deepEqual(await readFormState(page), RESET_FORM, '成功后表单应恢复初始填写状态');

  // 列表刷新后在已有记录之后展示新房间，原有记录的内容和次序不变。
  await waitForRowCount(page, 3);
  const rows = await readRows(page);
  assert.deepEqual(rows.slice(0, 2), initialRows, '原有房间的内容或次序被改变');
  const added = rows[2];
  assert.equal(added.cells[0], created.id, '新行编号应与创建结果一致');
  assert.equal(added.cells[1], TRIMMED_NAME, '新行名称应仅去掉首尾空白并保留内部空格与表情');
  assert.equal(added.cells[1], created.name, '新行名称应与创建结果一致');
  assert.equal(added.cells[2], '飞行棋');
  assert.equal(added.cells[3], '4 人');
  assert.equal(added.cells[4], '60 秒');
  assert.equal(added.cells[5], '未开始');
  assert.equal(added.badge, '未开始', '状态应以徽标显示“未开始”');
  assert.equal(added.timeTitle, created.createdAt, '新行创建时间应与创建结果一致');

  // 服务端仅在原有记录之后追加这一条，已有记录及附带字段保持原值。
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, 3, '服务端应只新增这一条房间');
  assert.deepEqual(serverRooms.slice(0, 2), seedRooms, '已有记录及附带字段应保持原值');
  assert.equal(serverRooms[2].id, created.id);
  assert.equal(serverRooms[2].name, TRIMMED_NAME);
  assert.equal(serverRooms[2].game, 'ludo');
  assert.equal(serverRooms[2].capacity, 4);
  assert.equal(serverRooms[2].turnSeconds, 60);

  // 请求完成后创建按钮仍可使用。
  assert.equal(
    (await readFormState(page)).submitDisabled,
    false,
    '请求完成后创建按钮应恢复可用',
  );
});

// 既有区分在连接层面的保留：服务已确认创建成功、仅后续列表刷新连接失败时，
// 仍保留成功提示及编号，不按创建连接失败处理；列表区域显示加载失败。
test('创建成功但列表刷新连接失败：保留成功提示与编号，不按创建连接失败处理', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const initialRows = await readRows(page);
  assertSeedRows(initialRows);

  // 页面正常加载后，仅让后续的列表读取连接失败（请求在送达前被中止）；
  // 创建请求照常放行到真实服务。
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.method() === 'GET' && req.url().endsWith('/api/rooms')) {
      req.abort();
    } else {
      req.continue();
    }
  });

  const createdPromise = nextCreated(page);
  await page.type('#name', '刷新连接失败的房间');
  await page.select('#game', 'gomoku');
  await page.waitForFunction(
    () => !document.getElementById('capacity').disabled &&
      document.getElementById('capacity').value === '2',
    { timeout: 5000 },
  );
  await page.type('#turnSeconds', '0');
  await page.click('#submit');

  // 创建已被服务确认成功：成功提示与非空编号保留，不显示连接失败文案。
  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;
  assert.ok(created.id, '创建结果应包含新房间编号');
  const msg = await readMessage(page);
  assert.ok(msg.text.startsWith(SUCCESS_PREFIX), `应保留创建成功提示，实际: ${msg.text}`);
  assert.equal(msg.text.slice(SUCCESS_PREFIX.length), created.id, '提示编号应与创建结果一致');
  assert.ok(!msg.text.includes(CONN_FAILURE_TEXT), '已确认成功的创建不应显示连接失败提示');

  // 表单仍按成功处理（恢复初始填写状态）。
  assert.deepEqual(await readFormState(page), RESET_FORM, '列表刷新连接失败不应影响已成功创建的表单处理');

  // 列表区域明确显示加载失败，而不是空列表提示或旧内容。
  await page.waitForFunction(
    () => !!document.querySelector('#list-area .list-error'),
    { timeout: 10000 },
  );
  const list = await readListArea(page);
  assert.equal(list.errorText, LIST_ERROR_TEXT);
  assert.equal(list.emptyText, null, '列表刷新连接失败时不得显示“还没有房间记录”');
  assert.ok(!list.hasTable, '列表刷新连接失败时不应展示旧表格冒充最新列表');

  // 列表读取连接失败落定后，成功提示与编号仍然保留，未被改写成创建失败。
  const msgAfter = await readMessage(page);
  assert.ok(msgAfter.className.includes('ok'), '列表刷新连接失败不应把已完成的创建说成失败');
  assert.equal(msgAfter.text, msg.text, '成功提示与编号应保留');
  assert.equal((await readFormState(page)).submitDisabled, false, '本次操作完成后创建按钮应恢复可用');

  // 服务端确实已保存本次创建（证明创建本身成功，只是刷新连接失败）。
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, 3, '服务端应已保存新房间');
  assert.equal(serverRooms[2].id, created.id, '服务端保存的编号应与页面提示一致');
});
