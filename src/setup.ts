import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  CONFIG_PATH,
  createDefaultConfigFile,
  loadCliConfig,
  readConfigFile,
  type DraftcraftConfigFile,
  writeConfigFile,
} from "./config";
import { type ExecutorMode } from "./executor";
import { type LlmProvider } from "./llm";

const LEGACY_ENV_PATH = path.resolve(process.cwd(), ".env");

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

function pickLegacy(map: Map<string, string>, key: string): string {
  return (map.get(key) ?? "").trim();
}

function loadDefaultsFromLegacyEnv(base: DraftcraftConfigFile): DraftcraftConfigFile {
  if (!fs.existsSync(LEGACY_ENV_PATH)) {
    return base;
  }
  const env = parseEnvFile(fs.readFileSync(LEGACY_ENV_PATH, "utf8"));
  return {
    llm: {
      provider: (pickLegacy(env, "LLM_PROVIDER") as LlmProvider) || base.llm.provider,
      model: pickLegacy(env, "LLM_MODEL") || pickLegacy(env, "OLLAMA_MODEL") || base.llm.model,
      ollamaBaseUrl: pickLegacy(env, "OLLAMA_BASE_URL") || base.llm.ollamaBaseUrl,
      lmstudioBaseUrl: pickLegacy(env, "LMSTUDIO_BASE_URL") || base.llm.lmstudioBaseUrl,
      openaiBaseUrl: pickLegacy(env, "OPENAI_BASE_URL") || base.llm.openaiBaseUrl,
      openaiApiKey: pickLegacy(env, "OPENAI_API_KEY") || base.llm.openaiApiKey,
      anthropicBaseUrl: pickLegacy(env, "ANTHROPIC_BASE_URL") || base.llm.anthropicBaseUrl,
      anthropicApiKey: pickLegacy(env, "ANTHROPIC_API_KEY") || base.llm.anthropicApiKey,
    },
    executor: {
      mode: (pickLegacy(env, "EXECUTOR_MODE") as ExecutorMode) || base.executor.mode,
      codexCommandTemplate:
        pickLegacy(env, "CODEX_COMMAND_TEMPLATE") || base.executor.codexCommandTemplate,
      claudeCommandTemplate:
        pickLegacy(env, "CLAUDE_COMMAND_TEMPLATE") || base.executor.claudeCommandTemplate,
      workdir: pickLegacy(env, "CODEX_WORKDIR") || base.executor.workdir,
      maxHistoryMessages:
        Number.parseInt(pickLegacy(env, "MAX_HISTORY_MESSAGES"), 10) ||
        base.executor.maxHistoryMessages,
    },
    discord: {
      botToken: pickLegacy(env, "DISCORD_BOT_TOKEN") || base.discord.botToken,
      panelChannelId: pickLegacy(env, "PANEL_CHANNEL_ID") || base.discord.panelChannelId,
      sessionCategoryId: pickLegacy(env, "SESSION_CATEGORY_ID") || base.discord.sessionCategoryId,
    },
  };
}

function loadSetupDefaults(): DraftcraftConfigFile {
  const existing = readConfigFile();
  if (existing) {
    return existing;
  }
  return loadDefaultsFromLegacyEnv(createDefaultConfigFile(process.cwd()));
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

async function runSetup(): Promise<void> {
  const defaults = loadSetupDefaults();
  const rl = readline.createInterface({ input, output, terminal: true });

  try {
    output.write("\n=== LLMDraft Setup ===\n");
    output.write("初回セットアップを開始します。\n");
    output.write(`保存先: ${CONFIG_PATH}\n`);

    const provider = await askProvider(rl, defaults.llm.provider);
    const model = await askWithDefault(
      rl,
      "モデル名",
      defaults.llm.model || askProviderDefaultModel(provider),
    );

    const ollamaBaseUrl = await askWithDefault(rl, "Ollama Base URL", defaults.llm.ollamaBaseUrl);
    const lmstudioBaseUrl = await askWithDefault(
      rl,
      "LM Studio Base URL",
      defaults.llm.lmstudioBaseUrl,
    );
    const openaiBaseUrl = await askWithDefault(rl, "OpenAI Base URL", defaults.llm.openaiBaseUrl);
    const anthropicBaseUrl = await askWithDefault(
      rl,
      "Anthropic Base URL",
      defaults.llm.anthropicBaseUrl,
    );

    const openaiApiKey = await askSecret(rl, "OPENAI_API_KEY", defaults.llm.openaiApiKey);
    const anthropicApiKey = await askSecret(rl, "ANTHROPIC_API_KEY", defaults.llm.anthropicApiKey);

    const modeRaw = await askWithDefault(
      rl,
      "実行モード (codex/claude/auto)",
      defaults.executor.mode,
    );
    const executorMode = parseExecutorMode(modeRaw.toLowerCase()) ?? defaults.executor.mode;

    const codexCommandTemplate = await askWithDefault(
      rl,
      "CODEX_COMMAND_TEMPLATE",
      defaults.executor.codexCommandTemplate || "codex",
    );
    const claudeCommandTemplate = await askWithDefault(
      rl,
      "CLAUDE_COMMAND_TEMPLATE",
      defaults.executor.claudeCommandTemplate || "claude",
    );
    const codexWorkdir = await askWithDefault(rl, "CODEX_WORKDIR", defaults.executor.workdir);
    const maxHistoryRaw = await askWithDefault(
      rl,
      "MAX_HISTORY_MESSAGES",
      String(defaults.executor.maxHistoryMessages),
    );
    const parsedHistory = Number.parseInt(maxHistoryRaw, 10);
    const maxHistoryMessages =
      Number.isInteger(parsedHistory) && parsedHistory >= 10 && parsedHistory <= 200
        ? parsedHistory
        : defaults.executor.maxHistoryMessages;

    const result: DraftcraftConfigFile = {
      llm: {
        provider,
        model,
        ollamaBaseUrl,
        lmstudioBaseUrl,
        openaiBaseUrl,
        openaiApiKey,
        anthropicBaseUrl,
        anthropicApiKey,
      },
      executor: {
        mode: executorMode,
        codexCommandTemplate,
        claudeCommandTemplate,
        workdir: codexWorkdir,
        maxHistoryMessages,
      },
      discord: defaults.discord,
    };

    const confirm = (await rl.question("この設定で保存しますか？ (Y/n): ")).trim().toLowerCase();
    if (confirm === "n") {
      throw new Error("セットアップをキャンセルしました。");
    }

    writeConfigFile(result);
    output.write(`\n保存しました: ${CONFIG_PATH}\n\n`);
  } finally {
    rl.close();
  }
}

function migrateLegacyEnvToJson(): boolean {
  if (fs.existsSync(CONFIG_PATH) || !fs.existsSync(LEGACY_ENV_PATH)) {
    return false;
  }

  const migrated = loadDefaultsFromLegacyEnv(createDefaultConfigFile(process.cwd()));
  writeConfigFile(migrated);
  output.write(`\n旧設定 .env を検出したため ${CONFIG_PATH} へ移行しました。\n`);
  return true;
}

export async function ensureCliSetup(): Promise<void> {
  if (!fs.existsSync(CONFIG_PATH)) {
    if (migrateLegacyEnvToJson()) {
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
