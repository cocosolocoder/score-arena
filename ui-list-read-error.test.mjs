// 首页“房间列表读取”在“请求返回 HTTP 200、但正文内容不可用”时的界面回归测试。
//
// 与其他浏览器回归文件的分工：
//   - ui.test.mjs：创建成功/被拒、成功后列表竞态刷新（含列表刷新返回 500 的区分）；
//   - ui-mixed-records.test.mjs：rooms 数组合法时，数组内部混有非对象记录的展示；
//   - ui-create-unconfirmed.test.mjs：POST 创建结果本身是否拿到有效编号；
//   - 本文件只盯住 GET /api/rooms“HTTP 层成功、内容层失败”这一种最容易被
//     误判成“没有房间”的情形：状态码是 200，但正文为空、不是合法 JSON，
//     或虽能解析但顶层/rooms 字段的形态不对。
//
// 保护的已有行为（本文件不修改任何产品代码，只补回归保障）：
//   - 列表读取成功的唯一形态是“顶层为 JSON 对象、且 rooms 字段是数组”。
//     正文为空/纯空白/非法 JSON，顶层为 null、数组（哪怕数组里装着房间
//     对象）、字符串、数字、布尔值，对象缺少 rooms，或 rooms 为 null、
//     对象、字符串、数字、布尔值等非数组值——一律显示固定的列表加载失败
//     文案，绝不显示“还没有房间记录”，也不能从 rooms 以外的字段
//     （data/items/otherRooms 等）或顶层数组里“猜”出房间上屏；
//   - 已正常展示过房间、随后创建成功触发列表刷新时遇到上述内容错误：
//     列表必须移除旧表格改显加载失败（不能保留旧记录冒充最新结果），
//     但表单区域仍保留本次“房间已创建”提示与真实编号、表单按成功行为
//     复位、创建按钮恢复可用；列表读取错误既不会再次创建房间，也不会
//     删除服务端已保存的新房间；
//   - 正常但容易混淆的对照：{"rooms":[]} 显示空列表提示；rooms 数组里
//     混有非对象记录时按现有规则展示房间对象并说明跳过条数，而不是整份
//     加载失败，rooms 以外的字段一律忽略；
//   - 内容恢复正常后用户按提示刷新页面：真实保存的旧房间与刚创建的房间
//     都按服务返回的次序与编号显示，先前的加载失败提示消失。
//
// 与 ui-create-unconfirmed.test.mjs 相同，本文件在真实服务前放一个仅用于
// 测试的转发代理：真实服务始终正常运行、真实读写数据，代理等到真实响应
// 到达后，再按用例把发给浏览器的 GET 响应替换成“200 + 异常正文”。这样
// 可以同时验证两端：浏览器看到的是 200 异常正文，而服务端数据从头到尾
// 真实可读、真实保存，不被异常回应改变。
//
// 运行：npm test（需要系统 Chrome，可用 CHROME_PATH 指定路径）。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer-core';

const repoRoot = import.meta.dirname;
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let serverBin;
let browser;

// 与其他界面回归文件相同的两条种子记录：创建/刷新前后用于核对旧房间的
// 内容、编号与次序，以及附带字段原样保留。
const SEED_ALPHA =
  '{"id":"seed-alpha","name":"晨间飞行棋","game":"ludo","capacity":4,"turnSeconds":30,' +
  '"status":"playing","visibility":"public","createdAt":"2026-01-01T08:00:00Z","note":"保留我","tags":["老友","周赛"]}';
const SEED_BETA =
  '{"id":"seed-beta","name":"午夜五子棋","game":"gomoku","capacity":2,"turnSeconds":0,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-01-02T23:00:00Z","extra":{"rank":3}}';

const LIST_ERROR_TEXT = '房间列表加载失败，请稍后刷新重试。已有数据不会因此丢失。';
const EMPTY_TEXT = '还没有房间记录。';
const SUCCESS_PREFIX = '房间已创建，编号：';
const CONN_FAILURE_TEXT = '无法连接服务，请确认服务仍在运行后重试。';

// 一个“看起来完全正常”的房间对象，专门放在错误位置（顶层数组里、rooms
// 以外的字段中、rooms 字符串内部）作诱惑：它绝不能被页面当成房间展示。
const LURE_ROOM = {
  id: 'lure-room-id',
  name: '不应被猜出的房间',
  game: 'gomoku',
  capacity: 2,
  turnSeconds: 0,
  status: 'waiting',
  visibility: 'public',
  createdAt: '2026-04-01T00:00:00Z',
};
const LURE_TOKENS = ['lure-room-id', '不应被猜出的房间'];

// 首屏“HTTP 200 但内容不可用”的全部变体。每一种都必须落到同一种处理：
// 列表区域显示固定的加载失败文案。lure 额外列出该变体正文里出现、但绝不
// 能上屏的诱惑文字。
const MALFORMED_VARIANTS = [
  { label: '响应正文为空', body: '', lure: [] },
  { label: '响应正文只有空白', body: '  \n\t\r\n  ', lure: [] },
  { label: '响应正文不是合法 JSON', body: '房间列表内容损坏了{,,', lure: ['房间列表内容损坏了'] },
  { label: 'JSON 在对象中途被截断', body: '{"rooms":[', lure: [] },
  { label: '顶层为 null', body: 'null', lure: [] },
  {
    label: '顶层为空数组',
    body: '[]',
    lure: [],
  },
  {
    label: '顶层为装着房间对象的数组（数组不展开、不猜房间）',
    body: JSON.stringify([LURE_ROOM, { ...LURE_ROOM, id: 'lure-room-id-2' }]),
    lure: [...LURE_TOKENS, 'lure-room-id-2'],
  },
  { label: '顶层为字符串', body: JSON.stringify('房间列表暂时不可用'), lure: ['房间列表暂时不可用'] },
  { label: '顶层为数字', body: '404', lure: ['404'] },
  { label: '顶层为布尔值', body: 'true', lure: [] },
  {
    label: '对象缺少 rooms，房间藏在 data 字段',
    body: JSON.stringify({ ok: true, data: [LURE_ROOM] }),
    lure: LURE_TOKENS,
  },
  {
    label: '对象缺少 rooms，房间藏在 items/otherRooms 字段',
    body: JSON.stringify({ rooms_: [LURE_ROOM], otherRooms: [{ ...LURE_ROOM, id: 'lure-2' }] }),
    lure: [...LURE_TOKENS, 'lure-2'],
  },
  { label: 'rooms 为 null', body: JSON.stringify({ rooms: null }), lure: [] },
  {
    label: 'rooms 为对象（房间对象也不能当成列表展开）',
    body: JSON.stringify({ rooms: LURE_ROOM }),
    lure: LURE_TOKENS,
  },
  {
    label: 'rooms 为字符串，内容是房间数组的 JSON 文本',
    body: JSON.stringify({ rooms: JSON.stringify([LURE_ROOM]) }),
    lure: LURE_TOKENS,
  },
  { label: 'rooms 为数字', body: JSON.stringify({ rooms: 42 }), lure: [] },
  { label: 'rooms 为布尔值', body: JSON.stringify({ rooms: true }), lure: [] },
];

// 创建成功后的列表刷新同样要覆盖主要错误形态（与首屏共用同一条失败路径，
// 这里选取有代表性的子集逐一体检“成功提示保留、旧表格移除、数据不丢”）。
const REFRESH_VARIANTS = MALFORMED_VARIANTS.filter((v) => [
  '响应正文为空',
  '响应正文不是合法 JSON',
  '顶层为 null',
  '顶层为装着房间对象的数组（数组不展开、不猜房间）',
  '顶层为字符串',
  '对象缺少 rooms，房间藏在 data 字段',
  'rooms 为 null',
  'rooms 为对象（房间对象也不能当成列表展开）',
  'rooms 为字符串，内容是房间数组的 JSON 文本',
].includes(v.label));

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

async function seedRooms(dataDir, records) {
  const content = '[\n' + records.join(',\n') + '\n]\n';
  await writeFile(path.join(dataDir, 'rooms.json'), content);
  return content;
}

// startProxy 在真实服务前启动只用于测试的转发代理。POST /api/rooms 始终
// 原样转发（创建是真实的），代理只记录真实响应；GET /api/rooms 在真实响应
// 到达后调用 options.getSpec({ index, upstreamStatus })：
//   返回 null             → 原样透传真实响应；
//   返回 { status, body } → 用给定状态（默认 200）与正文替换响应。
// gets/posts 记录每次房间接口请求的真实与实际发出状态，用于断言“浏览器
// 收到的确是 200”以及“列表失败没有触发第二次创建”。
function startProxy(t, realPort, options = {}) {
  const counts = { getRooms: 0, postRooms: 0 };
  const gets = [];
  const posts = [];
  // 主动销毁 keep-alive 连接，避免 server.close() 挂住用例清理。
  const sockets = new Set();
  const server = http.createServer((req, clientRes) => {
    const isRoomsApi = req.url.endsWith('/api/rooms');
    if (isRoomsApi && req.method === 'GET') counts.getRooms++;
    if (isRoomsApi && req.method === 'POST') counts.postRooms++;

    const reqChunks = [];
    req.on('data', (c) => reqChunks.push(c));
    req.on('error', () => clientRes.destroy());

    const forward = () => {
      const proxyReq = http.request({
        hostname: '127.0.0.1',
        port: realPort,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `127.0.0.1:${realPort}` },
      }, (proxyRes) => {
        const upChunks = [];
        proxyRes.on('data', (c) => upChunks.push(c));
        proxyRes.on('error', () => { if (!clientRes.writableEnded) clientRes.destroy(); });
        proxyRes.on('end', () => {
          const realBody = Buffer.concat(upChunks);

          // POST 始终透传，只记录真实保存结果（含服务端生成的真实编号）。
          if (isRoomsApi && req.method === 'POST') {
            let room = null;
            try { room = JSON.parse(realBody.toString('utf8')); } catch { room = null; }
            posts.push({
              status: proxyRes.statusCode,
              room,
              reqBody: Buffer.concat(reqChunks).toString('utf8'),
            });
          }

          if (isRoomsApi && req.method === 'GET' && options.getSpec) {
            const spec = options.getSpec({
              index: gets.length,
              upstreamStatus: proxyRes.statusCode,
            });
            gets.push({
              upstreamStatus: proxyRes.statusCode,
              sentStatus: spec ? (spec.status ?? 200) : proxyRes.statusCode,
              replaced: !!spec,
            });
            if (spec) {
              clientRes.writeHead(spec.status ?? 200, {
                'Content-Type': 'application/json; charset=utf-8',
              });
              clientRes.end(spec.body ?? '');
              return;
            }
          }

          clientRes.writeHead(proxyRes.statusCode, proxyRes.headers);
          clientRes.end(realBody);
        });
      });
      proxyReq.on('error', () => { if (!clientRes.writableEnded) clientRes.destroy(); });
      proxyReq.end(Buffer.concat(reqChunks));
    };
    if (req.complete) forward();
    else req.on('end', forward);
  });
  server.on('connection', (sock) => {
    sockets.add(sock);
    sock.on('close', () => sockets.delete(sock));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        counts,
        gets,
        posts,
        close: async () => {
          for (const sock of sockets) sock.destroy();
          await new Promise((resolveClose) => server.close(resolveClose));
        },
      });
    });
  });
}

// 每个用例独立的数据目录、真实服务、代理与页面。
// getSpec 控制 GET /api/rooms 的替换策略；seed 为初始 rooms.json 记录。
async function setupPage(t, getSpec, seed = [SEED_ALPHA, SEED_BETA]) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'score-arena-uidata-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const seedText = await seedRooms(dataDir, seed);
  const realURL = await startServer(t, dataDir);
  const realPort = Number(new URL(realURL).port);
  const proxy = await startProxy(t, realPort, { getSpec });
  t.after(() => proxy.close());

  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(proxy.url, { waitUntil: 'load' });
  return { page, proxy, realURL, dataDir, seedText };
}

function waitForListError(page) {
  return page.waitForFunction(
    (text) => {
      const el = document.querySelector('#list-area .list-error');
      return !!el && el.textContent === text;
    },
    { timeout: 10000 },
    LIST_ERROR_TEXT,
  );
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

function readListArea(page) {
  return page.evaluate(() => ({
    text: document.getElementById('list-area').textContent,
    hasTable: !!document.querySelector('#list-area table'),
    rowCount: document.querySelectorAll('#list-area table tbody tr').length,
    errorCount: document.querySelectorAll('#list-area .list-error').length,
    errorText: document.querySelector('#list-area .list-error')
      ? document.querySelector('#list-area .list-error').textContent
      : null,
    emptyTexts: [...document.querySelectorAll('#list-area .empty')].map((el) => el.textContent),
    skipCount: document.querySelectorAll('#list-area .skip-notice').length,
    skipText: document.querySelector('#list-area .skip-notice')
      ? document.querySelector('#list-area .skip-notice').textContent
      : null,
  }));
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

async function readServerRooms(baseURL) {
  const res = await fetch(baseURL + '/api/rooms');
  assert.equal(res.status, 200, '绕过代理直连真实服务应始终可读');
  return (await res.json()).rooms;
}

// 统一断言列表处于“加载失败”形态：唯一一条固定文案，无表格、无空列表
// 提示、无跳过提示，旧房间与诱惑内容都不上屏。
async function assertListError(page, lureTokens) {
  const list = await readListArea(page);
  assert.equal(list.errorCount, 1, '列表区域应只有一条加载失败提示');
  assert.equal(list.errorText, LIST_ERROR_TEXT, '应显示固定的列表加载失败文案');
  assert.equal(list.hasTable, false, '加载失败时必须移除房间表格（不能保留旧记录）');
  assert.equal(list.rowCount, 0, '加载失败时不能有任何房间行');
  assert.deepEqual(list.emptyTexts, [], '加载失败不能显示成“还没有房间记录”');
  assert.ok(!list.text.includes(EMPTY_TEXT), '加载失败文案中不能夹带空列表提示');
  assert.equal(list.skipCount, 0, '内容不可用不是“部分记录跳过”');
  assert.ok(!list.text.includes('跳过'), '加载失败不能显示跳过提示');
  // 旧房间与错误位置里的诱惑房间都不能上屏。
  for (const token of ['seed-alpha', 'seed-beta', '晨间飞行棋', '午夜五子棋', ...(lureTokens || [])]) {
    assert.ok(!list.text.includes(token), `加载失败时不能展示任何房间内容：${token}`);
  }
  return list;
}

// 填写一份合法的五子棋配置（2 人由页面自动选中），不点击提交。
async function fillGomokuForm(page, name, turnSeconds) {
  await page.type('#name', name);
  await page.select('#game', 'gomoku');
  await page.waitForFunction(
    () => !document.getElementById('capacity').disabled &&
      document.getElementById('capacity').value === '2',
    { timeout: 5000 },
  );
  await page.type('#turnSeconds', String(turnSeconds));
}

// 正常成功且等待期间未修改时的表单复位状态。
const RESET_FORM = {
  name: '',
  game: '',
  capacity: '',
  capacityDisabled: true,
  turnSeconds: '',
  submitDisabled: false,
};

// ---------------------------------------------------------------------------
// 一、首次打开首页：GET 返回 200 但正文内容不可用的全部形态
// ---------------------------------------------------------------------------

for (const variant of MALFORMED_VARIANTS) {
  test(`首屏列表 200 但内容不可用（${variant.label}）：显示加载失败，不显示空列表、不猜房间，服务端数据不变`, { timeout: 60000 }, async (t) => {
    // 始终用异常正文替换列表响应；真实服务本身数据正常（有两条种子房间）。
    const { page, proxy, realURL, dataDir, seedText } = await setupPage(
      t,
      () => ({ status: 200, body: variant.body }),
    );

    await waitForListError(page);
    // 给页面足够时间，确认不会迟来一个表格或空提示。
    await sleep(300);
    await assertListError(page, variant.lure);

    // 浏览器收到的确是 HTTP 200：失败判断只来自内容形态，不是状态码。
    assert.equal(proxy.gets.length, 1);
    assert.equal(proxy.gets[0].upstreamStatus, 200, '真实服务应正常返回 200');
    assert.equal(proxy.gets[0].sentStatus, 200, '浏览器收到的状态码必须是 200');

    // 查看失败不改写服务端数据：直连真实服务仍是原两条房间，本地文件逐字节不变。
    const rooms = await readServerRooms(realURL);
    assert.equal(rooms.length, 2, '异常列表回应不能改变或清空已有房间');
    assert.equal(rooms[0].id, 'seed-alpha');
    assert.equal(rooms[1].id, 'seed-beta');
    const onDisk = await readFile(path.join(dataDir, 'rooms.json'), 'utf8');
    assert.equal(onDisk, seedText, '列表内容错误时本地保存文件必须逐字节保持原样');

    // 首屏失败不产生任何创建请求。
    assert.equal(proxy.counts.postRooms, 0, '读取列表失败不能触发房间创建');
  });
}

// 即使服务端真实数据是空列表，200 异常正文仍必须显示“加载失败”而不是
// “还没有房间记录”：空数据与读不出内容是两件事。
test('首屏真实数据为空但 200 正文为 null：显示加载失败而非空列表提示', { timeout: 60000 }, async (t) => {
  const { page, proxy, realURL } = await setupPage(t, () => ({ status: 200, body: 'null' }), []);

  await waitForListError(page);
  await assertListError(page, []);

  const rooms = await readServerRooms(realURL);
  assert.deepEqual(rooms, [], '真实服务端确实没有房间，但页面不能据此显示空列表提示');
  assert.equal(proxy.counts.postRooms, 0);
});

// ---------------------------------------------------------------------------
// 二、已展示房间、创建成功后列表刷新遇到 200 内容错误
// ---------------------------------------------------------------------------

const NEW_ROOM_NAME = '刷新失败当天新建的五子棋房间';

for (const variant of REFRESH_VARIANTS) {
  test(`创建成功后列表刷新 200 但内容不可用（${variant.label}）：保留成功提示与真实编号、移除旧表格，房间真实保存`, { timeout: 60000 }, async (t) => {
    // 首屏列表（第 0 次 GET）透传看到种子房间；创建后的刷新（第 1 次 GET）
    // 返回 200 异常正文；POST 始终真实转发、真实保存。
    const { page, proxy, realURL } = await setupPage(t, (info) => {
      if (info.index === 1) return { status: 200, body: variant.body };
      return null;
    });

    await waitForRowCount(page, 2);
    const beforeRows = await readRows(page);
    assert.deepEqual(
      beforeRows.map((r) => r.cells[0]),
      ['seed-alpha', 'seed-beta'],
      '创建前应先正常看到两条种子房间',
    );

    await fillGomokuForm(page, NEW_ROOM_NAME, 0);
    await page.click('#submit');

    // 真实创建完成：代理拿到完整 201 与服务端生成的真实编号。
    await waitForMessageKind(page, 'ok');
    await waitForListError(page);
    assert.equal(proxy.posts.length, 1, '本次操作应只发出一次创建请求');
    const post = proxy.posts[0];
    assert.equal(post.status, 201, '创建请求应被真实服务接受并保存');
    const created = post.room;
    assert.ok(created && typeof created.id === 'string' && created.id !== '',
      '服务端应生成非空字符串编号');
    assert.equal(created.name, NEW_ROOM_NAME);
    assert.equal(created.game, 'gomoku');
    assert.equal(created.capacity, 2);
    assert.equal(created.turnSeconds, 0);
    assert.equal(created.status, 'waiting');
    assert.equal(created.visibility, 'public');

    // 表单区域：仍是本次成功提示与真实编号，不能误说成创建失败/未能确认/
    // 无法连接；等待期间未修改填写，表单按成功行为复位，按钮恢复可用。
    const msg = await readMessage(page);
    assert.equal(msg.text, SUCCESS_PREFIX + created.id, '列表刷新失败不能改变创建成功提示');
    assert.ok(msg.className.includes('ok'), '成功提示应保持 ok 样式');
    assert.ok(!msg.className.includes('error') && !msg.className.includes('warn'));
    assert.ok(!msg.text.includes('创建失败'), '不能误报创建失败');
    assert.ok(!msg.text.includes('创建结果未能确认'), '创建结果已确认，不能显示不确定提醒');
    assert.ok(!msg.text.includes(CONN_FAILURE_TEXT), '不能误报无法连接服务');
    assert.deepEqual(await readFormState(page), RESET_FORM, '未修改填写时表单应按成功行为复位、按钮恢复可用');

    // 列表区域：旧表格必须移除，改显加载失败；旧房间、新编号与诱惑内容都不上屏。
    await assertListError(page, variant.lure);
    assert.ok(!(await readListArea(page)).text.includes(created.id), '加载失败时新编号不能在列表区域出现');

    // 浏览器侧两次列表查询收到的都是 200（首屏正常、刷新内容错误）。
    assert.equal(proxy.gets.length, 2);
    assert.equal(proxy.gets[0].sentStatus, 200);
    assert.equal(proxy.gets[1].sentStatus, 200, '刷新失败那次响应的状态码必须是 200');
    assert.equal(proxy.gets[1].replaced, true);

    // 列表读取错误不会再次创建房间，也没有自动重试列表请求。
    await sleep(300);
    assert.equal(proxy.counts.postRooms, 1, '列表读取错误不能再次触发创建请求');
    assert.equal(proxy.posts.length, 1);
    assert.equal(proxy.counts.getRooms, 2, '页面不应自动重试失败的列表查询');

    // 新房间确实已经保存在真实服务端：旧房间原位保留，新房间追加在最后，
    // 编号即创建响应中的真实编号，异常列表回应没有删除或改写任何数据。
    const rooms = await readServerRooms(realURL);
    assert.equal(rooms.length, 3, '已保存的新房间不能因列表读取错误而消失');
    assert.equal(rooms[0].id, 'seed-alpha');
    assert.equal(rooms[1].id, 'seed-beta');
    assert.equal(rooms[2].id, created.id, '服务端新房间编号应与创建结果一致');
    assert.equal(rooms[2].name, NEW_ROOM_NAME);
    assert.equal(rooms[2].game, 'gomoku');
    assert.equal(rooms[2].capacity, 2);
    assert.equal(rooms[2].turnSeconds, 0);
    assert.equal(rooms[2].status, 'waiting');
    assert.equal(rooms[2].visibility, 'public');
  });
}

// ---------------------------------------------------------------------------
// 三、正常但容易混淆的对照内容
// ---------------------------------------------------------------------------

// 对照一：{"rooms":[]} 是空列表而不是加载失败；rooms 以外的字段全部忽略。
test('对照：rooms 为空数组时显示空列表提示，其他字段中的房间被忽略', { timeout: 60000 }, async (t) => {
  const body = JSON.stringify({ rooms: [], data: [LURE_ROOM], otherRooms: [LURE_ROOM] });
  const { page, proxy } = await setupPage(t, () => ({ status: 200, body }));

  await page.waitForFunction(
    (text) => {
      const el = document.querySelector('#list-area .empty');
      return !!el && el.textContent === text;
    },
    { timeout: 10000 },
    EMPTY_TEXT,
  );
  const list = await readListArea(page);
  assert.deepEqual(list.emptyTexts, [EMPTY_TEXT], '真正的空 rooms 数组才显示空列表提示');
  assert.equal(list.hasTable, false);
  assert.equal(list.errorText, null, '空数组不是加载失败');
  assert.equal(list.skipText, null, '空数组没有跳过提示');
  for (const token of LURE_TOKENS) {
    assert.ok(!list.text.includes(token), `不能从 rooms 以外的字段猜房间：${token}`);
  }
  assert.equal(proxy.gets[0].sentStatus, 200);
});

// 对照二：rooms 数组合法、内部混有非对象记录时，按现有规则展示房间对象、
// 说明跳过条数，不是整份加载失败；房间只来自 rooms 数组且次序沿用返回。
test('对照：rooms 数组混有非对象记录时展示房间并说明跳过条数，不整份加载失败', { timeout: 60000 }, async (t) => {
  const roomA = {
    id: 'mix-a', name: '混合前房间', game: 'gomoku', capacity: 2, turnSeconds: 0,
    status: 'waiting', createdAt: '2026-03-01T01:02:03Z',
  };
  const roomB = {
    id: 'mix-b', name: '混合后房间', game: 'ludo', capacity: 3, turnSeconds: 60,
    status: 'playing', createdAt: '2026-03-02T04:05:06Z',
  };
  // 5 条非对象记录穿插两个房间对象；另在 rooms 之外放诱惑房间。
  const body = JSON.stringify({
    rooms: [roomA, null, '误入字符串', 42, false, [], roomB],
    items: [LURE_ROOM],
  });
  const { page } = await setupPage(t, () => ({ status: 200, body }));

  await waitForRowCount(page, 2);
  const list = await readListArea(page);
  assert.equal(list.errorText, null, '数组内部的脏记录不能让整份列表加载失败');
  assert.equal(list.hasTable, true);
  assert.deepEqual(list.emptyTexts, []);
  assert.equal(
    list.skipText,
    '有 5 条房间记录无法作为房间显示，已跳过；原始数据仍保留在服务端，未被删除或改写。',
    '应按现有规则给出准确跳过条数',
  );

  const rows = await readRows(page);
  assert.deepEqual(
    rows.map((r) => r.cells[0]),
    ['mix-a', 'mix-b'],
    '只展示 rooms 数组中的对象，相对次序沿用服务返回',
  );
  assert.deepEqual(rows[0].cells.slice(0, 6), [
    'mix-a', '混合前房间', '五子棋', '2 人', '不限时', '未开始',
  ]);
  assert.deepEqual(rows[1].cells.slice(0, 6), [
    'mix-b', '混合后房间', '飞行棋', '3 人', '60 秒', 'playing',
  ]);
  for (const token of LURE_TOKENS) {
    assert.ok(!list.text.includes(token), `rooms 以外字段的房间不能上屏：${token}`);
  }
  assert.ok(!list.text.includes('误入字符串'), '被跳过的字符串不能上屏');
});

// 对照三：完全正常的 {"rooms":[...]} 必须正常展示，与失败形态明确区分。
test('对照：正常 rooms 对象响应照常展示房间表格，无失败/空列表/跳过提示', { timeout: 60000 }, async (t) => {
  // 不替换任何响应：代理透传真实服务的两条件种房间。
  const { page, proxy } = await setupPage(t, () => null);

  await waitForRowCount(page, 2);
  const list = await readListArea(page);
  assert.equal(list.errorText, null);
  assert.equal(list.skipText, null);
  assert.deepEqual(list.emptyTexts, []);
  assert.deepEqual(
    (await readRows(page)).map((r) => r.cells[0]),
    ['seed-alpha', 'seed-beta'],
  );
  assert.equal(proxy.gets[0].upstreamStatus, 200);
  assert.equal(proxy.gets[0].replaced, false);
});

// ---------------------------------------------------------------------------
// 四、内容恢复正常后刷新页面：失败提示消失，真实保存的新旧房间都可见
// ---------------------------------------------------------------------------

test('恢复：列表内容恢复正常后按提示刷新页面，旧房间与刚创建房间按服务次序与编号显示，失败提示消失', { timeout: 60000 }, async (t) => {
  // 第 0 次 GET（首屏）透传；第 1 次（创建后的刷新）回 200 非法正文；
  // 用户刷新页面后的第 2 次 GET 起恢复透传真实服务。
  const { page, proxy, realURL } = await setupPage(t, (info) => {
    if (info.index === 1) return { status: 200, body: '房间列表内容损坏了{,,，' + JSON.stringify(LURE_ROOM) };
    return null;
  });

  // 首屏正常看到两条旧房间。
  await waitForRowCount(page, 2);
  assert.deepEqual(
    (await readRows(page)).map((r) => r.cells[0]),
    ['seed-alpha', 'seed-beta'],
  );

  // 创建一间新房间，真实保存；随后的列表刷新内容失败。
  await fillGomokuForm(page, NEW_ROOM_NAME, 0);
  await page.click('#submit');
  await waitForMessageKind(page, 'ok');
  await waitForListError(page);
  const created = proxy.posts[0].room;
  assert.ok(created.id, '创建应已真实完成并返回编号');
  assert.equal((await readMessage(page)).text, SUCCESS_PREFIX + created.id);
  await assertListError(page, LURE_TOKENS);

  // 服务端此刻已真实保存三条房间（异常回应没有删除任何数据）。
  const savedDuringError = await readServerRooms(realURL);
  assert.equal(savedDuringError.length, 3);
  assert.deepEqual(
    savedDuringError.map((r) => r.id),
    ['seed-alpha', 'seed-beta', created.id],
  );

  // 用户按提示刷新页面（代理此后透传）：失败提示消失，真实保存的旧房间
  // 与新房间都显示，次序与编号完全沿用服务返回。
  await page.reload({ waitUntil: 'load' });
  await waitForRowCount(page, 3);
  const list = await readListArea(page);
  assert.equal(list.errorText, null, '内容恢复后加载失败提示必须消失');
  assert.equal(list.skipText, null);
  assert.deepEqual(list.emptyTexts, []);

  const serverRooms = await readServerRooms(realURL);
  const expectedIds = serverRooms.map((r) => r.id);
  assert.deepEqual(expectedIds, ['seed-alpha', 'seed-beta', created.id]);

  const rows = await readRows(page);
  assert.deepEqual(
    rows.map((r) => r.cells[0]),
    expectedIds,
    '页面房间次序与编号必须沿用服务返回',
  );
  // 旧房间内容不变。
  assert.deepEqual(rows[0].cells.slice(0, 6), [
    'seed-alpha', '晨间飞行棋', '飞行棋', '4 人', '30 秒', 'playing',
  ]);
  assert.deepEqual(rows[1].cells.slice(0, 6), [
    'seed-beta', '午夜五子棋', '五子棋', '2 人', '不限时', '未开始',
  ]);
  // 刚创建的房间。
  assert.deepEqual(rows[2].cells.slice(0, 6), [
    created.id, NEW_ROOM_NAME, '五子棋', '2 人', '不限时', '未开始',
  ]);
  assert.equal(rows[2].badge, '未开始');

  // 整个过程只创建过一次房间；三次列表请求（首屏、失败刷新、恢复刷新）
  // 收到的状态码都是 200，异常只发生在正文内容上。
  assert.equal(proxy.posts.length, 1, '刷新与等待不能再次创建房间');
  assert.equal(proxy.counts.postRooms, 1);
  assert.equal(proxy.gets.length, 3);
  for (const [i, g] of proxy.gets.entries()) {
    assert.equal(g.sentStatus, 200, `第 ${i + 1} 次列表查询状态码应为 200`);
  }
  assert.equal(proxy.gets[1].replaced, true);
  assert.equal(proxy.gets[2].replaced, false, '恢复后应透传真实服务响应');
});
