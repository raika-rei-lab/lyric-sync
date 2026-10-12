// 2つの .debug.json（異なるモデル）を単語レベルで比較する
//   node test/diff-models.mjs
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { runAlignment } from '../src/pipeline.js';
import { postProcessWords } from '../src/asr-core.js';
import { normalize } from '../src/text.js';
const dir='test/fixtures';
if (!existsSync(dir) || !readdirSync(dir).filter(f=>f.endsWith('.debug.json')).length) {
  console.log('fixture なし（test/fixtures/*.debug.json を2つ）— 比較をスキップします。');
  process.exit(0);
}
function load(n){ const d=JSON.parse(readFileSync(`${dir}/${n}`,'utf8'));
  const byLine=new Map(); for(const t of d.lyricsTokens){if(!byLine.has(t.line))byLine.set(t.line,[]);byLine.get(t.line).push(t.text);}
  const lines=[...byLine.entries()].sort((a,b)=>a[0]-b[0]).map(([,t])=>t.join(' ')).join('\n');
  const words=postProcessWords(d.recognizedWords.map(w=>({...w,key:normalize(w.text)})));
  return {d, res:runAlignment({lyricsText:lines,asrWords:words,language:'ja'}), lines};
}
const S=load('song-ja-small.debug.json'), M=load('song-ja-medium.debug.json');
const miss=r=>r.res.lines.filter(l=>l.type==='lyric').flatMap(l=>l.words.filter(w=>!w.matched).map(w=>w.text));
const sm=new Set(miss(S)), mm=new Set(miss(M));
console.log(`救われた語 (${[...sm].filter(x=>!mm.has(x)).length}):`, [...sm].filter(x=>!mm.has(x)).join(' '));
console.log(`\n新たに壊れた語 (${[...mm].filter(x=>!sm.has(x)).length}):`, [...mm].filter(x=>!sm.has(x)).join(' ') || '(なし)');
console.log(`\n両方とも未整列 (${[...sm].filter(x=>mm.has(x)).length}):`, [...sm].filter(x=>mm.has(x)).join(' '));

console.log('\n--- medium の残り13語: その時刻で実際にどう聞こえたか ---');
for(const L of M.res.lines.filter(x=>x.type==='lyric')){
  const bad=L.words.filter(w=>!w.matched); if(!bad.length) continue;
  const start=L.start??0, end=(M.res.lines.filter(x=>x.type==='lyric').find(x=>x.start>(L.start??0))?.start)??M.d.audio.duration;
  const heard=M.res && M.d.recognizedWords.filter(w=>w.start<end&&w.end>start).map(w=>w.text).join('');
  console.log(`  [${start.toFixed(1)}s] 歌詞: ${L.words.map(w=>w.text).join('')}`);
  console.log(`         未整列: ${bad.map(w=>w.text).join('')}`);
  console.log(`         認識:   ${heard}`);
}

console.log('\n--- 巨大スパン比較 ---');
for(const [n,X] of [['small',S],['medium',M]]){
  const long=X.d.recognizedWords.map(w=>({t:w.text,d:w.end-w.start})).filter(x=>x.d>3);
  console.log(`  ${n}: 3秒超の語 ${long.length}個 ${long.map(x=>`${x.t}(${x.d.toFixed(1)}s)`).join(' ')}`);
}
console.log('\n--- 認識テキスト先頭60字 ---');
console.log('  small :', S.d.recognizedText.slice(0,60));
console.log('  medium:', M.d.recognizedText.slice(0,60));
