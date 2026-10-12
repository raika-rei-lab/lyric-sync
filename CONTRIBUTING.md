# 貢献guideline

貢献ありがとうございます。

## 開発環境

```bash
npm install
npm run dev
```

Node.js 20 以上が必要です。

## Pull Request の前に

```bash
npm run test:unit    # 即時（モデル不要）
npm run build        # ビルドが通ること
npm run test:e2e     # ブラウザ実動作（初回はモデルのDLに数分かかります）
```

CI（GitHub Actions）が同じ項目を自動実行します。

## コミットメッセージ

Conventional Commits に準拠しています。

```
feat: SRT の1行最大文字数を設定できるようにした
fix: DTW退化で潰れた語 区間の時刻を補正
docs: MANUAL.md に Premiere Pro の手順を追加
```

## コードの Elected 方針

- **依存を増やさない。** 標準機能と既存依存で解けるならそうする
  （特に実行時の bundle size とブラウザー互換性を優先します）
- **DOM を触るのは `src/main.js` のみ。** ロジックは `src/` の他モジュールに置き、Node でもテストできるようにする
- **音声はブラウザー外に出さない。** 外部 API・トラッキング・遥测を追加しないでください
- **修正には根拠を.** アルゴリズムを変更する場合は、コメントに「何を観測したから何を変えたか」を書きます

## バグ報告

次の情報を含めて Issue を作成してください。

- ブラウザとバージョン、GPU の有無（`実行環境: WebGPU / WASM` の表示）
- 使用した認識モデル
- 整列率・一致精度の表示値
- 可能なら `.debug.json`（音声ファイルではなく、認識ログのみ。omitempty機密情報を含みません）

## ライセンス

貢献したコードは [MIT License](./LICENSE) に同意したものとみなします。

[Unreleased]: https://github.com/raika-rei-lab/lyric-sync/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/raika-rei-lab/lyric-sync/releases/tag/v0.1.0