// テキスト正規化とトークン分割（言語非依存・依存ライブラリなし）

const PUNCT = /[\p{P}\p{S}\p{C}]/gu;
const SPACE = /\s+/gu;

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

const segmenters = new Map();

function getSegmenter(lang) {
  const tag = /^(ja|zh|ko)/i.test(lang) ? lang.toLowerCase().slice(0, 2) : 'ja';
  if (segmenters.has(tag)) return segmenters.get(tag);
  let seg = null;
  try {
    seg = new Intl.Segmenter(tag, { granularity: 'word' });
  } catch {
    seg = null;
  }
  segmenters.set(tag, seg);
  return seg;
}

/** 全角英数字->_半角、大小文字統一、記号除去、空白圧縮 */
export function normalize(text, { keepSpaces = false } = {}) {
  let s = text.normalize('NFKC').toLowerCase();
  s = s.replace(PUNCT, '');
  s = keepSpaces ? s.replace(SPACE, ' ').trim() : s.replace(SPACE, '');
  return s;
}

export function containsCJK(text) {
  return CJK.test(text);
}

/**
 * 1行の歌詞を [ Surface, Key ] の配列にする。
 * - 英数: 空白区切り（Everything else removed）
 * - CJK : Intl.Segmenter による単語分割、無ければ1文字ずつ
 */
export function tokenizeLine(line, lang = 'auto') {
  const out = [];
  const trimmed = line.trim();
  if (!trimmed) return out;

  const cjk = containsCJK(trimmed);
  if (cjk) {
    const seg = getSegmenter(lang);
    if (seg) {
      for (const { segment, isWordLike } of seg.segment(trimmed)) {
        const key = normalize(segment);
        if (!key) continue;
        out.push({ text: segment, key, wordLike: isWordLike });
      }
    } else {
      for (const ch of trimmed) {
        const key = normalize(ch);
        if (!key) continue;
        out.push({ text: ch, key, wordLike: true });
      }
    }
    return out;
  }

  // 拉丁語・数字など: 空白/記号で分割
  for (const piece of trimmed.split(/[\s]+/)) {
    const key = normalize(piece);
    if (!key) continue;
    out.push({ text: piece.replace(/^[\p{P}\p{S}]+|[^\p{L}\p{N}]+$/gu, ''), key, wordLike: true });
  }
  return out;
}

/** 歌詞テキスト全体を「行ごとのトークン列」にする。[Verse] 等は type:'meta' */
export function parseLyrics(raw, lang = 'auto') {
  return raw
    .split(/\r?\n/)
    .map((line) => {
      const text = line.trim();
      if (!text) return { type: 'blank', tokens: [], raw: line };
      const isMeta = /^\s*[\[(][^\])]*[\])]\s*$/.test(text);
      if (isMeta) return { type: 'meta', text, tokens: [] };
      return { type: 'lyric', text, tokens: tokenizeLine(text, lang) };
    });
}

const editCache = new Map();

/** レーベンシュタイン距離（短いトークン専用・長さで打ち切り） */
export function editDistance(a, b, max = 8) {
  const key = `${a}\u0000${b}`;
  if (editCache.has(key)) return editCache.get(key);
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > max) return max + 1;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    let best = cur[0];
    for (let j = 1; j <= n; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    const t = prev;
    prev = cur;
    cur = t;
  }
  const d = prev[n];
  editCache.set(key, d);
  return d;
}

/** 0..1 の類似度 */
export function similarity(keyA, keyB) {
  if (!keyA || !keyB) return 0;
  if (keyA === keyB) return 1;
  const d = editDistance(keyA, keyB, 6);
  const sim = 1 - d / Math.max(keyA.length, keyB.length);
  return sim >= 0 ? sim : 0;
}
/** 文字列の文字2-gram Dice 係数（0..1）。ASRテキストが歌詞と全然違うかの判定用 */
export function bigramDice(a, b) {
  const A = normalize(a);
  const B = normalize(b);
  if (!A || !B) return 0;
  if (A === B) return 1;
  const grams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(A);
  const gb = grams(B);
  let hit = 0;
  for (const [g, n] of ga) hit += Math.min(n, gb.get(g) ?? 0);
  return (2 * hit) / (A.length - 1 + B.length - 1);
}


const CJK_EDGE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/** 日本語では語間にスペースを入れない（英語語同士はスペースで区切る） */
export function joinTokens(list) {
  let out = '';
  for (const t of list) {
    const prev = out[out.length - 1] ?? '';
    const needSpace = prev && !CJK_EDGE.test(prev) && !CJK_EDGE.test(t[0] ?? '');
    out += (needSpace ? ' ' : '') + t;
  }
  return out;
}
