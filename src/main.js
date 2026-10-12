import { AsrClient, decodeAudio, pickDevice } from './asr.js';
import { asrWordsToTokens } from './asr-core.js';
import { bigramDice, joinTokens, parseLyrics } from './text.js';
import { runAlignment } from './pipeline.js';
import { download, toEnhancedLRC, toJSON, toPlainLRC, toSRT, toTTML, toVTT } from './lrc.js';

const $ = (id) => document.getElementById(id);

const el = {
  deviceBadge: $('deviceBadge'),
  drop: $('drop'),
  audioFile: $('audioFile'),
  audioInfo: $('audioInfo'),
  player: $('player'),
  lyrics: $('lyrics'),
  lyricsFile: $('lyricsFile'),
  loadLyrics: $('loadLyrics'),
  clearLyrics: $('clearLyrics'),
  language: $('language'),
  model: $('model'),
  useWebGPU: $('useWebGPU'),
  run: $('run'),
  cancel: $('cancel'),
  status: $('status'),
  progressWrap: $('progressWrap'),
  progressBar: $('progressBar'),
  emptyState: $('emptyState'),
  result: $('result'),
  stats: $('stats'),
  offset: $('offset'),
  offsetValue: $('offsetValue'),
  title: $('title'),
  artist: $('artist'),
  lyricView: $('lyricView'),
  expLrc: $('expLrc'),
  expEnhanced: $('expEnhanced'),
  expTtml: $('expTtml'),
  expSrt: $('expSrt'),
  expVtt: $('expVtt'),
  srtMin: $('srtMin'),
  srtMax: $('srtMax'),
  expJson: $('expJson'),
  expDebug: $('expDebug'),
  asrPanel: $('asrPanel'),
  asrDiagnosis: $('asrDiagnosis'),
  asrText: $('asrText'),
  editHint: $('editHint'),
  onlyUnmatched: $('onlyUnmatched'),
  unmatchedInfo: $('unmatchedInfo'),
  adoptAsr: $('adoptAsr'),
};

const state = {
  file: null,
  objectUrl: null,
  raw: null,
  edits: new Map(),
  offsetMs: 0,
  selected: null,
  running: false,
  asr: null,
  asrText: '',
  asrWords: [],
  model: 'small',
  device: 'wasm',
  elapsed: 0,
  duration: 0,
};

const fmt = (s) => {
  if (s == null || !isFinite(s)) return '--.--';
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}:${r.toFixed(2).padStart(5, '0')}`;
};

function setStatus(text, kind = '') {
  el.status.textContent = text;
  el.status.dataset.kind = kind;
}

function showProgress(pct) {
  el.progressWrap.hidden = false;
  el.progressBar.style.width = `${Math.max(2, Math.min(100, pct))}%`;
}

/* ---------------- 入力 ---------------- */

el.drop.addEventListener('click', () => el.audioFile.click());
el.drop.addEventListener('dragover', (e) => {
  e.preventDefault();
  el.drop.classList.add('over');
});
el.drop.addEventListener('dragleave', () => el.drop.classList.remove('over'));
el.drop.addEventListener('drop', (e) => {
  e.preventDefault();
  el.drop.classList.remove('over');
  const f = e.dataTransfer.files?.[0];
  if (f) setAudioFile(f);
});
el.audioFile.addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) setAudioFile(f);
});

function setAudioFile(file) {
  state.file = file;
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = URL.createObjectURL(file);
  el.player.src = state.objectUrl;
  el.audioInfo.textContent = `${file.name}（${(file.size / 1024 / 1024).toFixed(1)} MB）`;
  el.title.value ||= file.name.replace(/\.[^.]+$/, '');
}

el.loadLyrics.addEventListener('click', () => el.lyricsFile.click());
el.lyricsFile.addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (!f) return;
  const text = await f.text();
  el.lyrics.value = text.replace(/^\s*\[[a-zA-Z#]+:[^\]]*\]\s*$/gm, '').replace(/^\[[0-9:.]+\]/gm, '');
});
el.clearLyrics.addEventListener('click', () => {
  el.lyrics.value = '';
});

/* ---------------- 実行 ---------------- */

async function detectDevice() {
  const wantGpu = el.useWebGPU.checked;
  const device = await pickDevice(wantGpu ? 'auto' : 'wasm');
  el.deviceBadge.textContent =
    device === 'webgpu' ? '実行環境: WebGPU（GPU 高速モード）' : '実行環境: WASM（CPU / 遅いモード）';
  el.deviceBadge.dataset.device = device;
  return device;
}

el.useWebGPU.addEventListener('change', () => detectDevice());
detectDevice();

el.run.addEventListener('click', run);
el.cancel.addEventListener('click', () => {
  if (state.asr) state.asr.dispose();
  state.asr = null;
  state.running = false;
  el.run.disabled = false;
  el.cancel.disabled = true;
  setStatus('中止しました', 'warn');
});

async function run() {
  if (state.running) return;
  if (!state.file) return setStatus('音声ファイルを選択してください', 'warn');
  const lyricsText = el.lyrics.value.trim();
  if (!lyricsText) return setStatus('歌詞を入力してください', 'warn');

  state.running = true;
  el.run.disabled = true;
  el.cancel.disabled = false;
  state.edits.clear();

  try {
    const device = await detectDevice();
    setStatus('音声をデコード中…');
    const { pcm, duration } = await decodeAudio(state.file);

    if (!state.asr) {
      state.asr = new AsrClient();
      state.asr.onProgress = (msg) => {
        if (msg.status === 'progress' && msg.total) {
          const pct = (msg.loaded / msg.total) * 100;
          showProgress(pct);
          setStatus(`モデルダウンロード中 ${pct.toFixed(0)}%（${(msg.loaded / 1e6).toFixed(0)}/${(msg.total / 1e6).toFixed(0)} MB）`);
        }
      };
    }

    setStatus(`モデル準備中（${device === 'webgpu' ? 'WebGPU' : 'WASM'} / ${el.model.value}）…`);
    await state.asr.load(el.model.value, device);

    setStatus('音声を解析中…（曲長の 1/2〜2 倍くらいかかります）');
    showProgress(100);
    const { words, elapsed, text } = await state.asr.transcribe(pcm, {
      model: el.model.value,
      device,
      language: el.language.value,
    });
    state.asrWords = words;
    state.asrText = text ?? words.map((w) => w.text).join(' ');
    state.model = el.model.value;
    state.device = device;
    state.elapsed = elapsed;
    state.duration = duration;

    setStatus('歌詞と整列中…');
    const tokens = asrWordsToTokens(words);
    state.raw = runAlignment({ lyricsText, asrWords: tokens, language: el.language.value, audioDuration: duration });

    render();
    el.emptyState.hidden = true;
    el.result.hidden = false;

    const s = state.raw.stats;
    const rtf = duration ? elapsed / duration : 0;
    setStatus(
      `完了: ${(elapsed).toFixed(1)}秒で解析（${rtf.toFixed(2)}x 再生時間）`,
      s.ratio > 0.75 ? 'ok' : 'warn',
    );
  } catch (err) {
    console.error(err);
    setStatus(`エラー: ${err.message}`, 'err');
  } finally {
    state.running = false;
    el.run.disabled = false;
    el.cancel.disabled = true;
  }
}

/* ---------------- 結果表示 ---------------- */

function currentResult() {
  if (!state.raw) return null;
  const off = state.offsetMs / 1000;
  const lines = state.raw.lines.map((line, li) => ({
    ...line,
    start: line.start == null ? null : line.start + off,
    end: line.end == null ? null : line.end + off,
    words: line.words.map((w, wi) => {
      const e = state.edits.get(`${li}:${wi}`);
      if (e && w.start != null) {
        return { ...w, start: e.start + off, end: (e.end ?? e.start) + off };
      }
      return w.start == null ? w : { ...w, start: w.start + off, end: w.end + off };
    }),
  }));
  return { lines, stats: state.raw.stats, duration: state.raw.duration };
}

/** 認識テキストが歌詞と合っているかを数値で見せ、原因を切り分ける */
function renderDiagnosis() {
  const lyricsText = el.lyrics.value;
  const heard = state.asrText ?? '';
  const dice = bigramDice(heard, lyricsText);
  const lyricTokens = parseLyrics(lyricsText, el.language.value).reduce((n, l) => n + l.tokens.length, 0);
  const heardTokens = state.asrWords.length;
  const stuck = state.asrWords.filter((w, i, a) => i > 0 && w.text === a[i - 1].text).length;
  const badTime = state.asrWords.filter((w) => w.end <= w.start).length;

  const hints = [];
  if (heard.trim().length < 10) hints.push('ASR が何も認識していません。音声が.mp3 のまま OffscreenCanvas 経由でデコードされていない可能性 → 別形式で試す');
  if (dice < 0.2) hints.push('認識テキストが歌詞とほぼ一致しません。①「言語」設定を歌っている言語（日本語/한국어/English）に変更 ②モデルを上げ.small→medium）③伴奏が重い場合はボーカル分離が必要');
  if (state.asrWords.length > lyricTokens * 3) hints.push('認識語数が歌詞語数の3倍超。Whisper の幻覚（繰り返し）が疑われます');
  if (stuck > state.asrWords.length * 0.15) hints.push(`同一単語の連続が${stuck}箇所。幻覚の典型パターンです`);
  if (badTime > 0) hints.push(`開始=終了の単語が${badTime}個。チャンク境界での時刻崩れの可能性`);

  el.asrDiagnosis.innerHTML = `
    <div class="dgrid">
      <span>認識テキスト↔歌詞 類似度</span><b class="${dice < 0.2 ? 'bad' : 'good'}">${(dice * 100).toFixed(0)}%</b>
      <span>認識語数 / 歌詞語数</span><b>${heardTokens} / ${lyricTokens}</b>
      <span>認識言語設定</span><b>${el.language.value}</b>
      <span>認識テキストの長さ</span><b>${heard.length} 文字</b>
    </div>
    ${hints.length ? `<ul class="hints">${hints.map((h) => `<li>${h}</li>`).join('')}</ul>` : '<p class="good">認識テキストは歌詞と整合しています。</p>'}`;
  el.asrText.textContent = (heard || '(空)').slice(0, 4000);
}

function render() {
  const res = currentResult();
  if (!res) return;

  const s = res.stats;
  const warn = s.ratio < 0.75 ? '  ⚠ 整列率が低いので要確認' : '';
  el.stats.innerHTML = `
    <span>整列率 <b>${(s.ratio * 100).toFixed(0)}%</b></span>
    <span>一致精度 <b>${(s.meanScore * 100).toFixed(0)}%</b></span>
    <span>未整列 <b>${s.unmatched}</b>/${s.total} 語</span>
    <span>長さ <b>${fmt(res.duration)}</b></span>${warn}`;

  renderDiagnosis();

  el.lyricView.innerHTML = '';
  const onlyUnmatched = el.onlyUnmatched.checked;
  let needCheck = 0;
  for (let li = 0; li < res.lines.length; li++) {
    const line = res.lines[li];
    const lineHasMiss = line.type === 'lyric' && line.words.some((w) => !w.matched);
    if (lineHasMiss) needCheck++;
    const div = document.createElement('div');
    div.className = `line ${line.type}${lineHasMiss ? ' needs-check' : ''}${onlyUnmatched && !lineHasMiss ? ' filtered-out' : ''}`;
    if (line.start != null) div.dataset.start = line.start;
    if (line.type === 'meta') {
      div.textContent = line.text;
    } else {
      for (let wi = 0; wi < line.words.length; wi++) {
        const w = line.words[wi];
        const span = document.createElement('span');
        span.className = `word${w.matched ? '' : ' loose'}${state.edits.has(`${li}:${wi}`) ? ' edited' : ''}`;
        span.textContent = w.text;
        if (w.start != null) {
          span.dataset.start = w.start;
          span.dataset.end = w.end;
        }
        span.title = `${w.start == null ? '未整列' : `${w.start.toFixed(2)}s`}${w.matched ? '' : '（補間）'}`;
        span.addEventListener('click', (e) => onWordClick(li, wi, e));
        // 区切りの空白は「前の語と現在の語の間」に出す（後ろに置くと1語ずれる）
        if (wi > 0 && joinTokens([line.words[wi - 1].text, w.text]).includes(' ')) {
          div.appendChild(document.createTextNode(' '));
        }
        div.appendChild(span);
      }
    }
    el.lyricView.appendChild(div);
  }
  el.unmatchedInfo.textContent = `（要確認 ${needCheck} 行）`;
}

el.onlyUnmatched.addEventListener('change', render);

/** 認識した語列を、APE息・語数で区切って歌詞行に落とし込む */
function asrWordsToLyricLines(words, { gap = 0.45, maxWords = 14 } = {}) {
  const lines = [];
  let cur = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (i > 0 && (w.start - words[i - 1].end > gap || cur.length >= maxWords)) {
      lines.push(joinTokens(cur));
      cur = [];
    }
    cur.push(w.text);
  }
  if (cur.length) lines.push(joinTokens(cur));
  return lines.join('\n');
}

el.adoptAsr.addEventListener('click', () => {
  if (!state.asrWords.length) return;
  if (!confirm('歌詞テキストを「実際に歌われた文言」で上書きします。元の歌詞は消えます。続けますか？')) return;
  el.lyrics.value = asrWordsToLyricLines(state.asrWords);
  state.edits.clear();
  state.raw = runAlignment({
    lyricsText: el.lyrics.value,
    asrWords: asrWordsToTokens(state.asrWords),
    language: el.language.value,
  });
  render();
  setStatus(
    `認識テキストを歌詞として採用しました（整列率 ${(state.raw.stats.ratio * 100).toFixed(0)}%）。文言のズレはテキスト欄で直してください。`,
    'ok',
  );
});

el.offset.addEventListener('input', () => {
  state.offsetMs = Number(el.offset.value);
  el.offsetValue.textContent = `${state.offsetMs} ms`;
  render();
});

/* 単語クリック = その時刻を再生ヘッドに合わせる（Alt+クリックで end も） */
function onWordClick(li, wi, e) {
  if (state.selected) {
    state.selected.el.classList.remove('selected');
  }
  const elSpan = e.currentTarget;
  elSpan.classList.add('selected');
  state.selected = { li, wi, el: elSpan };

  const line = currentResult().lines[li];
  const w = line.words[wi];
  if (w.start == null) return;
  const t = el.player.currentTime;
  const key = `${li}:${wi}`;
  if (e.altKey) {
    const prev = state.edits.get(key) ?? { start: w.start - state.offsetMs / 1000, end: w.end - state.offsetMs / 1000 };
    state.edits.set(key, { start: prev.start, end: t - state.offsetMs / 1000 });
  } else {
    const dur = Math.max(0.12, (w.end ?? w.start) - w.start);
    state.edits.set(key, { start: t - state.offsetMs / 1000, end: t - state.offsetMs / 1000 + dur });
  }
  el.editHint.textContent = `単語 «${w.text}» を ${fmt(t)} に設定（±10msは [ / ]）`;
  render();
  reselect();
}

function reselect() {
  if (!state.selected) return;
  const { li, wi } = state.selected;
  const spans = el.lyricView.children[li]?.querySelectorAll('.word');
  const s = spans?.[wi];
  if (s) {
    s.classList.add('selected');
    state.selected.el = s;
  }
}

document.addEventListener('keydown', (e) => {
  if (!state.selected || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.key !== '[' && e.key !== ']') return;
  const { li, wi } = state.selected;
  const res = currentResult();
  const w = res.lines[li].words[wi];
  if (!w || w.start == null) return;
  const step = e.shiftKey ? 0.05 : 0.01;
  const delta = e.key === ']' ? step : -step;
  const key = `${li}:${wi}`;
  const prev = state.edits.get(key) ?? { start: w.start - state.offsetMs / 1000, end: w.end - state.offsetMs / 1000 };
  const ns = Math.max(0, prev.start + delta);
  state.edits.set(key, { start: ns, end: prev.end + delta });
  el.editHint.textContent = `«${w.text}» ${fmt(ns)}（Shift で 50ms）`;
  render();
  reselect();
});

/* 再生ハイライト */
function tick() {
  const t = el.player.currentTime;
  let activeLine = null;
  for (const div of el.lyricView.children) {
    if (div.classList.contains('line')) div.classList.remove('active');
    if (div.dataset.start != null && Number(div.dataset.start) <= t) activeLine = div;
  }
  if (activeLine && !activeLine.classList.contains('active')) {
    activeLine.classList.add('active');
    activeLine.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
  let activeWord = null;
  for (const span of el.lyricView.querySelectorAll('.word')) {
    const s = Number(span.dataset.start);
    const e = Number(span.dataset.end);
    const on = !isNaN(s) && t >= s && (isNaN(e) ? false : t <= e + 0.08);
    span.classList.toggle('sung', on);
    if (on) activeWord = span;
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

/* ---------------- 書き出し ---------------- */

function baseName() {
  return (el.title.value || 'lyrics').replace(/[\\/:*?"<>|]/g, '_');
}
function meta() {
  return { title: el.title.value, artist: el.artist.value, language: el.language.value };
}

el.expLrc.addEventListener('click', () => download(`${baseName()}.lrc`, toPlainLRC(currentResult(), meta())));
el.expEnhanced.addEventListener('click', () => download(`${baseName()}.enhanced.lrc`, toEnhancedLRC(currentResult(), meta())));
el.expTtml.addEventListener('click', () =>
  download(`${baseName()}.ttml`, toTTML(currentResult(), meta()), 'application/ttml+xml'),
);
el.expJson.addEventListener('click', () => download(`${baseName()}.json`, toJSON(currentResult(), meta()), 'application/json'));

function cueOpts() {
  return {
    minDuration: Math.max(0.2, Number(el.srtMin.value) || 1.0),
    maxChars: Math.max(6, Number(el.srtMax.value) || 20),
  };
}

el.expSrt.addEventListener('click', () => download(`${baseName()}.srt`, toSRT(currentResult(), meta(), cueOpts())));
el.expVtt.addEventListener('click', () => download(`${baseName()}.vtt`, toVTT(currentResult(), meta(), cueOpts())));

el.expDebug.addEventListener('click', () => {
  const payload = {
    meta: meta(),
    settings: { model: state.model, device: state.device, language: el.language.value },
    audio: { duration: state.duration, elapsed: state.elapsed },
    stats: currentResult()?.stats ?? null,
    recognizedText: state.asrText,
    recognizedWords: state.asrWords,
    lyricsTokens: parseLyrics(el.lyrics.value, el.language.value).flatMap((l, li) =>
      l.tokens.map((t, ti) => ({ line: li, index: ti, text: t.text, key: t.key })),
    ),
    alignment: (currentResult()?.lines ?? []).map((l, li) => ({
      line: li,
      type: l.type,
      start: l.start,
      words: l.words.map((w) => ({ text: w.text, start: w.start, matched: w.matched, score: Number(w.score?.toFixed?.(2) ?? w.score) })),
    })),
  };
  download(`${baseName()}.debug.json`, JSON.stringify(payload, null, 2), 'application/json');
});