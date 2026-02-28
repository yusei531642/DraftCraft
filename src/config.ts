import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { type ExecutorMode } from "./executor";
import { type LlmConfig, type LlmProvider } from "./llm";

const baseSchema = z.object({
  LLM_PROVIDER: z.enum(["ollama", "lmstudio", "openai", "anthropic"]).default("ollama"),
  LLM_MODEL: z.string().trim().min(1).optional(),
  OLLAMA_BASE_URL: z.string().url().default("http://127.0.0.1:11434"),
  OLLAMA_MODEL: z.string().trim().min(1).optional(),
  LMSTUDIO_BASE_URL: z.string().url().default("http://127.0.0.1:1234/v1"),
  OPENAI_BASE_URL: z.string().url().default("https://api.openai.com/v1"),
  OPENAI_API_KEY: z.string().trim().min(1).optional(),
  ANTHROPIC_BASE_URL: z.string().url().default("https://api.anthropic.com"),
  ANTHROPIC_API_KEY: z.string().trim().min(1).optional(),
  EXECUTOR_MODE: z.enum(["codex", "claude", "auto"]).default("codex"),
  CODEX_COMMAND_TEMPLATE: z.string().trim().min(1).optional(),
  CLAUDE_COMMAND_TEMPLATE: z.string().trim().min(1).optional(),
  CODEX_WORKDIR: z.string().default(process.cwd()),
  MAX_HISTORY_MESSAGES: z.coerce.number().int().min(10).max(200).default(30),
});

const discordSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  PANEL_CHANNEL_ID: z.string().min(1),
  SESSION_CATEGORY_ID: z.string().min(1),
});

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
  const parsed = baseSchema.safeParse(process.env);

  if (!parsed.success) {
    throw new Error(
      `環境変数が不足/不正です:\n${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n")}`,
    );
  }

  const codexWorkdir = path.resolve(parsed.data.CODEX_WORKDIR);
  if (!fs.existsSync(codexWorkdir) || !fs.statSync(codexWorkdir).isDirectory()) {
    throw new Error(`CODEX_WORKDIR が存在しないディレクトリです: ${codexWorkdir}`);
  }

  const outputsDir = path.resolve(process.cwd(), "outputs");
  fs.mkdirSync(outputsDir, { recursive: true });

  const model = parsed.data.LLM_MODEL ?? parsed.data.OLLAMA_MODEL ?? "";
  if (!model) {
    throw new Error("LLM_MODEL が必要です。（後方互換として OLLAMA_MODEL も可）");
  }

  const openaiApiKey = parsed.data.OPENAI_API_KEY ?? null;
  const anthropicApiKey = parsed.data.ANTHROPIC_API_KEY ?? null;
  validateProviderRequirements(parsed.data.LLM_PROVIDER, openaiApiKey, anthropicApiKey);

  const codexCommandTemplate = parsed.data.CODEX_COMMAND_TEMPLATE ?? null;
  const claudeCommandTemplate = parsed.data.CLAUDE_COMMAND_TEMPLATE ?? null;
  if (!codexCommandTemplate && !claudeCommandTemplate) {
    throw new Error("CODEX_COMMAND_TEMPLATE または CLAUDE_COMMAND_TEMPLATE のどちらかは必須です。");
  }
  if (parsed.data.EXECUTOR_MODE === "codex" && !codexCommandTemplate) {
    throw new Error("EXECUTOR_MODE=codex には CODEX_COMMAND_TEMPLATE が必要です。");
  }
  if (parsed.data.EXECUTOR_MODE === "claude" && !claudeCommandTemplate) {
    throw new Error("EXECUTOR_MODE=claude には CLAUDE_COMMAND_TEMPLATE が必要です。");
  }

  return {
    llm: {
      provider: parsed.data.LLM_PROVIDER,
      model,
      ollamaBaseUrl: parsed.data.OLLAMA_BASE_URL,
      lmstudioBaseUrl: parsed.data.LMSTUDIO_BASE_URL,
      openaiBaseUrl: parsed.data.OPENAI_BASE_URL,
      openaiApiKey,
      anthropicBaseUrl: parsed.data.ANTHROPIC_BASE_URL,
      anthropicApiKey,
    },
    executorMode: parsed.data.EXECUTOR_MODE,
    codexCommandTemplate,
    claudeCommandTemplate,
    codexWorkdir,
    maxHistoryMessages: parsed.data.MAX_HISTORY_MESSAGES,
    outputsDir,
  };
}

export function loadCliConfig(): BaseConfig {
  return resolveBaseConfig();
}

export function loadDiscordConfig(): DiscordConfig {
  const base = resolveBaseConfig();
  const parsed = discordSchema.safeParse(process.env);

  if (!parsed.success) {
    throw new Error(
      `Discord用の環境変数が不足/不正です:\n${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("\n")}`,
    );
  }

  return {
    ...base,
    discordBotToken: parsed.data.DISCORD_BOT_TOKEN,
    panelChannelId: parsed.data.PANEL_CHANNEL_ID,
    sessionCategoryId: parsed.data.SESSION_CATEGORY_ID,
  };
}
