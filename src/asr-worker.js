// Whisper (ONNX / transformers.js) による単語レベル時刻推定を Web Worker で実行する
// 注意: return_timestamps:'word' の DTW はチャンク単位の逐次処理のため進捗コールバックが叩けない。
//       GPU メモリのリーク回避（transformers.js#1739）として 1曲ごとにパイプラインを破棄する。

import { MODELS, createTranscriber, transcribeWords } from './asr-core.js';

export { MODELS };

let pipe = null;
let loadedKey = null;

async function load(modelKey, device, progress_callback) {
  const spec = MODELS[modelKey] ?? MODELS.medium;
  const key = `${spec.id}:${device}`;
  if (pipe && loadedKey === key) return pipe;
  if (pipe) {
    await pipe.dispose();
    pipe = null;
    loadedKey = null;
  }
  pipe = await createTranscriber(modelKey, device, progress_callback);
  loadedKey = key;
  return pipe;
}

self.onmessage = async (event) => {
  const { type, payload } = event.data ?? {};

  try {
    if (type === 'load') {
      const { model, device } = payload;
      await load(model, device, (p) => {
        if (p.status === 'progress' || p.status === 'download' || p.status === 'done') {
          self.postMessage({
            type: 'progress',
            file: p.file,
            progress: p.progress ?? null,
            loaded: p.loaded ?? 0,
            total: p.total ?? 0,
            status: p.status,
          });
        }
      });
      self.postMessage({ type: 'loaded', device });
      return;
    }

    if (type === 'transcribe') {
      const { audio, model, device, language } = payload;
      const transcriber = await load(model, device, () => {});
      self.postMessage({ type: 'started' });

      const { words, elapsed, text } = await transcribeWords(transcriber, audio, { language });
      self.postMessage({ type: 'done', words, elapsed, text });

      if (device === 'webgpu') {
        await pipe.dispose();
        pipe = null;
        loadedKey = null;
      }
      return;
    }

    if (type === 'dispose') {
      if (pipe) await pipe.dispose();
      pipe = null;
      loadedKey = null;
      self.postMessage({ type: 'disposed' });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message ?? String(err), stack: err?.stack ?? null });
  }
};