// ASR の中核（Worker / Node テストで共有）

import { pipeline, env } from '@huggingface/transformers';
import { normalize } from './text.js';

env.allowLocalModels = false;

export const MODELS = {
  base: { id: 'onnx-community/whisper-base_timestamped', label: 'base（WebGPU 約200MB / WASM 約70MB）' },
  small: { id: 'onnx-community/whisper-small_timestamped', label: 'small（WebGPU 約560MB / WASM 約240MB）' },
  medium: { id: 'onnx-community/whisper-medium_timestamped', label: 'medium（推奨 / WebGPU 約1.6GB）' },
  turbo: {
    id: 'onnx-community/whisper-large-v3-turbo_timestamped',
    label: 'large-v3-turbo（WebGPU 約2.7GB / 長時間動作は未検証）',
  },
};

/** Whisper が受け付けるのは英語名。UI から来る ISO コードを変換する。 */
export const LANGUAGE_NAMES = {
  en: 'english',
  ja: 'japanese',
  ko: 'korean',
  zh: 'chinese',
  fr: 'french',
  de: 'german',
  es: 'spanish',
  ru: 'russian',
  it: 'italian',
  pt: 'portuguese',
  th: 'thai',
  vi: 'vietnamese',
  id: 'indonesian',
  tr: 'turkish',
  pl: 'polish',
  nl: 'dutch',
};

export function normalizeLanguage(lang) {
  if (!lang || lang === 'auto') return null;
  const key = String(lang).toLowerCase().slice(0, 2);
  return LANGUAGE_NAMES[key] ?? null;
}

export function dtypeFor(device) {
  if (device === 'webgpu') return { encoder_model: 'fp32', decoder_model_merged: 'q4' };
  return { encoder_model: 'q8', decoder_model_merged: 'q8' };
}

export async function createTranscriber(modelKey, device, progress_callback) {
  const spec = MODELS[modelKey] ?? MODELS.medium;
  return pipeline('automatic-speech-recognition', spec.id, {
    device,
    dtype: dtypeFor(device),
    progress_callback,
  });
}

/**
 * 単語レベル時刻つきで書き起こす。
 * chunk_length_s=30 は *_timestamped モデルで時刻が壊れるため必ず 29 を使う。
 */
export async function transcribeWords(transcriber, pcm, { language = 'auto' } = {}) {
  const options = {
    return_timestamps: 'word',
    chunk_length_s: 29,
    stride_length_s: 5,
    task: 'transcribe',
    // 歌唱音声では幻覚（繰り返し/無関係な語）が起きやすい。貪欲復号 + 前文条件無効で抑制する
    temperature: 0,
    condition_on_previous_text: false,
    no_repeat_ngram_size: 0,
  };
  if (language && language !== 'auto') {
    const name = normalizeLanguage(language);
    if (name) options.language = name;
  }

  const t0 = performance.now();
  const output = await transcriber(pcm, options);
  const elapsed = (performance.now() - t0) / 1000;

  const words = [];
  let prevEnd = 0;
  for (const c of output.chunks ?? []) {
    const ts = c.timestamp ?? [];
    let start = typeof ts[0] === 'number' && isFinite(ts[0]) ? ts[0] : prevEnd;
    let end = typeof ts[1] === 'number' && isFinite(ts[1]) ? ts[1] : start + 0.12;
    if (end < start) end = start;
    if (start < prevEnd) start = prevEnd;
    const text = String(c.text ?? '').trim();
    if (!text) continue;
    prevEnd = end;
    words.push({ text, start, end });
  }
  postProcessWords(words);
  return { words, elapsed, text: output.text ?? '' };
}
/** 認識単語（テキスト付き） -> 整列用のトークン列 */
export function asrWordsToTokens(words) {
  const out = [];
  for (const w of words) {
    const key = normalize(w.text);
    if (!key) continue;
    out.push({ text: w.text, key, start: w.start, end: w.end });
  }
  return out;
}

/**
 * Whisper の DTW は「無音 instrumental → 最初の歌い出し」で、最初の語に巨大スパン
 * （例: 0.00-14.26s）を丸ごと吸収することがある。
 * 周辺の中央値長さでクランプし、開始時刻を歌い出し付近へ寄せる。
 */
/**
 * DTW の退化出力: 連続する複数の語が同一時刻・長さゼロに潰れることがある
 * （例: 6 つの語がすべて 72.96-72.96）。区間長を見積もり、均等配分し直す。
 */
export function repairDegenerateRuns(words) {
  if (words.length < 2) return words;
  const EPS = 0.02;
  const normal = words.map((w) => w.end - w.start).filter((d) => d >= EPS).sort((a, b) => a - b);
  if (!normal.length) return words;
  const median = normal[Math.floor(normal.length / 2)];
  const unit = Math.min(0.35, Math.max(0.08, median * 0.7));

  let i = 0;
  while (i < words.length) {
    if (words[i].end - words[i].start >= EPS) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < words.length && words[j + 1].end - words[j + 1].start < EPS) j++;
    const n = j - i + 1;
    const prevEnd = i > 0 ? words[i - 1].end : 0;
    const anchorEnd = j + 1 < words.length ? words[j + 1].start : words[j].end;
    const span = (anchorEnd - prevEnd) / (n + 1);
    const dur = Math.min(Math.max(n * unit, span * 0.5), Math.max(0.05, anchorEnd - prevEnd));
    const start = Math.max(prevEnd, anchorEnd - dur);
    for (let k = i; k <= j; k++) {
      const f = (k - i) / n;
      words[k].start = start + (anchorEnd - start) * f;
      words[k].end = start + (anchorEnd - start) * ((k - i + 1) / n);
    }
    i = j + 1;
  }
  return words;
}

/** transcribeWords の後処理（巨大スパン + 退化スパン） */
export function postProcessWords(words) {
  return repairDegenerateRuns(fixInflatedSpans(words));
}

export function fixInflatedSpans(words) {
  if (words.length < 4) return words;
  const durs = words.map((w) => w.end - w.start).filter((d) => d > 0.01).sort((a, b) => a - b);
  if (!durs.length) return words;
  const median = durs[Math.floor(durs.length / 2)];
  // 3秒を超える語は「無音を吸収した」，几乎確実に異常。短い語（息継ぎを含んだ長い語）は触らない。
  const limit = Math.max(3.0, median * 8);
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const dur = w.end - w.start;
    if (dur <= limit) continue;
    const newStart = Math.max(w.start, w.end - median * 3);
    const prev = i > 0 ? words[i - 1].end : 0;
    w.start = Math.max(newStart, prev);
    if (w.start >= w.end) w.start = Math.max(prev, w.end - 0.1);
  }
  return words;
}
