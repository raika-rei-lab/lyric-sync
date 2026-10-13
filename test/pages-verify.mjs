// GitHub Pages 相当（/lyric-sync/ サブパス）での実動作を検証する
//   node test/pages-verify.mjs
//
// 確認する点:
//   - サブパス配信でページ・JS・CSS が 200 で取得できる
//   - Web Worker が正しいパスから読み込まれ、起動する
//   - Whisper モデルが取得され、音声認識が完走する
//   - コンソールエラー・失敗リクエストが無い

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, '.cache');
const shots = join(cache, 'shots');
const PORT = 5200;
const BASE = '/lyric-sync/';
const PAGE = `http://127.0.0.1:${PORT}${BASE}`;
await mkdir(shots, { recursive: true });

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label} ${extra}`);
  }
};

console.log(`\n[Pages] base=${BASE} でビルド`);
await new Promise((resolve, reject) => {
  const b = spawn('npx', ['vite', 'build', `--base=${BASE}`], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  b.stdout.on('data', () => {});
  b.stderr.on('data', (d) => process.stderr.write(`[build] ${d}`));
  b.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(`build failed: ${c}`))));
});

console.log('[Pages] 静的サーバーを起動（GitHub Pages を模す: dist/ を /lyric-sync/ にマウント）');
const server = createStaticServer({ root: join(root, 'dist'), base: BASE, port: PORT });
let stopped = false;
const stop = () => {
  if (stopped) return;
  stopped = true;
  server.close();
};
process.on('exit', stop);
await server.ready;

// テスト用音声
const wav = join(cache, 'jfk.wav');
if (!existsSync(wav)) {
  console.log('[Pages] テスト用音声をダウンロード中…');
  const res = await fetch('https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav');
  await writeFile(wav, Buffer.from(await res.arrayBuffer()));
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });

const requests = [];
const failed = [];
const errors = [];
page.on('response', (r) => requests.push({ url: r.url(), status: r.status() }));
page.on('requestfailed', (r) => {
    // blob: はブラウザ内部の object URL（音声ファイル）。読み込み中断で ERR_ABORTED が出るため対象外
    if (r.url().startsWith('blob:')) return;
    failed.push(`${r.url()} ${r.failure()?.errorText ?? ''}`);
  });
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

console.log(`\n[Pages] ${PAGE} を開く`);
await page.goto(PAGE, { waitUntil: 'load' });
ok(await page.locator('h1').isVisible(), 'ページが表示される');
await page.waitForFunction(() => !document.getElementById('deviceBadge').textContent.includes('判定中'), { timeout: 20000 });
console.log(`        ${await page.locator('#deviceBadge').textContent()}`);

// アセットが 200 で取得できたか
const assets = requests.filter((r) => r.url.includes(`${BASE}assets/`));
ok(assets.length >= 2 && assets.every((r) => r.status === 200), `アセット取得（${assets.length}件すべて200）`, JSON.stringify(assets.map((a) => a.status)));
ok(assets.some((r) => r.url.endsWith('.js')), 'JS が読み込まれる');
ok(assets.some((r) => r.url.endsWith('.css')), 'CSS が読み込まれる');

console.log('\n[Pages] 音声認識を実行（Worker とモデルの読み込みを確認）');
await page.setInputFiles('#audioFile', wav);
await page.fill('#lyrics', 'And so my fellow Americans\nask not what your country can do for you\nAsk what you can do for your country');
await page.selectOption('#language', 'en');
await page.selectOption('#model', 'base');

const t0 = Date.now();
await page.click('#run');
await page.waitForSelector('#result:not([hidden])', { timeout: 900000 });
console.log(`        ${((Date.now() - t0) / 1000).toFixed(1)}秒 / ${await page.locator('#status').textContent()}`);

// Worker がサブパスから取得されたか
const workerReq = requests.filter((r) => r.url.includes('asr-worker'));
ok(workerReq.length > 0, `Worker が /lyric-sync/ から取得された`, JSON.stringify(workerReq.map((w) => w.url)));
ok(workerReq.every((r) => r.status === 200), 'Worker が 200 で取得された', JSON.stringify(workerReq.map((w) => w.status)));

// モデル取得（fromCache: false を指定しているので必ずネットワークが走る）
const modelReq = requests.filter((r) => r.url.includes('huggingface.co'));
ok(modelReq.length > 0, `Whisper モデルがダウンロードされた（${modelReq.length} リクエスト）`);
const onnx = modelReq.filter((r) => r.url.endsWith('.onnx') || r.url.includes('.onnx?'));
ok(onnx.length >= 2, `ONNX モデルを取得（${onnx.length} ファイル）`);

const stats = (await page.locator('#stats').innerText()).replace(/\n/g, ' ');
console.log(`        統計: ${stats}`);
ok(/整列率\s*1?00%/.test(stats.replace(/\s+/g, ' ')), 'サブパス上で音声認識が完走して整列できた', stats);

ok(failed.length === 0, '失敗リクエストなし', JSON.stringify(failed.slice(0, 3)));
ok(errors.length === 0, 'コンソールエラーなし', JSON.stringify(errors.slice(0, 3)));

await page.screenshot({ path: join(shots, '07-pages.png'), fullPage: true });
await browser.close();
stop();

console.log(failures === 0 ? '\nPages 検証: すべて成功\n' : `\nPages 検証: ${failures} 件失敗\n`);
process.exit(failures === 0 ? 0 : 1);
/**
 * GitHub Pages の配信を模した最小静的サーバ。
 *   - dist/ の内容を <base> 配下にマウントして配信する（ Pages のプロジェクトページと同じ構造）
 *   - 未知のパスは 404（Pages のように index.html へ SPA フォールバックしない）
 *   - wasm は application/wasm で配信する（MIME が違うとブラウザが読み込まない）
 */
function createStaticServer({ root, base, port }) {
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.wasm': 'application/wasm',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
  };
  const server = createServer(async (req, res) => {
    try {
      let path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (!path.startsWith(base)) {
        res.writeHead(404).end('not found');
        return;
      }
      let rel = path.slice(base.length) || 'index.html';
      rel = normalize(rel).replace(/^(\.\.[/\\])+/, '');
      let file = join(root, rel);
      try {
        if ((await stat(file)).isDirectory()) file = join(file, 'index.html');
      } catch {
        res.writeHead(404).end('not found');
        return;
      }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' });
      res.end(body);
    } catch (err) {
      res.writeHead(500).end(String(err));
    }
  });
  let ready;
  const readyPromise = new Promise((r) => (ready = r));
  server.listen(port, '127.0.0.1', () => ready());
  return { ready: readyPromise, close: () => new Promise((r) => server.close(r)) };
}
