// 整列結果の組み立て（UI / Node テスト共通）

import { parseLyrics } from './text.js';
import { alignTokens } from './align.js';

/**
 * @param {object} input
 * @param {string} input.lyricsText  歌詞全文
 * @param {Array<{text:string,start:number,end:number}>} input.asrWords  認識単語（時刻付き）
 * @param {string} [input.language]  'ja' | 'ko' | 'en' | 'auto'
 * @param {number} [input.offset]    全体に掛けるオフセット（秒）
 * @param {number} [input.minLineDuration]
 */
export function runAlignment({ lyricsText, asrWords, language = 'auto', offset = 0, minLineDuration = 0.8, expandCJK = true, audioDuration = null }) {
  const parsed = parseLyrics(lyricsText, language);
  const flat = [];
  for (let li = 0; li < parsed.length; li++) {
    for (let ti = 0; ti < parsed[li].tokens.length; ti++) {
      flat.push({ ...parsed[li].tokens[ti], lineIndex: li, tokenIndex: ti });
    }
  }

  const asrTokens = asrWords.map((w) => ({ key: w.key, text: w.text, start: w.start, end: w.end }));
  const { items, stats } = alignTokens(flat, asrTokens, { expandCJK });

  const lines = parsed.map((line) => ({
    type: line.type,
    text: line.text ?? '',
    words: [],
    start: null,
    end: null,
  }));

  for (let k = 0; k < flat.length; k++) {
    const src = flat[k];
    const it = items[k];
    lines[src.lineIndex].words.push({
      text: src.text,
      key: src.key,
      start: it.start,
      end: it.end,
      matched: it.matched,
      score: it.score,
      heard: it.heard ?? null,
    });
  }

  for (const line of lines) {
    if (line.type !== 'lyric' || !line.words.length) continue;
    const first = line.words[0].start ?? null;
    const last = line.words[line.words.length - 1].end ?? null;
    line.start = first;
    line.end = last != null && first != null ? Math.max(last, first + minLineDuration) : first;
  }

  // 行位置の整合（重複・逆転を排除）
  const lyricIdx = lines.map((l, i) => (l.type === 'lyric' && l.start != null ? i : -1)).filter((i) => i >= 0);
  for (let k = 0; k < lyricIdx.length - 1; k++) {
    const a = lines[lyricIdx[k]];
    const b = lines[lyricIdx[k + 1]];
    if (b.start != null && a.end != null && a.end > b.start) a.end = b.start;
  }

  // [Verse] などの構造タグは直後の歌詞行の時刻を借りる
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].type !== 'meta') continue;
    let t = null;
    for (let j = i + 1; j < lines.length && t == null; j++) t = lines[j].start;
    if (t == null) for (let j = i - 1; j >= 0 && t == null; j--) t = lines[j].start;
    lines[i].start = t;
    lines[i].end = t;
  }

  if (offset) {
    for (const line of lines) {
      if (line.start != null) line.start += offset;
      if (line.end != null) line.end += offset;
      for (const w of line.words) {
        if (w.start != null) w.start += offset;
        if (w.end != null) w.end += offset;
      }
    }
  }

  // ASR の最終時刻は音声長を超えることがあるため、実際の音声長を優先する
  const duration = audioDuration ? Math.min(audioDuration, stats.duration || audioDuration) : stats.duration;

  return {
    lines: lines.filter((l) => l.type !== 'blank'),
    stats: { ...stats, unmatched: stats.total - stats.matched },
    duration,
  };
}