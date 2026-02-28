# DraftCraft

`LLMdraft CLI` をメインに、LLMとの対話で指示文を作り、最終的にCodexCLIまたはClaude Codeを実行するツールです。  
Discord連携はサブ機能として利用できます。

## メイン機能（CLI）

- 起動時に `LLMdraft` のAAアートを表示
- Gemini CLI / Claude Code 風の対話フローでチャット
- 初回起動時は自動で `Setup` ウィザードを開始
- LLMプロバイダを選択可能:
  - Ollama
  - LM Studio（OpenAI互換API）
  - OpenAI API
  - Anthropic API
- 会話履歴から最終指示文を統合し `outputs/prompts` に保存
- `node-pty` 経由でCodexCLI/Claude CodeをPTY実行
- `EXECUTOR_MODE=auto` では、選択中LLMが会話履歴を見て実行器を自動選択
- 実行結果を初心者向けのやさしい説明で自動要約
- 会話中に `[プロジェクト名]` を書くと、実行器に確認して理解メモを自動反映
- 実行ログを `outputs/logs` に保存

## サブ機能（Discord）

- 設定済みチャンネルに、Embed + ボタンの開始パネルを自動投稿
- ボタン押下で、ユーザー専用の作業チャンネルをカテゴリ配下に作成
- 作業チャンネル内で設定済みLLMと対話
- `/engine` `/reset` `/finalize` `/close` のアプリコマンドに対応
- `/finalize` またはボタンで選択済み実行器を起動し、ANSI除去済みログをDiscordへ逐次投稿
- 実行完了時に、初心者向けのやさしい説明を自動投稿
- 会話中に `[プロジェクト名]` を書くと、実行器へ確認してから会話を継続

## 必要環境

- Node.js 20+
- 利用するLLMプロバイダ（Ollama / LM Studio / OpenAI API / Anthropic API）
- CodexCLI もしくは Claude Code（テンプレートコマンドで実行可能な状態）
- Discord連携を使う場合のみ Discord Bot Token

## セットアップ

```bash
npm install
copy .env.example .env
```

`.env` を編集してください（CLI初回起動時のSetupでも生成できます）。

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

# Executor mode: codex | claude | auto
EXECUTOR_MODE=auto
CODEX_COMMAND_TEMPLATE=codex
CLAUDE_COMMAND_TEMPLATE=claude
CODEX_WORKDIR=D:/program/creativebot
MAX_HISTORY_MESSAGES=30

# Discord連携を使う場合のみ必須
DISCORD_BOT_TOKEN=your_discord_bot_token
PANEL_CHANNEL_ID=123456789012345678
SESSION_CATEGORY_ID=123456789012345678
```

## 実行器設定

- `EXECUTOR_MODE`: `codex` / `claude` / `auto`
- `CODEX_COMMAND_TEMPLATE`: CodexCLI用コマンド
- `CLAUDE_COMMAND_TEMPLATE`: Claude Code用コマンド

## LLMプロバイダ設定

- `LLM_PROVIDER`: `ollama` / `lmstudio` / `openai` / `anthropic`
- `LLM_MODEL`: 利用モデル名
- `OLLAMA_BASE_URL`: Ollama API URL
- `LMSTUDIO_BASE_URL`: LM Studio API URL（OpenAI互換）
- `OPENAI_BASE_URL` / `OPENAI_API_KEY`: OpenAI設定
- `ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY`: Anthropic設定

各テンプレートは最終確定時にそのまま実行され、以下のプレースホルダを使用できます。

- `{PROMPT_FILE}`: 生成された最終指示文ファイルパス
- `{CHANNEL_ID}`: セッションチャンネルID（CLIでは `cli-session`）
- `{OWNER_ID}`: セッション作成者ID（CLIでは `cli-user`）
- `{WORKDIR}`: `CODEX_WORKDIR`

実行時に環境変数も渡します。

- `DRAFTCRAFT_PROMPT`
- `DRAFTCRAFT_PROMPT_FILE`
- `DRAFTCRAFT_OWNER_ID`
- `DRAFTCRAFT_CHANNEL_ID`
- `DRAFTCRAFT_WORKDIR`

例:

```env
EXECUTOR_MODE=auto
CODEX_COMMAND_TEMPLATE=codex --prompt-file "{PROMPT_FILE}"
CLAUDE_COMMAND_TEMPLATE=claude --prompt-file "{PROMPT_FILE}"
```

## 起動

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

## CLIコマンド

- `?` ショートカット表示
- `/help` ヘルプ表示
- `/engine` 実行モード表示
- `/engine codex|claude|auto` 実行モード変更
- `/thinking` Thinkingレベル切替
- `/reset` 会話履歴を初期化
- `/finalize` 最終指示文を生成して保存
- `/run` 最終指示文を生成して実行器起動
- `/exit` 終了
