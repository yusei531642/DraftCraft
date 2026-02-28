# DraftCraft

LLMDraft CLIを中心に、要件整理から実行までを一気通貫で支援するツールです。  
「AIに実装を頼みたいが、指示文づくりが難しい」人向けに、会話しながら指示文を整えて実行できます。

## 概要

- メイン: ローカルCLI（LLMDraft UI）
- サブ: Discord連携（ボタンで専用チャンネル作成）
- LLM: Ollama / LM Studio / OpenAI / Anthropic
- 実行器: CodexCLI / Claude Code / 自動選択

## できること

- 会話から最終指示文を自動生成
- CodexCLI / Claude Code をPTY上で実行
- 実行ログを保存し、初心者向けのやさしい説明を自動生成
- `[プロジェクト名]` 指定時に、実行器へ確認して理解メモを作成してから会話継続
- Discordで複数人向けの運用（スレッド代わりの専用チャンネル）

## 画面イメージ（CLI）

- ヘッダー + 区切り線 + 入力枠 + ステータスライン
- `/` 入力時は候補表示、Tab補完対応
- `?` 単体でショートカット一覧表示

## 必要環境

- Node.js 20以上
- 実行器（どちらか）
  - CodexCLI
  - Claude Code
- LLMプロバイダ（いずれか）
  - Ollama
  - LM Studio（OpenAI互換）
  - OpenAI API
  - Anthropic API
- Discord連携を使う場合のみ:
  - Discord Bot Token
  - 連携先のチャンネル/カテゴリID

## クイックスタート

```bash
npm install
npm run start
```

初回起動時は自動でSetupが始まり、`.env` を生成します。  
手動で設定したい場合は `.env.example` をコピーして編集してください。

## インストール（CLI配布）

グローバルインストール:

```bash
npm i -g draftcraft
llmcraft
```

`npx` で単発実行:

```bash
npx draftcraft
```

## 起動方法

CLI（メイン）:

```bash
npm run dev
# または
npm run start
```

Discord Bot（サブ）:

```bash
npm run dev:bot
# または
npm run start:bot
```

## 環境変数

主要設定（`.env`）:

```env
# LLM provider: ollama | lmstudio | openai | anthropic
LLM_PROVIDER=ollama
LLM_MODEL=llama3.1:8b
OLLAMA_BASE_URL=http://127.0.0.1:11434
LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_API_KEY=

# Executor: codex | claude | auto
EXECUTOR_MODE=auto
CODEX_COMMAND_TEMPLATE=codex
CLAUDE_COMMAND_TEMPLATE=claude
CODEX_WORKDIR=D:/program/creativebot
MAX_HISTORY_MESSAGES=30

# Discord (optional)
DISCORD_BOT_TOKEN=
PANEL_CHANNEL_ID=
SESSION_CATEGORY_ID=
```

## 実行テンプレート仕様

`CODEX_COMMAND_TEMPLATE` / `CLAUDE_COMMAND_TEMPLATE` はそのまま実行されます。  
以下のプレースホルダを利用できます。

- `{PROMPT_FILE}`: 生成プロンプトファイル
- `{CHANNEL_ID}`: セッションID（CLIでは `cli-session`）
- `{OWNER_ID}`: ユーザーID（CLIでは `cli-user`）
- `{WORKDIR}`: `CODEX_WORKDIR`

実行時に渡される環境変数:

- `DRAFTCRAFT_PROMPT`
- `DRAFTCRAFT_PROMPT_FILE`
- `DRAFTCRAFT_OWNER_ID`
- `DRAFTCRAFT_CHANNEL_ID`
- `DRAFTCRAFT_WORKDIR`

## CLIコマンド

- `?` ショートカット表示
- `/help` ヘルプ
- `/engine` 実行モード表示
- `/engine codex|claude|auto` 実行モード変更
- `/autorun` 自動裏実行の状態表示
- `/autorun on|off` 自動裏実行の切替
- `/thinking` Thinkingレベル切替
- `/reset` 会話履歴初期化
- `/finalize` 最終指示文を生成して保存
- `/run` 最終指示文を生成して実行
- `/exit` 終了

## Discordコマンド

- `/engine`
- `/reset`
- `/finalize`
- `/close`

## 出力先

- `outputs/prompts/`: 生成された指示文
- `outputs/logs/`: 実行ログ
- `outputs/project-probe-prompts/`: プロジェクト理解用の調査プロンプト

## トラブルシューティング

- LLM接続エラー:
  - `LLM_PROVIDER` と各Base URL / API Keyを確認
- 実行器起動エラー:
  - `CODEX_COMMAND_TEMPLATE` または `CLAUDE_COMMAND_TEMPLATE` のコマンド単体実行を確認
- Discordコマンドが出ない:
  - Botを再起動し、権限（`applications.commands`）を確認

## セキュリティ注意

- `.env` は絶対に公開しないでください
- APIキーは漏えい時にすぐローテーションしてください
- 公開時は `outputs/` のログに秘密情報が含まれていないか確認してください

## ライセンス

このプロジェクトは [MIT License](./LICENSE) で公開しています。
