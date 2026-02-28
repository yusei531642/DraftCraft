import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

type RunCodexOptions = {
  commandTemplate: string;
  prompt: string;
  promptFilePath: string;
  ownerId: string;
  channelId: string;
  workdir: string;
  outputsDir: string;
  onLog?: (chunk: string) => void;
  onExit?: (code: number | null) => void;
};

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function runCodex(options: RunCodexOptions): { runId: string; logFilePath: string } {
  const runId = `${options.channelId}-${Date.now()}`;
  const logDir = path.resolve(options.outputsDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  const logFilePath = path.resolve(logDir, `codex-${timestamp()}-${runId}.log`);

  const command = options.commandTemplate
    .replaceAll("{PROMPT_FILE}", options.promptFilePath)
    .replaceAll("{CHANNEL_ID}", options.channelId)
    .replaceAll("{OWNER_ID}", options.ownerId)
    .replaceAll("{WORKDIR}", options.workdir);

  const writeLog = (text: string): void => {
    fs.appendFileSync(logFilePath, text, "utf8");
    options.onLog?.(text);
  };

  writeLog(`$ ${command}\n\n`);

  const child = spawn(command, {
    cwd: options.workdir,
    shell: true,
    env: {
      ...process.env,
      DRAFTCRAFT_PROMPT: options.prompt,
      DRAFTCRAFT_PROMPT_FILE: options.promptFilePath,
      DRAFTCRAFT_OWNER_ID: options.ownerId,
      DRAFTCRAFT_CHANNEL_ID: options.channelId,
      DRAFTCRAFT_WORKDIR: options.workdir,
    },
  });

  child.stdout.on("data", (data: Buffer) => {
    writeLog(data.toString("utf8"));
  });

  child.stderr.on("data", (data: Buffer) => {
    writeLog(data.toString("utf8"));
  });

  child.on("close", (code) => {
    writeLog(`\n[exit code] ${code ?? "null"}\n`);
    options.onExit?.(code);
  });

  child.on("error", (error) => {
    writeLog(`\n[spawn error] ${error.message}\n`);
    options.onExit?.(null);
  });

  return { runId, logFilePath };
}
