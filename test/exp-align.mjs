// 実データ fixture で整列アルゴリズムの効果を比較する（モデル不要・即時）
//   node test/exp-align.mjs
// 使い方: ブラウザの「.debug.json」を test/fixtures/*.debug.json に置いて実行

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAlignment } from '../src/pipeline.js';
import { normalize } from '../src/text.js';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.debug.json')) : [];
if (!files.length) {
  console.log('fixture なし（test/fixtures/*.debug.json）— 比較をスキップします。');
  console.log('  ブラウザの「.debug.json（解析ログ）」を test/fixtures/ に置くと比較できます。');
  process.exit(0);
}

for (const f of files) {
  const d = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
  // 行構造を復元: debug の lyricsTokens から行ごとのテキストを作る
  const byLine = new Map();
  for (const t of d.lyricsTokens) {
    if (!byLine.has(t.line)) byLine.set(t.line, []);
    byLine.get(t.line).push(t.text);
  }
  const lines = [...byLine.entries()].sort((a, b) => a[0] - b[0]).map(([, toks]) => toks.join(' '));

  const asrWords = d.recognizedWords.map((w) => ({ ...w, key: normalize(w.text) }));

  console.log(`\n=== ${f}`);
  console.log(`言語: ${d.settings.language} / モデル: ${d.settings.model} / 音声 ${d.audio.duration.toFixed(1)}s`);
  console.log(`認識語 ${asrWords.length} / 歌詞語 ${d.lyricsTokens.length}`);

  for (const expand of [false, true]) {
    const t0 = performance.now();
    const res = runAlignment({ lyricsText: lines.join('\n'), asrWords, language: d.settings.language, expandCJK: expand });
    const ms = (performance.now() - t0).toFixed(0);
    const s = res.stats;
    const label = expand ? '文字展開 ON ' : '文字展開 OFF';
    console.log(
      `  ${label}  整列率 ${(s.ratio * 100).toFixed(1)}%  精度 ${(s.meanScore * 100).toFixed(1)}%  ` +
        `未整列 ${s.unmatched}  ${ms}ms`,
    );
  }

  // 文字展開 ON のときの未整列語を分類
  const res = runAlignment({ lyricsText: lines.join('\n'), asrWords, language: d.settings.language, expandCJK: true });
  const misses = [];
  for (const l of res.lines) {
    if (l.type !== 'lyric') continue;
    for (const w of l.words) if (!w.matched) misses.push(w.text);
  }
  console.log(`  未整列語(${misses.length}): ${misses.slice(0, 40).join(' ')}`);
}