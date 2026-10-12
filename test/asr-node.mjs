// Node 実機ASRテスト: モデル DL → 書き起こし → 整列 → LRC 書き出し
//   node test/asr-node.mjs [audioPath] [lyricsPath]
// 音声 omitted の場合は Hub のサンプル音声 (JFK) で動く。

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asrWordsToTokens, createTranscriber, transcribeWords, MODELS } from '../src/asr-core.js';
import { runAlignment } from '../src/pipeline.js';
import { toEnhancedLRC, toPlainLRC } from '../src/lrc.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cache = join(root, '.cache');
await mkdir(cache, { recursive: true });

/** 16bit PCM WAV のみ対応（テスト用の最小パーサ） */
function decodeWav(buf) {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('WAV ではありません');
  }
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    const body = buf.subarray(pos + 8, pos + 8 + size);
    if (id === 'fmt ') {
      fmt = { channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    } else if (id === 'data') {
      data = body;
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('fmt/data チャンクが見つかりません');
  if (fmt.bits !== 16) throw new Error(`16bit のみ対応（実際 ${fmt.bits}bit）`);
  const frames = Math.floor(data.length / 2 / fmt.channels);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < fmt.channels; c++) acc += data.readInt16LE((i * fmt.channels + c) * 2);
    out[i] = acc / fmt.channels / 32768;
  }
  return { pcm: out, sampleRate: fmt.sampleRate, duration: frames / fmt.sampleRate };
}

async function resample16k(pcm, srcRate) {
  if (srcRate === 16000) return pcm;
  const ratio = srcRate / 16000;
  const out = new Float32Array(Math.floor(pcm.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const frac = x - i0;
    out[i] = pcm[i0] * (1 - frac) + (pcm[i0 + 1] ?? pcm[i0]) * frac;
  }
  return out;
}

const JFK_URL = 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav';
const JFK_LYRICS = `And so my fellow Americans
ask not what your country can do for you
Ask what you can do for your country`;

const audioArg = process.argv[2];
const lyricsArg = process.argv[3];
const modelKey = process.env.MODEL ?? 'base';
const language = process.env.ASR_LANG ?? 'en';

let pcm;
let duration;
let lyricsText;
let label;

if (audioArg) {
  label = audioArg;
  const buf = await readFile(audioArg);
  try {
    const wav = decodeWav(buf);
    pcm = await resample16k(wav.pcm, wav.sampleRate);
    duration = wav.duration;
  } catch {
    throw new Error(
      'Node テストは 16bit PCM WAV のみ対応です。mp3/m4a はブラウザ版で試してください。',
    );
  }
  lyricsText = lyricsArg ? await readFile(lyricsArg, 'utf-8') : '';
} else {
  label = 'Hub sample (JFK)';
  const wavPath = join(cache, 'jfk.wav');
  if (!existsSync(wavPath)) {
    console.log('サンプル音声をダウンロード中…');
    const res = await fetch(JFK_URL);
    if (!res.ok) throw new Error(`download failed: ${res.status}`);
    await writeFile(wavPath, Buffer.from(await res.arrayBuffer()));
  }
  const wav = decodeWav(await readFile(wavPath));
  pcm = await resample16k(wav.pcm, wav.sampleRate);
  duration = wav.duration;
  lyricsText = lyricsArg ? await readFile(lyricsArg, 'utf-8') : JFK_LYRICS;
}

console.log(`\n音声: ${label}`);
console.log(`長さ: ${duration.toFixed(2)}s / ${pcm.length} samples @16kHz`);
console.log(`歌詞: ${lyricsText.split('\n').length} 行`);
console.log(`モデル: ${MODELS[modelKey].id} (device=cpu)\n`);

const modelLoadT0 = performance.now();
// Node 版 transformers.js は cpu / cuda のみ（webgpu は無いため WASM 相当の cpu で実行）
const transcriber = await createTranscriber(modelKey, 'cpu', (p) => {
  if (p.status === 'progress' && p.file?.endsWith('.onnx')) {
    const mb = ((p.loaded ?? 0) / 1e6).toFixed(0);
    const tot = ((p.total ?? 0) / 1e6).toFixed(0);
    process.stdout.write(`\r  ダウンロード ${p.file.split('/').pop().padEnd(38)} ${mb}/${tot} MB   `);
  }
});
console.log(`\nモデルロード: ${((performance.now() - modelLoadT0) / 1000).toFixed(1)}s`);

const { words, elapsed, text } = await transcribeWords(transcriber, pcm, { language });

console.log(`\n認識テキスト: ${text}`);
console.log(`認識単語数: ${words.length}`);
console.log(`解析時間: ${elapsed.toFixed(2)}s  (RTF ${(elapsed / duration).toFixed(3)})`);
console.log('\n先頭10語の認識時刻:');
for (const w of words.slice(0, 10)) {
  console.log(`  ${w.start.toFixed(2)}s - ${w.end.toFixed(2)}s  ${w.text}`);
}

const bad = words.filter((w) => w.start > duration + 1);
console.log(`\n長さ外ジャンプ: ${bad.length} 件 ${bad.length ? JSON.stringify(bad.slice(0, 3)) : ''}`);

if (lyricsText.trim()) {
  const res = runAlignment({ lyricsText, asrWords: asrWordsToTokens(words), language });
  console.log(`\n整列結果: 整列率 ${(res.stats.ratio * 100).toFixed(0)}% / 精度 ${(res.stats.meanScore * 100).toFixed(0)}% / 未整列 ${res.stats.unmatched}`);
  for (const line of res.lines) {
    if (line.start == null) continue;
    const label2 = line.type === 'meta' ? line.text : line.words.map((w) => w.text).join(' ');
    console.log(`  [${line.start.toFixed(2)}] ${label2}`);
  }
  const base = join(cache, 'out');
  await writeFile(`${base}.lrc`, toPlainLRC(res, { title: 'test' }), 'utf-8');
  await writeFile(`${base}.enhanced.lrc`, toEnhancedLRC(res, { title: 'test' }), 'utf-8');
  console.log(`\n書き出し: .cache/out.lrc / .cache/out.enhanced.lrc`);
}

await transcriber.dispose();