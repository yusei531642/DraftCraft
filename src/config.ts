import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const schema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  PANEL_CHANNEL_ID: z.string().min(1),
  SESSION_CATEGORY_ID: z.string().min(1),
  OLLAMA_BASE_URL: z.string().url().default("http://127.0.0.1:11434"),
  OLLAMA_MODEL: z.string().min(1),
  CODEX_COMMAND_TEMPLATE: z.string().min(1),
  CODEX_WORKDIR: z.string().default(process.cwd()),
  MAX_HISTORY_MESSAGES: z.coerce.number().int().min(10).max(200).default(30),
});

export type AppConfig = {
  discordBotToken: string;
  panelChannelId: string;
  sessionCategoryId: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  codexCommandTemplate: string;
  codexWorkdir: string;
  maxHistoryMessages: number;
  outputsDir: string;
};

export function loadConfig(): AppConfig {
  const parsed = schema.safeParse(process.env);

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

  return {
    discordBotToken: parsed.data.DISCORD_BOT_TOKEN,
    panelChannelId: parsed.data.PANEL_CHANNEL_ID,
    sessionCategoryId: parsed.data.SESSION_CATEGORY_ID,
    ollamaBaseUrl: parsed.data.OLLAMA_BASE_URL,
    ollamaModel: parsed.data.OLLAMA_MODEL,
    codexCommandTemplate: parsed.data.CODEX_COMMAND_TEMPLATE,
    codexWorkdir,
    maxHistoryMessages: parsed.data.MAX_HISTORY_MESSAGES,
    outputsDir,
  };
}
