import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadCliConfig } from "./config";
import { type ExecutorMode } from "./executor";
import { type LlmProvider } from "./llm";

const ENV_PATH = path.resolve(process.cwd(), ".env");

type SetupResult = {
  provider: LlmProvider;
  model: string;
  ollamaBaseUrl: string;
  lmstudioBaseUrl: string;
  openaiBaseUrl: string;
  openaiApiKey: string;
  anthropicBaseUrl: string;
  anthropicApiKey: string;
  executorMode: ExecutorMode;
  codexCommandTemplate: string;
  claudeCommandTemplate: string;
  codexWorkdir: string;
  maxHistoryMessages: number;
};

function parseEnvFile(content: string): Map<string, string> {
  const map = new Map<string, string>();
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    map.set(key, value);
  }
  return map;
}

function askProviderDefaultModel(provider: LlmProvider): string {
  if (provider === "ollama") return "llama3.1:8b";
  if (provider === "lmstudio") return "qwen2.5-7b-instruct";
  if (provider === "openai") return "gpt-4.1-mini";
  return "claude-3-5-sonnet-latest";
}

function parseExecutorMode(raw: string): ExecutorMode | null {
  if (raw === "codex" || raw === "claude" || raw === "auto") {
    return raw;
  }
  return null;
}

async function askWithDefault(
  rl: readline.Interface,
  question: string,
  defaultValue: string,
): Promise<string> {
  const value = (await rl.question(`${question} [${defaultValue}]: `)).trim();
  return value || defaultValue;
}

async function askSecret(
  rl: readline.Interface,
  question: string,
  defaultValue = "",
): Promise<string> {
  const label = defaultValue ? `${question} [入力省略で既存値を維持]: ` : `${question}: `;
  const value = (await rl.question(label)).trim();
  if (!value && defaultValue) {
    return defaultValue;
  }
  return value;
}

async function askProvider(rl: readline.Interface, current: LlmProvider): Promise<LlmProvider> {
  output.write("\n利用するLLMプロバイダを選択してください:\n");
  output.write("  1. Ollama\n");
  output.write("  2. LM Studio (OpenAI互換API)\n");
  output.write("  3. OpenAI API\n");
  output.write("  4. Anthropic API\n");
  const currentMap: Record<LlmProvider, string> = {
    ollama: "1",
    lmstudio: "2",
    openai: "3",
    anthropic: "4",
  };
  const selected = await askWithDefault(rl, "番号を入力", currentMap[current]);
  if (selected === "1") return "ollama";
  if (selected === "2") return "lmstudio";
  if (selected === "3") return "openai";
  if (selected === "4") return "anthropic";
  output.write("不正な入力です。Ollama を選択します。\n");
  return "ollama";
}

function toEnvValue(value: string): string {
  return value.replace(/\r?\n/g, " ").trim();
}

function applyEnv(entries: Record<string, string>): void {
  for (const [key, value] of Object.entries(entries)) {
    process.env[key] = value;
  }
}

function buildEnvText(existing: Map<string, string>, next: SetupResult): string {
  const knownKeys = new Set<string>([
    "LLM_PROVIDER",
    "LLM_MODEL",
    "OLLAMA_BASE_URL",
    "LMSTUDIO_BASE_URL",
    "OPENAI_BASE_URL",
    "OPENAI_API_KEY",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_API_KEY",
    "EXECUTOR_MODE",
    "CODEX_COMMAND_TEMPLATE",
    "CLAUDE_COMMAND_TEMPLATE",
    "CODEX_WORKDIR",
    "MAX_HISTORY_MESSAGES",
  ]);

  const lines: string[] = [];
  lines.push("# LLMDraft settings");
  lines.push(`LLM_PROVIDER=${toEnvValue(next.provider)}`);
  lines.push(`LLM_MODEL=${toEnvValue(next.model)}`);
  lines.push(`OLLAMA_BASE_URL=${toEnvValue(next.ollamaBaseUrl)}`);
  lines.push(`LMSTUDIO_BASE_URL=${toEnvValue(next.lmstudioBaseUrl)}`);
  lines.push(`OPENAI_BASE_URL=${toEnvValue(next.openaiBaseUrl)}`);
  lines.push(`OPENAI_API_KEY=${toEnvValue(next.openaiApiKey)}`);
  lines.push(`ANTHROPIC_BASE_URL=${toEnvValue(next.anthropicBaseUrl)}`);
  lines.push(`ANTHROPIC_API_KEY=${toEnvValue(next.anthropicApiKey)}`);
  lines.push(`EXECUTOR_MODE=${toEnvValue(next.executorMode)}`);
  lines.push(`CODEX_COMMAND_TEMPLATE=${toEnvValue(next.codexCommandTemplate)}`);
  lines.push(`CLAUDE_COMMAND_TEMPLATE=${toEnvValue(next.claudeCommandTemplate)}`);
  lines.push(`CODEX_WORKDIR=${toEnvValue(next.codexWorkdir)}`);
  lines.push(`MAX_HISTORY_MESSAGES=${next.maxHistoryMessages}`);

  const discordKeys = ["DISCORD_BOT_TOKEN", "PANEL_CHANNEL_ID", "SESSION_CATEGORY_ID"];
  const hasAnyDiscord = discordKeys.some((key) => existing.has(key));
  lines.push("");
  lines.push("# Discord (optional)");
  if (hasAnyDiscord) {
    for (const key of discordKeys) {
      const value = existing.get(key) ?? "";
      lines.push(`${key}=${toEnvValue(value)}`);
    }
  } else {
    lines.push("DISCORD_BOT_TOKEN=");
    lines.push("PANEL_CHANNEL_ID=");
    lines.push("SESSION_CATEGORY_ID=");
  }

  const rest = [...existing.entries()]
    .filter(([key]) => !knownKeys.has(key) && !discordKeys.includes(key))
    .sort(([a], [b]) => a.localeCompare(b));
  if (rest.length > 0) {
    lines.push("");
    lines.push("# Existing custom keys");
    for (const [key, value] of rest) {
      lines.push(`${key}=${toEnvValue(value)}`);
    }
  }

  return `${lines.join("\n")}\n`;
}

async function runSetup(): Promise<void> {
  const existing = fs.existsSync(ENV_PATH)
    ? parseEnvFile(fs.readFileSync(ENV_PATH, "utf8"))
    : new Map<string, string>();
  const rl = readline.createInterface({ input, output, terminal: true });

  try {
    output.write("\n=== LLMDraft Setup ===\n");
    output.write("初回セットアップを開始します。\n");

    const currentProvider = (existing.get("LLM_PROVIDER") as LlmProvider | undefined) ?? "ollama";
    const provider = await askProvider(rl, currentProvider);
    const model = await askWithDefault(
      rl,
      "モデル名",
      existing.get("LLM_MODEL") ?? askProviderDefaultModel(provider),
    );

    const ollamaBaseUrl = await askWithDefault(
      rl,
      "Ollama Base URL",
      existing.get("OLLAMA_BASE_URL") ?? "http://127.0.0.1:11434",
    );
    const lmstudioBaseUrl = await askWithDefault(
      rl,
      "LM Studio Base URL",
      existing.get("LMSTUDIO_BASE_URL") ?? "http://127.0.0.1:1234/v1",
    );
    const openaiBaseUrl = await askWithDefault(
      rl,
      "OpenAI Base URL",
      existing.get("OPENAI_BASE_URL") ?? "https://api.openai.com/v1",
    );
    const anthropicBaseUrl = await askWithDefault(
      rl,
      "Anthropic Base URL",
      existing.get("ANTHROPIC_BASE_URL") ?? "https://api.anthropic.com",
    );

    const openaiApiKey = await askSecret(
      rl,
      "OPENAI_API_KEY",
      existing.get("OPENAI_API_KEY") ?? "",
    );
    const anthropicApiKey = await askSecret(
      rl,
      "ANTHROPIC_API_KEY",
      existing.get("ANTHROPIC_API_KEY") ?? "",
    );

    const modeRaw = await askWithDefault(
      rl,
      "実行モード (codex/claude/auto)",
      existing.get("EXECUTOR_MODE") ?? "auto",
    );
    const parsedMode = parseExecutorMode(modeRaw.toLowerCase());
    const executorMode = parsedMode ?? "auto";

    const codexCommandTemplate = await askWithDefault(
      rl,
      "CODEX_COMMAND_TEMPLATE",
      existing.get("CODEX_COMMAND_TEMPLATE") ?? "codex",
    );
    const claudeCommandTemplate = await askWithDefault(
      rl,
      "CLAUDE_COMMAND_TEMPLATE",
      existing.get("CLAUDE_COMMAND_TEMPLATE") ?? "claude",
    );
    const codexWorkdir = await askWithDefault(
      rl,
      "CODEX_WORKDIR",
      existing.get("CODEX_WORKDIR") ?? process.cwd(),
    );
    const maxHistoryRaw = await askWithDefault(
      rl,
      "MAX_HISTORY_MESSAGES",
      existing.get("MAX_HISTORY_MESSAGES") ?? "30",
    );
    const parsedHistory = Number(maxHistoryRaw);
    const maxHistoryMessages =
      Number.isInteger(parsedHistory) && parsedHistory >= 10 && parsedHistory <= 200
        ? parsedHistory
        : 30;

    const result: SetupResult = {
      provider,
      model,
      ollamaBaseUrl,
      lmstudioBaseUrl,
      openaiBaseUrl,
      openaiApiKey,
      anthropicBaseUrl,
      anthropicApiKey,
      executorMode,
      codexCommandTemplate,
      claudeCommandTemplate,
      codexWorkdir,
      maxHistoryMessages,
    };

    const confirm = (await rl.question("この設定で保存しますか？ (Y/n): ")).trim().toLowerCase();
    if (confirm === "n") {
      throw new Error("セットアップをキャンセルしました。");
    }

    const text = buildEnvText(existing, result);
    fs.writeFileSync(ENV_PATH, text, "utf8");
    applyEnv({
      LLM_PROVIDER: result.provider,
      LLM_MODEL: result.model,
      OLLAMA_BASE_URL: result.ollamaBaseUrl,
      LMSTUDIO_BASE_URL: result.lmstudioBaseUrl,
      OPENAI_BASE_URL: result.openaiBaseUrl,
      OPENAI_API_KEY: result.openaiApiKey,
      ANTHROPIC_BASE_URL: result.anthropicBaseUrl,
      ANTHROPIC_API_KEY: result.anthropicApiKey,
      EXECUTOR_MODE: result.executorMode,
      CODEX_COMMAND_TEMPLATE: result.codexCommandTemplate,
      CLAUDE_COMMAND_TEMPLATE: result.claudeCommandTemplate,
      CODEX_WORKDIR: result.codexWorkdir,
      MAX_HISTORY_MESSAGES: String(result.maxHistoryMessages),
    });

    output.write(`\n保存しました: ${ENV_PATH}\n\n`);
  } finally {
    rl.close();
  }
}

export async function ensureCliSetup(): Promise<void> {
  const hasInlineConfig =
    !!process.env.LLM_MODEL &&
    (!!process.env.CODEX_COMMAND_TEMPLATE || !!process.env.CLAUDE_COMMAND_TEMPLATE);

  if (!fs.existsSync(ENV_PATH)) {
    if (hasInlineConfig) {
      return;
    }
    await runSetup();
    return;
  }

  try {
    loadCliConfig();
  } catch (error) {
    const message = error instanceof Error ? error.message : "不明な設定エラーです。";
    output.write(`\n設定エラーを検出しました。Setupを開始します。\n${message}\n`);
    await runSetup();
  }
}
