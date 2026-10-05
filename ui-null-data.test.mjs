// 房间数据文件整体为 JSON null（含前后合法空白）时的首页回归测试。
//
// null 不表示“还没有房间”：已公开的数据约定要求顶层是数组，只有空数组才
// 表示没有记录。因此在首页：
//   1. 查看列表必须看到既有的“列表加载失败”提示，而不是空列表或成功列表；
//   2. 提交一份完全合法的创建表单必须看到服务端给出的创建失败原因（数据格式
//      问题，而非表单漏填），已填内容保留、按钮恢复可用、不出现成功提示；
//   3. 首页与服务状态入口始终可以正常访问。
// 磁盘上的 null 数据逐字节保留由 main_test.go 端到端断言，本文件聚焦页面表现。
//
// 运行：npm test（需要系统 Chrome，可用 CHROME_PATH 指定路径）。

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer-core';

const repoRoot = import.meta.dirname;
const chromePath = process.env.CHROME_PATH || '/usr/bin/google-chrome';

let serverBin;
let browser;

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

function readMessage(page) {
  return page.evaluate(() => {
    const el = document.getElementById('form-msg');
    return { className: el.className, text: el.textContent };
  });
}

function readFormState(page) {
  return page.evaluate(() => ({
    name: document.getElementById('name').value,
    game: document.getElementById('game').value,
    capacity: document.getElementById('capacity').value,
    turnSeconds: document.getElementById('turnSeconds').value,
    submitDisabled: document.getElementById('submit').disabled,
  }));
}

const NULL_VARIANTS = [
  { label: 'null', content: 'null' },
  { label: 'null 前后带合法 JSON 空白', content: ' \t\n null \r\n\t' },
];

for (const variant of NULL_VARIANTS) {
  test(`数据文件为 ${variant.label}：首页列表显示加载失败，合法创建显示数据格式原因且保留填写`, async (t) => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'score-arena-uidata-'));
    t.after(() => rm(dataDir, { recursive: true, force: true }));
    const dataFile = path.join(dataDir, 'rooms.json');
    await writeFile(dataFile, variant.content, { encoding: 'utf8' });
    const baseURL = await startServer(t, dataDir);

    // 服务状态入口不受房间数据格式影响。
    const health = await fetch(baseURL + '/health');
    assert.equal(health.status, 200);

    const page = await browser.newPage();
    t.after(() => page.close());
    await page.goto(baseURL, { waitUntil: 'load' });

    // 列表区域必须落到既有的加载失败提示，不能显示空列表提示或表格。
    await page.waitForFunction(
      () => !!document.querySelector('#list-area .list-error'),
      { timeout: 10000 },
    );
    const listArea = await page.evaluate(() => ({
      errorText: document.querySelector('#list-area .list-error')?.textContent ?? null,
      hasEmpty: !!document.querySelector('#list-area .empty'),
      hasTable: !!document.querySelector('#list-area table'),
      hasSkipNotice: !!document.querySelector('#list-area .skip-notice'),
    }));
    assert.match(listArea.errorText ?? '', /房间列表加载失败/);
    assert.equal(listArea.hasEmpty, false, 'null 数据不得显示“还没有房间记录”空提示');
    assert.equal(listArea.hasTable, false, 'null 数据不得渲染房间表格');
    assert.equal(listArea.hasSkipNotice, false, 'null 是顶层格式错误，不是数组内跳过记录');

    // 填写一份名称、规则、人数、时间全部合法的表单后提交。
    await page.type('#name', 'null 数据上的合法创建');
    await page.select('#game', 'ludo');
    await page.waitForFunction(
      () => !document.getElementById('capacity').disabled,
      { timeout: 5000 },
    );
    await page.select('#capacity', '3');
    await page.type('#turnSeconds', '60');
    await page.click('#submit');

    // 必须出现错误提示（不是成功提示），原因落在房间数据格式上。
    await page.waitForFunction(
      () => document.getElementById('form-msg').classList.contains('error'),
      { timeout: 10000 },
    );
    const msg = await readMessage(page);
    assert.equal(msg.className.includes('ok'), false, '不得出现创建成功提示');
    assert.match(msg.text, /房间数据/);
    assert.match(msg.text, /数组/);
    assert.doesNotMatch(msg.text, /不能为空|缺少必填字段/);

    // 已填内容原样保留，按钮恢复可用。
    await page.waitForFunction(
      () => document.getElementById('submit').disabled === false,
      { timeout: 5000 },
    );
    const form = await readFormState(page);
    assert.equal(form.name, 'null 数据上的合法创建');
    assert.equal(form.game, 'ludo');
    assert.equal(form.capacity, '3');
    assert.equal(form.turnSeconds, '60');
    assert.equal(form.submitDisabled, false);

    // 失败的创建不得改写数据文件：内容与周围空白逐字节保持。
    const onDisk = await readFile(dataFile, 'utf8');
    assert.equal(onDisk, variant.content);

    // 首页本身仍可正常访问（刷新后仍是同一个加载失败提示，而不是服务崩溃）。
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(
      () => !!document.querySelector('#list-area .list-error'),
      { timeout: 10000 },
    );
  });
}

// 对照用例：同一份创建流程在空数组数据上必须成功，证明 null 用例看到的失败
// 来自已保存数据的格式问题，而不是表单或页面流程本身有问题。
test('对照：空数组数据下同一份合法表单创建成功，不显示数据格式错误', async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'score-arena-uidata-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(path.join(dataDir, 'rooms.json'), '  [\n]\n', 'utf8');
  const baseURL = await startServer(t, dataDir);

  const page = await browser.newPage();
  t.after(() => page.close());
  await page.goto(baseURL, { waitUntil: 'load' });

  await page.waitForFunction(
    () => !!document.querySelector('#list-area .empty'),
    { timeout: 10000 },
  );

  await page.type('#name', 'null 数据上的合法创建');
  await page.select('#game', 'ludo');
  await page.waitForFunction(
    () => !document.getElementById('capacity').disabled,
    { timeout: 5000 },
  );
  await page.select('#capacity', '3');
  await page.type('#turnSeconds', '60');
  await page.click('#submit');

  await page.waitForFunction(
    () => document.getElementById('form-msg').classList.contains('ok'),
    { timeout: 10000 },
  );
  const msg = await readMessage(page);
  assert.match(msg.text, /房间已创建，编号：/);

  await page.waitForFunction(
    () => document.querySelectorAll('#list-area table tbody tr').length === 1,
    { timeout: 10000 },
  );
});
