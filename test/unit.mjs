// 整列と書き出しの純ロジックテスト（モデル不要・即時）
//   node test/unit.mjs

import { alignTokens } from '../src/align.js';
import { runAlignment } from '../src/pipeline.js';
import { toCues, toEnhancedLRC, toPlainLRC, toSRT, toTTML, toVTT } from '../src/lrc.js';
import { normalize as normalizeText, parseLyrics, tokenizeLine } from '../src/text.js';

let failures = 0;
function ok(cond, label, extra = '') {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label} ${extra}`);
  }
}
function near(a, b, tol, label) {
  ok(a != null && Math.abs(a - b) <= tol, label, `(got ${a}, want ${b}±${tol})`);
}

/* ---------- 1. トークン分割 ---------- */
console.log('\n[1] tokenizeLine');
{
  const en = tokenizeLine("Don't stop, believin' now");
  ok(en.length === 4, '英単語4つに分割', JSON.stringify(en.map((t) => t.text)));
  ok(en[0].key === 'dont', "don't -> dont", en[0].key);

  const ja = tokenizeLine('恋におちたらPCTile最強', 'ja');
  ok(ja.length >= 3, '日本語が複数トークンになる', JSON.stringify(ja.map((t) => t.text)));
  ok(ja.map((t) => t.key).join('') === '恋におちたらpctile最強', '日本語ノーマライズ一致(NFKC+小文字化)', ja.map((t) => t.key).join(''));

  const ko = tokenizeLine('사랑해 그대만', 'ko');
  ok(ko.map((t) => t.key).join('') === '사랑해그대만', '韓国語ノーマライズ一致', ko.map((t) => t.key).join(''));

  const parsed = parseLyrics('[Verse]\nhello world\n\n[ Chorus ]\nbye', 'en');
  ok(parsed.length === 5, '空行とセクションタグを保持', JSON.stringify(parsed.map((l) => l.type)));
  ok(parsed[0].type === 'meta' && parsed[2].type === 'blank' && parsed[3].type === 'meta', 'セクションタグ判定');
}

/* ---------- 2. 整列（模擬ASR） ---------- */
console.log('\n[2] Needleman-Wunsch 整列');
{
  // 歌詞: hello world again / 模擬ASR: 'hello' 'word'(聞き間違い) 'again'
  const lyric = ['hello', 'world', 'again'].map((k) => ({ key: k }));
  const asr = [
    { key: 'hello', start: 1.0, end: 1.2 },
    { key: 'word', start: 1.3, end: 1.6 },
    { key: 'again', start: 1.8, end: 2.0 },
  ];
  const { items, stats } = alignTokens(lyric, asr);
  near(items[0].start, 1.0, 1e-6, '完全一致語 hello = 1.0s');
  near(items[1].start, 1.3, 1e-6, '類似一致 world <- word の時刻を継承');
  near(items[2].start, 1.8, 1e-6, 'again = 1.8s');
  ok(stats.matched === 3 && stats.ratio === 1, '整列率 100%', JSON.stringify(stats));

  // 無関係すぎる単語（類似度33%）は未整列扱いになり補間される
  const far = alignTokens(lyric, [
    { key: 'hello', start: 1.0, end: 1.2 },
    { key: 'b', start: 1.3, end: 1.4 },
    { key: 'again', start: 1.8, end: 2.0 },
  ]);
  ok(far.stats.matched === 2, '低類似度は未整列扱い', JSON.stringify(far.stats));
  ok(far.items[1].start > 1.2 && far.items[1].start < 1.8, '低類似度語は補間', String(far.items[1].start));

  // ASRが1語落とした場合 -> 補間されるか
  // world が聞き取られていない
  const r2 = alignTokens(lyric, [
    { key: 'hello', start: 1.0, end: 1.2 },
    { key: 'again', start: 2.0, end: 2.2 },
  ]);
  ok(Math.abs(r2.stats.ratio - 2 / 3) < 1e-9, '未認識1語で整列率2/3', JSON.stringify(r2.stats));
  ok(r2.items[1].start > 1.2 && r2.items[1].start < 2.0, '欠落語は補間される', String(r2.items[1].start));

  // 曲全体が無関係（ASRが壊れている/ボーカルなし）
  const r3 = alignTokens(lyric, [{ key: 'zzz', start: 0, end: 1 }]);
  ok(r3.stats.ratio === 0, '無関係ASRでは整列率0%');
  ok(r3.items.length === 3 && r3.items.every((i) => i.start == null || i.start === 0), '安全に処理される');

  // ASRが空
  const r4 = alignTokens(lyric, []);
  ok(r4.stats.ratio === 0 && r4.items.length === 3, 'ASR空でもクラッシュしない');

  // 歌詞が空
  const r5 = alignTokens([], asr);
  ok(r5.items.length === 0 && r5.stats.ratio === 1, '歌詞空でもクラッシュしない');
}

/* ---------- 3. 行構成 + 書き出し ---------- */
console.log('\n[3] 行構成と出力フォーマット');
{
  const lyricsText = ['[Verse 1]', 'hello world', '[Chorus]', 'sing with me'].join('\n');
  const asrWords = [
    { key: 'hello', start: 1.0, end: 1.3, text: 'hello' },
    { key: 'world', start: 1.5, end: 1.9, text: 'world' },
    { key: 'sing', start: 5.0, end: 5.4, text: 'sing' },
    { key: 'with', start: 5.5, end: 5.7, text: 'with' },
    { key: 'me', start: 5.8, end: 6.1, text: 'me' },
  ];
  const res = runAlignment({ lyricsText, asrWords, language: 'en' });

  ok(res.lines.length === 4, 'セクションタグ行を保持', JSON.stringify(res.lines.map((l) => l.type)));
  near(res.lines[1].start, 1.0, 1e-6, '1行目の開始=1.0s');
  near(res.lines[3].start, 5.0, 1e-6, '4行目の開始=5.0s');
  near(res.lines[0].start, 1.0, 1e-6, 'meta行は次行の時刻を借りる');
  ok(res.stats.ratio === 1, '整列率100%');

  const lrc = toPlainLRC(res, { title: 'T', artist: 'A' });
  ok(/\[ti:T\]/.test(lrc) && /\[00:01\.00\]hello world/.test(lrc), 'plain LRC', lrc.split('\n')[2]);

  const enh = toEnhancedLRC(res, { title: 'T' });
  ok(/\[00:01\.00\]<00:01\.00>hello <00:01\.50>world/.test(enh), 'enhanced LRC の語タグ', enh.split('\n')[2]);

  const ttml = toTTML(res, { title: 'T', language: 'en' });
  ok(ttml.includes('itunes:timing="Word"'), 'TTML に Word タイミング指定');
  ok(/<span begin="00:00:01\.000" end="00:00:01\.300">hello<\/span>/.test(ttml), 'TTML の span', '');
  ok(ttml.includes('xmlns:ttm'), 'TTML 名前空間');

  // オフセット反映
  const off = runAlignment({ lyricsText, asrWords, language: 'en', offset: 0.5 });
  near(off.lines[1].start, 1.5, 1e-6, 'オフセット +0.5s');

  // 行が逆転しないこと
  let mono = true;
  let prev = -1;
  for (const l of res.lines) if (l.start != null) { if (l.start < prev) mono = false; prev = l.start; }
  ok(mono, '行時刻は単調増加');
}

/* ---------- 4. SRT / VTT ---------- */
console.log('\n[4] SRT / VTT');
{
  const lyricsText = [
    '[Verse]',
    '深夜2時',
    'この長い一行がそのまま字幕になると読みにくいですね本当に',
    '短い行',
  ].join('\n');
  const mk = (text, start, end, key) => ({ text, key: key ?? normalizeText(text), start, end });
  const asrWords = [
    mk('深夜', 13.7, 14.4),
    mk('2時', 14.5, 14.9),
    mk('この', 20.0, 20.4, 'こ'),
    mk('長い', 20.5, 20.9),
    mk('一行', 21.0, 21.4),
    mk('が', 21.5, 21.6),
    mk('そのまま', 21.7, 22.3),
    mk('字幕', 22.4, 22.8),
    mk('になる', 22.9, 23.4),
    mk('と', 23.5, 23.6),
    mk('読みにくい', 23.7, 24.6),
    mk('ですね', 24.7, 25.1),
    mk('本当に', 25.2, 25.7),
    mk('短い行', 30.0, 30.5, '短い行'),
  ];
  const res = runAlignment({ lyricsText, asrWords, language: 'ja', audioDuration: 40 });

  const srt = toSRT(res, { title: 'T' }, { minDuration: 1.0, maxChars: 18 });
  ok(/^1$/m.test(srt) && /00:00:13,700 --> 00:00:14,900/.test(srt) && /\n深夜2時$/m.test(srt), 'SRT 番号・時刻・カンマ区切り', JSON.stringify(srt));

  const cues = toCues(res, { minDuration: 1.0, maxChars: 18 });
  ok(cues.every((c) => c.text.length > 0), '空字幕なし');
  ok(cues.every((c, i) => i === 0 || c.start >= cues[i - 1].end), '字幕が重ならない');
  ok(cues.every((c) => c.end > c.start), '終了 > 開始');
  ok(
    cues.every((c) => [...c.text].length <= 18 || [...c.text].length < 25),
    '長行が分割されている',
    JSON.stringify(cues.map((c) => [...c.text].length)),
  );
  ok(cues.some((c) => c.text.includes('この長い一行がそのまま字幕になると')), '語境界で折り返し', JSON.stringify(cues.map((c) => c.text)));
  ok(!cues.some((c) => c.text.includes('[Verse]')), 'セクションタグは字幕に含めない');

  const short = toCues(res, { minDuration: 2.0, maxChars: 40 });
  ok(short[0].end - short[0].start >= 2.0 - 0.02, '最低表示時間が効く');

  const vtt = toVTT(res, {}, { minDuration: 1.0, maxChars: 18 });
  ok(vtt.startsWith('WEBVTT'), 'VTT ヘッダ');
  ok(/00:00:13.700 --> 00:00:14.900/.test(vtt), 'VTT はドット区切り', JSON.stringify(vtt.split('\n')[2]));

  // 英語も動く
  const enRes = runAlignment({
    lyricsText: 'Hello world\nGood night',
    asrWords: [mk('Hello', 1, 1.4), mk('world', 1.5, 1.9), mk('Good', 5, 5.4), mk('night', 5.5, 5.9)],
    language: 'en',
    audioDuration: 10,
  });
  ok(/Hello world/.test(toSRT(enRes, {}, { minDuration: 1 })), '英語も出力できる');
}

console.log(failures === 0 ? '\nすべて成功\n' : `\n${failures} 件失敗\n`);
process.exit(failures === 0 ? 0 : 1);