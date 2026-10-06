// 首页“创建公开房间”在创建结果返回前继续修改表单的界面回归测试。
//
// 与其他浏览器回归文件的分工：
//   - ui.test.mjs：创建成功/被拒的基本路径、成功后列表竞态刷新、名称整理；
//   - ui-capacity-linkage.test.mjs：规则与人数联动本身；
//   - ui-create-connection-failure.test.mjs：创建请求未送达服务的连接失败；
//   - 本文件只盯住“点击创建房间之后、创建结果返回之前继续编辑表单”这一段：
//     四项（名称、游戏规则、人数上限、每步时间限制）等待期间仍可编辑，但本次
//     创建固定使用点击提交时的配置快照；等待期间的输入属于下一次尚未提交的
//     填写，不能混进已发出的请求，也不能自动创建成另一个房间。
//
// 覆盖的产品行为：
//   1. 成功创建时，提示编号与列表新房间对应“提交时”的配置（名称按现有规则
//      去掉首尾空白）；是否复位表单以“创建结果返回时”的实际填写值为准——
//      四项与提交时逐项完全一致才恢复初始状态（等待期间改过又全部恢复原样
//      仍复位），任一项不同就整体保留当前四项（包括未修改的项与已经清空的
//      项），不能只留变化字段、不能把其他项回退旧值，未填完整不自动补齐；
//      仅调整名称首尾空白、即使整理后保存名称相同，也算输入变化、整体保留；
//   2. 保留下来的规则与人数选择状态必须相符（五子棋固定 2 人、飞行棋 2 至 4
//      人的联动等待期间照常生效），保留后继续按现有规则接受页面校验；
//   3. 成功且保留时提示同时说明“本次已创建成功、当前填写尚未提交”，用户可
//      直接继续编辑或再次提交，只有再次提交才使用当前配置创建下一间房；
//   4. 创建被服务拒绝时显示服务给出的原因、不出现成功编号、已有列表保持
//      原样，等待期间的最新四项仍保留，不因失败回退到提交时的内容；
//   5. 提交等待及随后列表刷新完成前创建按钮保持不可用，重复点击/再次提交
//      不会增加第二个房间；本次处理完成后按钮恢复可用。
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

// 与其他界面回归文件相同的种子记录：创建前后用来比对列表内容与次序不变。
const SEED_ALPHA =
  '{"id":"seed-alpha","name":"晨间飞行棋","game":"ludo","capacity":4,"turnSeconds":30,' +
  '"status":"playing","visibility":"public","createdAt":"2026-01-01T08:00:00Z","note":"保留我","tags":["老友","周赛"]}';
const SEED_BETA =
  '{"id":"seed-beta","name":"午夜五子棋","game":"gomoku","capacity":2,"turnSeconds":0,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-01-02T23:00:00Z","extra":{"rank":3}}';

const SUCCESS_PREFIX = '房间已创建，编号：';
// 成功且表单保留时，成功编号之后追加的说明文案（须与 index.html 完全一致，
// 含全角引号与句号）。
const RETAIN_SUFFIX =
  '。表单中当前填写的内容尚未提交，不会自动创建房间；如需创建下一间，可直接点击“创建房间”。';
const NAME_REQUIRED_TEXT = '房间名称不能为空。';
const CAPACITY_REQUIRED_TEXT = '请选择人数上限。';

// 创建成功且表单复位后的初始状态：名称/时间为空、规则未选、人数不可填写。
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

// 四项输入控件在等待期间是否可编辑（按钮状态由 readFormState 单独读取）。
function readEditable(page) {
  return page.evaluate(() => ({
    nameDisabled: document.getElementById('name').disabled,
    gameDisabled: document.getElementById('game').disabled,
    capacityDisabled: document.getElementById('capacity').disabled,
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

function nextPostResponse(page) {
  return new Promise((resolve, reject) => {
    page.on('response', (resp) => {
      if (resp.request().method() === 'POST' && resp.url().endsWith('/api/rooms')) {
        resp.json().then(
          (body) => resolve({ status: resp.status(), body }),
          reject,
        );
      }
    });
  });
}

// installCreateGate 打开请求拦截：每次 POST /api/rooms 都先挂起，由测试
// 显式 release 决定放行到真实服务还是直接构造响应（如服务拒绝）；其余请求
// （页面、GET 列表）照常放行。挂起期间正是“创建结果返回前”的观察窗口。
function installCreateGate(page) {
  const posts = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/rooms')) {
      const entry = { body: req.postData() };
      posts.push(entry);
      entry.whenReleased = new Promise((resolve) => {
        entry.release = (how) => { entry.how = how || { type: 'continue' }; resolve(); };
      });
      entry.whenReleased.then(() => {
        if (entry.how.type === 'respond') req.respond(entry.how.params);
        else req.continue();
      });
    } else {
      req.continue();
    }
  });
  return {
    posts,
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

// 重复触发提交：一次真实鼠标点击（按钮禁用时浏览器不会提交），一次直接
// 派发到表单的 submit 事件（绕过禁用属性，考验页面里的在途守卫）。
async function tryDuplicateSubmit(page) {
  await page.click('#submit');
  await page.evaluate(() => {
    document.getElementById('room-form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await sleep(300);
}

// 替换名称输入框的全部内容。
async function setName(page, value) {
  await page.$eval('#name', (el) => { el.value = ''; });
  await page.type('#name', value);
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

// 等待期间改成一份完整合法的飞行棋配置：名称、规则、人数、时间四项全动。
async function editToLudo4(page) {
  await setName(page, '等待中改成飞行棋');
  await chooseGame(page, 'ludo');
  await page.select('#capacity', '4');
  await setTurnSeconds(page, '90');
}

// 主用例：提交一份五子棋配置后，在结果返回前改成另一份完整合法的飞行棋配置。
// 本次创建必须仍使用提交时的快照；成功后四项整体保留，再次提交才创建下一间。
test('等待期间改成另一份完整配置：本次仍按提交时创建，四项整体保留，再次提交才用当前配置', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const initialRows = await readRows(page);
  assertSeedRows(initialRows);
  const seedRooms = await readServerRooms(baseURL);

  const gate = installCreateGate(page);
  await page.setRequestInterception(true);
  const createdPromise = nextPostResponse(page);

  // 点击提交时的配置：五子棋/2 人/30 秒，名称带首尾空白。
  const submittedName = '  提交时的五子棋房间  ';
  await page.type('#name', submittedName);
  await chooseGame(page, 'gomoku');
  await setTurnSeconds(page, '30');
  await page.click('#submit');

  await gate.waitFor(1);
  // 请求体在点击瞬间就已固定，不受等待期间编辑影响。
  assert.deepEqual(JSON.parse(gate.posts[0].body), {
    name: submittedName,
    game: 'gomoku',
    capacity: 2,
    turnSeconds: 30,
  }, '已发出的请求必须使用点击提交时的配置');

  // 等待期间按钮不可用，四项仍可编辑（规则与人数联动照常）。
  assert.equal((await readFormState(page)).submitDisabled, true, '等待期间创建按钮应不可用');
  await editToLudo4(page);
  const editable = await readEditable(page);
  assert.deepEqual(editable, {
    nameDisabled: false,
    gameDisabled: false,
    capacityDisabled: false,
    turnDisabled: false,
  }, '等待期间名称、规则、人数、时间四项仍应可以编辑');

  // 等待期间的任何再次提交尝试都不能产生第二个请求/另一间房。
  await tryDuplicateSubmit(page);
  assert.equal(gate.posts.length, 1, '等待期间重复提交不得发出第二次创建请求');
  assert.equal((await readFormState(page)).submitDisabled, true, '列表刷新完成前按钮应保持不可用');

  // 放行挂起的创建请求：服务端按提交时的五子棋配置创建，而非等待中的飞行棋。
  gate.posts[0].release();
  const created = await createdPromise;
  assert.equal(created.status, 201);
  assert.ok(created.body.id, '创建结果应包含非空编号');
  assert.equal(created.body.name, '提交时的五子棋房间', '名称应按现有规则去掉首尾空白');
  assert.equal(created.body.game, 'gomoku');
  assert.equal(created.body.capacity, 2);
  assert.equal(created.body.turnSeconds, 30);

  // 成功提示同时说明：本次已创建成功（带编号）、当前填写尚未提交。
  await waitForMessageKind(page, 'ok');
  const msg = await readMessage(page);
  assert.equal(
    msg.text,
    SUCCESS_PREFIX + created.body.id + RETAIN_SUFFIX,
    '保留填写时的成功提示应说明已创建成功且当前填写尚未提交',
  );

  // 四项整体保留为等待期间的最新（飞行棋）填写，未修改语义下也不允许只留
  // 变化字段；人数选择状态与规则相符且可用。按钮恢复要等列表刷新完成，故先
  // 等新房间上屏，再断言包含 submitDisabled:false 的完整表单状态。
  await waitForRowCount(page, 3);
  assert.deepEqual(await readFormState(page), {
    name: '等待中改成飞行棋',
    game: 'ludo',
    capacity: '4',
    capacityDisabled: false,
    turnSeconds: '90',
    submitDisabled: false,
  }, '创建结果返回时任一项不同，当前四项应整体保留');

  // 列表新房间对应的是提交时的五子棋配置，原有房间不变。
  const rows = await readRows(page);
  assert.deepEqual(rows.slice(0, 2), initialRows, '原有房间的内容或次序被改变');
  assert.equal(rows[2].cells[0], created.body.id, '列表新房间编号应与提示一致');
  assert.equal(rows[2].cells[1], '提交时的五子棋房间');
  assert.equal(rows[2].cells[2], '五子棋');
  assert.equal(rows[2].cells[3], '2 人');
  assert.equal(rows[2].cells[4], '30 秒');

  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, 3, '等待期间的编辑不得自动创建另一个房间');
  assert.deepEqual(serverRooms.slice(0, 2), seedRooms, '已有记录应保持原样');
  assert.equal(serverRooms[2].id, created.body.id);
  assert.equal(serverRooms[2].name, '提交时的五子棋房间');
  assert.equal(serverRooms[2].game, 'gomoku');
  assert.equal(serverRooms[2].capacity, 2);
  assert.equal(serverRooms[2].turnSeconds, 30);

  // 只有再次点击提交，才使用保留的当前配置创建下一间房。
  const secondPromise = nextPostResponse(page);
  await page.click('#submit');
  await gate.waitFor(2);
  assert.deepEqual(JSON.parse(gate.posts[1].body), {
    name: '等待中改成飞行棋',
    game: 'ludo',
    capacity: 4,
    turnSeconds: 90,
  }, '再次提交应使用当前保留的配置');
  gate.posts[1].release();
  const second = await secondPromise;
  assert.equal(second.status, 201);
  assert.equal(second.body.name, '等待中改成飞行棋');
  assert.equal(second.body.game, 'ludo');
  assert.equal(second.body.capacity, 4);
  assert.equal(second.body.turnSeconds, 90);

  // 第二次等待期间没有再改动：成功后普通成功提示，表单复位为初始状态。
  await waitForMessageKind(page, 'ok');
  const msg2 = await readMessage(page);
  assert.equal(msg2.text, SUCCESS_PREFIX + second.body.id, '再次提交成功后应显示普通成功提示');
  await waitForRowCount(page, 4);
  assert.deepEqual(await readFormState(page), RESET_FORM, '再次提交成功后表单应恢复初始状态');
  const finalRooms = await readServerRooms(baseURL);
  assert.equal(finalRooms.length, 4, '两次提交应恰好创建两间房');
  assert.equal(finalRooms[2].id, created.body.id);
  assert.equal(finalRooms[3].id, second.body.id);
});

// 等待期间四项都改过、随后又全部恢复成提交时原样：返回时逐项比较一致，
// 仍应恢复初始表单状态。
test('等待期间改过又把四项全部恢复原样：仍恢复初始表单状态', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const gate = installCreateGate(page);
  await page.setRequestInterception(true);
  const createdPromise = nextPostResponse(page);

  const submittedName = '恢复原样的飞行棋';
  await page.type('#name', submittedName);
  await chooseGame(page, 'ludo');
  await page.select('#capacity', '3');
  await setTurnSeconds(page, '60');
  await page.click('#submit');

  await gate.waitFor(1);

  // 四项都先改动：名称追加文字、规则切到五子棋（人数随之固定 2）、时间改掉；
  // 随后逐一恢复成提交时的原样。
  await page.type('#name', '临时改动');
  await chooseGame(page, 'gomoku');
  await setTurnSeconds(page, '120');
  assert.equal((await readFormState(page)).game, 'gomoku', '等待期间应已切到五子棋');

  await setName(page, submittedName);
  await chooseGame(page, 'ludo');
  await page.select('#capacity', '3');
  await setTurnSeconds(page, '60');

  // 放行前四项与提交时完全一致（人数选择状态也相符、可用）。
  assert.deepEqual(await readFormState(page), {
    name: submittedName,
    game: 'ludo',
    capacity: '3',
    capacityDisabled: false,
    turnSeconds: '60',
    submitDisabled: true,
  }, '恢复后四项应与提交时逐项一致');

  gate.posts[0].release();
  const created = await createdPromise;
  assert.equal(created.status, 201);
  assert.equal(created.body.name, submittedName);
  assert.equal(created.body.game, 'ludo');
  assert.equal(created.body.capacity, 3);
  assert.equal(created.body.turnSeconds, 60);

  // 等页面把成功结果渲染后再断言提示与表单。
  await waitForMessageKind(page, 'ok');
  // 提示为普通成功文案（不带“尚未提交”说明），表单恢复初始状态。
  const msg = await readMessage(page);
  assert.equal(msg.text, SUCCESS_PREFIX + created.body.id, '全部恢复原样时应按普通成功提示');
  assert.ok(!msg.text.includes('尚未提交'), '全部恢复原样时不应出现保留填写的说明');
  // 复位在列表刷新链路中落定，等新房间上屏后按钮已恢复可用再比对完整状态。
  await waitForRowCount(page, 3);
  assert.deepEqual(await readFormState(page), RESET_FORM, '四项恢复原样后应复位表单');
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, 3);
  assert.equal(serverRooms[2].name, submittedName);
  assert.equal(serverRooms[2].game, 'ludo');
});

// 只调整名称的首尾空白（整理后保存名称相同）也属于输入变化：当前四项整体
// 保留，再次提交时使用新的原始名称（同名房间允许再建一间）。
test('仅调整名称首尾空白（整理后名称相同）：仍视为变化并整体保留，再次提交用当前原貌名称', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const gate = installCreateGate(page);
  await page.setRequestInterception(true);
  const createdPromise = nextPostResponse(page);

  await page.type('#name', '   只改首尾空白   ');
  await chooseGame(page, 'gomoku');
  await setTurnSeconds(page, '0');
  await page.click('#submit');

  await gate.waitFor(1);
  assert.deepEqual(JSON.parse(gate.posts[0].body), {
    name: '   只改首尾空白   ',
    game: 'gomoku',
    capacity: 2,
    turnSeconds: 0,
  });

  // 等待期间只把首尾空格从三个减到两个：原始值不同，整理后相同。
  await setName(page, '  只改首尾空白  ');
  // 未改动的规则、人数、时间同样保持在表单中（不被清空、不回退旧值）。
  gate.posts[0].release();
  const created = await createdPromise;
  assert.equal(created.status, 201);
  assert.equal(created.body.name, '只改首尾空白', '服务端按提交时的原始名称整理保存');

  await waitForMessageKind(page, 'ok');
  const msg = await readMessage(page);
  assert.equal(
    msg.text,
    SUCCESS_PREFIX + created.body.id + RETAIN_SUFFIX,
    '仅首尾空白变化也应保留当前填写并说明尚未提交',
  );
  // 按钮恢复随列表刷新生效，等新房间上屏后再比对完整表单状态。
  await waitForRowCount(page, 3);
  assert.deepEqual(await readFormState(page), {
    name: '  只改首尾空白  ',
    game: 'gomoku',
    capacity: '2',
    capacityDisabled: false,
    turnSeconds: '0',
    submitDisabled: false,
  }, '改动的名称与未改动的规则/人数/时间应整体保留');

  // 再次提交：请求体使用等待后新的原始名称，服务端整理后仍是同名房间。
  const secondPromise = nextPostResponse(page);
  await page.click('#submit');
  await gate.waitFor(2);
  assert.equal(JSON.parse(gate.posts[1].body).name, '  只改首尾空白  ', '再次提交应使用新的原貌名称');
  gate.posts[1].release();
  const second = await secondPromise;
  assert.equal(second.status, 201);
  assert.equal(second.body.name, '只改首尾空白');

  await waitForRowCount(page, 4);
  assert.deepEqual(await readFormState(page), RESET_FORM);
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, 4, '同名房间再次提交后应是独立的第二间');
  assert.equal(serverRooms[2].id, created.body.id);
  assert.equal(serverRooms[3].id, second.body.id);
  assert.equal(serverRooms[2].name, serverRooms[3].name);
});

// 等待期间把四项全部清空：成功后四项整体保留为空（名称/时间为空、规则未选、
// 人数不可填），不自动补齐；保留状态继续接受现有校验，补填后可再次提交。
test('等待期间清空四项：成功后整体保留空填写不补齐，空表提交被拦截，补填后再次提交成功', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const initialRows = await readRows(page);
  const gate = installCreateGate(page);
  await page.setRequestInterception(true);
  const createdPromise = nextPostResponse(page);

  await page.type('#name', '等待中清空的房间');
  await chooseGame(page, 'gomoku');
  await setTurnSeconds(page, '45');
  await page.click('#submit');
  await gate.waitFor(1);

  // 等待期间清空四项：名称清空、规则切回未选择（人数随之禁用）、时间清空。
  await setName(page, '');
  await page.select('#game', '');
  await setTurnSeconds(page, '');
  assert.equal((await readFormState(page)).capacityDisabled, true, '规则未选时人数应不可填写');

  gate.posts[0].release();
  const created = await createdPromise;
  assert.equal(created.status, 201);
  assert.equal(created.body.name, '等待中清空的房间');
  assert.equal(created.body.game, 'gomoku');
  assert.equal(created.body.capacity, 2);
  assert.equal(created.body.turnSeconds, 45);

  await waitForMessageKind(page, 'ok');
  const msg = await readMessage(page);
  assert.equal(msg.text, SUCCESS_PREFIX + created.body.id + RETAIN_SUFFIX);

  // 四项整体保留为空，包括已清空的项；不补默认值、不回退到提交时的配置。
  // 按钮恢复随列表刷新生效，先等新房间上屏再比对完整状态。
  await waitForRowCount(page, 3);
  assert.deepEqual(await readFormState(page), {
    name: '',
    game: '',
    capacity: '',
    capacityDisabled: true,
    turnSeconds: '',
    submitDisabled: false,
  }, '清空的四项应整体保留，不自动补齐');

  // 列表只追加本次提交时配置的房间，不出现第二间。
  assert.deepEqual((await readRows(page)).slice(0, 2), initialRows);
  assert.equal((await readServerRooms(baseURL)).length, 3);

  // 保留的空填写继续按现有规则接受校验：直接提交被页面拦截，不发请求，
  // 内容仍保留，按钮可用。
  await page.click('#submit');
  await waitForMessageKind(page, 'error');
  const errMsg = await readMessage(page);
  assert.equal(errMsg.text, NAME_REQUIRED_TEXT, '空名称应按现有规则被页面拦截');
  await sleep(200);
  assert.equal(gate.posts.length, 1, '页面拦截时不得发出创建请求');
  assert.deepEqual(await readFormState(page), {
    name: '',
    game: '',
    capacity: '',
    capacityDisabled: true,
    turnSeconds: '',
    submitDisabled: false,
  }, '拦截后保留的填写不应被改动');

  // 补填一份完整合法配置后再次提交：成功创建下一间并复位。
  const secondPromise = nextPostResponse(page);
  await page.type('#name', '补填后的飞行棋');
  await chooseGame(page, 'ludo');
  await page.select('#capacity', '2');
  await setTurnSeconds(page, '10');
  await page.click('#submit');
  await gate.waitFor(2);
  gate.posts[1].release();
  const second = await secondPromise;
  assert.equal(second.status, 201);
  assert.equal(second.body.name, '补填后的飞行棋');
  assert.equal(second.body.game, 'ludo');
  assert.equal(second.body.capacity, 2);
  assert.equal(second.body.turnSeconds, 10);
  await waitForRowCount(page, 4);
  assert.deepEqual(await readFormState(page), RESET_FORM);
});

// 联动一致性（五子棋 → 飞行棋但未选人数）：保留下来的规则为飞行棋时人数
// 必须停留在未选择状态而不是沿用五子棋的 2；立即提交按现有规则拦截，选好
// 人数后再次提交才创建。
test('等待期间五子棋切飞行棋且未选人数：保留状态与规则相符，缺人数被拦截后补齐再提交', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const gate = installCreateGate(page);
  await page.setRequestInterception(true);
  const createdPromise = nextPostResponse(page);

  await page.type('#name', '联动保留的房间');
  await chooseGame(page, 'gomoku');
  await setTurnSeconds(page, '30');
  await page.click('#submit');
  await gate.waitFor(1);

  // 等待期间切到飞行棋：人数沿用五子棋的 2（现有联动保留合法人数），再手动
  // 改选占位空项模拟“尚未选完整”，并改时间；名称保持不动。
  await chooseGame(page, 'ludo');
  await page.select('#capacity', '');
  await setTurnSeconds(page, '77');

  gate.posts[0].release();
  const created = await createdPromise;
  assert.equal(created.status, 201);
  assert.equal(created.body.game, 'gomoku', '本次创建仍使用提交时的五子棋');
  assert.equal(created.body.capacity, 2);
  assert.equal(created.body.turnSeconds, 30);

  await waitForMessageKind(page, 'ok');
  // 保留状态与规则相符：飞行棋已选、人数未选（可选择），不自动补成 2。
  // 等列表刷新完成（按钮随之恢复）后再比对完整表单状态。
  await waitForRowCount(page, 3);
  assert.deepEqual(await readFormState(page), {
    name: '联动保留的房间',
    game: 'ludo',
    capacity: '',
    capacityDisabled: false,
    turnSeconds: '77',
    submitDisabled: false,
  }, '保留的人数选择状态必须与飞行棋规则相符，未选完整不自动补齐');

  // 立即提交按现有规则拦截（缺人数），不发请求，内容保留。
  await page.click('#submit');
  await waitForMessageKind(page, 'error');
  assert.equal((await readMessage(page)).text, CAPACITY_REQUIRED_TEXT);
  await sleep(200);
  assert.equal(gate.posts.length, 1, '缺人数时不得发出创建请求');

  // 选好人数后再次提交：以保留的飞行棋/3 人/77 秒创建。
  const secondPromise = nextPostResponse(page);
  await page.select('#capacity', '3');
  await page.click('#submit');
  await gate.waitFor(2);
  assert.deepEqual(JSON.parse(gate.posts[1].body), {
    name: '联动保留的房间',
    game: 'ludo',
    capacity: 3,
    turnSeconds: 77,
  });
  gate.posts[1].release();
  const second = await secondPromise;
  assert.equal(second.status, 201);
  assert.equal(second.body.game, 'ludo');
  assert.equal(second.body.capacity, 3);
  assert.equal(second.body.turnSeconds, 77);
  await waitForRowCount(page, 4);
  assert.deepEqual(await readFormState(page), RESET_FORM);
});

// 联动一致性（飞行棋/4 人 → 五子棋）：等待期间切到五子棋后人数自动固定为
// 2，保留状态即五子棋/2 人，再次提交直接以该配置创建。
test('等待期间飞行棋切五子棋：人数自动固定 2 人并保留，再次提交以五子棋 2 人创建', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const gate = installCreateGate(page);
  await page.setRequestInterception(true);
  const createdPromise = nextPostResponse(page);

  await page.type('#name', '切换规则的房间');
  await chooseGame(page, 'ludo');
  await page.select('#capacity', '4');
  await setTurnSeconds(page, '60');
  await page.click('#submit');
  await gate.waitFor(1);
  assert.deepEqual(JSON.parse(gate.posts[0].body), {
    name: '切换规则的房间',
    game: 'ludo',
    capacity: 4,
    turnSeconds: 60,
  });

  // 等待期间改规则为五子棋：人数自动固定 2；名称、时间不动。
  await chooseGame(page, 'gomoku');

  gate.posts[0].release();
  const created = await createdPromise;
  assert.equal(created.status, 201);
  assert.equal(created.body.game, 'ludo', '本次创建仍使用提交时的飞行棋');
  assert.equal(created.body.capacity, 4);

  await waitForMessageKind(page, 'ok');
  const msg = await readMessage(page);
  assert.equal(msg.text, SUCCESS_PREFIX + created.body.id + RETAIN_SUFFIX);
  // 等列表刷新完成后按钮恢复可用，再比对完整表单状态。
  await waitForRowCount(page, 3);
  assert.deepEqual(await readFormState(page), {
    name: '切换规则的房间',
    game: 'gomoku',
    capacity: '2',
    capacityDisabled: false,
    turnSeconds: '60',
    submitDisabled: false,
  }, '切到五子棋后应保留自动固定的 2 人状态');

  // 再次提交直接以五子棋/2 人创建。
  const secondPromise = nextPostResponse(page);
  await page.click('#submit');
  await gate.waitFor(2);
  assert.deepEqual(JSON.parse(gate.posts[1].body), {
    name: '切换规则的房间',
    game: 'gomoku',
    capacity: 2,
    turnSeconds: 60,
  });
  gate.posts[1].release();
  const second = await secondPromise;
  assert.equal(second.body.game, 'gomoku');
  assert.equal(second.body.capacity, 2);
  await waitForRowCount(page, 4);
  assert.deepEqual(await readFormState(page), RESET_FORM);
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms[2].game, 'ludo');
  assert.equal(serverRooms[3].game, 'gomoku');
});

// 创建被服务拒绝：显示服务给出的原因、不出现成功编号、列表保持原样；等待
// 期间的最新四项仍保留，不因失败回退到提交时内容；修正后再次提交成功。
test('创建被服务拒绝：显示服务原因、无编号、列表不变，等待期间最新填写保留，修正后再提交成功', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const initialRows = await readRows(page);
  assertSeedRows(initialRows);
  const seedRooms = await readServerRooms(baseURL);

  const gate = installCreateGate(page);
  await page.setRequestInterception(true);
  const rejectedPromise = nextPostResponse(page);

  // 提交时：五子棋配置。
  await page.type('#name', '  被拒绝的房间  ');
  await chooseGame(page, 'gomoku');
  await setTurnSeconds(page, '30');
  await page.click('#submit');
  await gate.waitFor(1);

  // 等待期间改成飞行棋/4 人/90 秒（最新填写）。
  await editToLudo4(page);

  // 服务拒绝本次创建并给出原因（真实服务不会收到这次请求）。
  const REASON = '服务端拒绝：本场赛事的公开房间数量已达上限';
  gate.posts[0].release({
    type: 'respond',
    params: {
      status: 400,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ error: REASON }),
    },
  });
  const rejected = await rejectedPromise;
  assert.equal(rejected.status, 400);

  // 显示服务给出的具体原因，不出现成功编号或成功文案。
  await waitForMessageKind(page, 'error');
  const msg = await readMessage(page);
  assert.equal(msg.text, REASON, '应原样显示服务给出的拒绝原因');
  assert.ok(!msg.text.includes(SUCCESS_PREFIX), '被拒绝时不应出现成功编号');
  assert.ok(!msg.text.includes('已创建'), '被拒绝时不应出现成功文案');

  // 等待期间的最新四项原样保留，不回退到提交时的五子棋配置；按钮恢复可用。
  assert.deepEqual(await readFormState(page), {
    name: '等待中改成飞行棋',
    game: 'ludo',
    capacity: '4',
    capacityDisabled: false,
    turnSeconds: '90',
    submitDisabled: false,
  }, '被拒绝后应保留等待期间的最新填写，不回退到提交时内容');

  // 已有列表与服务端记录保持原样，不新增房间。
  assert.deepEqual(await readRows(page), initialRows, '被拒绝时列表应保持原样');
  assert.deepEqual(await readServerRooms(baseURL), seedRooms, '服务端不应新增房间记录');

  // 以保留的最新填写再次提交：放行到真实服务，按当前配置创建成功。
  const secondPromise = nextPostResponse(page);
  await page.click('#submit');
  await gate.waitFor(2);
  assert.equal(gate.posts.length, 2, '处理完成后应能再次提交');
  assert.deepEqual(JSON.parse(gate.posts[1].body), {
    name: '等待中改成飞行棋',
    game: 'ludo',
    capacity: 4,
    turnSeconds: 90,
  }, '再次提交应使用保留的最新填写');
  gate.posts[1].release();
  const second = await secondPromise;
  assert.equal(second.status, 201);
  assert.equal(second.body.game, 'ludo');
  assert.equal(second.body.capacity, 4);

  // 拒绝原因被成功结果替换，表单复位，列表追加一间。
  await waitForMessageKind(page, 'ok');
  const okMsg = await readMessage(page);
  assert.equal(okMsg.text, SUCCESS_PREFIX + second.body.id, '成功后应替换为普通成功提示');
  assert.ok(!okMsg.text.includes(REASON), '成功后不应残留拒绝原因');
  await waitForRowCount(page, 3);
  assert.deepEqual(await readFormState(page), RESET_FORM);
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, 3);
  assert.deepEqual(serverRooms.slice(0, 2), seedRooms);
  assert.equal(serverRooms[2].id, second.body.id);
});

// 按钮禁用窗口覆盖“提交等待 + 随后的列表刷新”：POST 与创建后的列表查询都
// 挂起时按钮保持不可用、无法二次提交；列表刷新完成后才恢复可用。
test('提交等待及列表刷新完成前按钮不可用且不能二次提交，刷新完成后恢复', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);

  // 同时挂起第一次创建请求与创建后的列表查询；拦截在页面加载完成后才打开，
  // 因此打开页面的首次列表查询不受影响。
  await page.setRequestInterception(true);
  const posts = [];
  let markGetArrived;
  const getArrived = new Promise((resolve) => { markGetArrived = resolve; });
  let releaseGet;
  const getReleased = new Promise((resolve) => { releaseGet = resolve; });
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/rooms')) {
      const entry = { body: req.postData() };
      posts.push(entry);
      entry.whenReleased = new Promise((resolve) => {
        entry.release = () => resolve();
      });
      entry.whenReleased.then(() => req.continue());
    } else if (req.method() === 'GET' && req.url().endsWith('/api/rooms')) {
      markGetArrived();
      getReleased.then(() => req.continue());
    } else {
      req.continue();
    }
  });

  const createdPromise = nextPostResponse(page);
  await page.type('#name', '按钮禁用窗口的房间');
  await chooseGame(page, 'gomoku');
  await setTurnSeconds(page, '0');
  await page.click('#submit');

  // POST 在途：按钮不可用，重复提交无效。
  await sleep(100);
  assert.equal(posts.length, 1, '应只发起一次创建请求');
  assert.equal((await readFormState(page)).submitDisabled, true);
  await tryDuplicateSubmit(page);
  assert.equal(posts.length, 1, '等待期间不得发出第二次创建请求');

  // 创建结果返回、成功提示已显示，但列表刷新尚未完成：按钮仍不可用。
  posts[0].release();
  const created = await createdPromise;
  assert.equal(created.status, 201);
  await waitForMessageKind(page, 'ok');
  await getArrived;
  await sleep(300);
  assert.equal((await readFormState(page)).submitDisabled, true, '列表刷新完成前按钮应保持不可用');
  await tryDuplicateSubmit(page);
  assert.equal(posts.length, 1, '列表刷新期间重复提交也不得发起第二次请求');

  // 列表查询仍挂起时不应渲染出第三行。
  assert.equal((await readRows(page)).length, 2, '挂起的列表刷新完成前不应展示新房间行');

  // 放行列表刷新：新房间上屏后按钮恢复可用，表单按成功复位。
  releaseGet();
  await waitForRowCount(page, 3);
  await page.waitForFunction(
    () => !document.getElementById('submit').disabled,
    { timeout: 10000 },
  );
  assert.equal((await readFormState(page)).submitDisabled, false, '本次处理完成后按钮应恢复可用');
  assert.deepEqual(await readFormState(page), RESET_FORM);
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, 3);
  assert.equal(serverRooms[2].id, created.body.id);
});
