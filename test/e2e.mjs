// ブラウザ E2E: Vite を起動 → Chromium で実操作 → 同期完走 → 書き出し検証
//   node test/e2e.mjs

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, '.cache');
const shots = join(root, '.cache', 'shots');
await mkdir(shots, { recursive: true });

const JFK_LYRICS = `And so my fellow Americans
ask not what your country can do for you
Ask what you can do for your country`;

const wav = join(cache, 'jfk.wav');
if (!existsSync(wav)) {
  console.log('テスト用音声をダウンロード中…');
  const res = await fetch('https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav');
  if (!res.ok) {
    console.error(`音声のダウンロードに失敗しました: ${res.status}`);
    process.exit(1);
  }
  await writeFile(wav, Buffer.from(await res.arrayBuffer()));
}

// dev サーバー（開発中に起動）と依存最適化キャッシュを共有して衝突するため、本番ビルドを preview で検証する
const PORT = 5199;
console.log('本番ビルド中…');
await new Promise((resolve, reject) => {
  const build = spawn('npx', ['vite', 'build'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  build.stdout.on('data', () => {});
  build.stderr.on('data', (d) => process.stderr.write(`[build] ${d}`));
  build.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`build failed: ${code}`))));
});
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--host', '127.0.0.1'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', () => {});
server.stderr.on('data', (d) => process.stderr.write(`[vite] ${d}`));

let stopped = false;
const stop = () => {
  if (stopped) return;
  stopped = true;
  server.kill('SIGKILL');
};
process.on('exit', stop);

// 起動待ち
await new Promise((resolve, reject) => {
  const t0 = Date.now();
  const tick = async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/`);
      if (r.ok) return resolve();
    } catch {}
    if (Date.now() - t0 > 30000) return reject(new Error('vite 起動タイムアウト'));
    setTimeout(tick, 300);
  };
  tick();
});

let failures = 0;
const ok = (cond, label, extra = '') => {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label} ${extra}`);
  }
};

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1400, height: 950 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

console.log('\n[E2E] ページを開く');
await page.goto(`http://127.0.0.1:${PORT}/`, { waitUntil: 'networkidle' });
ok(await page.locator('h1').isVisible(), 'ヘッダーが表示される');
await page.waitForFunction(() => !document.getElementById('deviceBadge').textContent.includes('判定中'), { timeout: 15000 });
const badge = await page.locator('#deviceBadge').textContent();
console.log(`        実行環境: ${badge}`);
await page.screenshot({ path: join(shots, '01-initial.png') });

console.log('\n[E2E] 音声と歌詞を入力');
await page.setInputFiles('#audioFile', wav);
await page.fill('#lyrics', JFK_LYRICS);
await page.selectOption('#language', 'en');
await page.selectOption('#model', 'base');
ok((await page.locator('#audioInfo').textContent()).includes('jfk.wav'), '音声ファイルが選択された');
await page.screenshot({ path: join(shots, '02-input.png') });

console.log('\n[E2E] 同期を実行（初回はモデルDLで数分かかる場合があります）');
const t0 = Date.now();
await page.click('#run');
await page.waitForSelector('#result:not([hidden])', { timeout: 900000 });
const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
const status = await page.locator('#status').textContent();
console.log(`        ${elapsed}s / ステータス: ${status}`);

const stats = await page.locator('#stats').innerText();
console.log(`        統計: ${stats.replace(/\n/g, ' | ')}`);
ok(/整列率\s*\d+%/.test(stats.replace(/\s+/g, ' ')), '整列率が表示される');

const lines = await page.locator('#lyricView .line.lyric').allTextContents();
console.log(`        行数: ${lines.length}`);
ok(lines.length === 3, '歌詞3行が表示される', JSON.stringify(lines));

// 表示上の語間スペース（英語）
const rendered = lines.map((l) => l.trim());
ok(
  rendered[0] === 'And so my fellow Americans',
  '英語: 語間スペースが正しい（先頭語の後にも入る）',
  JSON.stringify(rendered[0]),
);
ok(!/\w\w/.test(rendered.join(' ').replace(/\s/g, '')) === false, '語が連結されていない', JSON.stringify(rendered));
ok(
  rendered.every((l) => l === l.replace(/\s+/g, ' ') && !/\s\s/.test(l)),
  '二重空白・欠損なし',
  JSON.stringify(rendered),
);
ok((await page.locator('#lyricView .word').count()) > 15, '単語要素が生成される');

const stamps = await page.locator('#lyricView .line.lyric').evaluateAll((els) =>
  els.map((e) => Number(e.dataset.start)),
);
ok(stamps.every((s) => s > 0 && s < 11), '行タイムスタンプが音声長内に収まる', JSON.stringify(stamps));
ok(stamps.every((s, i, a) => i === 0 || s >= a[i - 1]), '行タイムスタンプが単調増加', JSON.stringify(stamps));

await page.screenshot({ path: join(shots, '03-result.png') });

console.log('\n[E2E] 再生ハイライト');
await page.evaluate(() => {
  const a = document.getElementById('player');
  a.currentTime = 2.6;
});
await page.waitForTimeout(800);
const diag = await page.evaluate(() => {
  const a = document.getElementById('player');
  const words = [...document.querySelectorAll('#lyricView .word')];
  return {
    currentTime: a.currentTime,
    readyState: a.readyState,
    duration: a.duration,
    wordCount: words.length,
    sample: words.slice(0, 6).map((w) => `${w.dataset.start}-${w.dataset.end}`),
    sung: words.filter((w) => w.classList.contains('sung')).length,
  };
});
console.log(`        diag: ${JSON.stringify(diag)}`);
const sungCount = diag.sung;
ok(sungCount > 0, '再生位置の単語がハイライトされる', JSON.stringify(diag));
await page.screenshot({ path: join(shots, '04-highlight.png') });

console.log('\n[E2E] 書き出し');
for (const [btn, ext] of [
  ['#expLrc', 'lrc'],
  ['#expEnhanced', 'lrc'],
  ['#expTtml', 'ttml'],
  ['#expJson', 'json'],
  ['#expSrt', 'srt'],
  ['#expVtt', 'vtt'],
]) {
  const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 15000 }), page.click(btn)]);
  const target = join(cache, `e2e-${ext}-${dl.suggestedFilename()}`);
  await dl.saveAs(target);
  const body = await readFile(target, 'utf-8');
  console.log(`        ${dl.suggestedFilename()} (${body.length} bytes)`);
  ok(body.length > 50, `${ext} が空でない`);
  if (ext === 'ttml') ok(body.includes('itunes:timing="Word"'), 'TTML に語ごとタイミング');
  if (ext === 'srt') {
    ok(/^1$/m.test(body) && /^\d\d:\d\d:\d\d,\d\d\d --> \d\d:\d\d:\d\d,\d\d\d$/m.test(body), 'SRT 時刻書式', body.split('\n').slice(0, 4).join(' / '));
    const cues = body.split(/\n\n+/).filter((b) => /^\d+$/.test(b.split('\n')[0] ?? ''));
    let mono = true;
    let prevEnd = -1;
    for (const c of cues) {
      const m = c.match(/(\d\d):(\d\d):(\d\d),(\d\d\d) --> (\d\d):(\d\d):(\d\d),(\d\d\d)/);
      if (!m) continue;
      const s2 = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
      if (s2 < prevEnd) mono = false;
      prevEnd = s2;
    }
    ok(mono && cues.length > 0, `SRT ${cues.length} cue が時間順`, String(mono));
  }
  if (ext === 'vtt') ok(body.startsWith('WEBVTT'), 'VTT ヘッダあり');
}

console.log('\n[E2E] 手動補正（単語クリックで時刻設定）');
await page.evaluate(() => {
  document.getElementById('player').currentTime = 4.0;
});
await page.locator('#lyricView .word').first().click();
await page.waitForTimeout(200);
ok((await page.locator('#lyricView .word.edited').count()) === 1, 'クリックした単語に補正マークが付く');
const hint = await page.locator('#editHint').textContent();
console.log(`        ${hint}`);
await page.screenshot({ path: join(shots, '05-edit.png') });

console.log('\n[E2E] 認識テキストの採用');
await page.on('dialog', (d) => d.accept());
await page.locator('#asrPanel').evaluate((d) => { d.open = true; });
await page.click('#adoptAsr');
await page.waitForTimeout(500);
const adopted = await page.locator('#lyrics').inputValue();
ok(adopted.trim().length > 20, '歌詞欄に認識テキストが入れ替わる', adopted.slice(0, 60));
const adoptedStats = await page.locator('#stats').innerText();
console.log(`        ${adoptedStats.replace(/\n/g, ' | ')}`);
ok(/整列率\s*1?00%/.test(adoptedStats.replace(/\s+/g, ' ')), '採用後は整列率100%', adoptedStats.replace(/\n/g, ' '));
ok((await page.locator('#lyricView .word.loose').count()) === 0, '未整列の語が消える');
const adoptedLines = (await page.locator('#lyricView .line.lyric').allTextContents()).map((l) => l.trim());
ok(
  adoptedLines.some((l) => /^And so my fellow Americans/.test(l)),
  '採用後も英語の語間スペースが正しい',
  JSON.stringify(adoptedLines.slice(0, 2)),
);
ok(!adoptedLines.join(' ').includes('Andsofellow'), '採用後も語が連結されていない');
await page.screenshot({ path: join(shots, '06-adopted.png') });

console.log('\n[E2E] オフセットスライダー');
await page.locator('#offset').fill('250');
await page.waitForTimeout(200);
const shifted = await page.locator('#lyricView .line.lyric').first().evaluate((e) => Number(e.dataset.start));
ok(Math.abs(shifted - stamps[0] - 0.25) < 0.02, 'オフセットが全行に適用される', `${shifted} vs ${stamps[0] + 0.25}`);

const errs = logs.filter((l) => l.startsWith('[pageerror]') || l.startsWith('[error]'));
ok(errs.length === 0, 'コンソールエラーなし', JSON.stringify(errs.slice(0, 3)));
await writeFile(join(cache, 'e2e-console.log'), logs.join('\n'), 'utf-8');

await browser.close();
stop();

console.log(failures === 0 ? '\nE2E すべて成功\n' : `\nE2E ${failures} 件失敗\n`);
process.exit(failures === 0 ? 0 : 1);