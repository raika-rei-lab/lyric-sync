// .debug.json + 元の歌詞テキストから、最終成果物（LRC / TTML / 要確認リスト）を生成する
//   node scripts/finalize.mjs 曲名.debug.json 歌詞.txt [outdir]

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { runAlignment } from '../src/pipeline.js';
import { normalize, joinTokens, tokenizeLine } from '../src/text.js';
import { postProcessWords } from '../src/asr-core.js';
import { toEnhancedLRC, toPlainLRC, toSRT, toTTML, toJSON, toVTT } from '../src/lrc.js';

const [input, lyricsPath, outDir = 'out'] = process.argv.slice(2);
if (!input || !lyricsPath) {
  console.error('usage: node scripts/finalize.mjs <xxx.debug.json> <lyrics.txt> [outdir]');
  process.exit(1);
}

const d = JSON.parse(readFileSync(input, 'utf-8'));
const lyricsText = readFileSync(lyricsPath, 'utf-8').replace(/\r\n/g, '\n');
const asrWords = postProcessWords(d.recognizedWords.map((w) => ({ ...w, key: normalize(w.text) })));
const res = runAlignment({ lyricsText, asrWords, language: d.settings.language, audioDuration: d.audio?.duration ?? null });
const meta = d.meta ?? {};
const name = basename(input).replace(/\.debug(\.json)?$/i, '').replace(/\.json$/i, '');

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, `${name}.lrc`), toPlainLRC(res, meta), 'utf-8');
writeFileSync(join(outDir, `${name}.enhanced.lrc`), toEnhancedLRC(res, meta), 'utf-8');
writeFileSync(join(outDir, `${name}.ttml`), toTTML(res, meta), 'utf-8');
writeFileSync(join(outDir, `${name}.json`), toJSON(res, meta), 'utf-8');
const cueOpts = { minDuration: Number(process.env.SRT_MIN ?? 1.0), maxChars: Number(process.env.SRT_MAX ?? 20) };
writeFileSync(join(outDir, `${name}.srt`), toSRT(res, meta, cueOpts), 'utf-8');
writeFileSync(join(outDir, `${name}.vtt`), toVTT(res, meta, cueOpts), 'utf-8');

// 要確認リスト（未整列語 + 前後の整列済み語）
const lines = res.lines.filter((l) => l.type === 'lyric');
const rows = [];
for (let i = 0; i < lines.length; i++) {
  const L = lines[i];
  const miss = L.words.map((w, wi) => ({ w, wi })).filter((x) => !x.w.matched);
  if (!miss.length) continue;
  for (const { w, wi } of miss) {
    const before = L.words[wi - 1];
    const after = L.words[wi + 1];
    const heard = asrWords
      .filter((a) => a.start >= (w.start ?? 0) - 0.35 && a.start <= (w.start ?? 0) + 0.35)
      .map((a) => a.text)
      .join('');
    rows.push({
      line: i,
      start: w.start,
      word: w.text,
      prev: before ? `${before.text}@${before.start?.toFixed(2)}` : '',
      next: after ? `${after.text}@${after.start?.toFixed(2)}` : '',
      heard,
    });
  }
}
writeFileSync(join(outDir, `${name}.checklist.csv`), ['line,start,word,prev,next,heard', ...rows.map((r) => [r.line, r.start?.toFixed(2), r.word, r.prev, r.next, `"${r.heard}"`].join(','))].join('\n') + '\n', 'utf-8');

console.log(`${name}: 整列率 ${(res.stats.ratio * 100).toFixed(1)}% / 精度 ${(res.stats.meanScore * 100).toFixed(1)}% / 未整列 ${res.stats.unmatched} 語`);
console.log(`出力: ${outDir}/${name}.{lrc,enhanced.lrc,ttml,srt,vtt,json,checklist.csv}\n`);
console.log('要確認リスト（補間時刻なので、ここだけ聞けば確認できます）:');
for (const r of rows) {
  console.log(`  ${r.start?.toFixed(2).padStart(7)}s  「${r.word}」  前:${r.prev}  後:${r.next}  認識:${r.heard || '(該当なし)'}`);
}
