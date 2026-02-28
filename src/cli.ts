import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline";
import readlinePromises from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadCliConfig } from "./config";
import { explainExecutorResult } from "./explain";
import {
  executorLabel,
  runSelectedExecutor,
  selectExecutor,
  type ExecutorKey,
  type ExecutorMode,
} from "./executor";
import { LlmClient, type ChatMessage } from "./llm";
import { resolveProjectContext } from "./project-context";
import { ensureCliSetup } from "./setup";

const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  magenta: "\x1b[38;5;205m",
  cyan: "\x1b[36m",
};

const SLASH_COMMANDS = [
  "/help",
  "/engine",
  "/thinking",
  "/reset",
  "/finalize",
  "/run",
  "/exit",
] as const;

const SLASH_COMMAND_HELP: Record<(typeof SLASH_COMMANDS)[number], string> = {
  "/help": "ヘルプを表示",
  "/engine": "実行モード表示/変更",
  "/thinking": "Thinkingレベル切替",
  "/reset": "会話履歴を初期化",
  "/finalize": "最終指示文を生成して保存",
  "/run": "最終指示文を生成して実行器を起動",
  "/exit": "CLIを終了",
};

const SYSTEM_PROMPT = [
  "あなたはユーザーと一緒に、CodexCLIやClaude Codeに渡す実装指示文を作るアシスタントです。",
  "ユーザーの意図を確認し、曖昧な部分は質問し、具体的な手順と完了条件が含まれる指示文へ改善してください。",
  "日本語で簡潔に回答してください。",
].join("\n");

const FINALIZER_SYSTEM_PROMPT = [
  "あなたは会話ログから、実行器へ渡す最終指示文を1つに統合するエディタです。",
  "出力は最終指示文のみを返してください。",
  "日本語で、目的・要件・制約・完了条件が明確になるように書いてください。",
].join("\n");

const BANNER = String.raw`
 _      _      __  __     ____            __ _   
| |    | |    |  \/  |   |  _ \          / _| |  
| |    | |    | \  / | __| | | |_ __ __ _| |_| |_ 
| |    | |    | |\/| |/ _\` | | '__/ _\` |  _| __|
| |____| |____| |  | | (_| | | | | (_| | | | |_ 
|______|______|_|  |_|\__,_|_| |_|\__,_|_|  \__|
`;

type CliState = {
  history: ChatMessage[];
  executorMode: ExecutorMode;
  projectContextCache: Map<string, string>;
  thinkingLevel: "normal" | "deep";
  latestPromptPath: string | null;
  latestPromptText: string | null;
};

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function trimHistory(history: ChatMessage[], maxHistoryMessages: number): ChatMessage[] {
  if (history.length <= maxHistoryMessages + 1) {
    return history;
  }

  const system = history[0] ?? { role: "system", content: SYSTEM_PROMPT };
  const rest = history.slice(1);
  return [system, ...rest.slice(-maxHistoryMessages)];
}

function formatHistoryForFinalizer(history: ChatMessage[]): string {
  return history
    .filter((msg) => msg.role !== "system")
    .map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`)
    .join("\n\n");
}

async function buildFinalPrompt(
  llm: LlmClient,
  history: ChatMessage[],
): Promise<{ prompt: string; historyText: string }> {
  const historyText = formatHistoryForFinalizer(history);
  if (!historyText) {
    throw new Error("会話履歴が空のため、最終指示文を生成できません。");
  }

  const prompt = await llm.chat([
    { role: "system", content: FINALIZER_SYSTEM_PROMPT },
    { role: "user", content: historyText },
  ]);

  return { prompt, historyText };
}

function printHelp(): void {
  output.write("\n");
  output.write("Shortcuts:\n");
  output.write("  ?          ショートカット表示\n");
  output.write("  /help      ヘルプを表示\n");
  output.write("  /engine    実行モード表示 (codex / claude / auto)\n");
  output.write("  /engine X  実行モード変更 (X: codex|claude|auto)\n");
  output.write("  /thinking  Thinkingレベル切替 (normal/deep)\n");
  output.write("  /reset     会話履歴を初期化\n");
  output.write("  /finalize  最終指示文を生成して保存\n");
  output.write("  /run       最終指示文を生成して実行器を起動\n");
  output.write("  /exit      CLIを終了\n");
  output.write("\n");
}

function separatorLine(width: number): string {
  return "-".repeat(Math.max(20, width));
}

function buildStatusLine(state: CliState, width: number): string {
  const left = "? for shortcuts";
  const right = `Thinking ${state.thinkingLevel} | tab: command suggestions`;
  const spaces = Math.max(1, width - left.length - right.length);
  return `${left}${" ".repeat(spaces)}${right}`;
}

function fitToWidth(text: string, width: number): string {
  if (text.length === width) return text;
  if (text.length < width) return text + " ".repeat(width - text.length);
  if (width <= 3) return text.slice(0, width);
  return `${text.slice(0, width - 3)}...`;
}

function buildFooterLine(state: CliState, width: number, currentInput: string): string {
  if (currentInput.startsWith("/")) {
    const hits = SLASH_COMMANDS.filter((command) => command.startsWith(currentInput));
    if (hits.length === 0) {
      return fitToWidth("候補: なし", width);
    }
    return fitToWidth(`候補: ${hits.join("  ")}`, width);
  }
  return fitToWidth(buildStatusLine(state, width), width);
}

function renderCliFrame(
  configModel: string,
  configProvider: string,
  configWorkdir: string,
): void {
  const width = Math.max(72, (process.stdout.columns ?? 100) - 2);
  output.write(`${ANSI.magenta}[##]${ANSI.reset} ${ANSI.bold}LLMDraft CLI v1${ANSI.reset}\n`);
  output.write(
    `${ANSI.dim}${configProvider.toUpperCase()} agent ${ANSI.reset}${ANSI.cyan}${configModel}${ANSI.reset}\n`,
  );
  output.write(`${ANSI.dim}${configWorkdir}${ANSI.reset}\n`);
  output.write(`${ANSI.dim}${separatorLine(width)}${ANSI.reset}\n`);
  output.write(`${ANSI.dim}入力欄は下に表示されます。${ANSI.reset}\n\n`);
}

async function askInActiveBox(
  rlFallback: readlinePromises.Interface,
  state: CliState,
): Promise<{ lineInput: string; width: number }> {
  const stdin = input as NodeJS.ReadStream;
  const width = Math.max(72, (process.stdout.columns ?? 100) - 2);

  if (!process.stdout.isTTY || !stdin.isTTY || typeof stdin.setRawMode !== "function") {
    const lineInput = (await rlFallback.question("| > ")).trim();
    return { lineInput, width };
  }

  readline.emitKeypressEvents(stdin);
  const wasRaw = stdin.isRaw;
  if (!wasRaw) {
    stdin.setRawMode(true);
  }

  let buffer = "";
  let cursor = 0;

  output.write(`${ANSI.dim}${separatorLine(width)}${ANSI.reset}\n`);
  output.write("| >\n");
  output.write(`${ANSI.dim}${buildFooterLine(state, width, buffer)}${ANSI.reset}\n`);
  output.write(`${ANSI.dim}${separatorLine(width)}${ANSI.reset}\n`);

  const redraw = (): void => {
    // Move to input line.
    readline.moveCursor(output, 0, -3);
    readline.cursorTo(output, 0);
    readline.clearLine(output, 0);
    output.write(`| > ${buffer}`);

    // Draw footer line (command candidates or default status).
    readline.moveCursor(output, 0, 1);
    readline.cursorTo(output, 0);
    readline.clearLine(output, 0);
    output.write(`${ANSI.dim}${buildFooterLine(state, width, buffer)}${ANSI.reset}`);

    // Return to input line and set cursor position.
    readline.moveCursor(output, 0, -1);
    readline.cursorTo(output, 4 + cursor);
  };

  redraw();

  const lineInput = await new Promise<string>((resolve) => {
    const onKeypress = (str: string, key: readline.Key): void => {
      if (key.ctrl && key.name === "c") {
        stdin.off("keypress", onKeypress);
        if (!wasRaw) stdin.setRawMode(false);
        output.write("\n");
        process.exit(0);
      }

      if (key.name === "return" || key.name === "enter") {
        stdin.off("keypress", onKeypress);
        if (!wasRaw) stdin.setRawMode(false);
        // Move below the box before returning.
        readline.moveCursor(output, 0, 2);
        readline.cursorTo(output, 0);
        output.write("\n");
        resolve(buffer.trim());
        return;
      }

      if (key.name === "left") {
        cursor = Math.max(0, cursor - 1);
        redraw();
        return;
      }
      if (key.name === "right") {
        cursor = Math.min(buffer.length, cursor + 1);
        redraw();
        return;
      }
      if (key.name === "home") {
        cursor = 0;
        redraw();
        return;
      }
      if (key.name === "end") {
        cursor = buffer.length;
        redraw();
        return;
      }
      if (key.name === "backspace") {
        if (cursor > 0) {
          buffer = buffer.slice(0, cursor - 1) + buffer.slice(cursor);
          cursor -= 1;
          redraw();
        }
        return;
      }
      if (key.name === "delete") {
        if (cursor < buffer.length) {
          buffer = buffer.slice(0, cursor) + buffer.slice(cursor + 1);
          redraw();
        }
        return;
      }
      if (key.name === "tab") {
        if (buffer.startsWith("/")) {
          const hits = SLASH_COMMANDS.filter((command) => command.startsWith(buffer));
          if (hits.length === 1) {
            const only = hits[0];
            if (only) {
              buffer = only;
              cursor = buffer.length;
            }
          } else if (hits.length > 1) {
            const hitStrings = hits.map((item) => item as string);
            const commonPrefix = hitStrings.reduce((prefix, command) => {
              let idx = 0;
              while (
                idx < prefix.length &&
                idx < command.length &&
                prefix[idx] === command[idx]
              ) {
                idx += 1;
              }
              return prefix.slice(0, idx);
            }, hitStrings[0] ?? "");
            if (commonPrefix.length > buffer.length) {
              buffer = commonPrefix;
              cursor = buffer.length;
            }
          }
          redraw();
        }
        return;
      }

      if (str && !key.ctrl && !key.meta && str >= " ") {
        buffer = buffer.slice(0, cursor) + str + buffer.slice(cursor);
        cursor += str.length;
        redraw();
      }
    };

    stdin.on("keypress", onKeypress);
  });

  return { lineInput, width };
}

function printSlashCommandCandidates(prefix: string): void {
  const candidates = SLASH_COMMANDS.filter((command) => command.startsWith(prefix));
  if (candidates.length === 0) {
    output.write("候補がありません。`/help` で確認してください。\n\n");
    return;
  }
  output.write("コマンド候補:\n");
  for (const cmd of candidates) {
    output.write(`  ${cmd.padEnd(10)} ${SLASH_COMMAND_HELP[cmd]}\n`);
  }
  output.write("\n");
}

async function savePrompt(outputsDir: string, prompt: string): Promise<string> {
  const promptDir = path.resolve(outputsDir, "prompts");
  fs.mkdirSync(promptDir, { recursive: true });
  const promptFilePath = path.resolve(promptDir, `prompt-cli-${timestamp()}.md`);
  fs.writeFileSync(promptFilePath, `${prompt}\n`, "utf8");
  return promptFilePath;
}

function parseExecutorMode(raw: string): ExecutorMode | null {
  if (raw === "codex" || raw === "claude" || raw === "auto") {
    return raw;
  }
  return null;
}

async function runExecutorWithPrompt(
  executor: ExecutorKey,
  codexCommandTemplate: string | null,
  claudeCommandTemplate: string | null,
  prompt: string,
  promptFilePath: string,
  workdir: string,
  outputsDir: string,
): Promise<{ runId: string; logFilePath: string; exitCode: number | null }> {
  const label = executorLabel(executor);
  output.write(`\n--- ${label} stream ---\n`);
  const result = await new Promise<{ runId: string; logFilePath: string; exitCode: number | null }>(
    (resolve) => {
      const { runId, logFilePath } = runSelectedExecutor({
        executor,
        codexCommandTemplate,
        claudeCommandTemplate,
        prompt,
        promptFilePath,
        ownerId: "cli-user",
        channelId: "cli-session",
        workdir,
        outputsDir,
        onLog: (cleanChunk) => {
          output.write(cleanChunk);
        },
        onExit: (code) => {
          resolve({ runId, logFilePath, exitCode: code });
        },
      });
    },
  );
  output.write(`\n--- ${label} end ---\n\n`);
  return result;
}

export async function startCli(): Promise<void> {
  await ensureCliSetup();
  const config = loadCliConfig();
  const llm = new LlmClient(config.llm);

  const state: CliState = {
    history: [{ role: "system", content: SYSTEM_PROMPT }],
    executorMode: config.executorMode,
    projectContextCache: new Map<string, string>(),
    thinkingLevel: "normal",
    latestPromptPath: null,
    latestPromptText: null,
  };

  output.write(`${BANNER}\n`);
  renderCliFrame(config.llm.model, config.llm.provider, config.codexWorkdir);

  const rl = readlinePromises.createInterface({ input, output, terminal: true });

  try {
    while (true) {
      const { lineInput } = await askInActiveBox(rl, state);

      if (!lineInput) {
        continue;
      }

      if (lineInput === "?" || lineInput === "/?") {
        printHelp();
        continue;
      }

      if (lineInput.startsWith("/")) {
        if (lineInput === "/") {
          printSlashCommandCandidates("/");
          continue;
        }
        if (lineInput === "/help") {
          printHelp();
          continue;
        }
        if (lineInput === "/thinking") {
          state.thinkingLevel = state.thinkingLevel === "normal" ? "deep" : "normal";
          output.write(`Thinkingレベルを ${state.thinkingLevel} に変更しました。\n\n`);
          continue;
        }
        if (lineInput === "/engine") {
          output.write(`現在の実行モード: ${state.executorMode}\n\n`);
          continue;
        }
        if (lineInput.startsWith("/engine ")) {
          const nextModeRaw = lineInput.replace("/engine ", "").trim().toLowerCase();
          const nextMode = parseExecutorMode(nextModeRaw);
          if (!nextMode) {
            output.write("指定値が不正です。`/engine codex|claude|auto` を使ってください。\n\n");
            continue;
          }
          state.executorMode = nextMode;
          output.write(`実行モードを ${state.executorMode} に変更しました。\n\n`);
          continue;
        }
        if (lineInput === "/reset") {
          state.history = [{ role: "system", content: SYSTEM_PROMPT }];
          state.projectContextCache.clear();
          state.latestPromptPath = null;
          state.latestPromptText = null;
          output.write("会話履歴を初期化しました。\n\n");
          continue;
        }
        if (lineInput === "/finalize") {
          try {
            output.write("最終指示文を生成しています...\n");
            const { prompt } = await buildFinalPrompt(llm, state.history);
            const promptFilePath = await savePrompt(config.outputsDir, prompt);
            state.latestPromptPath = promptFilePath;
            state.latestPromptText = prompt;

            output.write("\n[最終指示文]\n");
            output.write(`${prompt}\n\n`);
            output.write(`保存先: ${promptFilePath}\n\n`);
          } catch (error) {
            const message = error instanceof Error ? error.message : "不明なエラーです。";
            output.write(`最終指示文の生成に失敗しました: ${message}\n\n`);
          }
          continue;
        }
        if (lineInput === "/run") {
          try {
            output.write("最終指示文を生成して実行器を起動します...\n");
            const { prompt, historyText } = await buildFinalPrompt(llm, state.history);
            const promptFilePath = await savePrompt(config.outputsDir, prompt);
            state.latestPromptPath = promptFilePath;
            state.latestPromptText = prompt;
            const selected = await selectExecutor({
              mode: state.executorMode,
              llm,
              historyText,
              codexCommandTemplate: config.codexCommandTemplate,
              claudeCommandTemplate: config.claudeCommandTemplate,
            });
            output.write(`選択実行器: ${executorLabel(selected.executor)} (${selected.reason})\n`);
            const result = await runExecutorWithPrompt(
              selected.executor,
              config.codexCommandTemplate,
              config.claudeCommandTemplate,
              prompt,
              promptFilePath,
              config.codexWorkdir,
              config.outputsDir,
            );

            output.write(`run id: ${result.runId}\n`);
            output.write(`prompt: ${promptFilePath}\n`);
            output.write(`log: ${result.logFilePath}\n`);
            output.write(`exit code: ${result.exitCode === null ? "null" : result.exitCode}\n\n`);

            const logText = fs.existsSync(result.logFilePath)
              ? fs.readFileSync(result.logFilePath, "utf8")
              : "";
            const simpleExplanation = await explainExecutorResult({
              llm,
              executorLabel: executorLabel(selected.executor),
              exitCode: result.exitCode,
              logText,
            });
            output.write(`${simpleExplanation}\n\n`);
          } catch (error) {
            const message = error instanceof Error ? error.message : "不明なエラーです。";
            output.write(`実行に失敗しました: ${message}\n\n`);
          }
          continue;
        }
        if (lineInput === "/exit") {
          output.write("LLMDraft CLIを終了します。\n");
          break;
        }

        printSlashCommandCandidates(lineInput);
        continue;
      }

      let userContent = lineInput;
      try {
        const projectContext = await resolveProjectContext({
          messageContent: lineInput,
          llm,
          executorMode: state.executorMode,
          codexCommandTemplate: config.codexCommandTemplate,
          claudeCommandTemplate: config.claudeCommandTemplate,
          workdir: config.codexWorkdir,
          outputsDir: config.outputsDir,
          ownerId: "cli-user",
          sessionId: "cli-session",
          cache: state.projectContextCache,
        });
        if (projectContext.contextText) {
          userContent = `${lineInput}\n\n[補足: プロジェクト理解メモ]\n${projectContext.contextText}`;
          output.write(
            `project> ${projectContext.resolvedProjects.join(", ")} を実行器に確認して理解した上で続行します。\n`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "不明なエラーです。";
        output.write(`project> プロジェクト調査に失敗したため通常応答で続行します: ${message}\n`);
      }

      state.history.push({ role: "user", content: userContent });
      state.history = trimHistory(state.history, config.maxHistoryMessages);

      try {
        const response = await llm.chat(state.history);
        state.history.push({ role: "assistant", content: response });
        state.history = trimHistory(state.history, config.maxHistoryMessages);
        output.write(`assistant> ${response}\n\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "不明なエラーです。";
        output.write(`LLM連携でエラーが発生しました: ${message}\n\n`);
      }
    }
  } finally {
    rl.close();
  }
}
