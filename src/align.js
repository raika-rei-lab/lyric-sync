// 歌詞トークン（正解テキスト）と ASR トークン（認識結果＋時刻）の Needleman-Wunsch 整列
// 役割: 「どの単語がどの時刻に歌われたか」を、聞き間違いを吸収しつつ決定する

import { similarity } from './text.js';

export const TUNING = { gap: -1, matchWeight: 2, minScore: 0.4 };

// Whisper の日本語出力はUMAほぼ1文字単位（"深" "夜" "じ"）だが、歌詞側は単語単位（"深夜" "全部"）。
// この粒度差は1対1整列では吸収できないので、CJKは両側とも1文字に展開してから整列し、元の語に戻して集計する。
const CJK_CHAR = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]$/u;

/** CJKだけで構成された複数文字のトークンを1文字ずつに展開する */
function expandCJK(tokens, { hasTime }) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const chars = [...(t.key ?? '')];
    if (chars.length <= 1 || !chars.every((c) => CJK_CHAR.test(c))) {
      out.push({ ...t, parent: i });
      continue;
    }
    const n = chars.length;
    for (let k = 0; k < n; k++) {
      const item = { key: chars[k], parent: i };
      if (hasTime) {
        const s = t.start;
        const e = t.end ?? t.start;
        const span = (e - s) / n;
        item.start = s + span * k;
        item.end = s + span * (k + 1);
      }
      out.push(item);
    }
  }
  return out;
}

/**
 * @param {Array<{key:string}>} lyricTokens  歌詞側のトークン（既知）
 * @param {Array<{key:string,start:number,end:number}>} asrTokens  認識トークン（時刻付き）
 * @returns {{items:Array, stats:object}}
 */
export function alignTokens(lyricTokens, asrTokens, { expandCJK: doExpand = true } = {}) {
  const L = doExpand ? expandCJK(lyricTokens, { hasTime: false }) : lyricTokens.map((t, i) => ({ ...t, parent: i }));
  const A = doExpand ? expandCJK(asrTokens, { hasTime: true }) : asrTokens.map((t, i) => ({ ...t, parent: i }));

  const n = L.length;
  const m = A.length;

  if (n === 0) {
    return { items: [], stats: { matched: 0, total: 0, ratio: 1, meanScore: 1, duration: asrDuration(asrTokens) } };
  }
  if (m === 0) {
    return {
      items: lyricTokens.map((t) => ({ matched: false, score: 0, start: null, end: null })),
      stats: { matched: 0, total: n, ratio: 0, meanScore: 0, duration: 0 },
    };
  }

  const W = m + 1;
  const score = new Float32Array((n + 1) * W);
  const back = new Uint8Array((n + 1) * W); // 0=diag 1=up(歌詞側で消費) 2=left(ASR側で消費)

  for (let j = 1; j <= m; j++) score[j] = j * TUNING.gap;

  for (let i = 1; i <= n; i++) {
    const row = i * W;
    const prev = row - W;
    score[row] = i * TUNING.gap;
    for (let j = 1; j <= m; j++) {
      const sim = similarity(L[i - 1].key, A[j - 1].key);
      const diag = score[prev + j - 1] + TUNING.matchWeight * sim;
      const up = score[prev + j] + TUNING.gap;
      const left = score[row + j - 1] + TUNING.gap;
      let best = diag;
      let dir = 0;
      if (up > best) {
        best = up;
        dir = 1;
      }
      if (left > best) {
        best = left;
        dir = 2;
      }
      score[row + j] = best;
      back[row + j] = dir;
    }
  }

  // トレースバック
  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0) {
      const dir = back[i * W + j];
      if (dir === 0) {
        const sim = similarity(L[i - 1].key, A[j - 1].key);
        ops.push({ i: i - 1, j: j - 1, sim });
        i--;
        j--;
        continue;
      }
      if (dir === 1) {
        ops.push({ i: i - 1, j: -1, sim: 0 });
        i--;
        continue;
      }
    }
    if (j > 0) {
      ops.push({ i: -1, j: j - 1, sim: 0 }); // ASR 側だけの消費 = 聞き間違い/ハルシネーション
      j--;
    } else {
      ops.push({ i: i - 1, j: -1, sim: 0 }); // 歌詞側は残ったが ASR 側は尽きた = 未認識
      i--;
    }
  }
  ops.reverse();

  const items = lyricTokens.map(() => ({ matched: false, score: 0, start: null, end: null, chars: 0, hits: 0 }));
  for (const op of ops) {
    if (op.i < 0) continue; // ASR 側だけ消費 = 聞き間違い/ハルシネーション
    const asr = A[op.j];
    const item = items[L[op.i].parent];
    item.chars++;
    if (op.sim < TUNING.minScore) continue;
    item.hits++;
    item.score = Math.max(item.score, op.sim);
    item.matched = true;
    item.heard = asr.text ?? null;
    item.start = item.start == null ? asr.start : Math.min(item.start, asr.start);
    item.end = item.end == null ? asr.end : Math.max(item.end, asr.end);
  }
  for (const it of items) {
    if (!it.chars) continue;
    // 語の一部だけが一致した場合は「一致した割合」を score にする
    it.score = it.hits / it.chars;
    if (!it.matched) {
      it.score = 0;
      it.start = null;
      it.end = null;
    }
  }
  const matchedItems = items.filter((it) => it.matched);
  const matched = matchedItems.length;

  interpolate(items);

  return {
    items,
    stats: {
      matched,
      total: lyricTokens.length,
      ratio: matched / lyricTokens.length,
      meanScore: matched ? matchedItems.reduce((a, it) => a + it.score, 0) / matched : 0,
      duration: asrDuration(asrTokens),
    },
  };
}

/** 未整列トークンの時刻を前後の整列済みトークンから補間し、単調増加に整える */
export function interpolate(items) {
  const idx = [];
  for (let i = 0; i < items.length; i++) if (items[i].matched && items[i].start != null) idx.push(i);

  if (idx.length === 0) return items;

  // 整列済み語の実測長（1語あたりの中央値）を補間の粒度にする
  const spans = [];
  for (const i of idx) {
    const d = items[i].end - items[i].start;
    if (d > 0.02 && d < 3) spans.push(d);
  }
  spans.sort((a, b) => a - b);
  const unit = spans.length ? spans[Math.floor(spans.length / 2)] : 0.2;

  const first = idx[0];
  for (let k = 0; k < first; k++) items[k] = { ...items[k], start: items[first].start, end: items[first].start };
  const last = idx[idx.length - 1];
  for (let k = last + 1; k < items.length; k++) items[k] = { ...items[k], start: items[last].end, end: items[last].end };

  // 2.5秒を超える空白（間奏・無音）は「歌ってない」ので、その中間に均等に置かない。
  // 次の歌い出しの直前に詰める。
  const BIG_GAP = 2.5;

  for (let s = 0; s < idx.length - 1; s++) {
    const i0 = idx[s];
    const i1 = idx[s + 1];
    const gapCount = i1 - i0 - 1;
    if (gapCount <= 0) continue;
    const t0 = items[i0].start;
    const t1 = items[i1].start;

    if (t1 - t0 > BIG_GAP) {
      const startAt = Math.max(t0, t1 - gapCount * unit);
      for (let k = 1; k <= gapCount; k++) {
        items[i0 + k] = {
          ...items[i0 + k],
          start: startAt + unit * (k - 1),
          end: startAt + unit * k,
        };
      }
      continue;
    }

    const span = gapCount + 1;
    for (let k = 1; k <= gapCount; k++) {
      items[i0 + k] = {
        ...items[i0 + k],
        start: t0 + ((t1 - t0) * k) / span,
        end: t0 + ((t1 - t0) * (k + 0.85)) / span,
      };
    }
  }

  let prev = -Infinity;
  for (const it of items) {
    if (it.start == null) continue;
    if (it.start < prev) {
      it.start = prev;
      if (it.end < it.start) it.end = it.start;
    }
    prev = it.start;
  }
  return items;
}

function asrDuration(asrTokens) {
  let d = 0;
  for (const t of asrTokens) if (typeof t.end === 'number' && t.end > d) d = t.end;
  return d;
}