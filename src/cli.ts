import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
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
  gray: "\x1b[90m",
  magenta: "\x1b[38;5;205m",
  cyan: "\x1b[36m",
};

const SLASH_COMMANDS = [
  "/help",
  "/engine",
  "/thinking",
  "/clear",
  "/reset",
  "/finalize",
  "/run",
  "/exit",
] as const;

const SLASH_COMMAND_HELP: Record<(typeof SLASH_COMMANDS)[number], string> = {
  "/help": "ヘルプを表示",
  "/engine": "実行モード表示/変更",
  "/thinking": "Thinkingレベル切替",
  "/clear": "画面をクリア",
  "/reset": "会話履歴を初期化",
  "/finalize": "最終指示文を生成して保存",
  "/run": "最終指示文を生成して実行器を起動",
  "/exit": "CLIを終了",
};

const SYSTEM_PROMPT = [
  "あなたは、ユーザーが出したラフな要望文を整えて、CodexCLIやClaude Codeが理解しやすい実行指示文に直す通訳・編集アシスタントです。",
  "役割は『実装者』ではなく『指示文の整形者』です。仕様を勝手に決めず、ユーザー意図を忠実に整理してください。",
  "不足情報があっても、まず実行可能な暫定指示文を作り、必要な確認点は末尾に [要確認] として短く添えてください。",
  "ユーザーへ一方的に情報提供を要求する質問票だけを返してはいけません。",
  "日本語で、簡潔かつ分かりやすく回答してください。",
].join("\n");

const FINALIZER_SYSTEM_PROMPT = [
  "あなたは会話ログから、CodexCLI/Claude Codeへ渡す最終指示文を1つに統合する通訳エディタです。",
  "ユーザーのラフな文を、AI実行器が誤解しにくい正しい作業指示文へ直してください。",
  "役割は通訳であり、要求元ユーザーに質問を返すことではありません。",
  "不足情報は [要確認] として明記し、作業の進め方を止めない形で指示文に残してください。",
  "指示文は『目的』『実施内容』『制約』『完了条件』が分かる構成にしてください。",
  "出力は最終指示文のみを返してください。",
  "日本語で、目的・要件・制約・完了条件が明確になるように書いてください。",
].join("\n");

function looksLikeQuestionnaire(text: string): boolean {
  const patterns = [
    /ご提供ください/u,
    /教えてください/u,
    /情報を(提供|共有)してください/u,
    /必要な情報/u,
    /以下の情報/u,
    /届いた時点/u,
  ];
  return patterns.some((pattern) => pattern.test(text));
}

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

  let prompt = await llm.chat([
    { role: "system", content: FINALIZER_SYSTEM_PROMPT },
    { role: "user", content: historyText },
  ]);

  if (looksLikeQuestionnaire(prompt)) {
    prompt = await llm.chat([
      {
        role: "system",
        content: [
          "あなたは通訳エディタです。",
          "次の文章はユーザー向け質問票になっている可能性があります。",
          "質問票ではなく、実行器がすぐ作業できる指示文へ書き換えてください。",
          "不足情報は [要確認] を使って残し、作業手順は止めないでください。",
          "出力は指示文本文のみ。",
        ].join("\n"),
      },
      { role: "user", content: prompt },
    ]);
  }

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
  output.write("  /clear     画面をクリア\n");
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
  const left = "[/] commands  [?] help  [tab] complete";
  const right = `mode:${state.executorMode}  thinking:${state.thinkingLevel}`;
  const spaces = Math.max(1, width - left.length - right.length);
  return `${left}${" ".repeat(spaces)}${right}`;
}

function renderCliFrame(configModel: string, configProvider: string, configWorkdir: string): void {
  output.write(`${ANSI.magenta}[##]${ANSI.reset} ${ANSI.bold}LLMDraft ChatCLI${ANSI.reset}\n`);
  output.write(
    `${ANSI.dim}session ${ANSI.reset}${ANSI.cyan}${configProvider.toUpperCase()} / ${configModel}${ANSI.reset}\n`,
  );
  output.write(`${ANSI.dim}workspace ${ANSI.reset}${configWorkdir}\n`);
}

async function askInActiveBox(
  rl: readlinePromises.Interface | null,
  state: CliState,
): Promise<{ lineInput: string; width: number }> {
  const width = Math.max(72, (process.stdout.columns ?? 100) - 2);
  const sep = `${ANSI.dim}${separatorLine(width)}${ANSI.reset}`;
  const status = `${ANSI.dim}${buildStatusLine(state, width)}${ANSI.reset}`;
  const promptPlain = "chat> ";
  const promptColored = `${ANSI.bold}${ANSI.cyan}${promptPlain}${ANSI.reset}`;
  const placeholder = "Type your request...";
  const isTty = Boolean(process.stdout.isTTY && (input as NodeJS.ReadStream).isTTY);

  if (!isTty || typeof (input as NodeJS.ReadStream).setRawMode !== "function") {
    if (!rl) {
      throw new Error("非TTY入力モードの初期化に失敗しました。");
    }
    output.write(`${sep}\n`);
    output.write(`${promptPlain}${ANSI.gray}${placeholder}${ANSI.reset}\n`);
    output.write(`${sep}\n`);
    output.write(`${status}\n`);
    const lineInput = (await rl.question(`${promptPlain}`)).trim();
    output.write("\n");
    return { lineInput, width };
  }

  output.write(`${sep}\n`);
  output.write(`${promptColored}${ANSI.gray}${placeholder}${ANSI.reset}\n`);
  output.write(`${sep}\n`);
  output.write(`${status}\n`);
  readline.moveCursor(output, 0, -3);
  readline.cursorTo(output, promptPlain.length);

  const readStream = input as NodeJS.ReadStream;
  const lineInput = await new Promise<string>((resolve) => {
    let current = "";
    let cursor = 0;
    const wasRaw = Boolean((readStream as NodeJS.ReadStream & { isRaw?: boolean }).isRaw);

    const render = (): void => {
      readline.cursorTo(output, promptPlain.length);
      readline.clearLine(output, 1);
      if (current.length === 0) {
        output.write(`${ANSI.gray}${placeholder}${ANSI.reset}`);
        readline.cursorTo(output, promptPlain.length);
        return;
      }
      output.write(current);

      if (current.startsWith("/") && cursor === current.length) {
        const hits = SLASH_COMMANDS.filter((command) => command.startsWith(current));
        if (hits.length > 0) {
          const match = hits[0];
          if (match && match.length > current.length) {
            const suggestion = match.slice(current.length);
            output.write(`${ANSI.gray}${suggestion}${ANSI.reset}`);
          }
        }
      }

      readline.cursorTo(output, promptPlain.length + cursor);
    };

    const cleanup = (): void => {
      readStream.off("keypress", onKeypress);
      if (!wasRaw && typeof readStream.setRawMode === "function") {
        readStream.setRawMode(false);
      }
    };

    const onKeypress = (str: string, key: readline.Key): void => {
      if (key.ctrl && key.name === "c") {
        cleanup();
        resolve("/exit");
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        cleanup();
        resolve(current);
        return;
      }

      if (key.name === "left") {
        cursor = Math.max(0, cursor - 1);
        render();
        return;
      }

      if (key.name === "right") {
        cursor = Math.min(current.length, cursor + 1);
        render();
        return;
      }

      if (key.name === "home") {
        cursor = 0;
        render();
        return;
      }

      if (key.name === "end") {
        cursor = current.length;
        render();
        return;
      }

      if (key.name === "backspace") {
        if (cursor > 0) {
          current = `${current.slice(0, cursor - 1)}${current.slice(cursor)}`;
          cursor -= 1;
          render();
        }
        return;
      }

      if (key.name === "delete") {
        if (cursor < current.length) {
          current = `${current.slice(0, cursor)}${current.slice(cursor + 1)}`;
          render();
        }
        return;
      }

      if (key.name === "tab") {
        if (current.startsWith("/")) {
          const hits = SLASH_COMMANDS.filter((command) => command.startsWith(current));
          if (hits.length === 1) {
            const match = hits[0];
            if (match) {
              current = match;
              cursor = current.length;
              render();
            }
          }
        }
        return;
      }

      if (!str || key.ctrl || key.meta || key.name === "escape") {
        return;
      }

      current = `${current.slice(0, cursor)}${str}${current.slice(cursor)}`;
      cursor += str.length;
      render();
    };

    readline.emitKeypressEvents(readStream);
    if (!wasRaw && typeof readStream.setRawMode === "function") {
      readStream.setRawMode(true);
    }
    readStream.on("keypress", onKeypress);
  });

  readline.moveCursor(output, 0, 3);
  readline.cursorTo(output, 0);
  output.write("\n");
  return { lineInput: lineInput.trim(), width };
}

function slashCommandCompleter(currentLine: string): [string[], string] {
  if (!currentLine.startsWith("/")) {
    return [[], currentLine];
  }
  const hits = SLASH_COMMANDS.filter((command) => command.startsWith(currentLine));
  return [hits.length > 0 ? [...hits] : [...SLASH_COMMANDS], currentLine];
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

  output.write(`${BANNER}\n`);
  renderCliFrame(config.llm.model, config.llm.provider, config.codexWorkdir);

  const state: CliState = {
    history: [{ role: "system", content: SYSTEM_PROMPT }],
    executorMode: config.executorMode,
    projectContextCache: new Map<string, string>(),
    thinkingLevel: "normal",
    latestPromptPath: null,
    latestPromptText: null,
  };

  const isTty = Boolean(process.stdout.isTTY && (input as NodeJS.ReadStream).isTTY);
  const rl = isTty
    ? null
    : readlinePromises.createInterface({
        input,
        output,
        terminal: true,
        completer: slashCommandCompleter,
      });

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
        if (lineInput === "/clear") {
          if (process.stdout.isTTY) {
            output.write("\x1b[2J\x1b[H");
          }
          output.write(`${BANNER}\n`);
          renderCliFrame(config.llm.model, config.llm.provider, config.codexWorkdir);
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
            `system> ${projectContext.resolvedProjects.join(", ")} を実行器に確認して理解した上で続行します。\n`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "不明なエラーです。";
        output.write(`system> プロジェクト調査に失敗したため通常応答で続行します: ${message}\n`);
      }

      state.history.push({ role: "user", content: userContent });
      state.history = trimHistory(state.history, config.maxHistoryMessages);

      let loadingInterval: NodeJS.Timeout | null = null;
      try {
        const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
        let frameIndex = 0;

        if (isTty) {
          output.write(`${ANSI.cyan}● ${ANSI.reset}${frames[0]} 生成中...`);
          loadingInterval = setInterval(() => {
            frameIndex = (frameIndex + 1) % frames.length;
            readline.cursorTo(output, 2);
            output.write(`${frames[frameIndex]} 生成中...`);
          }, 80);
        }

        const response = await llm.chat(state.history);

        if (loadingInterval) {
          clearInterval(loadingInterval);
          readline.cursorTo(output, 2);
          readline.clearLine(output, 1);
        }

        state.history.push({ role: "assistant", content: response });
        state.history = trimHistory(state.history, config.maxHistoryMessages);

        if (isTty) {
          output.write(`${ANSI.cyan}● ${ANSI.reset}${response}\n\n`);
        } else {
          output.write(`● ${response}\n\n`);
        }
      } catch (error) {
        if (loadingInterval) {
          clearInterval(loadingInterval);
          readline.cursorTo(output, 2);
          readline.clearLine(output, 1);
        }
        const message = error instanceof Error ? error.message : "不明なエラーです。";
        output.write(`LLM連携でエラーが発生しました: ${message}\n\n`);
      }
    }
  } finally {
    rl?.close();
  }
}
