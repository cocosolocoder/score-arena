// 首页“创建公开房间”在“房间列表可正常读取、提交配置完全合法，但服务无法完成
// 新房间保存”时的界面回归测试。
//
// 与相邻浏览器回归文件的分工：
//   - ui-create-connection-failure.test.mjs：创建请求“尚未送达服务”就连接失败，
//     没有任何服务端响应，页面只能提示“无法连接服务”；
//   - ui-create-unconfirmed.test.mjs：服务已返回 201 成功状态、房间可能已保存，
//     只是创建结果（编号）没能可靠拿到，页面必须表达“不确定”；
//   - ui.test.mjs：创建被服务以 4xx 业务原因拒绝（输入层面的错误）；
//   - 本文件只盯住“保存失败”这一条：已有房间数据始终能正常读取，用户填写的
//     名称、规则、人数、时间全部合法，服务在落盘阶段失败并真实返回 500 与
//     具体 error，不返回成功房间或新编号。页面必须把服务给出的保存原因原样
//     显示在创建表单附近，不能把这次失败说成无法连接服务或“创建结果未能确认”，
//     也不能反过来要求用户修改本来就合法的名称、规则、人数或时间。
//
// 与连接失败用例不同，这里不能在浏览器里凭空伪造响应（伪造的响应不能证明
// “服务端确实没有保存”），也不能用损坏数据文件（那会让列表读取也变成 500，
// 偏离本用例“列表可读、仅保存失败”的前提）。做法是让真实服务子进程照常运行、
// 种子房间照常可读，仅在第一次创建请求在途时把数据目录改成只读（0555）：
// 服务的临时文件写入必然失败，于是真实返回 500 和保存原因；文件本身仍可读，
// GET 依旧 200。恢复目录权限后不刷新页面、不重新填写，直接再次提交，同一服务
// 即可按保留的配置正常创建。
//
// 覆盖的产品行为：
//   1. 用户先看到正常加载的已有房间，填写合法的飞行棋配置（4 人、60 秒，名称
//      含首尾空白、内部空格与表情）后提交；
//   2. 处理期间创建按钮不可用；服务确认真实保存失败（500，error 说明原因，
//      无成功房间、无新编号）后，表单附近原样显示该原因，不出现“房间已创建”
//      或“创建结果未能确认”，也不显示成无法连接服务；按钮恢复可用；
//   3. 失败不清空填写：名称保持输入时的首尾空白，规则、人数、时间保持原值，
//      飞行棋的人数选项仍可使用；已有房间行与顺序不变，不临时增加新行，也不
//      换成空列表提示；服务端记录、本地 rooms.json 逐字节不变，无半条新房间或
//      临时文件残留；失败期间 GET 列表仍返回 200；
//   4. 保存条件恢复后用户留在同一页面，不刷新、不重填，直接再次提交即按保留的
//      配置创建成功：成功提示给出这次真正保存的编号，列表只在旧房间之后增加
//      这一条，先前失败的提交不会后来补成另一条；新房间名称只去首尾空白（内部
//      空格与表情保留），规则/人数/时间与提交一致，状态仍为 waiting；等待期间
//      用户未修改填写，成功后表单按现有行为恢复初始状态。
//
// 该保障只围绕“保存失败 → 手动再次提交”的使用过程，沿用现有页面与创建接口的
// 公开行为：不增加自动重试，也不改变房间创建规则。
//
// 运行：npm test（需要系统 Chrome，可用 CHROME_PATH 指定路径）。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, readdir, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer-core';

const repoRoot = import.meta.dirname;
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let serverBin;
let browser;

// 与其他界面回归文件相同的种子记录：附带 note（字符串）、tags（数组）与
// extra（嵌套对象），用于验证保存失败与恢复成功的整个过程中，已有房间的
// 编号、配置、状态、创建时间以及各类附带内容全部保持原值和原有次序。
const SEED_ALPHA =
  '{"id":"seed-alpha","name":"晨间飞行棋","game":"ludo","capacity":4,"turnSeconds":30,' +
  '"status":"playing","visibility":"public","createdAt":"2026-01-01T08:00:00Z","note":"保留我","tags":["老友","周赛"]}';
const SEED_BETA =
  '{"id":"seed-beta","name":"午夜五子棋","game":"gomoku","capacity":2,"turnSeconds":0,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-01-02T23:00:00Z","extra":{"rank":3}}';

const SUCCESS_PREFIX = '房间已创建，编号：';
const CONN_FAILURE_TEXT = '无法连接服务，请确认服务仍在运行后重试。';
const UNCONFIRMED_TEXT = '创建结果未能确认';

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

// 合法的飞行棋提交：名称含首尾空白、内部空格与表情；4 人、60 秒。
const RAW_NAME = '  周末 飞行棋 🎲 友谊赛  ';
const TRIMMED_NAME = '周末 飞行棋 🎲 友谊赛';
const VALID_PAYLOAD = { name: RAW_NAME, game: 'ludo', capacity: 4, turnSeconds: 60 };

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

// 用例使用独立的数据目录、服务进程与页面；打开页面时已有两条种子房间正常
// 加载。清理时先恢复数据目录权限再删除，避免用例中途只读导致清理失败。
async function setupPage(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'score-arena-uidata-'));
  t.after(async () => {
    await chmod(dataDir, 0o755).catch(() => {});
    await rm(dataDir, { recursive: true, force: true });
  });
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
    return {
      className: el.className,
      text: el.textContent,
      insideForm: !!document.getElementById('room-form').contains(el),
    };
  });
}

function readListArea(page) {
  return page.evaluate(() => ({
    text: document.getElementById('list-area').textContent,
    hasTable: !!document.querySelector('#list-area table'),
    rowCount: document.querySelectorAll('#list-area table tbody tr').length,
    errorText: document.querySelector('#list-area .list-error')
      ? document.querySelector('#list-area .list-error').textContent
      : null,
    emptyText: document.querySelector('#list-area .empty')
      ? document.querySelector('#list-area .empty').textContent
      : null,
  }));
}

// readCapacityOptions 读取人数下拉当前是否可用、可选值与当前选中项，
// 用于确认保存失败后飞行棋的人数选项仍可使用。
function readCapacityOptions(page) {
  return page.evaluate(() => {
    const sel = document.getElementById('capacity');
    return {
      disabled: sel.disabled,
      value: sel.value,
      options: [...sel.options].map((o) => o.value),
    };
  });
}

// readServerRooms 直接读接口，确认服务端实际保存的记录（绕过页面展示）。
async function readServerRooms(baseURL) {
  const res = await fetch(baseURL + '/api/rooms');
  assert.equal(res.status, 200, '保存失败期间已有房间数据仍应能正常读取');
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

async function waitForPostCount(posts, count) {
  const deadline = Date.now() + 10000;
  while (posts.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`等待第 ${count} 次创建响应超时（实际 ${posts.length} 次）`);
    }
    await sleep(10);
  }
}

test('保存失败（合法配置、列表可读、服务返回 500）：显示保存原因并保留填写与数据，恢复后不刷新页面直接重提成功', { timeout: 60000 }, async (t) => {
  const { page, baseURL, dataDir } = await setupPage(t);
  const dataFile = path.join(dataDir, 'rooms.json');

  // 用户先看到正常加载的已有房间，并记录服务端记录与本地文件字节，
  // 作为失败前后“逐字节不变”的基准。
  const initialRows = await readRows(page);
  assertSeedRows(initialRows);
  const beforeRooms = await readServerRooms(baseURL);
  assert.equal(beforeRooms.length, 2);
  const beforeBytes = await readFile(dataFile);

  await fillLudoForm(page);

  // 记录页面发出的每一次创建请求体与真实响应（含状态码）。第一次请求先在
  // 浏览器侧挂住，待测试确认等待状态后再把数据目录改成只读并放行，由真实
  // 服务在写入临时文件时失败并返回真实 500；之后的请求一律放行。
  const postBodies = [];
  const posts = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/rooms')) {
      postBodies.push(req.postData());
    }
  });
  page.on('response', async (resp) => {
    if (resp.request().method() === 'POST' && resp.url().endsWith('/api/rooms')) {
      let data = null;
      try { data = await resp.json(); } catch { data = null; }
      posts.push({ status: resp.status(), data });
    }
  });

  let failFirstPost = true;
  let releaseFirstPost;
  const firstPostHeld = new Promise((resolve) => { releaseFirstPost = resolve; });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/rooms') && failFirstPost) {
      failFirstPost = false;
      // 等测试明确放行后：先把数据目录改成只读（文件本身仍可读），再让请求
      // 到达真实服务。服务读取数据与校验配置都正常，只在保存阶段失败。
      (async () => {
        await firstPostHeld;
        await chmod(dataDir, 0o555);
        req.continue();
      })();
      return;
    }
    req.continue();
  });

  await page.click('#submit');

  // 处理期间创建按钮不可用，且不是瞬间恢复（请求被挂住以稳定观察等待状态）。
  await page.waitForFunction(
    () => document.getElementById('submit').disabled,
    { timeout: 5000 },
  );
  await sleep(300);
  assert.equal(
    (await readFormState(page)).submitDisabled,
    true,
    '保存处理期间创建按钮应保持不可用',
  );
  assert.equal(posts.length, 0, '响应返回前不应结束本次创建处理');

  // 放行：数据目录只读，真实服务保存失败。
  releaseFirstPost();
  await waitForMessageKind(page, 'error');
  await waitForPostCount(posts, 1);

  // 服务真实返回 500：error 说明保存方面的具体原因，不返回成功房间或新编号。
  const failResp = posts[0];
  assert.equal(failResp.status, 500, '保存失败应由真实服务返回 500');
  assert.ok(failResp.data && typeof failResp.data.error === 'string' && failResp.data.error !== '',
    '500 响应应携带非空的具体 error');
  assert.equal(failResp.data.id, undefined, '保存失败不应返回新房间编号');
  const saveReason = failResp.data.error;
  assert.ok(saveReason.includes('失败'), `error 应说明保存失败，实际: ${saveReason}`);
  assert.ok(
    saveReason.includes('数据') || saveReason.includes('文件') || saveReason.includes('保存'),
    `error 应指向数据/文件保存环节，实际: ${saveReason}`,
  );
  // 不能把保存失败说成合法填写有问题：原因里不应要求修改名称、规则、人数或时间。
  for (const word of ['名称', '规则', '人数', '时间']) {
    assert.ok(!saveReason.includes(word), `保存原因不应要求修改合法的${word}，实际: ${saveReason}`);
  }

  // 页面在创建表单附近原样显示服务给出的原因：不是成功提示、不是“创建结果
  // 未能确认”，也不是无法连接服务。
  const msg = await readMessage(page);
  assert.equal(msg.text, saveReason, '应在创建表单附近原样显示服务给出的保存原因');
  assert.equal(msg.insideForm, true, '失败原因应显示在创建表单附近');
  assert.ok(msg.className.includes('error'), '保存失败原因应以错误样式显示');
  assert.ok(!msg.className.includes('ok'), '保存失败时不应显示成功样式');
  assert.ok(!msg.className.includes('warn'), '保存失败不应显示成“创建结果未能确认”');
  assert.ok(!msg.text.includes(SUCCESS_PREFIX), '保存失败时不应出现成功编号');
  assert.ok(!msg.text.includes('房间已创建'), '保存失败时不应出现“房间已创建”');
  assert.ok(!msg.text.includes(UNCONFIRMED_TEXT), '保存失败不应显示“创建结果未能确认”');
  assert.ok(!msg.text.includes(CONN_FAILURE_TEXT), '保存失败不应显示成无法连接服务');

  // 失败不清空填写：名称保持输入时的首尾空白，规则、人数、时间保持原值，
  // 处理结束后按钮恢复可用。
  assert.deepEqual(await readFormState(page), {
    name: RAW_NAME,
    game: 'ludo',
    capacity: '4',
    capacityDisabled: false,
    turnSeconds: '60',
    submitDisabled: false,
  }, '保存失败后应保留全部已填内容（名称首尾空白原样）并恢复按钮可用');

  // 飞行棋的人数选项仍可使用：下拉未禁用，2/3/4 选项都在，当前仍是 4。
  assert.deepEqual(await readCapacityOptions(page), {
    disabled: false,
    value: '4',
    options: ['', '2', '3', '4'],
  }, '保存失败后飞行棋的人数选项仍应可用');

  // 已经展示的房间行与顺序保持不变：不临时增加新行，不换成空列表提示或
  // 列表加载失败。
  assert.deepEqual(await readRows(page), initialRows, '保存失败时不应改动房间列表');
  const list = await readListArea(page);
  assert.equal(list.rowCount, 2, '保存失败不应凭提交内容临时增加房间行');
  assert.ok(list.hasTable, '保存失败时已有房间表格应保留');
  assert.equal(list.errorText, null, '保存失败不应显示成房间列表读取失败');
  assert.equal(list.emptyText, null, '保存失败不应把列表替换成没有房间的提示');
  assert.ok(!list.text.includes('还没有房间记录'), '列表区域不应出现空列表提示');

  // 失败期间已有房间数据仍能正常读取，服务端记录没有增加。
  assert.deepEqual(
    await readServerRooms(baseURL),
    beforeRooms,
    '保存失败后服务端记录不应增加，已有记录的编号、配置、状态、创建时间与附带字段保持原值',
  );

  // 本地保存内容逐字节不变，没有半条新房间，也没有临时文件残留。
  const afterFailBytes = await readFile(dataFile);
  assert.ok(Buffer.compare(beforeBytes, afterFailBytes) === 0, '保存失败不得改写本地 rooms.json');
  assert.deepEqual(await readdir(dataDir), ['rooms.json'], '保存失败不应留下临时文件或半条新房间');

  // 保存条件恢复：不刷新页面、不重新填写，直接再次提交。
  await chmod(dataDir, 0o755);
  await page.click('#submit');

  await waitForMessageKind(page, 'ok');
  await waitForPostCount(posts, 2);

  // 页面确实只尝试了两次创建，两次请求体都是保留的合法配置（名称首尾空白
  // 与表情原样发送，页面侧不裁剪），没有自动重试产生额外请求。
  assert.equal(postBodies.length, 2, '应只在失败后手动再提交一次');
  assert.deepEqual(JSON.parse(postBodies[0]), VALID_PAYLOAD, '失败的提交应使用用户填写的合法配置');
  assert.deepEqual(JSON.parse(postBodies[1]), VALID_PAYLOAD, '再次提交应沿用保留的合法配置');

  const created = posts[1].data;
  assert.equal(posts[1].status, 201, '恢复后再次提交应由真实服务返回 201');
  assert.ok(created && typeof created.id === 'string' && created.id !== '',
    '创建结果应包含非空的新房间编号');
  assert.equal(created.name, TRIMMED_NAME, '名称应仅去掉首尾空白，保留内部空格与表情');
  assert.equal(created.game, 'ludo');
  assert.equal(created.capacity, 4);
  assert.equal(created.turnSeconds, 60);
  assert.equal(created.status, 'waiting');
  assert.equal(created.visibility, 'public');

  // 保存失败原因被成功结果替换；成功提示给出这次真正保存的编号。
  const msg2 = await readMessage(page);
  assert.ok(msg2.className.includes('ok'), '失败原因应被成功结果替换');
  assert.ok(msg2.text.startsWith(SUCCESS_PREFIX), `应显示成功提示，实际: ${msg2.text}`);
  assert.equal(msg2.text.slice(SUCCESS_PREFIX.length), created.id, '成功提示编号应与创建结果一致');
  assert.ok(!msg2.text.includes(saveReason), '成功结果不应残留保存失败原因');

  // 用户等待期间没有修改填写：成功后表单按现有行为恢复初始状态，按钮可用。
  assert.deepEqual(await readFormState(page), RESET_FORM, '未修改填写时成功后表单应恢复初始状态');
  assert.equal(
    (await readFormState(page)).submitDisabled,
    false,
    '请求完成后创建按钮应恢复可用',
  );

  // 列表只在旧房间之后增加这一条记录；先前失败的提交不会后来补成另一条。
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

  // 服务端只在原有记录之后追加这一条，已有记录（含备注、数组、嵌套对象）
  // 保持原值；本地落盘内容与接口一致，失败提交没有补成另一条。
  const serverRooms = await readServerRooms(baseURL);
  assert.equal(serverRooms.length, 3, '服务端应只新增这一条房间');
  assert.deepEqual(serverRooms.slice(0, 2), beforeRooms, '已有记录及附带字段应保持原值');
  assert.equal(serverRooms[2].id, created.id);
  assert.equal(serverRooms[2].name, TRIMMED_NAME);
  assert.equal(serverRooms[2].game, 'ludo');
  assert.equal(serverRooms[2].capacity, 4);
  assert.equal(serverRooms[2].turnSeconds, 60);
  assert.equal(serverRooms[2].status, 'waiting');

  const diskRooms = JSON.parse(await readFile(dataFile, 'utf8'));
  assert.equal(diskRooms.length, 3, '本地保存应只包含两条旧记录与本次新记录');
  assert.deepEqual(diskRooms.slice(0, 2), beforeRooms, '本地保存的旧记录及附带字段应保持原值');
  assert.deepEqual(diskRooms[2], created, '本地保存的新记录应与创建结果一致');
});
