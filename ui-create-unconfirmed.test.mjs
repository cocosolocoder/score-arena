// 首页“创建公开房间”在“服务已返回 201 成功状态，但创建结果未能确认”时的
// 界面回归测试。
//
// 与其他浏览器回归文件的分工：
//   - ui.test.mjs：创建成功/被拒（服务返回业务原因）、成功后列表竞态刷新；
//   - ui-create-connection-failure.test.mjs：创建请求“尚未送达服务”就连接失败；
//   - ui-pending-edit.test.mjs：等待期间继续编辑时的提交快照与表单保留；
//   - 本文件只盯住“201 已到达、但房间编号没有可靠拿到”这一条容易误导用户
//     重复创建的路径：正文没能完整读出（连接在正文传完前断开）、正文不是
//     合法 JSON，或正文可解析但没有非空字符串编号（缺失、空字符串、数字、
//     null、数组等类型不符）。这几种情形必须同一种处理：
//     表单区域继续显示“创建结果未能确认”的提醒，说明服务已返回成功状态、
//     房间可能已经保存，请先刷新页面查看房间列表再决定是否重新提交；
//     不能显示“房间已创建”及编号，不能换成输入错误或“无法连接服务”。
//
// 关键在于“不确定”而非“失败”：201 意味着服务端处理可能已经落盘，页面没有
// 有效编号时只能表达不确定，不能因没有成功提示就断定服务端没有新增记录。
// 因此本文件不用纯浏览器拦截凭空构造响应（那样请求根本没到服务端），而是在
// 真实服务前放一个仅用于测试的转发代理：创建请求照常转发、服务端真实保存，
// 代理读到完整的 201 响应后，再按用例把发给浏览器的正文替换成截断/非法/缺
// 编号的内容。这样可以同时验证两端：
//   - 页面侧：没有编号就只显示不确定提醒、保留四项当前填写、不拼新行、
//     不自动刷新列表、不自动再次发送创建请求、按钮恢复可用且仍可编辑；
//   - 服务端侧：房间确实已经保存（真实编号、提交时配置），用户按提醒刷新
//     页面后能看到这次房间，等待期间的编辑没有自动生成另一间房。
//
// 既有区分继续保留：完整的创建结果仍按正常成功处理（显示返回编号、复位表单
// 并刷新列表，本文件末尾用例在代理透传下锁定）；已确认成功但列表刷新失败
// 仍保留成功提示与编号（本文件末尾用例锁定 HTTP 层区分，连接层区分见
// ui-create-connection-failure.test.mjs）；请求未送达的连接失败文案与行为
// 由 ui-create-connection-failure.test.mjs 专门保障。
//
// 运行：npm test（需要系统 Chrome，可用 CHROME_PATH 指定路径）。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
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

// 与其他界面回归文件相同的种子记录：验证不确定结果前后列表内容与次序不变，
// 以及刷新后新房间只追加在种子记录之后。
const SEED_ALPHA =
  '{"id":"seed-alpha","name":"晨间飞行棋","game":"ludo","capacity":4,"turnSeconds":30,' +
  '"status":"playing","visibility":"public","createdAt":"2026-01-01T08:00:00Z","note":"保留我","tags":["老友","周赛"]}';
const SEED_BETA =
  '{"id":"seed-beta","name":"午夜五子棋","game":"gomoku","capacity":2,"turnSeconds":0,' +
  '"status":"waiting","visibility":"public","createdAt":"2026-01-02T23:00:00Z","extra":{"rank":3}}';

const SUCCESS_PREFIX = '房间已创建，编号：';
const CONN_FAILURE_TEXT = '无法连接服务，请确认服务仍在运行后重试。';
const LIST_ERROR_TEXT = '房间列表加载失败，请稍后刷新重试。已有数据不会因此丢失。';
// 不确定提醒须与 index.html 完全一致（含全角冒号、逗号与句号）。
const UNCONFIRMED_TEXT =
  '创建结果未能确认：服务已返回成功状态，但回应内容未能完整读取，' +
  '房间可能已经保存。请先刷新页面查看房间列表，确认是否已创建后，再决定是否重新提交。';

// 正常成功后表单复位状态：名称/时间为空、规则未选、人数不可填。
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

// startProxy 在真实服务前启动一个只用于测试的转发代理，页面通过代理地址访问。
// 默认透传所有请求/响应；选项：
//   - corruptPost(info)：每次 POST /api/rooms 在“真实服务的完整响应已经到达
//     代理”之后被调用，info 含真实 status、解析出的 room（真实保存结果）与
//     请求体原文。返回（可 await）：
//       null/undefined        → 原样透传真实响应；
//       { truncate: true, body }
//                             → 回 201 但声明的 Content-Length 大于实际正文，
//                               写出 body 后断开连接，模拟正文未能完整读出；
//       { body }              → 回 201 与指定完整正文（可为非法 JSON 或缺
//                               编号的 JSON）。
//   - corruptGet(info)：对 GET /api/rooms 同样在真实响应到达后调用，返回
//     { status, body } 替换响应或 null 透传（用于列表刷新失败区分用例）。
// 代理把服务端处理与浏览器收到的内容分开：即使浏览器拿到的是残缺正文，真实
// 服务上的创建也已经落盘，info.room 里是服务端生成的真实编号。
function startProxy(t, realPort, options = {}) {
  const counts = { getRooms: 0, postRooms: 0 };
  const posts = [];
  // 记录所有代理监听上的连接，关闭时主动销毁：浏览器对代理保持 keep-alive，
  // 否则 server.close() 会一直等待空闲连接，拖慢甚至挂住用例清理。
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
        proxyRes.on('end', async () => {
          const realBody = Buffer.concat(upChunks);

          // 每一次 POST 都记录真实响应（含真实保存结果），与是否替换正文无关，
          // 这样透传对照用例也能拿到服务端生成的编号。
          if (isRoomsApi && req.method === 'POST') {
            let room = null;
            try { room = JSON.parse(realBody.toString('utf8')); } catch { room = null; }
            const info = {
              index: posts.length,
              status: proxyRes.statusCode,
              room,
              reqBody: Buffer.concat(reqChunks).toString('utf8'),
            };
            posts.push(info);
            const spec = options.corruptPost ? await options.corruptPost(info) : null;
            if (spec) {
              if (spec.truncate) {
                // 声明一个比实际正文更长的 Content-Length，写出部分正文后断开：
                // 浏览器能收到 201 状态行，但正文读取失败（resp.json() 拒绝）。
                clientRes.writeHead(spec.status || 201, {
                  'Content-Type': 'application/json; charset=utf-8',
                  'Content-Length': String(Buffer.byteLength(spec.body || '', 'utf8') + 40),
                });
                if (spec.body) clientRes.write(spec.body);
                setTimeout(() => {
                  if (!clientRes.destroyed && clientRes.socket) clientRes.socket.destroy();
                }, 50);
                return;
              }
              clientRes.writeHead(spec.status || 201, {
                'Content-Type': 'application/json; charset=utf-8',
              });
              clientRes.end(spec.body ?? realBody);
              return;
            }
          }

          if (isRoomsApi && req.method === 'GET' && options.corruptGet) {
            const spec = options.corruptGet({ status: proxyRes.statusCode });
            if (spec) {
              clientRes.writeHead(spec.status, { 'Content-Type': 'application/json; charset=utf-8' });
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
        posts,
        async waitForPost(count) {
          const deadline = Date.now() + 10000;
          while (posts.length < count) {
            if (Date.now() > deadline) {
              throw new Error(`等待第 ${count} 次创建响应超时（实际 ${posts.length} 次）`);
            }
            await sleep(10);
          }
        },
        close: async () => {
          for (const sock of sockets) sock.destroy();
          await new Promise((resolveClose) => server.close(resolveClose));
        },
      });
    });
  });
}

// 每个用例独立的数据目录、真实服务、转发代理与页面；打开页面时已有两条种子
// 房间经代理正常加载。
async function setupPage(t, proxyOptions = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'score-arena-uidata-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await seedRooms(dataDir, SEED_ALPHA, SEED_BETA);
  const realURL = await startServer(t, dataDir);
  const realPort = Number(new URL(realURL).port);
  const proxy = await startProxy(t, realPort, proxyOptions);
  t.after(() => proxy.close());

  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(proxy.url, { waitUntil: 'load' });
  await waitForRowCount(page, 2);
  return { page, proxy, realURL };
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

// 合法的飞行棋配置：4 人、60 秒，名称含首尾空格、内部空格与表情。
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

// 统一断言不确定提醒：固定文案、warn 样式，不含任何成功/编号/失败/连接失败
// 信息；forbidden 额外传入本用例正文里出现过、但绝不能被页面拿来展示的
// “诱惑值”（真实编号、提交名称等）。
async function assertUnconfirmedMessage(page, realId, forbidden) {
  const msg = await readMessage(page);
  assert.equal(msg.text, UNCONFIRMED_TEXT, '应显示固定的“创建结果未能确认”提醒');
  assert.ok(msg.className.includes('warn'), '不确定提醒应以 warn 样式显示');
  assert.ok(!msg.className.includes('ok'), '不确定结果不应显示成功样式');
  assert.ok(!msg.className.includes('error'), '不确定结果不应显示成输入错误或连接失败');
  assert.ok(!msg.text.includes('房间已创建'), '提醒中不应出现“房间已创建”');
  assert.ok(!msg.text.includes('编号'), '提醒中不应出现任何编号字样');
  assert.ok(!msg.text.includes(realId), '不能显示未确认成功的真实编号');
  assert.ok(!msg.text.includes(CONN_FAILURE_TEXT), '不能换成“无法连接服务”');
  for (const value of forbidden || []) {
    assert.ok(!msg.text.includes(value), `提醒不应从响应内容拼出编号或名称：${value}`);
  }
  return msg;
}

// 不确定结果后的统一页面状态断言：四项当前填写原样保留、按钮恢复可用、列表
// 维持提交前内容与次序、不自动刷新列表、不自动再次提交。
async function assertUnchangedAfterUnconfirmed(page, proxy, initialRows, expectedForm) {
  assert.deepEqual(await readFormState(page), expectedForm, '不确定结果后应整体保留当前四项并恢复按钮可用');

  // 页面仍允许继续编辑（真实改一下名称验证，而非只看 disabled 属性）。
  const editable = await readEditable(page);
  assert.deepEqual(editable, {
    nameDisabled: false,
    gameDisabled: false,
    capacityDisabled: false,
    turnDisabled: false,
  }, '处理结束后四项仍应允许编辑');
  await page.type('#name', 'X');
  const afterTyping = await readFormState(page);
  assert.equal(afterTyping.name, expectedForm.name + 'X', '页面应仍允许继续编辑名称');
  assert.equal(afterTyping.submitDisabled, false, '继续编辑时按钮应保持可用');
  await page.$eval('#name', (el) => { el.value = el.value.slice(0, -1); });

  // 列表维持提交前已展示的房间及次序，不凭提交内容拼出新行。
  assert.deepEqual(await readRows(page), initialRows, '不确定结果不应改动房间列表');

  // 不自动刷新列表、不自动再次发送创建请求（页面加载后只查询过一次列表）。
  await sleep(300);
  assert.equal(proxy.counts.getRooms, 1, '不确定结果后不应自动刷新房间列表');
  assert.equal(proxy.counts.postRooms, 1, '不确定结果后不应自动再次发送创建请求');
  assert.equal(proxy.posts.length, 1, '不应产生第二次创建请求');
}

// 表格用例的各种 201 异常正文。每一种都必须落到同一种不确定处理。
const CORRUPT_VARIANTS = [
  {
    label: '正文传完前连接断开（Content-Length 大于实际正文）',
    spec: { truncate: true, body: '{"id":"' },
    forbidden: [],
  },
  {
    label: '正文为空',
    spec: { body: '' },
    forbidden: [],
  },
  {
    label: '正文不是合法 JSON',
    spec: { body: '服务已返回成功但正文损坏{,,' },
    forbidden: ['服务已返回成功但正文损坏'],
  },
  {
    label: '正文可解析但缺少编号字段',
    // 给出名称等完整配置也不能据此“猜出”编号或拼出房间行。
    spec: {
      body: JSON.stringify({
        name: TRIMMED_NAME, game: 'ludo', capacity: 4, turnSeconds: 60,
        status: 'waiting', visibility: 'public',
      }),
    },
    forbidden: [TRIMMED_NAME],
  },
  {
    label: '编号为空字符串',
    spec: { body: JSON.stringify({ id: '', name: TRIMMED_NAME }) },
    forbidden: [TRIMMED_NAME],
  },
  {
    label: '编号为数字（类型不符）',
    spec: { body: JSON.stringify({ id: 12345, name: TRIMMED_NAME }) },
    forbidden: ['12345', TRIMMED_NAME],
  },
  {
    label: '编号为 null（类型不符）',
    spec: { body: JSON.stringify({ id: null, name: TRIMMED_NAME }) },
    forbidden: [TRIMMED_NAME],
  },
  {
    label: '编号为数组（类型不符），内含诱惑编号',
    spec: { body: JSON.stringify({ id: ['guessed-room-id'], name: TRIMMED_NAME }) },
    forbidden: ['guessed-room-id', TRIMMED_NAME],
  },
];

for (const variant of CORRUPT_VARIANTS) {
  test(`201 但创建结果未能确认（${variant.label}）：显示不确定提醒、保留填写、列表不变；房间实际已保存，刷新后可见`, { timeout: 60000 }, async (t) => {
    // 第一次创建请求在真实保存后被替换成异常正文；之后（刷新页面、再次提交）
    // 一律透传真实响应。
    let corruptOnce = true;
    const { page, proxy, realURL } = await setupPage(t, {
      corruptPost: () => {
        if (!corruptOnce) return null;
        corruptOnce = false;
        return variant.spec;
      },
    });

    const initialRows = await readRows(page);
    assertSeedRows(initialRows);
    const beforeRooms = await readServerRooms(realURL);
    assert.equal(beforeRooms.length, 2);

    await fillLudoForm(page);
    await page.click('#submit');

    // 等待不确定提醒出现（不是成功提示，也不是输入错误/连接失败）。
    await waitForMessageKind(page, 'warn');
    await proxy.waitForPost(1);
    const post = proxy.posts[0];

    // 真实服务确实按提交时配置保存成功：代理拿到的是完整 201 与非空真实编号，
    // 只是发给浏览器的正文被本用例替换/截断。
    assert.equal(post.status, 201, '代理转发的真实响应应为 201');
    assert.ok(post.room && typeof post.room.id === 'string' && post.room.id !== '',
      '真实服务应已保存并生成非空字符串编号');
    assert.deepEqual(JSON.parse(post.reqBody), {
      name: RAW_NAME,
      game: 'ludo',
      capacity: 4,
      turnSeconds: 60,
    }, '请求体应是提交时的合法配置（名称保留输入原貌）');
    const realId = post.room.id;
    assert.equal(post.room.name, TRIMMED_NAME, '服务端保存名称应仅去首尾空白');
    assert.equal(post.room.game, 'ludo');
    assert.equal(post.room.capacity, 4);
    assert.equal(post.room.turnSeconds, 60);

    // 页面侧：固定的不确定提醒，不显示编号/名称，不换成其他含义的提示。
    await assertUnconfirmedMessage(page, realId, variant.forbidden);

    // 名称首尾空白保持输入原貌，四项整体保留；不沿用正常成功的清空行为。
    await assertUnchangedAfterUnconfirmed(page, proxy, initialRows, {
      name: RAW_NAME,
      game: 'ludo',
      capacity: '4',
      capacityDisabled: false,
      turnSeconds: '60',
      submitDisabled: false,
    });

    // 服务端记录确实增加了这一间（页面没有成功提示不代表服务端没有新增）。
    const savedRooms = await readServerRooms(realURL);
    assert.equal(savedRooms.length, 3, '服务端应已保存本次房间');
    assert.deepEqual(savedRooms.slice(0, 2), beforeRooms, '已有记录及附带字段保持原值');
    const saved = savedRooms[2];
    assert.equal(saved.id, realId, '服务端真实编号以代理读到的创建结果为准');
    assert.equal(saved.name, TRIMMED_NAME);
    assert.equal(saved.game, 'ludo');
    assert.equal(saved.capacity, 4);
    assert.equal(saved.turnSeconds, 60);

    // 用户按提醒刷新页面：应看到这次已保存的房间及真实编号，追加在种子之后；
    // 刷新不会再次提交（没有因等待/保留状态自动多建一间房）。
    await page.reload({ waitUntil: 'load' });
    await waitForRowCount(page, 3);
    const rowsAfterReload = await readRows(page);
    assert.deepEqual(
      rowsAfterReload.slice(0, 2).map((r) => r.cells),
      initialRows.map((r) => r.cells),
      '刷新后原有房间的内容与次序应保持',
    );
    const newRow = rowsAfterReload[2];
    assert.equal(newRow.cells[0], realId, '刷新后应显示已保存房间的真实编号');
    assert.equal(newRow.cells[1], TRIMMED_NAME);
    assert.equal(newRow.cells[2], '飞行棋');
    assert.equal(newRow.cells[3], '4 人');
    assert.equal(newRow.cells[4], '60 秒');
    assert.equal(newRow.cells[5], '未开始');
    assert.equal(newRow.badge, '未开始');
    assert.equal(newRow.timeTitle, saved.createdAt);

    const finalRooms = await readServerRooms(realURL);
    assert.equal(finalRooms.length, 3, '刷新前后的等待/保留状态不应自动生成另一间房');
    assert.equal(finalRooms[2].id, realId);
    assert.equal(proxy.counts.postRooms, 1, '整个过程中应只发送过一次创建请求');
  });
}

// 等待期间改成另一份配置时收到不确定结果：保留“结果到达时”的最新填写，
// 人数选择状态与当前规则一致；服务端保存的是提交时快照；刷新后只看到
// 提交时那一间，等待期间的编辑没有自动生成另一间房。
test('等待期间改成另一份配置后收到 201 截断响应：保留到达时最新四项，已保存的是提交时快照，刷新无额外房间', { timeout: 60000 }, async (t) => {
  let releaseGate;
  const { page, proxy, realURL } = await setupPage(t, {
    // 真实响应到达后先挂住，让测试在“等待期间”完成编辑，再放行残缺正文。
    corruptPost: () => new Promise((resolve) => {
      releaseGate = () => resolve({ truncate: true, body: '{"id":"' });
    }),
  });

  const initialRows = await readRows(page);
  assertSeedRows(initialRows);
  const beforeRooms = await readServerRooms(realURL);

  // 提交时：五子棋/2 人/30 秒，名称带首尾空白。
  const submittedName = '  提交时的五子棋房间  ';
  await page.type('#name', submittedName);
  await page.select('#game', 'gomoku');
  await page.waitForFunction(
    () => !document.getElementById('capacity').disabled &&
      document.getElementById('capacity').value === '2',
    { timeout: 5000 },
  );
  await page.type('#turnSeconds', '30');
  await page.click('#submit');

  // 真实服务已保存但响应被代理挂住：等待期间按钮不可用。
  await proxy.waitForPost(1);
  assert.equal((await readFormState(page)).submitDisabled, true, '等待期间按钮应不可用');
  assert.deepEqual(JSON.parse(proxy.posts[0].reqBody), {
    name: submittedName,
    game: 'gomoku',
    capacity: 2,
    turnSeconds: 30,
  }, '请求体必须固定为点击提交时的配置快照');

  // 等待期间改成另一份完整合法的飞行棋配置。
  await page.$eval('#name', (el) => { el.value = ''; });
  await page.type('#name', '等待中改成飞行棋');
  await page.select('#game', 'ludo');
  await page.waitForFunction(
    () => !document.getElementById('capacity').disabled,
    { timeout: 5000 },
  );
  await page.select('#capacity', '4');
  await page.$eval('#turnSeconds', (el) => { el.value = ''; });
  await page.type('#turnSeconds', '90');

  const editable = await readEditable(page);
  assert.deepEqual(editable, {
    nameDisabled: false,
    gameDisabled: false,
    capacityDisabled: false,
    turnDisabled: false,
  }, '等待期间四项应仍可编辑');

  // 重复点击或绕过禁用直接派发 submit，都不能发出第二次创建请求。
  await page.click('#submit');
  await page.evaluate(() => {
    document.getElementById('room-form')
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
  await sleep(300);
  assert.equal(proxy.posts.length, 1, '等待期间不得发出第二次创建请求');

  // 放行：浏览器收到 201 但正文被截断。
  releaseGate();
  await waitForMessageKind(page, 'warn');
  const realId = proxy.posts[0].room.id;
  await assertUnconfirmedMessage(page, realId, ['等待中改成飞行棋', '提交时的五子棋房间']);

  // 保留结果到达时的最新填写（飞行棋/4 人/90 秒），人数选择与当前规则一致；
  // 不回退到提交时的五子棋，也不按正常成功清空。
  await assertUnchangedAfterUnconfirmed(page, proxy, initialRows, {
    name: '等待中改成飞行棋',
    game: 'ludo',
    capacity: '4',
    capacityDisabled: false,
    turnSeconds: '90',
    submitDisabled: false,
  });

  // 服务端保存的是提交时的五子棋快照，且只有这一间新房间。
  const savedRooms = await readServerRooms(realURL);
  assert.equal(savedRooms.length, 3, '等待期间的编辑不得自动创建另一个房间');
  assert.deepEqual(savedRooms.slice(0, 2), beforeRooms);
  const saved = savedRooms[2];
  assert.equal(saved.id, realId);
  assert.equal(saved.name, '提交时的五子棋房间', '服务端应只去掉名称首尾空白');
  assert.equal(saved.game, 'gomoku');
  assert.equal(saved.capacity, 2);
  assert.equal(saved.turnSeconds, 30);

  // 刷新页面：看到提交时保存的五子棋房间及真实编号，不会多出飞行棋房间。
  await page.reload({ waitUntil: 'load' });
  await waitForRowCount(page, 3);
  const rows = await readRows(page);
  assert.equal(rows[2].cells[0], realId, '刷新后应显示已保存房间的真实编号');
  assert.equal(rows[2].cells[1], '提交时的五子棋房间');
  assert.equal(rows[2].cells[2], '五子棋');
  assert.equal(rows[2].cells[3], '2 人');
  assert.equal(rows[2].cells[4], '30 秒');
  const finalRooms = await readServerRooms(realURL);
  assert.equal(finalRooms.length, 3, '刷新后仍应只有提交时创建的一间房');
  assert.equal(finalRooms[2].id, realId);
});

// 对照：完整的创建结果（201 + 非空字符串编号）仍按正常成功处理——显示返回
// 编号、复位表单并刷新列表，不显示不确定提醒。
test('对照：完整创建结果仍按正常成功处理，显示编号、复位表单并更新列表', { timeout: 60000 }, async (t) => {
  // 不传任何代理选项：所有请求透传真实服务。
  const { page, proxy, realURL } = await setupPage(t);
  const initialRows = await readRows(page);
  assertSeedRows(initialRows);

  await fillLudoForm(page);
  await page.click('#submit');

  await waitForMessageKind(page, 'ok');
  await proxy.waitForPost(1);
  const created = proxy.posts[0].room;
  assert.equal(proxy.posts[0].status, 201);
  assert.ok(created.id && typeof created.id === 'string');

  const msg = await readMessage(page);
  assert.equal(msg.text, SUCCESS_PREFIX + created.id, '完整结果应显示普通成功提示与编号');
  assert.ok(!msg.text.includes('创建结果未能确认'), '完整结果不应显示不确定提醒');

  await waitForRowCount(page, 3);
  assert.deepEqual(await readFormState(page), RESET_FORM, '正常成功后表单应复位');

  const rows = await readRows(page);
  assert.deepEqual(rows.slice(0, 2), initialRows);
  assert.equal(rows[2].cells[0], created.id);
  assert.equal(rows[2].cells[1], TRIMMED_NAME);
  assert.equal(rows[2].cells[2], '飞行棋');
  assert.equal(rows[2].cells[3], '4 人');
  assert.equal(rows[2].cells[4], '60 秒');

  const serverRooms = await readServerRooms(realURL);
  assert.equal(serverRooms.length, 3);
  assert.equal(serverRooms[2].id, created.id);
});

// 对照：已确认创建成功（拿到非空编号）但随后的列表刷新失败时，仍保留成功
// 提示及编号，不按不确定结果或创建连接失败处理。
test('对照：已确认成功但列表刷新失败时保留成功提示与编号，不显示不确定提醒', { timeout: 60000 }, async (t) => {
  // 打开页面的第一次列表查询透传；创建成功后的列表查询返回 500。
  let listSeen = 0;
  const { page, proxy, realURL } = await setupPage(t, {
    corruptGet: () => {
      listSeen++;
      if (listSeen === 1) return null; // 首次加载正常
      return { status: 500, body: JSON.stringify({ error: '模拟列表读取失败' }) };
    },
  });
  const initialRows = await readRows(page);
  assertSeedRows(initialRows);

  await fillLudoForm(page);
  await page.click('#submit');

  await waitForMessageKind(page, 'ok');
  await proxy.waitForPost(1);
  const created = proxy.posts[0].room;
  assert.ok(created.id, '创建结果应包含非空编号');

  const msg = await readMessage(page);
  assert.ok(msg.text.startsWith(SUCCESS_PREFIX), `应保留成功提示，实际: ${msg.text}`);
  assert.equal(msg.text.slice(SUCCESS_PREFIX.length), created.id, '提示编号应与创建结果一致');
  assert.ok(!msg.text.includes('创建结果未能确认'), '已确认成功不应显示不确定提醒');
  assert.ok(!msg.text.includes(CONN_FAILURE_TEXT), '已确认成功不应显示连接失败提示');

  // 表单仍按正常成功复位，按钮恢复可用。
  assert.deepEqual(await readFormState(page), RESET_FORM);

  // 列表区域显示加载失败，而不是保留旧表格或显示不确定提醒。
  await page.waitForFunction(
    () => document.querySelector('#list-area .list-error')?.textContent ===
      '房间列表加载失败，请稍后刷新重试。已有数据不会因此丢失。',
    { timeout: 10000 },
  );
  const listText = await page.$eval('#list-area', (el) => el.textContent);
  assert.ok(listText.includes(LIST_ERROR_TEXT));

  // 服务端确实已保存本次创建。
  const serverRooms = await readServerRooms(realURL);
  assert.equal(serverRooms.length, 3);
  assert.equal(serverRooms[2].id, created.id);
});
