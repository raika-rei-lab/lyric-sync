# GitHub 公開手順書

このプロジェクト（**Suno Lyric Sync**）を GitHub に公開する手順です。
公開用ファイルはすべて作成済み・コミット済みなので、**この手順は push だけです**。

---

## 結論を先に

**「リポジトリを作って、ファイルを手動アップロード」で流すのは非推奨です。**
以下に理由があります。

- コミット履歴（`a3c2956`）が失われる
- `.gitignore` が効かず、`node_modules/`（約200MB）や実データまで公開される
- **`.github/workflows/ci.yml` は GitHub の Web エディタでは編集できない**（セキュリティ上の制約で
  Web UI から workflow を書き換えると GitHub が削除する）→ CI が動かなくなる

**推奨は「Web で空リポジトリ作成 → ローカルから `git push`」です。**
手動アップロードでも push でも公開後のリポジトリの内容は同じですが、
**コミット履歴と CI が残るかどうか**が違います。

---

## 手順 0：公開前に直す 3 箇所（重要）

| # | ファイル | 変更内容 |
| --- | --- | --- |
| 1 | `LICENSE` | `Copyright (c) 2026 raika` → **あなたの名前／GitHub ハンドル** |
| 2 | `CHANGELOG.md` | `OWNER/REPO` → `あなたのユーザー名/リポジトリ名`（3箇所） |
| 3 | `CONTRIBUTING.md` | `OWNER/REPO` → `あなたのユーザー名/リポジトリ名`（2箇所） |

GitHub 上に自動生成されるリンクが `OWNER/REPO` のままになると、切れないリンクになります。

---

## 手順 1：GitHub でリポジトリを作る

**まず Private（非公開）で作成することを推奨します。**
公開前に CI の動作・README の表示・リンク切れを全部確認でき、確認後に
Settings → General → Danger Zone から Public に切り替えられます（履歴は消えません）。

1. <https://github.com/new> を開く
2. **Repository name**: `suno-lyric-sync`（または任意の名前。命名については「補足」参照）
3. **Private** を選択（確認後に Public に変更）
4. **Add a README file / .gitignore / license はすべてチェックしない**
   （既にローカルに存在するため。チェックすると push が衝突します）
5. **Create repository**

### Private 期間中に確認すること

- [ ] Actions タブで CI が緑になっていること（初回はモデルの DL で 10〜15 分）
- [ ] README が正しく描画され、スクリーンショット2枚が表示されていること
- [ ] 手順 0 の3箇所のプレースホルダを修正済みであること
- [ ] About 欄と Topics を設定したこと（→ 末尾の「補足」を参照）
- [ ] ファイル一覧に `node_modules` や歌詞データが入っていないこと

確認が完了したら **Settings → General → Danger Zone → Change repository visibility → Public** で公開します。

---

## 手順 2：ローカルから push する

### 2-A. HTTPS + 認証トークン（ブラウザでログインできない場合）

```bash
cd <このディレクトリ>

git remote add origin https://github.com/<あなたのユーザー名>/<リポジトリ名>.git
git push -u origin main
```

- ユーザー名: GitHub のログイン名
- パスワード: **GitHub のパスワードではなく Personal Access Token** を使います
  （Settings → Developer settings → Personal access tokens → Fine-grained token
    → 権限に `Contents: Read and write` を選択）

push 時にパスワードを問かれたら、GitHub のパスワードではなく上記のトークンを貼り付けします。

### 2-B. SSH キーを使う場合（一度設定すれば楽）

```bash
cd <このディレクトリ>

git remote add origin git@github.com:<あなたのユーザー名>/<リポジトリ名>.git
git push -u origin main
```

SSH 未設定の場合は GitHub の Settings → SSH and GPG keys で登録してください。

---

## 手順 3：push 後に確認する

1. **Actions** タブを開く → CI が自動走る（初回はモデルの DL で 10〜15 分）
2. リポジトリの README が正しく表示される（スクリーンショットが出る）
3. ソースコードが閲覧できる
4. ファイル数が 30 前後であることを確認（`node_modules` が混ざっていないか）

---

## 手順 4：リリースを切る（任意）

最初の公開 milestone として、タグとリリースを作ります。

```bash
cd <このディレクトリ>
git tag -a v0.1.0 -m "初回リリース: 歌詞同期・7形式書き出し"
git push origin v0.1.0
```

その後 GitHub の Releases → Draft a new release → v0.1.0 を選び、
Releases の説明に次を書いて公開します。

```markdown
Suno などの AI 生成音楽の歌詞を自動で同期し、MV 制作で使える字幕/歌詞ファイルを出力します。
サーバー不要・API キー不要・音声はブラウザ外に出ません。

実測: 日本語 3分20秒の曲で整列率 96.0%（medium / WebGPU）

詳細は README を参照してください。
```

---

## 手順 5：デモを公開する（任意）

> ⚠️ GitHub Pages は **プライベートリポジトリでは Free プランでは利用できません**
> （Pro / Team 以上、または公開後のリポジトリが必要）。公開後に設定してください。

公開リポジトリから動かせるデモがあると_);
、[GitHub Pages](https://pages.github.com/) を使うのが便利です。

Vite なのでビルド成果物（`dist/`）を Pages に配置するだけです。
ワークフローを追加する場合は `.github/workflows/deploy.yml` を作り、
`Settings → Pages → Source` を `GitHub Actions` に設定してください。
必要であれば作成します（声をかけてください）。

---

## 補足：コマンド一覧（コピペ用）

```bash
# --- リポジトリ作成（gh を使う場合：最短） ---
# gh が未インストールなら: https://cli.github.com/ を参照
gh auth login
gh repo create suno-lyric-sync --public --source=. --push --description "ブラウザ完結の歌詞同期ツール"

# --- Web で作成したリポジトリに push する場合 ---
cd <このディレクトリ>
git remote add origin https://github.com/<ユーザー名>/suno-lyric-sync.git
git push -u origin main

# --- 確認 ---
git remote -v
git log --oneline -1
```

---

## 補足：リポジトリの説明欄（About）と Topics

公開時（またはプライベート作成時）に設定しておくと、発見されやすくなります。

### About 欄（おすすめ）

```
Suno などのAI生成音楽の歌詞を自動同期。ブラウザだけで完結（サーバー・APIキー不要）で、単語レベルの時刻を推定し SRT/LRC/TTML を出力。
```

別案（スタイルが異なる場合）:

| 风格 | 文言 |
| --- | --- |
| 超短 | `ブラウザ完結のAI生成音楽 歌詞同期ツール。SRT / LRC / TTML 出力。` |
| MV 製作者向け | `Suno などのAI生成音楽の歌詞を自動同期し、MV制作で使えるSRT/歌詞ファイルを出力。ブラウザだけで完結し、音声は外部に送信されません。` |
| 技術寄り | `Whisper と forced alignment による歌詞同期。SRT / LRC / TTML / WebVTT を出力。全てブラウザ内で実行、サーバーもAPIキーも不要。` |
| 英語版 | `Word-level lyric sync for AI-generated music. Runs fully in your browser — no server, no API key. Exports SRT / LRC / TTML / WebVTT.` |

**構文は「What（何）→ How（どう）→ Output（何を出す）」の順。** About 欄は 2 行しか見えないので、
1 行目に「何ができるか」を置きます。

### Topics（最大20個）

リポジトリページ右上の ⚙ → Topics から追加します。

```
lyrics          lyric-sync       lrc             srt
ttml            vtt              karaoke         subtitles
whisper         forced-alignment transformers.js  onnx
webgpu          browser          local-first     privacy
suno            ai-music         music-video     japanese
```

### package.json / README 側の説明文

About 欄とは別に、ローカルのファイル側にも同じ内容を入れておきます。

| ファイル | フィールド |
| --- | --- |
| `package.json` | `description` |
| `README.md` | 冒頭のサブタイトル |
| `index.html` | `<meta name="description">` |


---

## 補足：機密情報を push しないこと

- **入力音声と歌詞テキストは公開リポジトリに含まれません**（`.gitignore` で除外済み）
  - `*.debug.json` / `*.lyrics.txt` / `test/fixtures/` / `out/` はすべて除外
 万が一、実データを push してしまった場合:
  ```bash
  # リポジトリを作り直して push し直す（履歴を完全に消す）
  rm -rf .git
  git init -b main
  git add -A
  git commit -m "Initial commit"
  ```
  既に push 済みの場合は、GitHub のリポジトリを削除してから作り直してください
  （GitHub のキャッシュには消えた後も残る可能性があります）

---

## 補足：Issue （※ 任意）

公開後はバグ報告や要望を Issue で受け付けられます。
`.debug.json`（音声ではなく認識ログのみ）を添えてもらえると
原因の特定が早くできます（LICENSE と NOTICE の「利用者側の責任」を参照）。