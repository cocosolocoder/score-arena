// 首页“创建公开房间”在服务无法完成保存（保存失败）时的界面回归测试。
//
// 与其他浏览器回归文件的分工：
//   - ui.test.mjs：创建被服务以 400 拒绝（输入/配置错误）时显示服务端原因；
//   - ui-create-connection-failure.test.mjs：创建请求“尚未送达服务”就连接失败，
//     此时没有服务端返回，页面只能提示“无法连接服务”；
//   - ui-create-unconfirmed.test.mjs：服务已返回 201 成功状态但创建结果未能确认；
//   - 本文件盯住另一种必须区分开的情况：房间列表已经正常读出、用户提交的配置
//     完全合法，但服务在“保存新房间”这一步失败。此时请求已真实到达服务、服务
//     返回 500 与保存方面的具体原因，页面必须把该原因原样显示在创建表单附近，
//     不能要求用户修改本来合法的名称、规则、人数或时间，不能显示成“无法连接
//     服务”“房间已创建”或“创建结果未能确认”，也不能改动已填内容与已有列表。
//
// 覆盖的产品行为：
//   1. 用户先看到正常加载的已有房间，再填写一份合法的飞行棋配置（4 人、60 秒、
//      名称含首尾空格、内部空格与表情）；
//   2. 提交处理期间创建按钮不可用；服务确认保存失败（真实 500，error 说明失败
//      原因，不返回成功房间或新编号）后，表单附近原样显示服务给出的原因，
//      处理结束按钮恢复可用；
//   3. 失败不清空填写：名称仍保持输入时的首尾空白，规则、人数、时间保持原值，
//      飞行棋的人数选项仍可使用；列表行与次序不变，不临时增加新行、不换成
//      空列表或加载失败；服务端记录、本地 rooms.json 逐字节不变，不留半条
//      新房间或临时文件，且页面不自动重试；
//   4. 保存条件恢复后，用户停留在同一页面，不刷新、不重新填写，直接再次提交：
//      按保留的配置真实创建成功，成功提示给出这次真正保存的编号，列表只在旧
//      房间之后增加这一条，先前失败的提交不会后来补成另一条；新房间名称只去
//      首尾空白（内部空格与表情保留），规则、人数、时间与提交一致，状态仍为
//      未开始；等待期间没有修改填写时，成功后表单按现有行为恢复初始状态。
//
// 失败条件用真实服务制造：数据文件保持可读（GET 列表正常），仅把数据目录改为
// 不可写，服务写临时文件必然失败并返回真正的 500；恢复目录写权限即代表保存
// 条件恢复。请求拦截只在第一次提交时“延迟放行”，以便观察提交处理期间的按钮
// 状态——请求仍真实到达服务，响应是服务自己给出的真实 500，不由测试伪造。
//
// 运行：npm test（需要系统 Chrome，可用 CHROME_PATH 指定路径）。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
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
// 用于验证保存失败与恢复后成功创建的整个过程中，原有房间的编号、配置、
// 状态、创建时间、次序与附带字段保持不变。
const SEED_ALPHA =
  '{"id":"seed-alpha","name":"晨间飞行棋","game":"ludo","capacity":4,"turnSeconds":30,' +
  '"status":"playing","visibility":"public","createdAt":"2026-01-01T08:00:00Z","note":"保留我","tags":["老友","周赛"]}';
const SEED_BETA =
  '{"id":"seed-beta","name":"午夜五子棋","game":"gomoku","capacity":2,"turnSeconds":0,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-01-02T23:00:00Z","extra":{"rank":3}}';

const SUCCESS_PREFIX = '房间已创建，编号：';
const UNCONFIRMED_TEXT = '创建结果未能确认';
const CONN_FAILURE_TEXT = '无法连接服务，请确认服务仍在运行后重试。';

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

// 用例使用独立的数据目录、服务进程与页面；打开页面时已有两条种子房间正常加载。
// 返回 dataDir 以便用例切换目录写权限并逐字节核对本地保存内容。
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

// nextPostResult 解析下一次创建响应的真实状态码与 JSON（这里是服务端真实 500）。
function nextPostResult(page) {
  return new Promise((resolve) => {
    const onResp = async (resp) => {
      if (resp.request().method() !== 'POST' || !resp.url().endsWith('/api/rooms')) return;
      page.off('response', onResp);
      let data = null;
      try {
        data = await resp.json();
      } catch {
        data = null;
      }
      resolve({ status: resp.status(), ok: resp.ok(), data });
    };
    page.on('response', onResp);
  });
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

async function readDataFile(dataDir) {
  return readFile(path.join(dataDir, 'rooms.json'));
}

async function readDataDirNames(dataDir) {
  return (await readdir(dataDir)).sort();
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
const WANT_PAYLOAD = { name: RAW_NAME, game: 'ludo', capacity: 4, turnSeconds: 60 };

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

// 主用例：合法提交但服务保存失败（真实 500）→ 原样提示保存原因、保留填写与
// 已有数据、不自动重试 → 保存条件恢复后不刷新页面直接重提交成功。
test('合法配置提交但服务保存失败：显示服务的保存原因并保留全部填写与已有数据，恢复后不刷新直接重提交成功', { timeout: 60000 }, async (t) => {
  const { page, baseURL, dataDir } = await setupPage(t);

  // 用户先看到正常加载的已有房间。
  const initialRows = await readRows(page);
  assertSeedRows(initialRows);
  const seedRoomsBefore = await readServerRooms(baseURL);
  assert.equal(seedRoomsBefore.length, 2);
  const fileBefore = await readDataFile(dataDir);
  assert.deepEqual(await readDataDirNames(dataDir), ['rooms.json'], '用例开始时数据目录应只有 rooms.json');

  // 记录页面发出的每一次创建请求体，并把第一次创建请求延迟放行为“在途”状态，
  // 以便观察处理期间按钮不可用。延迟不伪造任何响应：请求随后真实到达服务，
  // 由在只读数据目录上运行的服务自己返回真正的 500；第二次提交立即放行。
  const postBodies = [];
  let delayFirstPost = true;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/rooms')) {
      postBodies.push(req.postData());
      if (delayFirstPost) {
        delayFirstPost = false;
        setTimeout(() => { req.continue().catch(() => {}); }, 450);
        return;
      }
    }
    req.continue().catch(() => {});
  });

  // 数据文件保持可读，仅让数据目录不可写：服务读得到旧数据，但写临时文件
  // 必然失败，保存无法完成。测试以目录属主身份运行，仍可在恢复阶段改回权限。
  await chmod(dataDir, 0o555);
  t.after(async () => { await chmod(dataDir, 0o755).catch(() => {}); });

  // 填写一份完全合法的飞行棋配置并提交。
  await fillLudoForm(page);
  const failureResult = nextPostResult(page);
  await page.click('#submit');

  // 提交处理期间创建按钮不可用，且不是瞬间恢复（请求被延迟放行期间仍在途）。
  await page.waitForFunction(
    () => document.getElementById('submit').disabled,
    { timeout: 5000 },
  );
  await sleep(300);
  assert.equal(
    (await readFormState(page)).submitDisabled,
    true,
    '提交处理期间创建按钮应保持不可用',
  );

  // 服务真实确认保存失败：500、error 说明失败原因，不返回成功房间或新编号。
  const failure = await failureResult;
  assert.equal(failure.status, 500, '服务无法完成保存时应返回 500');
  assert.equal(typeof failure.data?.error, 'string', '500 响应应给出具体 error 原因');
  const serverReason = failure.data.error;
  assert.ok(serverReason.length > 0, '保存失败原因不能为空');
  assert.equal(failure.data.id, undefined, '保存失败不得返回新房间编号');
  assert.equal(failure.data.name, undefined, '保存失败不得返回成功房间');

  // 页面在创建表单附近原样显示服务给出的原因。
  await waitForMessageKind(page, 'error');
  const msg = await readMessage(page);
  assert.equal(msg.text, serverReason, '应原样显示服务给出的保存失败原因');
  assert.ok(msg.className.includes('error'), '保存失败原因应以错误样式显示在表单区域');
  assert.ok(!msg.className.includes('ok'), '保存失败不应显示成功提示');
  assert.ok(!msg.className.includes('warn'), '保存失败不应显示成“结果未能确认”提醒');
  assert.ok(!msg.text.includes(SUCCESS_PREFIX), '保存失败时不应出现成功编号');
  assert.ok(!msg.text.includes('已创建'), '保存失败时不应出现“房间已创建”文案');
  assert.ok(!msg.text.includes(UNCONFIRMED_TEXT), '保存失败不应显示成“创建结果未能确认”');
  assert.ok(!msg.text.includes('无法连接服务'), '已收到服务 500 响应，不能显示成无法连接服务');

  // 原因必须指向保存环节，而不是要求用户修改本来合法的名称、规则、人数或时间。
  assert.ok(/失败/.test(serverReason), '原因应说明保存失败');
  assert.ok(/数据|保存|临时/.test(serverReason), '原因应指向房间数据保存环节');
  for (const inputPhrase of ['不能为空', '必须为', '只能', '超过 40', '未知游戏规则']) {
    assert.ok(!serverReason.includes(inputPhrase), `保存失败不能要求修改合法输入，原因里不应出现“${inputPhrase}”`);
  }

  // 失败不清空填写：名称仍保持输入时的首尾空白，规则、人数、时间保持原值，
  // 飞行棋的人数选项仍可使用；处理结束后按钮恢复可用。
  assert.deepEqual(await readFormState(page), {
    name: RAW_NAME,
    game: 'ludo',
    capacity: '4',
    capacityDisabled: false,
    turnSeconds: '60',
    submitDisabled: false,
  }, '保存失败后应保留全部已填内容（含名称首尾空白）并恢复按钮可用');

  // 保存失败期间已有房间数据仍能正常读取（GET 仍是 200，内容不变）。
  const roomsDuringFailure = await readServerRooms(baseURL);
  assert.deepEqual(roomsDuringFailure, seedRoomsBefore, '保存失败时已有房间仍应原样可读');

  // 已展示的房间行与次序保持不变：不凭提交内容临时增加新行，不换成空列表
  // 提示或列表加载失败。
  assert.deepEqual(await readRows(page), initialRows, '保存失败时不应改动房间列表');
  const list = await readListArea(page);
  assert.ok(list.hasTable, '保存失败时已有房间表格应保留');
  assert.equal(list.errorText, null, '保存失败不应显示成房间列表读取失败');
  assert.equal(list.emptyText, null, '保存失败时不得显示空列表提示');
  assert.ok(!list.text.includes('加载失败'), '列表区域不应出现加载失败文案');

  // 服务端记录不增加；本地保存内容逐字节不变，目录里不留半条新房间或临时文件。
  assert.deepEqual(
    await readServerRooms(baseURL),
    seedRoomsBefore,
    '保存失败后服务端记录不应增加，编号、配置、状态、创建时间与附带字段保持原值',
  );
  const fileAfterFailure = await readDataFile(dataDir);
  assert.ok(fileAfterFailure.equals(fileBefore), '保存失败不得改写本地 rooms.json');
  assert.deepEqual(await readDataDirNames(dataDir), ['rooms.json'], '保存失败不得留下临时文件');

  // 页面只发出过这一次创建请求，不做自动重试。
  assert.equal(postBodies.length, 1, '保存失败后不应自动重试');
  assert.deepEqual(JSON.parse(postBodies[0]), WANT_PAYLOAD, '失败请求体应是用户提交的合法配置（名称保留首尾空白）');

  // 保存条件恢复：数据目录重新可写。用户留在同一页面，不刷新、不重新填写，
  // 直接再次提交。
  await chmod(dataDir, 0o755);
  const createdPromise = nextCreated(page);
  await page.click('#submit');

  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  // 重试沿用保留的配置，名称仍是输入时原貌（页面侧不裁剪），共两次手动提交。
  assert.equal(postBodies.length, 2, '应先后手动提交两次创建请求，失败那次不自动补发');
  assert.deepEqual(JSON.parse(postBodies[1]), WANT_PAYLOAD, '重试请求应沿用保留的填写内容');

  // 这次真正保存成功：非空编号、名称只去首尾空白（内部空格与表情保留），
  // 规则、人数、时间与提交一致，状态仍为未开始、公开范围不变。
  assert.ok(created.id, '创建结果应包含非空的新房间编号');
  assert.equal(created.name, TRIMMED_NAME, '名称应仅去掉首尾空白，保留内部空格与表情');
  assert.equal(created.game, 'ludo');
  assert.equal(created.capacity, 4);
  assert.equal(created.turnSeconds, 60);
  assert.equal(created.status, 'waiting');
  assert.equal(created.visibility, 'public');

  // 保存失败原因被成功结果替换，成功提示中的编号就是本次真正保存的编号。
  const msg2 = await readMessage(page);
  assert.ok(msg2.className.includes('ok'), '保存失败提示应被成功结果替换');
  assert.ok(msg2.text.startsWith(SUCCESS_PREFIX), `应显示成功提示，实际: ${msg2.text}`);
  assert.ok(!msg2.text.includes(serverReason), '成功结果不应残留保存失败原因');
  assert.ok(!msg2.text.includes(UNCONFIRMED_TEXT), '成功结果不应残留“未能确认”提醒');
  assert.equal(
    msg2.text.slice(SUCCESS_PREFIX.length),
    created.id,
    '成功提示中的编号应与服务端本次真正保存的新房间一致',
  );

  // 列表只在旧房间之后增加这一条记录；先前失败的提交没有补成另一条。
  await waitForRowCount(page, 3);

  // 等待期间用户没有修改填写：成功后表单按现有行为恢复初始状态。按钮按既有
  // 约定在创建成功“及随后的列表刷新落定后”才恢复可用，因此在等到新行出现
  // （列表刷新已渲染）后再核对整份复位状态，避免抢在刷新落定前读取。
  assert.deepEqual(await readFormState(page), RESET_FORM, '成功后表单应恢复初始填写状态');

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

  // 服务端只在原有记录之后追加这一条，已有记录及备注、数组、嵌套对象保持原值。
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, 3, '服务端应只新增这一条房间（失败提交不占记录）');
  assert.deepEqual(serverRooms.slice(0, 2), seedRoomsBefore, '已有记录及附带字段应保持原值');
  assert.equal(serverRooms[2].id, created.id);
  assert.equal(serverRooms[2].name, TRIMMED_NAME);
  assert.equal(serverRooms[2].game, 'ludo');
  assert.equal(serverRooms[2].capacity, 4);
  assert.equal(serverRooms[2].turnSeconds, 60);
  assert.equal(serverRooms[2].status, 'waiting');

  // 本地保存同样只追加这一条，原有两条逐字不变，且没有遗留临时文件。
  const finalFile = await readDataFile(dataDir);
  assert.ok(!fileBefore.equals(finalFile), '成功创建后本地文件应包含新房间');
  const savedRecords = JSON.parse(finalFile.toString('utf8'));
  assert.equal(savedRecords.length, 3, '本地保存应只有旧记录加新房间一条');
  assert.equal(savedRecords[0].id, 'seed-alpha');
  assert.equal(savedRecords[0].note, '保留我');
  assert.deepEqual(savedRecords[0].tags, ['老友', '周赛']);
  assert.equal(savedRecords[1].id, 'seed-beta');
  assert.deepEqual(savedRecords[1].extra, { rank: 3 });
  assert.equal(savedRecords[2].id, created.id);
  assert.deepEqual(await readDataDirNames(dataDir), ['rooms.json'], '创建完成后不应遗留临时文件');

  // 请求完成后创建按钮仍可使用。
  assert.equal(
    (await readFormState(page)).submitDisabled,
    false,
    '请求完成后创建按钮应恢复可用',
  );
});
