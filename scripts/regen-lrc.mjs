// .debug.json から LRC / TTML を再生成する（ASR 再実行なし・即時）
//   node scripts/regen-lrc.mjs example.debug.json [出力ディレクトリ]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { runAlignment } from '../src/pipeline.js';
import { postProcessWords } from '../src/asr-core.js';
import { normalize } from '../src/text.js';
import { toEnhancedLRC, toPlainLRC, toSRT, toTTML, toJSON, toVTT } from '../src/lrc.js';

const input = process.argv[2];
const outDir = process.argv[3] ?? '.';
if (!input) {
  console.error('usage: node scripts/regen-lrc.mjs <xxx.debug.json> [outdir]');
  process.exit(1);
}

const d = JSON.parse(readFileSync(input, 'utf-8'));

// 行ごとの歌詞テキストを復元
const byLine = new Map();
for (const t of d.lyricsTokens) {
  if (!byLine.has(t.line)) byLine.set(t.line, []);
  byLine.get(t.line).push(t.text);
}
const lyricsText = [...byLine.entries()]
  .sort((a, b) => a[0] - b[0])
  .map(([, toks]) => toks.join(' '))
  .join('\n');

const asrWords = postProcessWords(d.recognizedWords.map((w) => ({ ...w, key: normalize(w.text) })));
const res = runAlignment({ lyricsText, asrWords, language: d.settings.language, audioDuration: d.audio?.duration ?? null });
const meta = d.meta ?? {};
const name = basename(input).replace(/\.debug(\.json)?$/i, '').replace(/\.json$/i, '');

mkdirSync(outDir, { recursive: true });
const files = {
  [`${name}.lrc`]: toPlainLRC(res, meta),
  [`${name}.enhanced.lrc`]: toEnhancedLRC(res, meta),
  [`${name}.ttml`]: toTTML(res, meta),
  [`${name}.srt`]: toSRT(res, meta, cueOpts),
  [`${name}.vtt`]: toVTT(res, meta, cueOpts),
  [`${name}.json`]: toJSON(res, meta),
};
const cueOpts = { minDuration: Number(process.env.SRT_MIN ?? 1.0), maxChars: Number(process.env.SRT_MAX ?? 20) };
for (const [fname, body] of Object.entries(files)) {
  writeFileSync(join(outDir, fname), body, 'utf-8');
}

console.log(`${input} → ${outDir}`);
console.log(`  整列率 ${(res.stats.ratio * 100).toFixed(1)}% / 精度 ${(res.stats.meanScore * 100).toFixed(1)}% / 未整列 ${res.stats.unmatched} 語`);
console.log(`  ${Object.keys(files).join(', ')}`);
const misses = res.lines
  .filter((l) => l.type === 'lyric')
  .flatMap((l) => l.words.filter((w) => !w.matched).map((w) => w.text));
console.log(`  未整列語: ${misses.slice(0, 30).join(' ')}${misses.length > 30 ? ' …' : ''}`);