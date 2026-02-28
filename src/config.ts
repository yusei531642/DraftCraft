import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { type ExecutorMode } from "./executor";
import { type LlmConfig, type LlmProvider } from "./llm";

const providerSchema = z.enum(["ollama", "lmstudio", "openai", "anthropic"]);
const executorModeSchema = z.enum(["codex", "claude", "auto"]);
const maybeStringSchema = z.union([z.string(), z.null(), z.undefined()]);

const fileInputSchema = z.object({
  llm: z
    .object({
      provider: providerSchema.optional(),
      model: maybeStringSchema.optional(),
      ollamaBaseUrl: maybeStringSchema.optional(),
      lmstudioBaseUrl: maybeStringSchema.optional(),
      openaiBaseUrl: maybeStringSchema.optional(),
      openaiApiKey: maybeStringSchema.optional(),
      anthropicBaseUrl: maybeStringSchema.optional(),
      anthropicApiKey: maybeStringSchema.optional(),
    })
    .optional(),
  executor: z
    .object({
      mode: executorModeSchema.optional(),
      codexCommandTemplate: maybeStringSchema.optional(),
      claudeCommandTemplate: maybeStringSchema.optional(),
      workdir: maybeStringSchema.optional(),
      maxHistoryMessages: z.coerce.number().int().optional(),
    })
    .optional(),
  discord: z
    .object({
      botToken: maybeStringSchema.optional(),
      panelChannelId: maybeStringSchema.optional(),
      sessionCategoryId: maybeStringSchema.optional(),
    })
    .optional(),
});

export const CONFIG_FILE_NAME = "draftcraft.config.json";
export const CONFIG_PATH = path.resolve(process.cwd(), CONFIG_FILE_NAME);

type LlmConfigFile = {
  provider: LlmProvider;
  model: string;
  ollamaBaseUrl: string;
  lmstudioBaseUrl: string;
  openaiBaseUrl: string;
  openaiApiKey: string;
  anthropicBaseUrl: string;
  anthropicApiKey: string;
};

type ExecutorConfigFile = {
  mode: ExecutorMode;
  codexCommandTemplate: string;
  claudeCommandTemplate: string;
  workdir: string;
  maxHistoryMessages: number;
};

type DiscordConfigFile = {
  botToken: string;
  panelChannelId: string;
  sessionCategoryId: string;
};

export type DraftcraftConfigFile = {
  llm: LlmConfigFile;
  executor: ExecutorConfigFile;
  discord: DiscordConfigFile;
};

export type BaseConfig = {
  llm: LlmConfig;
  executorMode: ExecutorMode;
  codexCommandTemplate: string | null;
  claudeCommandTemplate: string | null;
  codexWorkdir: string;
  maxHistoryMessages: number;
  outputsDir: string;
};

export type DiscordConfig = BaseConfig & {
  discordBotToken: string;
  panelChannelId: string;
  sessionCategoryId: string;
};

function trimOrEmpty(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

function mergeWithDefaults(
  parsed: z.infer<typeof fileInputSchema>,
  cwd: string,
): DraftcraftConfigFile {
  return {
    llm: {
      provider: parsed.llm?.provider ?? "ollama",
      model: trimOrEmpty(parsed.llm?.model) || "llama3.1:8b",
      ollamaBaseUrl: trimOrEmpty(parsed.llm?.ollamaBaseUrl) || "http://127.0.0.1:11434",
      lmstudioBaseUrl: trimOrEmpty(parsed.llm?.lmstudioBaseUrl) || "http://127.0.0.1:1234/v1",
      openaiBaseUrl: trimOrEmpty(parsed.llm?.openaiBaseUrl) || "https://api.openai.com/v1",
      openaiApiKey: trimOrEmpty(parsed.llm?.openaiApiKey),
      anthropicBaseUrl: trimOrEmpty(parsed.llm?.anthropicBaseUrl) || "https://api.anthropic.com",
      anthropicApiKey: trimOrEmpty(parsed.llm?.anthropicApiKey),
    },
    executor: {
      mode: parsed.executor?.mode ?? "codex",
      codexCommandTemplate: trimOrEmpty(parsed.executor?.codexCommandTemplate),
      claudeCommandTemplate: trimOrEmpty(parsed.executor?.claudeCommandTemplate),
      workdir: trimOrEmpty(parsed.executor?.workdir) || cwd,
      maxHistoryMessages: parsed.executor?.maxHistoryMessages ?? 30,
    },
    discord: {
      botToken: trimOrEmpty(parsed.discord?.botToken),
      panelChannelId: trimOrEmpty(parsed.discord?.panelChannelId),
      sessionCategoryId: trimOrEmpty(parsed.discord?.sessionCategoryId),
    },
  };
}

function createDefaultConfig(cwd: string): DraftcraftConfigFile {
  return mergeWithDefaults({}, cwd);
}

function readRawConfigFile(configPath: string): unknown {
  const text = fs.readFileSync(configPath, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`設定ファイルのJSON解析に失敗しました: ${configPath}\n${message}`);
  }
}

function parseConfigFile(raw: unknown, cwd: string): DraftcraftConfigFile {
  const parsed = fileInputSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `設定ファイルが不正です:\n${parsed.error.issues
        .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
        .join("\n")}`,
    );
  }
  return mergeWithDefaults(parsed.data, cwd);
}

export function readConfigFile(configPath = CONFIG_PATH): DraftcraftConfigFile | null {
  if (!fs.existsSync(configPath)) {
    return null;
  }
  const cwd = path.dirname(configPath);
  const raw = readRawConfigFile(configPath);
  return parseConfigFile(raw, cwd);
}

export function writeConfigFile(config: DraftcraftConfigFile, configPath = CONFIG_PATH): void {
  const dir = path.dirname(configPath);
  fs.mkdirSync(dir, { recursive: true });
  const text = `${JSON.stringify(config, null, 2)}\n`;
  fs.writeFileSync(configPath, text, "utf8");
}

export function createDefaultConfigFile(cwd = process.cwd()): DraftcraftConfigFile {
  return createDefaultConfig(cwd);
}

function validateProviderRequirements(
  provider: LlmProvider,
  openaiApiKey: string | null,
  anthropicApiKey: string | null,
): void {
  if (provider === "openai" && !openaiApiKey) {
    throw new Error("LLM_PROVIDER=openai には OPENAI_API_KEY が必要です。");
  }
  if (provider === "anthropic" && !anthropicApiKey) {
    throw new Error("LLM_PROVIDER=anthropic には ANTHROPIC_API_KEY が必要です。");
  }
}

function resolveBaseConfig(): BaseConfig {
  const file = readConfigFile();
  if (!file) {
    throw new Error(`設定ファイルが見つかりません: ${CONFIG_PATH}`);
  }

  const codexWorkdir = path.resolve(file.executor.workdir);
  if (!fs.existsSync(codexWorkdir) || !fs.statSync(codexWorkdir).isDirectory()) {
    throw new Error(`CODEX_WORKDIR が存在しないディレクトリです: ${codexWorkdir}`);
  }

  const outputsDir = path.resolve(process.cwd(), "outputs");
  fs.mkdirSync(outputsDir, { recursive: true });

  const model = file.llm.model.trim();
  if (!model) {
    throw new Error("llm.model が必要です。");
  }

  const openaiApiKey = file.llm.openaiApiKey || null;
  const anthropicApiKey = file.llm.anthropicApiKey || null;
  validateProviderRequirements(file.llm.provider, openaiApiKey, anthropicApiKey);

  const codexCommandTemplate = file.executor.codexCommandTemplate || null;
  const claudeCommandTemplate = file.executor.claudeCommandTemplate || null;
  if (!codexCommandTemplate && !claudeCommandTemplate) {
    throw new Error("CODEX_COMMAND_TEMPLATE または CLAUDE_COMMAND_TEMPLATE のどちらかは必須です。");
  }
  if (file.executor.mode === "codex" && !codexCommandTemplate) {
    throw new Error("EXECUTOR_MODE=codex には CODEX_COMMAND_TEMPLATE が必要です。");
  }
  if (file.executor.mode === "claude" && !claudeCommandTemplate) {
    throw new Error("EXECUTOR_MODE=claude には CLAUDE_COMMAND_TEMPLATE が必要です。");
  }

  const maxHistoryMessages = z.coerce
    .number()
    .int()
    .min(10)
    .max(200)
    .parse(file.executor.maxHistoryMessages);

  return {
    llm: {
      provider: file.llm.provider,
      model,
      ollamaBaseUrl: file.llm.ollamaBaseUrl,
      lmstudioBaseUrl: file.llm.lmstudioBaseUrl,
      openaiBaseUrl: file.llm.openaiBaseUrl,
      openaiApiKey,
      anthropicBaseUrl: file.llm.anthropicBaseUrl,
      anthropicApiKey,
    },
    executorMode: file.executor.mode,
    codexCommandTemplate,
    claudeCommandTemplate,
    codexWorkdir,
    maxHistoryMessages,
    outputsDir,
  };
}

export function loadCliConfig(): BaseConfig {
  return resolveBaseConfig();
}

export function loadDiscordConfig(): DiscordConfig {
  const base = resolveBaseConfig();
  const file = readConfigFile();
  if (!file) {
    throw new Error(`設定ファイルが見つかりません: ${CONFIG_PATH}`);
  }

  const botToken = file.discord.botToken.trim();
  const panelChannelId = file.discord.panelChannelId.trim();
  const sessionCategoryId = file.discord.sessionCategoryId.trim();
  if (!botToken || !panelChannelId || !sessionCategoryId) {
    throw new Error(
      "Discord設定が不足しています。draftcraft.config.json の discord.botToken / panelChannelId / sessionCategoryId を設定してください。",
    );
  }

  return {
    ...base,
    discordBotToken: botToken,
    panelChannelId,
    sessionCategoryId,
  };
}
