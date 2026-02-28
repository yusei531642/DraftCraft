# DraftCraft

Discordのボタン操作で専用チャンネルを作成し、Ollamaと会話しながらCodexCLI向けの指示文を仕上げ、最終確定時にCodexCLIを実行するツールです。

## 機能

- 設定済みチャンネルに、Embed + ボタンの開始パネルを自動投稿
- ボタン押下で、ユーザー専用の作業チャンネルをカテゴリ配下に作成
- 作業チャンネル内でOllamaと対話して指示文をブラッシュアップ
- `最終確定してCodexCLI実行` ボタンまたは `!finalize` で:
  - 会話履歴から最終指示文を生成
  - `outputs/prompts` に保存
  - CodexCLIコマンドをバックグラウンド実行
  - 実行ログを `outputs/logs` に保存

## 必要環境

- Node.js 20+
- Discord Bot Token
- Ollama（ローカルまたは接続可能なサーバー）
- CodexCLI（`CODEX_COMMAND_TEMPLATE` で実行可能な状態）

## セットアップ

```bash
npm install
copy .env.example .env
```

`.env` を編集してください。

```env
DISCORD_BOT_TOKEN=your_discord_bot_token
PANEL_CHANNEL_ID=123456789012345678
SESSION_CATEGORY_ID=123456789012345678
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=llama3.1:8b
CODEX_COMMAND_TEMPLATE=codex
CODEX_WORKDIR=D:/program/creativebot
MAX_HISTORY_MESSAGES=30
```

## `CODEX_COMMAND_TEMPLATE` の使い方

`CODEX_COMMAND_TEMPLATE` は最終確定時にそのまま実行されます。以下のプレースホルダを使用できます。

- `{PROMPT_FILE}`: 生成された最終指示文ファイルパス
- `{CHANNEL_ID}`: セッションチャンネルID
- `{OWNER_ID}`: セッション作成者のユーザーID
- `{WORKDIR}`: `CODEX_WORKDIR`

また実行時に環境変数も渡します。

- `DRAFTCRAFT_PROMPT`
- `DRAFTCRAFT_PROMPT_FILE`
- `DRAFTCRAFT_OWNER_ID`
- `DRAFTCRAFT_CHANNEL_ID`
- `DRAFTCRAFT_WORKDIR`

例:

```env
CODEX_COMMAND_TEMPLATE=codex --prompt-file "{PROMPT_FILE}"
```

## 起動

開発モード:

```bash
npm run dev
```

本番ビルド:

```bash
npm run build
npm run start
```

## セッション操作

作業チャンネル内で使えるコマンド:

- `!reset` 会話履歴を初期化
- `!finalize` 最終確定してCodexCLI実行
- `!close` チャンネルを削除
