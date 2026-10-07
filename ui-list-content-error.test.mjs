// 首页“房间列表读取：HTTP 200 但内容不可用”的界面回归测试。
//
// 与其他浏览器回归文件的分工：
//   - ui.test.mjs：创建成功/被拒、成功后列表竞态刷新（含刷新返回 500 的区分）；
//   - ui-mixed-records.test.mjs：rooms 数组合法时，数组内部混有非对象记录的展示；
//   - 本文件只盯住“列表请求返回 HTTP 200、正文却不可用”这一类容易与
//     “没有房间”混淆的内容错误，覆盖首次打开与创建成功触发刷新两个时机，
//     并以空数组、混合记录作为正常但易混的对照。
//
// 保护的已有行为（本文件不修改任何产品代码，只补回归保障）：
//   - 列表读取成功的唯一形态是“顶层为 JSON 对象且 rooms 字段是数组”：
//     正文为空或只有空白、不是合法 JSON，或虽能解析但顶层为 null、数组、
//     字符串（以及数字、布尔值）时，列表区域一律显示固定的加载失败提示；
//   - 顶层为对象但缺少 rooms，或 rooms 为 null、对象、字符串等任何非数组值，
//     同样按加载失败处理，不能显示“还没有房间记录”，不能把 room/data/list
//     等其他字段、顶层数组里的房间样子对象或 rooms 对象的内部内容猜成房间；
//   - 已经正常展示过房间、随后创建成功触发刷新而刷新遇到上述内容错误时：
//     旧表格必须移除并显示加载失败，不能保留旧记录冒充最新结果；表单区域
//     仍保留“房间已创建”提示与真实编号，不能误说成创建失败或创建结果未能
//     确认；等待期间未修改填写时表单按成功行为复位，创建按钮处理结束后恢复
//     可用；列表读取错误不会再次发出创建请求，也不会删除已保存的新房间；
//   - 正常对照：{ "rooms": [] } 显示空列表提示；rooms 数组混有非对象记录时
//     按现有规则展示房间对象并说明跳过条数，而不是整份加载失败；
//   - 内容恢复正常后用户刷新页面，看到真实保存的旧房间与刚创建的房间，
//     次序及编号沿用服务返回，先前的加载失败提示消失。
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

// 两条真实保存在服务端的旧房间：内容错误只发生在浏览器收到的响应正文里
// （请求拦截合成 HTTP 200），服务端数据始终完好，用于证明“已有数据不会
// 因此丢失”以及页面不能拿旧表格冒充最新结果。
const SEED_OLD_A =
  '{"id":"old-alpha","name":"旧房间甲","game":"ludo","capacity":4,"turnSeconds":30,' +
  '"status":"playing","visibility":"public","createdAt":"2026-04-01T08:00:00Z","note":"保留我"}';
const SEED_OLD_B =
  '{"id":"old-beta","name":"旧房间乙","game":"gomoku","capacity":2,"turnSeconds":0,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-04-02T20:00:00Z"}';

const EMPTY_TEXT = '还没有房间记录。';
const LIST_ERROR_TEXT = '房间列表加载失败，请稍后刷新重试。已有数据不会因此丢失。';
const SUCCESS_PREFIX = '房间已创建，编号：';

// 首次打开首页时，GET /api/rooms 返回 HTTP 200 但正文不可用的各种形态。
// leaks 列出该正文里“看起来像房间”的编号/名称：任何一个都不能被猜上屏。
const BAD_FIRST_OPEN = [
  { label: '正文为空', body: '', leaks: [] },
  { label: '正文只有空白', body: '  \n\t  \r\n', leaks: [] },
  { label: '正文不是合法 JSON', body: '{rooms:', leaks: [] },
  { label: '正文是半截 JSON 对象', body: '{"rooms":[', leaks: [] },
  { label: '顶层为 null', body: 'null', leaks: [] },
  { label: '顶层为数字', body: '42', leaks: [] },
  { label: '顶层为布尔值', body: 'true', leaks: [] },
  { label: '顶层为空数组', body: '[]', leaks: [] },
  {
    label: '顶层为装着房间样子对象的数组（不能展开）',
    body: '[{"id":"guess-array-room","name":"数组里的房间不应展开"}]',
    leaks: ['guess-array-room', '数组里的房间不应展开'],
  },
  { label: '顶层为字符串', body: '"guess-string-room"', leaks: ['guess-string-room'] },
  { label: '对象缺少 rooms（空对象）', body: '{}', leaks: [] },
  {
    label: '对象缺少 rooms，但 room/data/list 等其他字段像房间（不能猜）',
    body: '{"id":"guess-top-id","name":"顶层名称不是房间",' +
      '"room":{"id":"guess-room","name":"room 字段不是房间"},' +
      '"data":[{"id":"guess-data"}],"list":[{"id":"guess-list"}],' +
      '"items":[{"id":"guess-items"}],"results":[{}]}',
    leaks: ['guess-top-id', '顶层名称不是房间', 'guess-room', 'room 字段不是房间',
      'guess-data', 'guess-list', 'guess-items'],
  },
  { label: 'rooms 为 null', body: '{"rooms":null}', leaks: [] },
  {
    label: 'rooms 为对象（内部像房间也不能展开）',
    body: '{"rooms":{"id":"guess-rooms-obj","name":"rooms 对象不是数组"}}',
    leaks: ['guess-rooms-obj', 'rooms 对象不是数组'],
  },
  { label: 'rooms 为字符串', body: '{"rooms":"guess-rooms-str"}', leaks: ['guess-rooms-str'] },
  { label: 'rooms 为数字', body: '{"rooms":42}', leaks: [] },
  { label: 'rooms 为布尔值', body: '{"rooms":false}', leaks: [] },
];

// 创建成功后的列表刷新遇到内容错误：覆盖与首次打开相同的关键分支。
const BAD_REFRESH = [
  { label: '正文为空', body: '', leaks: [] },
  { label: '正文只有空白', body: '  \n\t ', leaks: [] },
  { label: '正文不是合法 JSON', body: '{rooms:', leaks: [] },
  { label: '顶层为 null', body: 'null', leaks: [] },
  {
    label: '顶层为装着房间样子对象的数组（不能展开）',
    body: '[{"id":"guess-array-room","name":"数组里的房间不应展开"}]',
    leaks: ['guess-array-room', '数组里的房间不应展开'],
  },
  { label: '顶层为字符串', body: '"guess-string-room"', leaks: ['guess-string-room'] },
  {
    label: '对象缺少 rooms，但其他字段像房间（不能猜）',
    body: '{"room":{"id":"guess-room"},"data":[{"id":"guess-data"}]}',
    leaks: ['guess-room', 'guess-data'],
  },
  { label: 'rooms 为 null', body: '{"rooms":null}', leaks: [] },
  {
    label: 'rooms 为对象（内部像房间也不能展开）',
    body: '{"rooms":{"id":"guess-rooms-obj","name":"rooms 对象不是数组"}}',
    leaks: ['guess-rooms-obj', 'rooms 对象不是数组'],
  },
  { label: 'rooms 为字符串', body: '{"rooms":"guess-rooms-str"}', leaks: ['guess-rooms-str'] },
];

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

async function seedRooms(dataDir, records) {
  const content = '[\n' + records.join(',\n') + '\n]\n';
  await writeFile(path.join(dataDir, 'rooms.json'), content);
  return content;
}

async function setupSeededServer(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'score-arena-uidata-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const seedText = await seedRooms(dataDir, [SEED_OLD_A, SEED_OLD_B]);
  const baseURL = await startServer(t, dataDir);
  return { dataDir, baseURL, seedText };
}

async function setupEmptyServer(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'score-arena-uidata-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await seedRooms(dataDir, []);
  const baseURL = await startServer(t, dataDir);
  return { dataDir, baseURL };
}

function waitForRowCount(page, n) {
  return page.waitForFunction(
    (want) => document.querySelectorAll('#list-area table tbody tr').length === want,
    { timeout: 10000 },
    n,
  );
}

function waitForListError(page) {
  return page.waitForFunction(
    () => !!document.querySelector('#list-area .list-error'),
    { timeout: 10000 },
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
    rowCount: document.querySelectorAll('#list-area table tbody tr').length,
    errorText: document.querySelector('#list-area .list-error')
      ? document.querySelector('#list-area .list-error').textContent
      : null,
    emptyText: document.querySelector('#list-area .empty')
      ? document.querySelector('#list-area .empty').textContent
      : null,
    skipText: document.querySelector('#list-area .skip-notice')
      ? document.querySelector('#list-area .skip-notice').textContent
      : null,
  }));
}

async function readServerRooms(baseURL) {
  const res = await fetch(baseURL + '/api/rooms');
  assert.equal(res.status, 200);
  return (await res.json()).rooms;
}

// 填写五子棋表单（人数固定 2 人由页面自动选中），不触发提交。
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

function nextCreated(page) {
  return new Promise((resolve, reject) => {
    page.on('response', (resp) => {
      if (resp.request().method() === 'POST' && resp.url().endsWith('/api/rooms')) {
        resp.json().then(resolve, reject);
      }
    });
  });
}

// 打开一个新页面，GET /api/rooms 一律由测试以 HTTP 200 + 指定正文应答，
// 其余请求（页面本身）放行到真实服务。返回监听到的列表响应状态码，
// 用于锁定“确实是 200 内容错误，而不是非 200”这一前提。
async function openPageWithFixedListBody(t, baseURL, body) {
  const page = await browser.newPage();
  let listStatus = null;
  page.on('response', (resp) => {
    if (resp.request().method() === 'GET' && resp.url().endsWith('/api/rooms')) {
      listStatus = resp.status();
    }
  });
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.method() === 'GET' && req.url().endsWith('/api/rooms')) {
      req.respond({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        body,
      });
    } else {
      req.continue();
    }
  });
  await page.goto(baseURL, { waitUntil: 'load' });
  return { page, getListStatus: () => listStatus };
}

// 断言列表区域只有固定的加载失败提示：没有空列表文案、没有表格、没有跳过
// 提示，旧房间与正文里“看起来像房间”的内容一律不上屏。
async function assertListContentError(page, variant) {
  const list = await readListArea(page);
  assert.equal(list.errorText, LIST_ERROR_TEXT, `${variant.label}：应显示固定的加载失败提示`);
  assert.equal(list.emptyText, null, `${variant.label}：不得显示“${EMPTY_TEXT}”`);
  assert.equal(list.hasTable, false, `${variant.label}：不应出现房间表格`);
  assert.equal(list.skipText, null, `${variant.label}：内容错误不是记录跳过，不应出现跳过提示`);
  assert.equal(
    list.text.trim(),
    LIST_ERROR_TEXT,
    `${variant.label}：列表区域应只包含加载失败提示，实际：${JSON.stringify(list.text)}`,
  );
  for (const token of ['old-alpha', 'old-beta', '旧房间甲', '旧房间乙', ...variant.leaks]) {
    assert.ok(!list.text.includes(token), `${variant.label}：不得把任何房间内容猜上屏：${token}`);
  }
}

// 首次打开首页：HTTP 200 但正文不可用的所有形态都必须明确显示“加载失败”，
// 不能与“没有房间”混淆，也不能从任何其他字段猜出房间；查看不改动服务端数据。
test('首次打开：HTTP 200 但正文为空/非法 JSON/顶层非对象/缺 rooms/rooms 非数组时显示加载失败', { timeout: 180000 }, async (t) => {
  const { baseURL, seedText, dataDir } = await setupSeededServer(t);

  for (const variant of BAD_FIRST_OPEN) {
    const { page, getListStatus } = await openPageWithFixedListBody(t, baseURL, variant.body);
    try {
      await waitForListError(page);

      // 前提必须是 HTTP 200：本保障针对的是“状态成功、内容不可用”。
      assert.equal(getListStatus(), 200, `${variant.label}：列表响应前提应为 HTTP 200`);
      await assertListContentError(page, variant);

      // 加载失败只影响列表区域：不影响创建表单本身（不出现创建相关的失败文案）。
      const msg = await readMessage(page);
      assert.equal(msg.text, '', `${variant.label}：列表失败不应在表单区域产生任何提示`);
    } finally {
      await page.close();
    }
  }

  // 服务端真实保存的旧房间一条不少、次序不变，本地文件逐字节保持种子内容：
  // 浏览器收到的错误正文是拦截合成的，只读查看绝不会改动已有数据。
  const rooms = await readServerRooms(baseURL);
  assert.deepEqual(rooms.map((r) => r.id), ['old-alpha', 'old-beta'], '服务端旧房间必须保留');
  assert.deepEqual(rooms[0], JSON.parse(SEED_OLD_A), '旧房间内容与附带字段必须原样保留');
  assert.deepEqual(rooms[1], JSON.parse(SEED_OLD_B));
  const onDisk = await readFile(path.join(dataDir, 'rooms.json'), 'utf8');
  assert.equal(onDisk, seedText, '查看错误正文不应改写本地 rooms.json');
});

// 对照：同样是 HTTP 200，{ "rooms": [] } 是合法的空列表，必须显示空列表提示，
// 不能误报加载失败。
test('对照：包含空 rooms 数组的对象显示空列表提示，不是加载失败', { timeout: 60000 }, async (t) => {
  const { baseURL } = await setupEmptyServer(t);
  const { page } = await openPageWithFixedListBody(t, baseURL, JSON.stringify({ rooms: [] }));
  try {
    await page.waitForFunction(
      () => !!document.querySelector('#list-area .empty'),
      { timeout: 10000 },
    );
    const list = await readListArea(page);
    assert.equal(list.emptyText, EMPTY_TEXT, '空 rooms 数组应显示空列表提示');
    assert.equal(list.errorText, null, '空 rooms 数组不是加载失败');
    assert.equal(list.hasTable, false);
    assert.equal(list.skipText, null, '空数组不应产生跳过提示');
    assert.equal(list.text.trim(), EMPTY_TEXT);
  } finally {
    await page.close();
  }
});

// 对照：rooms 数组合法但混有非对象记录时，沿用现有规则展示房间对象并说明
// 跳过条数，绝不能因为数组里有坏记录就把整份列表判成加载失败。
test('对照：rooms 数组混有非对象记录时展示房间对象、说明跳过条数，不是整份加载失败', { timeout: 60000 }, async (t) => {
  const { baseURL } = await setupEmptyServer(t);
  const ok1 = {
    id: 'ctrl-room-1', name: '可展示房间甲', game: 'gomoku', capacity: 2,
    turnSeconds: 0, status: 'waiting', visibility: 'public',
    createdAt: '2026-05-01T01:02:03Z',
  };
  const ok2 = {
    id: 'ctrl-room-2', name: '可展示房间乙', game: 'ludo', capacity: 3,
    turnSeconds: 60, status: 'waiting', visibility: 'public',
    createdAt: '2026-05-02T04:05:06Z',
  };
  // 5 条非对象记录：null、字符串、数字、布尔值、装着房间的数组（不展开）。
  const roomsPayload = [ok1, null, '误入的字符串', 42, false, [{ id: 'inside-array' }], ok2];
  const { page } = await openPageWithFixedListBody(t, baseURL, JSON.stringify({ rooms: roomsPayload }));
  try {
    await waitForRowCount(page, 2);
    const list = await readListArea(page);
    assert.equal(list.errorText, null, '数组内部的坏记录不能让整份列表加载失败');
    assert.equal(list.emptyText, null, '存在可展示房间时不应显示空列表提示');
    assert.equal(list.rowCount, 2, '只有房间对象成行，非对象记录不展开');
    assert.equal(
      list.skipText,
      '有 5 条房间记录无法作为房间显示，已跳过；原始数据仍保留在服务端，未被删除或改写。',
      '应按现有规则给出准确跳过条数与保留说明',
    );

    const rows = await readRows(page);
    assert.deepEqual(rows.map((r) => r.cells[0]), ['ctrl-room-1', 'ctrl-room-2'],
      '房间对象按返回数组中的相对次序成行');
    assert.deepEqual(rows[0].cells.slice(0, 6),
      ['ctrl-room-1', '可展示房间甲', '五子棋', '2 人', '不限时', '未开始']);
    assert.deepEqual(rows[1].cells.slice(0, 6),
      ['ctrl-room-2', '可展示房间乙', '飞行棋', '3 人', '60 秒', '未开始']);
    assert.ok(!list.text.includes('inside-array'), '数组里的房间不能被展开');
    assert.ok(!list.text.includes('误入的字符串'), '被跳过的字符串不能上屏');
  } finally {
    await page.close();
  }
});

// 核心区分：先正常展示旧房间，再真实创建一间房（201 + 有效编号，确已保存），
// 紧随其后的列表刷新返回 HTTP 200 错误正文。页面必须移除旧表格显示加载失败，
// 同时完整保留创建成功这一独立结果；列表错误既不会再建一间房，也不会删掉新房间。
test('创建成功后刷新遇 HTTP 200 错误正文：移除旧表格显示加载失败，成功提示/编号/表单复位/按钮恢复保留，不重建不删除', { timeout: 180000 }, async (t) => {
  const { baseURL } = await setupSeededServer(t);

  for (const variant of BAD_REFRESH) {
    const beforeRooms = await readServerRooms(baseURL);
    const page = await browser.newPage();
    const postBodies = [];
    let listGets = 0;
    let refreshStatus = null;
    try {
      page.on('request', (req) => {
        if (req.method() === 'POST' && req.url().endsWith('/api/rooms')) {
          postBodies.push(req.postData());
        }
      });
      page.on('response', (resp) => {
        if (resp.request().method() === 'GET' && resp.url().endsWith('/api/rooms')) {
          listGets += 1;
          if (listGets === 2) refreshStatus = resp.status();
        }
      });

      // 第一次列表查询（打开页面）放行到真实服务；创建成功触发的第二次查询
      // 以 HTTP 200 + 错误正文应答；POST 创建始终放行并真实落盘。
      let getCount = 0;
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        if (req.method() === 'GET' && req.url().endsWith('/api/rooms')) {
          getCount += 1;
          if (getCount === 1) {
            req.continue();
          } else {
            req.respond({
              status: 200,
              contentType: 'application/json; charset=utf-8',
              body: variant.body,
            });
          }
        } else {
          req.continue();
        }
      });

      await page.goto(baseURL, { waitUntil: 'load' });
      // 刷新前先真实展示服务端已有的全部房间。
      await waitForRowCount(page, beforeRooms.length);
      const oldRows = await readRows(page);
      assert.deepEqual(
        oldRows.map((r) => r.cells[0]),
        beforeRooms.map((r) => r.id),
        `${variant.label}：刷新前应先看到服务端真实房间`,
      );

      // 真实创建：名称首尾带空白，五子棋固定 2 人，0 秒不限时；等待期间不修改。
      const createdPromise = nextCreated(page);
      const rawName = '  刷新内容错误房  ';
      await fillGomokuForm(page, rawName, 0);
      await page.click('#submit');
      const created = await createdPromise;
      assert.ok(created.id, `${variant.label}：创建响应必须带有效编号`);

      // 表单区域保留本次“房间已创建”提示与真实编号：不能误说成创建失败或
      // 创建结果未能确认，也不能提示无法连接。
      await waitForMessageKind(page, 'ok');
      const msg = await readMessage(page);
      assert.equal(
        msg.text,
        SUCCESS_PREFIX + created.id,
        `${variant.label}：应原样保留成功提示与真实编号`,
      );
      assert.ok(msg.className.includes('ok'));
      for (const wrong of ['创建失败', '创建结果未能确认', '无法连接', '失败']) {
        assert.ok(!msg.text.includes(wrong), `${variant.label}：成功提示不能包含“${wrong}”`);
      }

      // 等待期间未修改填写：表单按成功行为复位，创建按钮在处理结束后恢复可用。
      await page.waitForFunction(
        () => !document.getElementById('submit').disabled,
        { timeout: 10000 },
      );
      assert.deepEqual(await readFormState(page), {
        name: '',
        game: '',
        capacity: '',
        capacityDisabled: true,
        turnSeconds: '',
        submitDisabled: false,
      }, `${variant.label}：成功后表单应复位、创建按钮应恢复可用`);

      // 列表区域：旧表格移除、显示加载失败，不留旧记录、不显示空列表、
      // 不把错误正文里的任何内容猜成房间（包括刚创建的真实编号也不能借错误正文上屏）。
      await waitForListError(page);
      assert.equal(refreshStatus, 200, `${variant.label}：刷新响应前提应为 HTTP 200`);
      const listVariant = { label: variant.label, leaks: [...variant.leaks, created.id, '刷新内容错误房'] };
      await assertListContentError(page, listVariant);

      // 列表读取错误不会再次创建房间：整个流程只发出一次 POST，多等一会儿
      // 也不得出现自动重试或补建。
      assert.equal(postBodies.length, 1, `${variant.label}：应只发出一次创建请求`);
      assert.deepEqual(JSON.parse(postBodies[0]), {
        name: rawName,
        game: 'gomoku',
        capacity: 2,
        turnSeconds: 0,
      }, `${variant.label}：创建请求体应与提交时配置一致`);
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(postBodies.length, 1, `${variant.label}：列表失败不得触发再次创建`);

      // 服务端侧：旧房间一条不少，新房间确实已保存且只追加一次，编号与配置
      // 与创建响应一致——错误的列表回应不能删除或改写任何已保存数据。
      const afterRooms = await readServerRooms(baseURL);
      assert.equal(afterRooms.length, beforeRooms.length + 1,
        `${variant.label}：服务端应恰好多出本次创建的一间房`);
      assert.deepEqual(
        afterRooms.slice(0, beforeRooms.length).map((r) => r.id),
        beforeRooms.map((r) => r.id),
        `${variant.label}：旧房间编号与次序必须保留`,
      );
      const saved = afterRooms[afterRooms.length - 1];
      assert.equal(saved.id, created.id, `${variant.label}：新房间编号应与创建结果一致`);
      assert.equal(saved.name, '刷新内容错误房', `${variant.label}：名称应只去首尾空白`);
      assert.equal(saved.game, 'gomoku');
      assert.equal(saved.capacity, 2);
      assert.equal(saved.turnSeconds, 0);
      assert.equal(saved.status, 'waiting');
      assert.equal(saved.visibility, 'public');
    } finally {
      await page.close();
    }
  }
});

// 恢复：列表内容恢复正常后，用户按提示刷新页面，应看到真实保存的旧房间和
// 刚创建的房间，次序及编号沿用服务返回，先前的加载失败提示消失。
test('内容恢复正常后刷新页面：看到真实保存的旧房间与新房间，次序编号沿用服务返回，失败提示消失', { timeout: 60000 }, async (t) => {
  const { baseURL } = await setupSeededServer(t);

  const page = await browser.newPage();
  t.after(() => page.close());
  const postBodies = [];
  page.on('request', (req) => {
    if (req.method() === 'POST' && req.url().endsWith('/api/rooms')) {
      postBodies.push(req.postData());
    }
  });

  let getCount = 0;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.method() === 'GET' && req.url().endsWith('/api/rooms')) {
      getCount += 1;
      if (getCount === 1) {
        req.continue(); // 首次打开：真实展示两条旧房间
      } else if (getCount === 2) {
        req.respond({ status: 200, contentType: 'application/json; charset=utf-8', body: 'null' });
      } else {
        req.continue(); // 用户刷新后内容恢复正常，放行到真实服务
      }
    } else {
      req.continue();
    }
  });

  await page.goto(baseURL, { waitUntil: 'load' });
  await waitForRowCount(page, 2);

  const createdPromise = nextCreated(page);
  await fillGomokuForm(page, '  恢复后可见的新房间 ', 30);
  await page.click('#submit');
  const created = await createdPromise;
  await waitForMessageKind(page, 'ok');
  await waitForListError(page);

  // 失败状态确认：旧表格移除、成功提示与真实编号保留、新房间确已保存。
  let list = await readListArea(page);
  assert.equal(list.errorText, LIST_ERROR_TEXT);
  assert.equal(list.hasTable, false);
  const msg = await readMessage(page);
  assert.equal(msg.text, SUCCESS_PREFIX + created.id);
  const truthBefore = await readServerRooms(baseURL);
  assert.deepEqual(truthBefore.map((r) => r.id), ['old-alpha', 'old-beta', created.id]);

  // 用户按提示刷新页面：此后 GET 放行真实服务，内容恢复正常。
  await page.reload({ waitUntil: 'load' });
  await waitForRowCount(page, 3);

  list = await readListArea(page);
  assert.equal(list.errorText, null, '刷新恢复后先前的加载失败提示必须消失');
  assert.equal(list.emptyText, null);
  assert.equal(list.hasTable, true);
  assert.equal(list.skipText, null);

  // 页面上的房间、次序与编号完全沿用服务返回。
  const serverRooms = await readServerRooms(baseURL);
  const rows = await readRows(page);
  assert.deepEqual(
    rows.map((r) => r.cells[0]),
    serverRooms.map((r) => r.id),
    '刷新后展示的编号与次序应与服务返回一致',
  );
  assert.deepEqual(rows.map((r) => r.cells[0]), ['old-alpha', 'old-beta', created.id]);
  assert.deepEqual(rows[0].cells.slice(0, 6),
    ['old-alpha', '旧房间甲', '飞行棋', '4 人', '30 秒', 'playing']);
  assert.deepEqual(rows[1].cells.slice(0, 6),
    ['old-beta', '旧房间乙', '五子棋', '2 人', '不限时', '未开始']);
  assert.equal(rows[1].badge, '未开始');
  assert.deepEqual(rows[2].cells.slice(0, 6),
    [created.id, '恢复后可见的新房间', '五子棋', '2 人', '30 秒', '未开始']);
  assert.equal(rows[2].badge, '未开始');
  assert.ok(!list.text.includes(LIST_ERROR_TEXT), '列表区域不得残留任何失败文案');

  // 全程只创建一次；真实保存的房间数与内容不变。
  assert.equal(postBodies.length, 1, '恢复刷新不得再次创建房间');
  const roomsAfter = await readServerRooms(baseURL);
  assert.equal(roomsAfter.length, 3);
  assert.equal(roomsAfter[2].id, created.id);
});
