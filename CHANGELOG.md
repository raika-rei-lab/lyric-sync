# Changelog

この project's変更履歴です。
書式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に準拠し、
バージョン付けは [Semantic Versioning](https://semver.org/lang/ja/) に従います。

## [Unreleased]

## [0.1.0] - 2026-10-12

初回リリース。

### 追加

- ブラウザ内 Whisper（ONNX）による単語レベル時刻推定（WebGPU / WASM フォールバック）
- Needleman-Wunsch 整列による forced alignment（歌詞テキスト ↔ ASR 認識時刻）
- CJK の粒度合わせ（歌詞の単語単位 ↔ Whisper の1文字単位）
- DTW 退化出力の補正（巨大スパン / 長さゼロの連続）
- 出力フォーマット: LRC / enhanced LRC (A2) / TTML / SRT / WebVTT / JSON
- MV 向け字幕設定（最低表示時間・1行最大文字数）
- 手動補正 UI（単語クリックで再生ヘッド時刻に設定、`[` `]` で ±10ms / ±50ms）
- 診断パネル（認識テキストの表示、認識テキスト↔歌詞類似度、幻覚検出）
- 「認識テキストを歌詞として採用」（整列率 100% で時刻を確定）
- 要確認行フィルター
- CLI: `scripts/regen-lrc.mjs` / `scripts/finalize.mjs`
- テスト: ユニット 43件 / E2E 24件

[Unreleased]: https://github.com/raika-rei-lab/lyric-sync/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/raika-rei-lab/lyric-sync/releases/tag/v0.1.0