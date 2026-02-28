import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
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
  output.write("コマンド:\n");
  output.write("  /help      ヘルプを表示\n");
  output.write("  /engine    実行モード表示 (codex / claude / auto)\n");
  output.write("  /engine X  実行モード変更 (X: codex|claude|auto)\n");
  output.write("  /reset     会話履歴を初期化\n");
  output.write("  /finalize  最終指示文を生成して保存\n");
  output.write("  /run       最終指示文を生成して実行器を起動\n");
  output.write("  /exit      CLIを終了\n");
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
    latestPromptPath: null,
    latestPromptText: null,
  };

  output.write(`${BANNER}\n`);
  output.write("LLMdraft CLI\n");
  output.write(`provider: ${config.llm.provider}\n`);
  output.write(`model: ${config.llm.model}\n`);
  output.write(`executor mode: ${state.executorMode}\n`);
  output.write("入力した内容は選択したLLMと対話しながら指示文に育てられます。\n");
  printHelp();

  const rl = readline.createInterface({ input, output, terminal: true });

  try {
    while (true) {
      const line = (await rl.question("you> ")).trim();
      if (!line) {
        continue;
      }

      if (line.startsWith("/")) {
        if (line === "/help") {
          printHelp();
          continue;
        }
        if (line === "/engine") {
          output.write(`現在の実行モード: ${state.executorMode}\n\n`);
          continue;
        }
        if (line.startsWith("/engine ")) {
          const nextModeRaw = line.replace("/engine ", "").trim().toLowerCase();
          const nextMode = parseExecutorMode(nextModeRaw);
          if (!nextMode) {
            output.write("指定値が不正です。`/engine codex|claude|auto` を使ってください。\n\n");
            continue;
          }
          state.executorMode = nextMode;
          output.write(`実行モードを ${state.executorMode} に変更しました。\n\n`);
          continue;
        }
        if (line === "/reset") {
          state.history = [{ role: "system", content: SYSTEM_PROMPT }];
          state.projectContextCache.clear();
          state.latestPromptPath = null;
          state.latestPromptText = null;
          output.write("会話履歴を初期化しました。\n\n");
          continue;
        }
        if (line === "/finalize") {
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
        if (line === "/run") {
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
        if (line === "/exit") {
          output.write("LLMdraft CLIを終了します。\n");
          break;
        }

        output.write("不明なコマンドです。`/help` を確認してください。\n\n");
        continue;
      }

      let userContent = line;
      try {
        const projectContext = await resolveProjectContext({
          messageContent: line,
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
          userContent = `${line}\n\n[補足: プロジェクト理解メモ]\n${projectContext.contextText}`;
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
