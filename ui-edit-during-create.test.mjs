// 首页“创建公开房间”在“提交后、创建结果返回前继续修改表单”这段使用过程的
// 界面回归测试。
//
// 与其他浏览器回归文件的分工：
//   - ui.test.mjs：创建成功/被拒的基础路径、成功后列表竞态刷新、名称整理边界；
//   - ui-capacity-linkage.test.mjs：规则与人数联动本身；
//   - ui-create-connection-failure.test.mjs：创建请求未送达服务的连接失败；
//   - 本文件只盯住“点击创建房间后、结果返回前继续编辑四项”这一段：
//
// 覆盖的产品行为：
//   1. 等待期间名称、规则、人数、时间四项仍可编辑（联动照常），但本次创建固定
//      使用点击提交瞬间的配置快照；等待期间的输入既不混入已发出的请求，也不会
//      自动再创建一间房（整个过程只有一次创建请求）。
//   2. 创建成功时，提示编号与列表新房间都对应“提交时”的配置（名称按现有规则
//      去掉首尾空白）；是否清空表单，以创建结果返回时页面上的“实际填写值”为准：
//        a. 任一项与提交时不同（含只改了名称首尾空白、即使整理后保存名相同），
//           四项整体保留——未改的项不回退旧值、已清空的项保持清空、未填完整不
//           自动补齐，提示同时说明“已创建成功、当前填写尚未提交”，用户可直接
//           继续编辑或再次提交，且再次提交才会用当前配置创建下一间；
//        b. 等待期间改过、随后把四项全部恢复成提交时原样，仍恢复初始表单
//           （名称/时间为空、规则未选、人数不可填写）。
//   3. 保留下来的规则与人数继续符合联动（五子棋固定 2 人、飞行棋 2~4 人、
//      未选规则时人数不可填写）。
//   4. 创建被服务拒绝：显示服务给出的原因、不出现成功编号、已有列表原样；
//      等待期间的最新四项保留，不回退到提交时的内容。
//   5. 提交等待以及随后列表刷新完成前，创建按钮保持不可用，回车等方式也不能
//      触发第二次提交；本次处理完成后按钮恢复可用，保留的填写继续按现有规则校验。
//
// 用请求拦截把创建请求（POST）挂起，在其在途期间稳定地编辑表单；需要同时观察
// “列表刷新完成前按钮仍禁用”时，再把创建成功后触发的列表刷新（GET）一并挂起。
// 拦截在页面首次加载完成后才启用，因此被挂起的 GET 只会是创建后的刷新查询。
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

// 与其他界面回归文件相同的两条种子记录，用于比对创建前后列表内容与次序。
const SEED_ALPHA =
  '{"id":"seed-alpha","name":"晨间飞行棋","game":"ludo","capacity":4,"turnSeconds":30,' +
  '"status":"playing","visibility":"public","createdAt":"2026-01-01T08:00:00Z","note":"保留我","tags":["老友","周赛"]}';
const SEED_BETA =
  '{"id":"seed-beta","name":"午夜五子棋","game":"gomoku","capacity":2,"turnSeconds":0,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-01-02T23:00:00Z","extra":{"rank":3}}';

const SUCCESS_PREFIX = '房间已创建，编号：';
// 成功但表单被整体保留时，提示中必须说明当前填写尚未提交、不会自动创建。
const PENDING_NOTICE = '尚未提交';
// 被服务拒绝时由“服务”给出的具体原因（页面应原样显示）。
const REJECT_REASON = '服务端拒绝：本场赛事房间数量已达上限';

// 创建成功且四项与提交时一致时的初始表单状态。
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

// 每个用例独立的数据目录、服务进程与页面；打开页面时两条种子房间已正常加载。
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

// 创建按钮要等“创建响应 + 随后的列表刷新”都落定后才恢复可用。
function waitButtonEnabled(page) {
  return page.waitForFunction(
    () => !document.getElementById('submit').disabled,
    { timeout: 10000 },
  );
}

// 只比较四项填写值与人数可填状态（不含按钮状态）：用于创建响应刚返回、
// 列表刷新尚未完成的时刻。
function readFourFields(page) {
  return page.evaluate(() => ({
    name: document.getElementById('name').value,
    game: document.getElementById('game').value,
    capacity: document.getElementById('capacity').value,
    capacityDisabled: document.getElementById('capacity').disabled,
    turnSeconds: document.getElementById('turnSeconds').value,
  }));
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

// 四项输入控件本身在等待期间是否仍可编辑（人数是否可填随规则联动单独判断）。
function readEditable(page) {
  return page.evaluate(() => ({
    nameDisabled: document.getElementById('name').disabled,
    gameDisabled: document.getElementById('game').disabled,
    turnDisabled: document.getElementById('turnSeconds').disabled,
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

// 等待下一次创建响应并解析为创建结果对象。
function waitCreateResponse(page) {
  return new Promise((resolve, reject) => {
    const handler = (resp) => {
      if (resp.request().method() === 'POST' && resp.url().endsWith('/api/rooms')) {
        page.off('response', handler);
        resp.json().then(resolve, reject);
      }
    };
    page.on('response', handler);
  });
}

// installGate 在页面首次加载完成后启用请求拦截：
//   - 第一个创建请求（POST）始终挂起，交由测试在“等待期间编辑表单”之后决定
//     放行到真实服务（releasePost）或直接由服务拒绝（rejectPost）；
//   - continueRest: 后续 POST 立即放行到真实服务（用于同一用例里再次提交）；
//   - holdRefresh: 创建成功后触发的列表刷新（GET）同样挂起，用于观察“刷新
//     完成前按钮仍禁用”；其余 GET（本文件里没有）正常放行。
// postBodies 记录每次创建请求实际发出的请求体（即点击提交瞬间的配置快照）。
async function installGate(page, { continueRest = false, holdRefresh = false } = {}) {
  const postBodies = [];
  let heldPost = null;
  let heldRefresh = null;
  let refreshCount = 0;

  // 轮询等待，避免“事件在注册 waiter 之前就已触发”的竞态（点击 await 返回时
  // 请求可能已经挂起）。与 ui.test.mjs 的 gate.waitFor 同一做法。
  async function waitUntil(predicate, message) {
    const deadline = Date.now() + 10000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(message);
      await sleep(15);
    }
  }

  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const isPost = req.method() === 'POST' && req.url().endsWith('/api/rooms');
    const isRoomsGet = req.method() === 'GET' && req.url().endsWith('/api/rooms');
    if (isPost) {
      postBodies.push(req.postData());
      // 第一个 POST 挂起；配置了 continueRest 时，再次提交直接放行。
      if (postBodies.length > 1 && continueRest) {
        req.continue();
        return;
      }
      heldPost = req;
      return;
    }
    if (isRoomsGet && holdRefresh) {
      heldRefresh = req;
      refreshCount += 1;
      return;
    }
    req.continue();
  });

  return {
    postBodies,
    // 等待第一次创建请求真正发出并处于挂起状态。
    waitPostHeld: () =>
      waitUntil(() => heldPost !== null, '等待挂起的创建请求超时'),
    waitRefreshHeld: () =>
      waitUntil(() => refreshCount >= 1 && heldRefresh !== null, '等待挂起的列表刷新超时'),
    async releasePost() {
      const req = heldPost;
      heldPost = null;
      await req.continue();
    },
    async rejectPost(status, body) {
      const req = heldPost;
      heldPost = null;
      await req.respond({
        status,
        contentType: 'application/json; charset=utf-8',
        body: JSON.stringify(body),
      });
    },
    async releaseRefresh() {
      const req = heldRefresh;
      heldRefresh = null;
      await req.continue();
    },
  };
}

// ---- 表单操作：直接设置 value 后触发的读取与真实输入一致（页面仅在提交与
// 响应到达时读取 value，不监听 input）；规则切换走 select 以触发 change 联动。----
async function setName(page, value) {
  await page.$eval('#name', (el) => { el.value = ''; });
  if (value !== '') await page.type('#name', value);
}
async function setTurn(page, value) {
  await page.$eval('#turnSeconds', (el) => { el.value = ''; });
  if (value !== '') await page.type('#turnSeconds', String(value));
}
async function chooseGame(page, game) {
  await page.select('#game', game);
  if (game === 'gomoku') {
    await page.waitForFunction(
      () => {
        const c = document.getElementById('capacity');
        return !c.disabled && c.value === '2';
      },
      { timeout: 5000 },
    );
  } else if (game === 'ludo') {
    await page.waitForFunction(() => !document.getElementById('capacity').disabled, { timeout: 5000 });
  } else {
    await page.waitForFunction(() => document.getElementById('capacity').disabled, { timeout: 5000 });
  }
}
async function fillLudo(page, name, cap, sec) {
  await setName(page, name);
  await chooseGame(page, 'ludo');
  await page.select('#capacity', String(cap));
  await setTurn(page, sec);
}
async function fillGomoku(page, name, sec) {
  await setName(page, name);
  await chooseGame(page, 'gomoku');
  await setTurn(page, sec);
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

// 主路径：等待期间改动（并清空其中一项）→ 成功后四项整体保留、不自动补齐；
// 本次房间用提交时快照；再次提交才用当前保留（并继续编辑后）的配置创建下一间。
test('等待期间改名称并清空时间：本次按提交时配置创建，成功后四项整体保留；再次提交才创建下一间', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const initialRows = await readRows(page);
  assertSeedRows(initialRows);

  const gate = await installGate(page, { continueRest: true });

  // 提交时的配置（名称含首尾空白，验证保存时仅去首尾空白）。
  const NAME_A = '  等待期 飞行棋 房间  ';
  const NAME_A_TRIMMED = '等待期 飞行棋 房间';
  await fillLudo(page, NAME_A, 4, 60);

  const createdP1 = waitCreateResponse(page);
  await page.click('#submit');
  await gate.waitPostHeld();

  // 结果返回前：按钮不可用，但四项仍可编辑（名称/规则/时间未禁用，
  // 飞行棋下人数可选）。
  assert.equal((await readFormState(page)).submitDisabled, true, '等待期间创建按钮应不可用');
  assert.deepEqual(await readEditable(page), {
    nameDisabled: false, gameDisabled: false, turnDisabled: false,
  }, '等待期间名称、规则、时间仍应可编辑');
  assert.equal((await readFormState(page)).capacityDisabled, false, '飞行棋等待期间人数仍可选择');

  // 等待期间继续填写：改名，并把时间清空（规则/人数保持 ludo/4 不动）。
  const NAME_B = '尚未提交的新名称';
  await setName(page, NAME_B);
  await setTurn(page, '');

  // 放行本次创建：它必须使用点击提交时的快照，而不是等待期间的输入。
  await gate.releasePost();
  const created1 = await createdP1;

  assert.equal(gate.postBodies.length, 1, '等待期间的编辑不得触发额外创建请求');
  assert.deepEqual(JSON.parse(gate.postBodies[0]), {
    name: NAME_A, game: 'ludo', capacity: 4, turnSeconds: 60,
  }, '已发出的请求必须是点击提交时的配置');

  // 创建结果对应提交时配置：名称仅去首尾空白。
  assert.equal(created1.name, NAME_A_TRIMMED);
  assert.equal(created1.game, 'ludo');
  assert.equal(created1.capacity, 4);
  assert.equal(created1.turnSeconds, 60);

  // 成功提示：编号来自本次结果，并说明当前填写尚未提交、不会自动创建。
  const msg = await readMessage(page);
  assert.ok(msg.text.startsWith(SUCCESS_PREFIX + created1.id), `提示应含本次编号，实际: ${msg.text}`);
  assert.ok(msg.text.includes(PENDING_NOTICE), '提示应说明当前填写尚未提交');
  assert.ok(msg.text.includes('不会自动创建房间'), '提示应说明不会自动创建下一间房');

  // 四项整体保留：改名生效、时间保持清空（不补旧值/默认值），未改的规则/人数
  // 不回退。此刻列表刷新可能尚未完成，按钮仍可处于禁用；按钮恢复在刷新完成后
  // 单独断言。
  assert.deepEqual(await readFourFields(page), {
    name: NAME_B,
    game: 'ludo',
    capacity: '4',
    capacityDisabled: false,
    turnSeconds: '',
  }, '成功后应整体保留当前四项，已清空项保持清空、未改项不回退');

  // 列表新房间对应提交时配置，原有两条不变；服务端只新增这一间。
  await waitForRowCount(page, 3);
  await waitButtonEnabled(page);
  assert.equal((await readFormState(page)).submitDisabled, false, '列表刷新完成后按钮应恢复可用');
  const rows1 = await readRows(page);
  assert.deepEqual(rows1.slice(0, 2), initialRows, '原有房间内容或次序被改变');
  assert.deepEqual(rows1[2].cells.slice(0, 6),
    [created1.id, NAME_A_TRIMMED, '飞行棋', '4 人', '60 秒', '未开始'],
    '列表新房间应对应提交时配置');
  const serverAfter1 = await readServerRooms(baseURL);
  assert.equal(serverAfter1.length, 3);
  assert.deepEqual(serverAfter1[2], created1, '服务端保存的房间应与创建结果一致');

  // 不会自动创建另一间：处理完成后仍只有一次创建请求。
  assert.equal(gate.postBodies.length, 1, '保留填写期间不得自动再发出创建请求');

  // 用户继续编辑（补上时间、改名）后再次提交，才用“当前配置”创建下一间。
  const NAME_C_RAW = '  下一间 飞行棋 ';
  const NAME_C_TRIMMED = '下一间 飞行棋';
  await setName(page, NAME_C_RAW);
  await setTurn(page, 100);
  const createdP2 = waitCreateResponse(page);
  await page.click('#submit');
  const created2 = await createdP2;

  assert.equal(gate.postBodies.length, 2, '再次提交应发出第二次创建请求');
  assert.deepEqual(JSON.parse(gate.postBodies[1]), {
    name: NAME_C_RAW, game: 'ludo', capacity: 4, turnSeconds: 100,
  }, '再次提交必须使用当前填写的配置');
  assert.equal(created2.name, NAME_C_TRIMMED);
  assert.equal(created2.game, 'ludo');
  assert.equal(created2.capacity, 4);
  assert.equal(created2.turnSeconds, 100);

  // 第二次等待期间没有再改，成功后按一致配置恢复初始表单。
  await waitForMessageKind(page, 'ok');
  await waitForRowCount(page, 4);
  await waitButtonEnabled(page);
  assert.deepEqual(await readFormState(page), RESET_FORM, '一致配置成功后应恢复初始表单');
  const rows2 = await readRows(page);
  assert.deepEqual(rows2.slice(0, 3), rows1, '前三个房间的内容或次序被改变');
  assert.deepEqual(rows2[3].cells.slice(0, 6),
    [created2.id, NAME_C_TRIMMED, '飞行棋', '4 人', '100 秒', '未开始']);
  const serverAfter2 = await readServerRooms(baseURL);
  assert.equal(serverAfter2.length, 4, '再次提交后服务端才新增第二间房');
});

// 等待期间改过四项、随后又全部恢复成提交时原样：仍恢复初始表单。
test('等待期间改过又把四项全部恢复原样：成功后仍恢复初始表单', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const initialRows = await readRows(page);

  const gate = await installGate(page);
  const NAME_D = '恢复原样的五子棋';
  await fillGomoku(page, NAME_D, 30);

  const createdP = waitCreateResponse(page);
  await page.click('#submit');
  await gate.waitPostHeld();

  // 先把四项都改乱（改名、五子棋切飞行棋并选 3 人、改时间）。
  await setName(page, '临时改的名字');
  await chooseGame(page, 'ludo');
  await page.select('#capacity', '3');
  await setTurn(page, 11);

  // 再把四项逐一恢复成提交时原样（切回五子棋时人数由联动固定回 2）。
  await setName(page, NAME_D);
  await chooseGame(page, 'gomoku');
  await setTurn(page, 30);

  await gate.releasePost();
  const created = await createdP;

  // 请求体始终是提交时快照。
  assert.deepEqual(JSON.parse(gate.postBodies[0]), {
    name: NAME_D, game: 'gomoku', capacity: 2, turnSeconds: 30,
  });
  assert.equal(created.name, NAME_D);

  // 四项与提交时一致（尽管中途改过）：恢复初始表单，提示不含“尚未提交”。
  const msg = await readMessage(page);
  assert.equal(msg.text, SUCCESS_PREFIX + created.id, '完全恢复后应只显示普通成功提示');
  assert.ok(!msg.text.includes(PENDING_NOTICE));
  await waitForRowCount(page, 3);
  await waitButtonEnabled(page);
  assert.deepEqual(await readFormState(page), RESET_FORM, '完全恢复后应恢复初始表单');
  const rows = await readRows(page);
  assert.deepEqual(rows.slice(0, 2), initialRows);
  assert.deepEqual(rows[2].cells.slice(0, 6),
    [created.id, NAME_D, '五子棋', '2 人', '30 秒', '未开始']);
  assert.equal((await readServerRooms(baseURL)).length, 3);
});

// 仅调整名称首尾空白：即使整理后的保存名称相同，输入也算变化，必须保留当前填写。
test('只改名称首尾空白（保存名相同）也算变化：成功后保留当前填写、不复位', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);

  const gate = await installGate(page);
  // 提交时名称带首尾空白；等待期间改成去掉空白的同一名字（保存名相同）。
  await fillLudo(page, '  同名房间  ', 3, 45);

  const createdP = waitCreateResponse(page);
  await page.click('#submit');
  await gate.waitPostHeld();
  await setName(page, '同名房间');
  await gate.releasePost();
  const created = await createdP;

  // 提交的仍是带空白的原始输入；服务端保存名恰好与当前显示相同。
  assert.equal(JSON.parse(gate.postBodies[0]).name, '  同名房间  ');
  assert.equal(created.name, '同名房间');

  // 只要实际填写值与提交时任一不同（哪怕只是首尾空白），就整体保留、不复位。
  assert.deepEqual(await readFourFields(page), {
    name: '同名房间',
    game: 'ludo',
    capacity: '3',
    capacityDisabled: false,
    turnSeconds: '45',
  }, '仅首尾空白变化也应保留当前四项');
  const msg = await readMessage(page);
  assert.ok(msg.text.startsWith(SUCCESS_PREFIX + created.id));
  assert.ok(msg.text.includes(PENDING_NOTICE), '应提示当前填写尚未提交');

  await waitForRowCount(page, 3);
  await waitButtonEnabled(page);
  assert.equal((await readServerRooms(baseURL)).length, 3, '不得因等待期编辑自动多建房间');
});

// 等待期间把表单改成“未填完整”（清空名称/时间、规则改回未选择）：成功后原样
// 保留这个不完整状态，不自动补齐，人数随未选规则恢复不可填写。
test('等待期间改成未填完整：成功后原样保留、不自动补齐，人数随空规则不可填写', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);

  const gate = await installGate(page);
  await fillGomoku(page, '将被清空的五子棋', 60);

  const createdP = waitCreateResponse(page);
  await page.click('#submit');
  await gate.waitPostHeld();

  // 清空名称与时间，规则切回“未选择”（联动使人数不可填写、值清空）。
  await setName(page, '');
  await setTurn(page, '');
  await chooseGame(page, '');

  await gate.releasePost();
  const created = await createdP;

  // 本次仍按提交时的完整配置创建。
  assert.deepEqual(JSON.parse(gate.postBodies[0]), {
    name: '将被清空的五子棋', game: 'gomoku', capacity: 2, turnSeconds: 60,
  });
  assert.equal(created.game, 'gomoku');
  assert.equal(created.capacity, 2);

  // 当前四项原样保留为未填完整状态，不补任何默认值。
  assert.deepEqual(await readFourFields(page), {
    name: '',
    game: '',
    capacity: '',
    capacityDisabled: true,
    turnSeconds: '',
  }, '未填完整的内容应原样保留、不自动补齐');
  const msg = await readMessage(page);
  assert.ok(msg.text.startsWith(SUCCESS_PREFIX + created.id));
  assert.ok(msg.text.includes(PENDING_NOTICE));

  await waitForRowCount(page, 3);
  await waitButtonEnabled(page);
  assert.equal((await readFormState(page)).submitDisabled, false, '列表刷新完成后按钮应恢复可用');
  assert.equal((await readServerRooms(baseURL)).length, 3);
});

// 保留下来的规则与人数必须符合联动：等待期间从飞行棋 4 人切到五子棋，保留状态
// 为五子棋固定 2 人；直接再次提交即用当前（五子棋）配置创建下一间。
test('等待期飞行棋切五子棋：保留状态人数固定为 2，再次提交按五子棋创建下一间', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);

  const gate = await installGate(page, { continueRest: true });
  const NAME_F = '联动保留房间';
  await fillLudo(page, NAME_F, 4, 90);

  const createdP1 = waitCreateResponse(page);
  await page.click('#submit');
  await gate.waitPostHeld();

  // 等待期间切到五子棋：人数由联动固定为 2（不能保留飞行棋的 4）。
  await chooseGame(page, 'gomoku');
  assert.deepEqual(await readFormState(page), {
    name: NAME_F,
    game: 'gomoku',
    capacity: '2',
    capacityDisabled: false,
    turnSeconds: '90',
    submitDisabled: true,
  }, '保留下来的规则与人数必须相符（五子棋固定 2 人）');

  await gate.releasePost();
  const created1 = await createdP1;

  // 本次房间仍是提交时的飞行棋 4 人。
  assert.deepEqual(JSON.parse(gate.postBodies[0]), {
    name: NAME_F, game: 'ludo', capacity: 4, turnSeconds: 90,
  });
  assert.equal(created1.game, 'ludo');
  assert.equal(created1.capacity, 4);

  // 成功后保留五子棋/2 人状态，并提示尚未提交。
  const msg = await readMessage(page);
  assert.ok(msg.text.startsWith(SUCCESS_PREFIX + created1.id));
  assert.ok(msg.text.includes(PENDING_NOTICE));
  assert.deepEqual(await readFourFields(page), {
    name: NAME_F,
    game: 'gomoku',
    capacity: '2',
    capacityDisabled: false,
    turnSeconds: '90',
  });
  await waitForRowCount(page, 3);
  await waitButtonEnabled(page);

  // 不刷新、不再改，直接再次提交：第二间按当前五子棋/2 人配置创建。
  const createdP2 = waitCreateResponse(page);
  await page.click('#submit');
  const created2 = await createdP2;
  assert.deepEqual(JSON.parse(gate.postBodies[1]), {
    name: NAME_F, game: 'gomoku', capacity: 2, turnSeconds: 90,
  }, '再次提交必须使用当前保留的五子棋配置');
  assert.equal(created2.game, 'gomoku');
  assert.equal(created2.capacity, 2);
  assert.equal(created2.turnSeconds, 90);

  await waitForRowCount(page, 4);
  const rows = await readRows(page);
  assert.equal(rows[2].cells[2], '飞行棋', '第一次创建的房间应是提交时的飞行棋');
  assert.equal(rows[3].cells[2], '五子棋', '再次提交创建的房间应是当前的五子棋');
  assert.equal(rows[3].cells[3], '2 人');
  assert.equal((await readServerRooms(baseURL)).length, 4);
});

// 创建被服务拒绝：显示服务原因、无成功编号、列表原样；等待期间的最新填写保留，
// 不回退提交时内容；再次提交放行后按保留的当前配置创建。
test('等待期间编辑后创建被拒绝：显示服务原因、保留最新填写、列表原样，可再次提交', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const initialRows = await readRows(page);
  assertSeedRows(initialRows);

  const gate = await installGate(page, { continueRest: true });

  // 提交时是一份合法的五子棋配置（将被“服务”拒绝）。
  const NAME_G = '将被拒绝的房间';
  await fillGomoku(page, NAME_G, 0);

  await page.click('#submit');
  await gate.waitPostHeld();

  // 等待期间改成飞行棋 3 人/120 秒的最新填写。
  const NAME_G2 = '拒绝后保留的飞行棋';
  await setName(page, NAME_G2);
  await chooseGame(page, 'ludo');
  await page.select('#capacity', '3');
  await setTurn(page, 120);

  // 服务拒绝本次创建（请求体仍是提交时快照）。
  await gate.rejectPost(400, { error: REJECT_REASON });

  // 显示服务给出的具体原因，不出现成功编号或成功文案。
  await waitForMessageKind(page, 'error');
  const msg = await readMessage(page);
  assert.equal(msg.text, REJECT_REASON, '应原样显示服务返回的拒绝原因');
  assert.ok(!msg.className.includes('ok'));
  assert.ok(!msg.text.includes(SUCCESS_PREFIX), '被拒绝时不应出现成功编号');
  assert.ok(!msg.text.includes('已创建'));

  // 请求体用的是提交时配置；等待期间的最新四项原样保留（不回退五子棋/0 秒）。
  assert.deepEqual(JSON.parse(gate.postBodies[0]), {
    name: NAME_G, game: 'gomoku', capacity: 2, turnSeconds: 0,
  }, '被拒绝的请求仍应使用提交时配置');
  assert.deepEqual(await readFormState(page), {
    name: NAME_G2,
    game: 'ludo',
    capacity: '3',
    capacityDisabled: false,
    turnSeconds: '120',
    submitDisabled: false,
  }, '被拒绝后应保留等待期间的最新填写，不回退提交时内容');

  // 列表保持原样，服务端没有新增记录，也没有因失败触发列表刷新改动。
  assert.deepEqual(await readRows(page), initialRows, '被拒绝时列表应保持原样');
  assert.equal((await readServerRooms(baseURL)).length, 2, '被拒绝不得新增房间');
  assert.equal(gate.postBodies.length, 1);

  // 直接再次提交（保留的当前配置合法）：本次放行，按飞行棋 3 人/120 秒创建。
  const createdP = waitCreateResponse(page);
  await page.click('#submit');
  const created = await createdP;
  assert.equal(gate.postBodies.length, 2);
  assert.deepEqual(JSON.parse(gate.postBodies[1]), {
    name: NAME_G2, game: 'ludo', capacity: 3, turnSeconds: 120,
  }, '再次提交应使用保留的最新填写');
  assert.equal(created.game, 'ludo');
  assert.equal(created.capacity, 3);
  assert.equal(created.turnSeconds, 120);

  await waitForMessageKind(page, 'ok');
  await waitForRowCount(page, 3);
  const rows = await readRows(page);
  assert.deepEqual(rows.slice(0, 2), initialRows);
  assert.deepEqual(rows[2].cells.slice(0, 6),
    [created.id, NAME_G2, '飞行棋', '3 人', '120 秒', '未开始']);
  assert.equal((await readFormState(page)).submitDisabled, false, '完成后按钮应恢复可用');
});

// 提交等待以及随后列表刷新完成前按钮保持不可用，回车也不能触发第二次提交；
// 刷新完成后按钮恢复。
test('提交等待与列表刷新完成前按钮不可用且不能二次提交，刷新完成后恢复', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t);

  // 创建请求与创建后的列表刷新都挂起，以便观察两个阶段的按钮状态。
  const gate = await installGate(page, { holdRefresh: true });
  await fillGomoku(page, '刷新完成前禁用按钮', 30);

  const createdP = waitCreateResponse(page);
  await page.click('#submit');
  await gate.waitPostHeld();

  // 阶段一：创建请求在途，按钮禁用。
  await page.waitForFunction(() => document.getElementById('submit').disabled, { timeout: 5000 });
  // 即使焦点在名称框按回车，也不能借表单提交再发一次创建。
  await page.focus('#name');
  await page.keyboard.press('Enter');
  await sleep(300);
  assert.equal(gate.postBodies.length, 1, '等待期间回车不得触发第二次创建');

  // 创建成功返回：提示出现，但列表刷新仍在途，按钮必须继续禁用。
  await gate.releasePost();
  const created = await createdP;
  await waitForMessageKind(page, 'ok');
  await gate.waitRefreshHeld();
  assert.equal((await readFormState(page)).submitDisabled, true, '列表刷新完成前按钮应继续不可用');
  // 刷新结果未返回前，列表仍是提交前的两条种子房间（不会抢先显示新房间）。
  assert.equal((await readRows(page)).length, 2, '刷新未返回前不应展示新房间');
  await page.focus('#name');
  await page.keyboard.press('Enter');
  await sleep(300);
  assert.equal(gate.postBodies.length, 1, '列表刷新期间也不得触发第二次创建');

  // 刷新完成：列表展示新房间、按钮恢复可用、表单复位；自始至终只有一次创建。
  await gate.releaseRefresh();
  await waitForRowCount(page, 3);
  await page.waitForFunction(() => !document.getElementById('submit').disabled, { timeout: 10000 });
  assert.equal((await readFormState(page)).submitDisabled, false, '刷新完成后按钮应恢复可用');
  assert.deepEqual(await readFormState(page), RESET_FORM);
  assert.equal(gate.postBodies.length, 1, '整个过程只能有一次创建请求');
  const rows = await readRows(page);
  assert.equal(rows[2].cells[0], created.id);
});
