// Worker 制御 + 音声デコード（16kHz モノラル Float32）

import { asrWordsToTokens } from './asr-core.js';

export { asrWordsToTokens };

export function hasWebGPU() {
  return typeof navigator !== 'undefined' && 'gpu' in navigator;
}

export async function pickDevice(preferred = 'auto') {
  if (preferred === 'wasm') return 'wasm';
  if (!hasWebGPU()) return 'wasm';
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return 'wasm';
    return 'webgpu';
  } catch {
    return 'wasm';
  }
}

/** 音声ファイル -> { pcm: Float32Array(16kHz mono), duration, sampleRate } */
export async function decodeAudio(file) {
  const ctx = new OfflineAudioContext(1, 1, 16000);
  const buf = await file.arrayBuffer();
  let decoded;
  try {
    decoded = await ctx.decodeAudioData(buf);
  } catch {
    // ctx が消費済みになることがあるため、リトライ
    const ctx2 = new OfflineAudioContext(1, 1, 16000);
    decoded = await ctx2.decodeAudioData(buf.slice(0));
  }
  if (decoded.sampleRate !== 16000) {
    const off = new OfflineAudioContext(1, Math.ceil((decoded.duration * 16000) | 0) + 1, 16000);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    decoded = await off.startRendering();
  }
  // モノラル化 + ピーク保護
  let pcm = decoded.getChannelData(0);
  if (decoded.numberOfChannels > 1) {
    const out = new Float32Array(decoded.length);
    for (let c = 0; c < decoded.numberOfChannels; c++) {
      const ch = decoded.getChannelData(c);
      for (let i = 0; i < out.length; i++) out[i] += ch[i];
    }
    pcm = out;
    const inv = 1 / decoded.numberOfChannels;
    for (let i = 0; i < out.length; i++) out[i] *= inv;
  }
  return { pcm: pcm.slice(0), duration: decoded.duration, sampleRate: 16000 };
}

export class AsrClient {
  constructor() {
    this.worker = new Worker(new URL('./asr-worker.js', import.meta.url), { type: 'module' });
    this.seq = 0;
    this.pending = new Map();
    this.worker.onmessage = (e) => {
      const msg = e.data ?? {};
      if (msg.type === 'progress') {
        this.onProgress?.(msg);
        return;
      }
      const p = this.pending.get(msg.type);
      if (!p) return;
      this.pending.delete(msg.type);
      if (msg.type === 'error') p.reject(new Error(msg.message));
      else p.resolve(msg);
    };
    this.worker.onerror = (e) => {
      for (const [, p] of this.pending) p.reject(new Error(e.message || 'worker error'));
      this.pending.clear();
    };
  }

  onProgress = null;

  // リクエスト種別 -> 応答種別（Worker 側のメッセージ名）
  static RESPONSE = { load: 'loaded', transcribe: 'done', dispose: 'disposed' };

  send(type, payload, transfer) {
    const replyType = AsrClient.RESPONSE[type] ?? type;
    return new Promise((resolve, reject) => {
      this.pending.set(replyType, { resolve, reject });
      this.worker.postMessage({ type, payload }, transfer ?? []);
    });
  }

  load(model, device) {
    return this.send('load', { model, device });
  }

  transcribe(audio, opts) {
    const copy = audio.slice(0);
    return this.send('transcribe', { audio: copy, ...opts }, [copy.buffer]);
  }

  dispose() {
    this.worker.terminate();
  }
}
