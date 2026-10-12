# サードパーティクレジット（NOTICE）

本リポジトリのソースコードは **MIT License**（[LICENSE](./LICENSE)）で公開しています。
以下は利用しているサードパーティコンポーネントのクレジットとライセンスです。

## 音声認識モデル

実行時に Hugging Face Hub からダウンロードし、ブラウザのキャッシュに保存されます。
（ソースコードには含まれません）

| モデル | 由来 | ライセンス |
| --- | --- | --- |
| `onnx-community/whisper-base_timestamped` | `openai/whisper-base` | Apache-2.0 |
| `onnx-community/whisper-small_timestamped` | `openai/whisper-small` | Apache-2.0 |
| `onnx-community/whisper-medium_timestamped` | `openai/whisper-medium` | Apache-2.0 |
| `onnx-community/whisper-large-v3-turbo_timestamped` | `openai/whisper-large-v3-turbo` | Apache-2.0 |

- Whisper は OpenAI によって開発されました（<https://github.com/openai/whisper>）。
  Whisper の**コード**は MIT、**モデルの重み**は Apache-2.0 で公開されています。
- ONNX 変換版は [`onnx-community`](https://huggingface.co/onnx-community) が公開しているものです。
  一部モデルカードにライセンスタグが無いものがありますが、派生元である `openai/whisper-*` の
  Apache-2.0 を適用しています。 Commercial 利用は各モデルのモデルカードの条款に従ってください。

## 依存パッケージ

| パッケージ | 用途 | ライセンス |
| --- | --- | --- |
| [`@huggingface/transformers`](https://github.com/huggingface/transformers.js) | ONNX モデル実行・音声認識パイプライン | Apache-2.0 |
| [`onnxruntime-web`](https://github.com/microsoft/onnxruntime)（依存） | 推論エンジン | MIT |
| [`vite`](https://github.com/vitejs/vite)（開発） | ビルド / 開発サーバー | MIT |
| [`playwright`](https://github.com/microsoft/playwright)（開発・テストのみ） | E2E テスト | Apache-2.0 |

## アルゴリズム

- **Needleman-Wunsch 整列**による forced alignment。既存の公開アルゴリズムをもとにした
  独自実装です（実装の意図は `src/align.js` のコメントを参照）。
- **Whisper の単語レベルタイムスタンプ**は cross-attention + DTW により算出されます
  （`openai/whisper` / `huggingface/transformers` の実装に準拠）。

## 歌詞フォーマット仕様

- LRC / Enhanced LRC (A2): 一般的な非公式規格（<https://en.wikipedia.org/wiki/LRC_(file_format)>）
- TTML: W3C 標準（<https://www.w3.org/TR/ttml/>）
- SRT / WebVTT: 一般的な字幕フォーマット

## 利用者側の責任

本ツールは音声ファイルの内容を読み取るだけです。入力音声および歌詞テキストの
権利（著作権・利用許諾）は、**利用者自身的責任**となります。
生成された楽曲を配信・収益化する場合は、Suno 等の生成AIサービスの利用規約も
ご確認ください。