// 出力フォーマット: plain LRC / enhanced LRC (A2) / TTML / JSON

import { joinTokens } from './text.js';

function fmt(sec, ms = true) {
  if (sec == null || !isFinite(sec)) return '00:00.00';
  const clamped = Math.max(0, sec);
  const m = Math.floor(clamped / 60);
  const s = clamped - m * 60;
  if (ms) {
    const whole = Math.floor(s);
    const frac = Math.round((s - whole) * 100);
    if (frac === 100) return `${pad(m)}:${pad(whole + 1)}.00`;
    return `${pad(m)}:${pad(whole)}.${pad(frac)}`;
  }
  return `${pad(m)}:${pad(Math.floor(s))}`;
}

function pad(v) {
  return String(v).padStart(2, '0');
}

function stamp(sec) {
  const clamped = Math.max(0, sec ?? 0);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped - h * 3600) / 60);
  const s = clamped - h * 3600 - m * 60;
  return `${pad(h)}:${pad(m)}:${s.toFixed(3).padStart(6, '0')}`;
}

export function toPlainLRC(result, meta = {}) {
  const out = [];
  if (meta.title) out.push(`[ti:${meta.title}]`);
  if (meta.artist) out.push(`[ar:${meta.artist}]`);
  if (meta.album) out.push(`[al:${meta.album}]`);
  out.push('[re:lyric-sync]');
  if (result.duration) out.push(`[length:${fmt(result.duration)}]`);
  for (const line of result.lines) {
    if (line.start == null) continue;
    out.push(`[${fmt(line.start)}]${line.type === 'meta' ? line.text : joinTokens(line.words.map((w) => w.text))}`);
  }
  return out.join('\n') + '\n';
}

/** enhanced LRC (A2): [mm:ss.xx]<mm:ss.xx>word ... */
export function toEnhancedLRC(result, meta = {}) {
  const out = [];
  if (meta.title) out.push(`[ti:${meta.title}]`);
  if (meta.artist) out.push(`[ar:${meta.artist}]`);
  out.push('[re:lyric-sync]');
  for (const line of result.lines) {
    if (line.type === 'meta') {
      if (line.start != null) out.push(`[${fmt(line.start)}]${line.text}`);
      continue;
    }
    if (line.start == null) continue;
    const spans = line.words.filter((w) => w.start != null);
    const body = spans.map((w, i) => `${i > 0 && joinTokens([spans[i - 1].text, w.text]).includes(' ') ? ' ' : ''}<${fmt(w.start)}>${w.text}`).join('');
    out.push(`[${fmt(line.start)}]${body}`);
  }
  return out.join('\n') + '\n';
}

/** TTML (Apple Music 互換の語ごとタイミング) */
export function toTTML(result, meta = {}) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lang = meta.language && meta.language !== 'auto' ? meta.language : 'en';
  const lines = [];
  for (const line of result.lines) {
    if (line.start == null) continue;
    if (line.type === 'meta') {
      lines.push(`    <p begin="${stamp(line.start)}" end="${stamp(line.start + 0.01)}">${esc(line.text)}</p>`);
      continue;
    }
    const spans = line.words
      .filter((w) => w.start != null)
      .map(
        (w) =>
          `<span begin="${stamp(w.start)}" end="${stamp(Math.max(w.end ?? w.start, w.start + 0.05))}">${esc(w.text)}</span>`,
      )
      .join('\n      ');
    lines.push(
      `    <p begin="${stamp(line.start)}" end="${stamp(Math.max(line.end ?? line.start, line.start + 0.05))}">${spans}</p>`,
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttm="http://www.w3.org/ns/ttml#metadata" xmlns:itunes="http://music.apple.com/lyric-ttml-internal" xml:lang="${lang}" itunes:timing="Word">
  <head>
    <metadata>
      <ttm:title>${esc(meta.title ?? '')}</ttm:title>
      <ttm:artist>${esc(meta.artist ?? '')}</ttm:artist>
      <ttm:tool>lyric-sync</ttm:tool>
    </metadata>
  </head>
  <body>
    <div>
${lines.join('\n')}
    </div>
  </body>
</tt>
`;
}

/**
 * SRT / WebVTT 用の cue 列を作る。
 * - 行は「単語」の単位で分割する（日本語の語境界で自然に折り返す）
 * - 短い行は最低表示時間まで延ばす（読めないほど早送りにならないように）
 * - 終了は次の行の開始に揃える（重なりの防止）
 */
export function toCues(result, { minDuration = 1.0, maxChars = 20, includeMeta = false } = {}) {
  const lines = result.lines.filter((l) => l.start != null && (includeMeta || l.type !== 'meta'));

  // 行 -> 単語アトムの配列（日本語は語境界で分割できる）
  const atomsOf = (L) => {
    if (L.type === 'meta') return [{ text: L.text, start: L.start, end: L.end }];
    return L.words.map((w) => ({
      text: w.text,
      start: w.start ?? L.start,
      end: w.end ?? L.end ?? L.start,
    }));
  };

  const cues = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const atoms = atomsOf(L);
    if (!atoms.length) continue;

    let end = L.end ?? L.start + minDuration;
    const nextStart = lines[i + 1]?.start;
    if (nextStart != null && nextStart - L.start < minDuration) end = Math.max(end, nextStart - 0.01);
    else end = Math.max(end, L.start + minDuration);

    // 語境界で maxChars 以内に分割する
    const groups = [];
    let cur = [];
    let curLen = 0;
    for (const a of atoms) {
      const len = [...a.text].length;
      if (cur.length && curLen + len > maxChars) {
        groups.push(cur);
        cur = [];
        curLen = 0;
      }
      cur.push(a);
      curLen += len;
    }
    if (cur.length) groups.push(cur);

    if (groups.length === 1) {
      cues.push({ start: L.start, end, text: joinTokens(groups[0].map((a) => a.text)) });
      continue;
    }
    const total = groups.reduce((n, g) => n + g.reduce((m, a) => m + [...a.text].length, 0), 0) || 1;
    const span = end - L.start;
    let acc = 0;
    for (const g of groups) {
      const n = g.reduce((m, a) => m + [...a.text].length, 0);
      const s = L.start + (span * acc) / total;
      acc += n;
      const e = L.start + (span * acc) / total;
      cues.push({ start: s, end: Math.max(e, s + 0.3), text: joinTokens(g.map((a) => a.text)) });
    }
  }

  // 時間順・非重複を保証
  cues.sort((a, b) => a.start - b.start);
  for (let i = 0; i < cues.length; i++) {
    if (i > 0 && cues[i].start < cues[i - 1].end) cues[i].start = cues[i - 1].end + 0.01;
    if (cues[i].end <= cues[i].start) cues[i].end = cues[i].start + 0.3;
  }
  return cues;
}

function srtTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec - h * 3600) / 60);
  const s = sec - h * 3600 - m * 60;
  return `${pad(h)}:${pad(m)}:${s.toFixed(3).padStart(6, '0').replace('.', ',')}`;
}

function vttTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec - h * 3600) / 60);
  const s = sec - h * 3600 - m * 60;
  return `${pad(h)}:${pad(m)}:${s.toFixed(3).padStart(6, '0')}`;
}

export function toSRT(result, meta = {}, opts = {}) {
  const cues = toCues(result, opts);
  const head = [];
  if (meta.title) head.push(`# ${meta.title}`);
  return (
    head.join('\n') +
    (head.length ? '\n\n' : '') +
    cues
      .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}`)
      .join('\n\n') +
    '\n'
  );
}

export function toVTT(result, meta = {}, opts = {}) {
  const cues = toCues(result, opts);
  return (
    'WEBVTT\n\n' +
    cues.map((c) => `${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text}`).join('\n\n') +
    '\n'
  );
}

export function toJSON(result, meta = {}) {
  return JSON.stringify(
    {
      meta: { title: meta.title ?? '', artist: meta.artist ?? '', language: meta.language ?? 'auto' },
      duration: result.duration,
      stats: result.stats,
      lines: result.lines.map((l) => ({
        type: l.type,
        text: l.text,
        start: l.start,
        end: l.end,
        words:
          l.type === 'lyric'
            ? l.words.map((w) => ({ text: w.text, start: w.start, end: w.end, matched: w.matched }))
            : [],
      })),
    },
    null,
    2,
  );
}

export function download(filename, content, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}