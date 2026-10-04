// 首页“创建公开房间”中“游戏规则 ↔ 人数上限”联动的界面回归测试。
//
// 与 ui.test.mjs 的分工：ui.test.mjs 覆盖成功/失败、列表刷新与名称整理；
// 本文件只盯住规则切换与人数上限的联动，把“切换过程 → 页面当前选择 →
// 实际提交的请求体 → 创建结果 → 房间列表”串起来断言，防止出现页面显示的是
// 当前规则下的人数，保存的却是先前规则下残留值的错配。
//
// 覆盖的产品行为（保持现有公开入口与产品行为不变）：
//   - 未选规则时人数不可填写，选项提示先选择游戏规则；
//   - 选五子棋后人数自动固定为 2，不能沿用先前飞行棋的 3/4；
//   - 选飞行棋后允许 2/3/4；从未选规则首次选飞行棋时人数保持未选择；
//     从五子棋切过去时当前合法的 2 人保留；
//   - 来回切换以当前选择为准（飞行棋 4 → 五子棋 2 → 飞行棋仍为 2）；
//   - 切换规则时名称与每步时间限制保留，仅人数随规则调整；
//   - 切回“请选择游戏规则”后人数重新不可填写，旧人数不再是可提交的值；
//   - 规则为空或首次选飞行棋未选人数时提交，页面明确指出缺哪项：
//     不发创建请求、不新增房间、已填内容保留；补齐后按此时的规则/人数创建；
//   - 创建成功后人数回到不可填写的初始状态；飞行棋的 3 人与 4 人都必须按
//     所选值创建（请求体、创建结果、列表三处一致），不能都存成 2。
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

let serverBin;
let browser;

// 与 ui.test.mjs 相同的种子记录：验证联动用例创建房间时，
// 原有房间的内容与次序保持不变、新房间按原方式追加。
const SEED_ALPHA =
  '{"id":"seed-alpha","name":"晨间飞行棋","game":"ludo","capacity":4,"turnSeconds":30,' +
  '"status":"playing","visibility":"public","createdAt":"2026-01-01T08:00:00Z","note":"保留我","tags":["老友","周赛"]}';
const SEED_BETA =
  '{"id":"seed-beta","name":"午夜五子棋","game":"gomoku","capacity":2,"turnSeconds":0,' +
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

// readCapacity 读取人数上限下拉的完整状态：是否禁用、当前值、可选项的值与文案、
// 首项（占位项）文案。联动断言必须同时看“当前值”和“可选项集合”，
// 因为残留值可能既显示不出来又仍被提交。
function readCapacity(page) {
  return page.$eval('#capacity', (sel) => ({
    disabled: sel.disabled,
    value: sel.value,
    options: [...sel.options].map((o) => ({ value: o.value, text: o.textContent })),
    optionValues: [...sel.options].map((o) => o.value),
    placeholder: sel.options[0] ? sel.options[0].textContent : null,
  }));
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

function readRows(page) {
  return page.$$eval('#list-area table tbody tr', (trs) =>
    trs.map((tr) => [...tr.querySelectorAll('td')].map((td) => td.textContent)),
  );
}

async function readServerRooms(baseURL) {
  const res = await fetch(baseURL + '/api/rooms');
  assert.equal(res.status, 200);
  return (await res.json()).rooms;
}

// trackRoomPosts 记录页面发出的每一次创建请求体：联动用例据此确认
// 提交给服务的规则/人数就是页面当前显示的选择，且被页面拦截时没有请求发出。
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

// 模拟用户在规则下拉上的一次真实选择（会触发 change 事件）。
async function chooseGame(page, value) {
  await page.select('#game', value);
}

// 切换规则后等待人数下拉完成重建：禁用态与给定期望值一致。
async function waitForCapacityValue(page, value) {
  await page.waitForFunction(
    (want) => {
      const sel = document.getElementById('capacity');
      return want === null ? sel.disabled : (!sel.disabled && sel.value === want);
    },
    { timeout: 5000 },
    value,
  );
}

// 等待人数下拉启用且可选项集合与期望一致；切换后保留的当前值可能不是空，
// （五子棋切到飞行棋时保留 2），因此用可选项集合而非当前值判断重建完成。
async function waitForCapacityOptions(page, values) {
  await page.waitForFunction(
    (want) => {
      const sel = document.getElementById('capacity');
      return !sel.disabled &&
        [...sel.options].map((o) => o.value).join(',') === want.join(',');
    },
    { timeout: 5000 },
    values,
  );
}

const SUCCESS_PREFIX = '房间已创建，编号：';

// 初始状态：规则未选择时人数上限不可填写，选项明确提示先选择游戏规则，
// 当前值为空。
test('未选择规则时人数上限不可填写，提示先选择游戏规则', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t);

  assert.equal(await page.$eval('#game', (el) => el.value), '');
  const cap = await readCapacity(page);
  assert.equal(cap.disabled, true, '未选规则时人数下拉应禁用');
  assert.equal(cap.value, '', '未选规则时人数当前值应为空');
  assert.deepEqual(cap.optionValues, [''], '禁用状态下只应有一个占位选项');
  assert.equal(cap.placeholder, '请先选择游戏规则', '占位项应提示先选择游戏规则');
});

// 选择五子棋：人数自动成为 2 人（占位项 + 唯一合法值 2），无需也无法选择
// 3/4；从飞行棋 3 人切过来时不能沿用 3。
test('选择五子棋后人数自动固定为 2，不能沿用此前飞行棋的 3 或 4', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t);

  // 先选飞行棋并选 3 人，制造“先前规则下的值”。
  await chooseGame(page, 'ludo');
  await waitForCapacityValue(page, '');
  await page.select('#capacity', '3');
  assert.equal((await readCapacity(page)).value, '3');

  // 切到五子棋：人数自动变为 2，可选项中不存在 3/4，旧值 3 被清除。
  await chooseGame(page, 'gomoku');
  await waitForCapacityValue(page, '2');
  let cap = await readCapacity(page);
  assert.equal(cap.disabled, false);
  assert.deepEqual(cap.optionValues, ['', '2'], '五子棋应只有固定 2 人这一个可选值');
  assert.equal(cap.value, '2', '切到五子棋后必须自动成为 2 人，不能沿用 3');

  // 再来一次：飞行棋选 4 后切五子棋，同样必须归 2。
  await chooseGame(page, 'ludo');
  await waitForCapacityOptions(page, ['', '2', '3', '4']);
  assert.equal((await readCapacity(page)).value, '2', '五子棋切到飞行棋应保留当前的 2 人');
  await page.select('#capacity', '4');
  assert.equal((await readCapacity(page)).value, '4');
  await chooseGame(page, 'gomoku');
  await waitForCapacityValue(page, '2');
  cap = await readCapacity(page);
  assert.equal(cap.value, '2', '切到五子棋后必须自动成为 2 人，不能沿用 4');
  assert.deepEqual(cap.optionValues, ['', '2']);
});

// 选择飞行棋：允许 2/3/4，且必须有一个空占位项表示未选择。
test('选择飞行棋后可选择 2、3、4 人', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t);

  await chooseGame(page, 'ludo');
  await waitForCapacityValue(page, '');
  const cap = await readCapacity(page);
  assert.equal(cap.disabled, false, '选飞行棋后人数下拉应可填写');
  assert.deepEqual(cap.optionValues, ['', '2', '3', '4'], '飞行棋应提供未选择占位与 2/3/4 人');
  assert.equal(cap.placeholder, '请选择人数上限…');

  // 三个合法值都能被用户选中。
  for (const n of ['2', '3', '4']) {
    await page.select('#capacity', n);
    assert.equal((await readCapacity(page)).value, n);
  }
});

// 从未选规则的初始状态首次选择飞行棋：人数保持未选择，页面不替用户决定。
test('首次选择飞行棋时人数保持未选择，不替用户决定', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t);

  await chooseGame(page, 'ludo');
  await waitForCapacityValue(page, '');
  const cap = await readCapacity(page);
  assert.equal(cap.disabled, false);
  assert.equal(cap.value, '', '首次选飞行棋不应自动选中任何人数');
});

// 从五子棋切到飞行棋：五子棋当前合法的 2 人应保留，而不是清空或跳成 3/4。
test('从五子棋切到飞行棋时保留当前合法的 2 人', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t);

  await chooseGame(page, 'gomoku');
  await waitForCapacityValue(page, '2');
  await chooseGame(page, 'ludo');
  await waitForCapacityValue(page, '2');
  const cap = await readCapacity(page);
  assert.deepEqual(cap.optionValues, ['', '2', '3', '4']);
  assert.equal(cap.value, '2', '从五子棋切到飞行棋应保留合法的 2 人');
});

// 规则来回切换以当前选择为准：飞行棋选 4 → 改选五子棋必须是 2 →
// 再切回飞行棋仍保留 2，不能“记住”最初的 4 人。
test('来回切换以当前选择为准：飞行棋 4 → 五子棋 2 → 飞行棋保留 2', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t);

  await chooseGame(page, 'ludo');
  await waitForCapacityValue(page, '');
  await page.select('#capacity', '4');
  assert.equal((await readCapacity(page)).value, '4');

  await chooseGame(page, 'gomoku');
  await waitForCapacityValue(page, '2');
  assert.equal((await readCapacity(page)).value, '2', '改选五子棋后人数必须是 2');

  await chooseGame(page, 'ludo');
  await waitForCapacityValue(page, '2');
  assert.equal((await readCapacity(page)).value, '2', '再切回飞行棋应保留当前的 2 人，不能恢复最初的 4 人');

  // 再多切一轮确认 4 不会在后续切换中复活。
  await chooseGame(page, 'gomoku');
  await waitForCapacityValue(page, '2');
  await chooseGame(page, 'ludo');
  await waitForCapacityValue(page, '2');
  assert.equal((await readCapacity(page)).value, '2');
});

// 切换规则时，已填写的房间名称与每步时间限制必须原样保留，仅人数随规则调整。
test('切换规则后名称与时间限制保留，仅人数随规则调整', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t);

  const name = '  规则来回切的房间  ';
  await page.type('#name', name);
  await page.type('#turnSeconds', '45');

  // 五子棋（自动 2 人）→ 飞行棋（2 人合法，保留）→ 选 4 → 五子棋（归 2）。
  await chooseGame(page, 'gomoku');
  await waitForCapacityValue(page, '2');
  await chooseGame(page, 'ludo');
  await waitForCapacityOptions(page, ['', '2', '3', '4']);
  assert.equal((await readCapacity(page)).value, '2', '五子棋切到飞行棋应保留合法的 2 人');
  await page.select('#capacity', '4');
  await chooseGame(page, 'gomoku');
  await waitForCapacityValue(page, '2');

  const form = await readFormState(page);
  assert.equal(form.name, name, '切换规则后名称输入应原样保留（含首尾空白）');
  assert.equal(form.turnSeconds, '45', '切换规则后时间限制应保留');
  assert.equal(form.game, 'gomoku');
  assert.equal(form.capacity, '2', '仅人数应随规则调整为五子棋的 2 人');
  assert.equal(form.capacityDisabled, false);
});

// 切回“请选择游戏规则”：人数重新不可填写、旧人数不再是可提交的选择；
// 名称与时间仍保留。
test('切回未选择规则后人数重新禁用，旧人数不可提交，名称与时间保留', { timeout: 60000 }, async (t) => {
  const { page } = await setupPage(t);

  const name = '又不想选规则了';
  await page.type('#name', name);

  // 飞行棋选 4，再切到五子棋（2），再清空规则：旧的 2 必须随之失效。
  await chooseGame(page, 'ludo');
  await waitForCapacityValue(page, '');
  await page.select('#capacity', '4');
  await chooseGame(page, 'gomoku');
  await waitForCapacityValue(page, '2');
  await page.type('#turnSeconds', '60');
  await chooseGame(page, '');
  await waitForCapacityValue(page, null);

  const cap = await readCapacity(page);
  assert.equal(cap.disabled, true, '规则清空后人数下拉应重新禁用');
  assert.equal(cap.value, '', '旧人数不应再作为当前值');
  assert.deepEqual(cap.optionValues, [''], '禁用后只剩占位项，2/3/4 均不可提交');
  assert.equal(cap.placeholder, '请先选择游戏规则');

  const form = await readFormState(page);
  assert.equal(form.game, '');
  assert.equal(form.capacity, '');
  assert.equal(form.capacityDisabled, true);
  assert.equal(form.name, name, '名称应保留');
  assert.equal(form.turnSeconds, '60', '时间限制应保留');
});

// 规则为空时提交：页面明确提示缺少游戏规则，不发创建请求、不新增房间，
// 已填内容保留。
test('规则为空提交被页面拦截：明确提示缺少规则，不发请求、不增房间、内容保留', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const postBodies = trackRoomPosts(page);
  const initialRows = await readRows(page);

  // 先选过五子棋再切回空规则，制造“人数下拉里曾经有值”的状态，
  // 确认旧值不会被偷偷提交。
  await chooseGame(page, 'gomoku');
  await waitForCapacityValue(page, '2');
  await chooseGame(page, '');
  await waitForCapacityValue(page, null);

  await page.type('#name', '缺规则的房间');
  await page.type('#turnSeconds', '30');
  await page.click('#submit');

  await waitForMessageKind(page, 'error');
  const msg = await readMessage(page);
  assert.equal(msg.text, '请选择游戏规则。', '应明确提示缺少游戏规则');
  assert.ok(!msg.className.includes('ok'));

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(postBodies.length, 0, '页面拦截时不应发出创建请求');
  assert.equal((await readServerRooms(baseURL)).length, 2, '服务端不应新增房间');
  assert.deepEqual(await readRows(page), initialRows, '列表应保持不变');

  const form = await readFormState(page);
  assert.equal(form.name, '缺规则的房间', '已填名称应保留');
  assert.equal(form.game, '', '规则仍为空，等用户选择');
  assert.equal(form.capacity, '');
  assert.equal(form.capacityDisabled, true, '人数仍不可填写');
  assert.equal(form.turnSeconds, '30', '已填时间应保留');
  assert.equal(form.submitDisabled, false);
});

// 首次选择飞行棋但未选人数时提交：明确提示缺少人数上限，不发请求、
// 不增房间，已填内容（含已选规则）保留。
test('首次选飞行棋未选人数提交被拦截：提示缺少人数，不发请求、内容保留', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const postBodies = trackRoomPosts(page);
  const initialRows = await readRows(page);

  await page.type('#name', '人数没选的房间');
  await chooseGame(page, 'ludo');
  await waitForCapacityValue(page, '');
  await page.type('#turnSeconds', '90');
  // 刻意不选择人数上限。
  await page.click('#submit');

  await waitForMessageKind(page, 'error');
  const msg = await readMessage(page);
  assert.equal(msg.text, '请选择人数上限。', '应明确提示缺少人数上限');
  assert.ok(!msg.className.includes('ok'));

  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(postBodies.length, 0, '未选人数时不应发出创建请求');
  assert.equal((await readServerRooms(baseURL)).length, 2);
  assert.deepEqual(await readRows(page), initialRows);

  const form = await readFormState(page);
  assert.deepEqual(form, {
    name: '人数没选的房间',
    game: 'ludo',
    capacity: '',
    capacityDisabled: false,
    turnSeconds: '90',
    submitDisabled: false,
  }, '已填内容（含飞行棋规则）应原样保留供继续填写');
});

// 缺项被拦截后，补齐“此时”的规则与人数即可正常创建——验证保留的表单
// 与联动状态衔接正确，而不是带着残留值提交。
test('缺人数被拦截后，按当前规则补齐人数可正常创建并正确复位', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const postBodies = trackRoomPosts(page);
  const initialRows = await readRows(page);

  await page.type('#name', '补齐人数的房间');
  await chooseGame(page, 'ludo');
  await waitForCapacityValue(page, '');
  await page.type('#turnSeconds', '60');
  await page.click('#submit');
  await waitForMessageKind(page, 'error');
  assert.equal((await readMessage(page)).text, '请选择人数上限。');

  // 补齐为此时飞行棋下的 3 人，再提交。
  const createdPromise = nextCreated(page);
  await page.select('#capacity', '3');
  await page.click('#submit');

  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;
  assert.equal(postBodies.length, 1, '拦截时不发请求，补齐后只发出一次创建请求');
  assert.deepEqual(JSON.parse(postBodies[0]), {
    name: '补齐人数的房间',
    game: 'ludo',
    capacity: 3,
    turnSeconds: 60,
  }, '请求体必须是补齐后的规则与人数');

  // 创建结果与请求体一致。
  assert.equal(created.game, 'ludo');
  assert.equal(created.capacity, 3, '飞行棋 3 人必须按所选值保存，不能存成 2');
  assert.equal(created.turnSeconds, 60);

  // 列表按原方式追加，原有房间内容与次序不变，新行规则/人数与最终选择一致。
  await waitForRowCount(page, 3);
  const rows = await readRows(page);
  assert.deepEqual(
    rows.slice(0, 2).map((r) => r.slice(0, 6)),
    [
      ['seed-alpha', '晨间飞行棋', '飞行棋', '4 人', '30 秒', 'playing'],
      ['seed-beta', '午夜五子棋', '五子棋', '2 人', '不限时', '未开始'],
    ],
    '原有房间的内容或次序被改变',
  );
  assert.deepEqual(rows[2].slice(0, 5), [
    created.id, '补齐人数的房间', '飞行棋', '3 人', '60 秒',
  ]);

  // 成功后人数回到不可填写的初始状态，等待下一次选择规则。
  const form = await readFormState(page);
  assert.deepEqual(form, {
    name: '',
    game: '',
    capacity: '',
    capacityDisabled: true,
    turnSeconds: '',
    submitDisabled: false,
  }, '成功后表单应复位，人数重新不可填写');
  assert.equal((await readServerRooms(baseURL)).length, 3);
});

// 切换过程与最终提交的端到端一致性：飞行棋选 4 → 五子棋（自动 2）→
// 飞行棋（保留 2），最终以飞行棋 2 人提交；请求体、创建结果、列表三处一致。
test('端到端：多轮切换后最终以飞行棋 2 人创建，三处值一致', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const postBodies = trackRoomPosts(page);
  const initialRows = await readRows(page);

  await page.type('#name', '  最终是飞行棋两人  ');
  await page.type('#turnSeconds', '0');

  await chooseGame(page, 'ludo');
  await waitForCapacityValue(page, '');
  await page.select('#capacity', '4'); // 最初选过 4
  await chooseGame(page, 'gomoku');
  await waitForCapacityValue(page, '2');
  await chooseGame(page, 'ludo');
  await waitForCapacityValue(page, '2'); // 回到飞行棋后应保留 2，而非 4

  assert.equal((await readFormState(page)).capacity, '2', '提交前页面显示的人数必须是 2');

  const createdPromise = nextCreated(page);
  await page.click('#submit');
  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  assert.equal(postBodies.length, 1);
  assert.deepEqual(JSON.parse(postBodies[0]), {
    name: '  最终是飞行棋两人  ',
    game: 'ludo',
    capacity: 2,
    turnSeconds: 0,
  }, '请求体必须与最终选择一致，不能携带最初的 4');

  assert.equal(created.game, 'ludo');
  assert.equal(created.capacity, 2);
  assert.equal(created.turnSeconds, 0);

  await waitForRowCount(page, 3);
  const rows = await readRows(page);
  assert.deepEqual(rows.slice(0, 2), initialRows, '原有房间的内容或次序被改变');
  assert.deepEqual(rows[2].slice(0, 5), [
    created.id, '最终是飞行棋两人', '飞行棋', '2 人', '不限时',
  ], '列表的规则与人数必须与最终选择一致');
  assert.equal((await readServerRooms(baseURL))[2].capacity, 2);
});

// 飞行棋 4 人独立成功路径：确保 4 这个值本身能贯穿页面、请求体、服务端保存
// 与列表（与 3 人用例一起防止“飞行棋都被存成 2”的回归）。
test('端到端：飞行棋选择 4 人时按 4 创建，请求体/创建结果/列表一致', { timeout: 60000 }, async (t) => {
  const { page, baseURL } = await setupPage(t);
  const postBodies = trackRoomPosts(page);
  const initialRows = await readRows(page);

  await page.type('#name', '四人飞行棋专场');
  await chooseGame(page, 'ludo');
  await waitForCapacityValue(page, '');
  await page.select('#capacity', '4');
  await page.type('#turnSeconds', '15');

  const createdPromise = nextCreated(page);
  await page.click('#submit');
  await waitForMessageKind(page, 'ok');
  const created = await createdPromise;

  assert.deepEqual(JSON.parse(postBodies[0]), {
    name: '四人飞行棋专场',
    game: 'ludo',
    capacity: 4,
    turnSeconds: 15,
  }, '请求体必须携带所选的 4 人');
  assert.equal(created.game, 'ludo');
  assert.equal(created.capacity, 4, '飞行棋 4 人必须按 4 保存');
  assert.equal(created.turnSeconds, 15);

  const msg = await readMessage(page);
  assert.ok(msg.text.startsWith(SUCCESS_PREFIX));
  assert.equal(msg.text.slice(SUCCESS_PREFIX.length), created.id);

  await waitForRowCount(page, 3);
  const rows = await readRows(page);
  assert.deepEqual(rows.slice(0, 2), initialRows, '原有房间的内容或次序被改变');
  assert.deepEqual(rows[2].slice(0, 5), [
    created.id, '四人飞行棋专场', '飞行棋', '4 人', '15 秒',
  ]);

  const saved = (await readServerRooms(baseURL)).find((r) => r.id === created.id);
  assert.equal(saved.capacity, 4, '服务端保存的人数必须是 4');
  assert.equal(saved.game, 'ludo');

  // 成功提示与表单复位遵循现有行为：人数回到不可填写的初始状态。
  assert.deepEqual(await readFormState(page), {
    name: '',
    game: '',
    capacity: '',
    capacityDisabled: true,
    turnSeconds: '',
    submitDisabled: false,
  });
});
