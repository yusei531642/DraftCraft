import fs from "node:fs";
import path from "node:path";
import { stripVTControlCharacters } from "node:util";
import * as pty from "node-pty";

type RunCodexOptions = {
  commandTemplate: string;
  prompt: string;
  promptFilePath: string;
  ownerId: string;
  channelId: string;
  workdir: string;
  outputsDir: string;
  onLog?: (cleanChunk: string) => void;
  onExit?: (code: number | null) => void | Promise<void>;
};

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function resolveShell(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    const shell = process.env.ComSpec ?? "cmd.exe";
    return { file: shell, args: ["/d", "/s", "/c", command] };
  }

  const shell = process.env.SHELL ?? "/bin/bash";
  return { file: shell, args: ["-lc", command] };
}

function sanitizeForDiscord(text: string): string {
  return stripVTControlCharacters(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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
  };

  writeLog(`$ ${command}\n\n`);

  const env = {
    ...process.env,
    DRAFTCRAFT_PROMPT: options.prompt,
    DRAFTCRAFT_PROMPT_FILE: options.promptFilePath,
    DRAFTCRAFT_OWNER_ID: options.ownerId,
    DRAFTCRAFT_CHANNEL_ID: options.channelId,
    DRAFTCRAFT_WORKDIR: options.workdir,
  };

  const shell = resolveShell(command);
  let exitNotified = false;
  const notifyExit = (code: number | null): void => {
    if (exitNotified) return;
    exitNotified = true;
    const maybePromise = options.onExit?.(code);
    if (maybePromise) {
      void maybePromise.catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        writeLog(`\n[onExit callback error] ${message}\n`);
      });
    }
  };

  try {
    const ptyProcess = pty.spawn(shell.file, shell.args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd: options.workdir,
      env,
    });

    ptyProcess.onData((data) => {
      writeLog(data);
      const cleaned = sanitizeForDiscord(data);
      if (cleaned.length > 0) {
        options.onLog?.(cleaned);
      }
    });

    ptyProcess.onExit((event) => {
      writeLog(`\n[exit code] ${event.exitCode}\n`);
      notifyExit(event.exitCode);
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeLog(`\n[pty spawn error] ${message}\n`);
    notifyExit(null);
  }

  return { runId, logFilePath };
}
