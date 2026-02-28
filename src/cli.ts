import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { loadCliConfig } from "./config";
import { runCodex } from "./codex-runner";
import { OllamaClient, type ChatMessage } from "./ollama";

const SYSTEM_PROMPT = [
  "あなたはユーザーと一緒に、CodexCLIに渡す実装指示文を作るアシスタントです。",
  "ユーザーの意図を確認し、曖昧な部分は質問し、具体的な手順と完了条件が含まれる指示文へ改善してください。",
  "日本語で簡潔に回答してください。",
].join("\n");

const FINALIZER_SYSTEM_PROMPT = [
  "あなたは会話ログから、CodexCLIへ渡す最終指示文を1つに統合するエディタです。",
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

async function buildFinalPrompt(ollama: OllamaClient, history: ChatMessage[]): Promise<string> {
  const historyText = formatHistoryForFinalizer(history);
  if (!historyText) {
    throw new Error("会話履歴が空のため、最終指示文を生成できません。");
  }

  const prompt = await ollama.chat([
    { role: "system", content: FINALIZER_SYSTEM_PROMPT },
    { role: "user", content: historyText },
  ]);

  return prompt;
}

function printHelp(): void {
  output.write("\n");
  output.write("コマンド:\n");
  output.write("  /help      ヘルプを表示\n");
  output.write("  /reset     会話履歴を初期化\n");
  output.write("  /finalize  最終指示文を生成して保存\n");
  output.write("  /run       最終指示文を生成してCodexCLI実行\n");
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

async function runCodexWithPrompt(
  commandTemplate: string,
  prompt: string,
  promptFilePath: string,
  workdir: string,
  outputsDir: string,
): Promise<{ runId: string; logFilePath: string; exitCode: number | null }> {
  output.write("\n--- CodexCLI stream ---\n");
  const result = await new Promise<{ runId: string; logFilePath: string; exitCode: number | null }>(
    (resolve) => {
      const { runId, logFilePath } = runCodex({
        commandTemplate,
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
  output.write("\n--- CodexCLI end ---\n\n");
  return result;
}

export async function startCli(): Promise<void> {
  const config = loadCliConfig();
  const ollama = new OllamaClient({
    baseUrl: config.ollamaBaseUrl,
    model: config.ollamaModel,
  });

  const state: CliState = {
    history: [{ role: "system", content: SYSTEM_PROMPT }],
    latestPromptPath: null,
    latestPromptText: null,
  };

  output.write(`${BANNER}\n`);
  output.write("LLMdraft CLI\n");
  output.write(`model: ${config.ollamaModel}\n`);
  output.write("入力した内容はOllamaと対話しながら指示文に育てられます。\n");
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
        if (line === "/reset") {
          state.history = [{ role: "system", content: SYSTEM_PROMPT }];
          state.latestPromptPath = null;
          state.latestPromptText = null;
          output.write("会話履歴を初期化しました。\n\n");
          continue;
        }
        if (line === "/finalize") {
          try {
            output.write("最終指示文を生成しています...\n");
            const prompt = await buildFinalPrompt(ollama, state.history);
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
            output.write("最終指示文を生成してCodexCLIを実行します...\n");
            const prompt = await buildFinalPrompt(ollama, state.history);
            const promptFilePath = await savePrompt(config.outputsDir, prompt);
            state.latestPromptPath = promptFilePath;
            state.latestPromptText = prompt;
            const result = await runCodexWithPrompt(
              config.codexCommandTemplate,
              prompt,
              promptFilePath,
              config.codexWorkdir,
              config.outputsDir,
            );

            output.write(`run id: ${result.runId}\n`);
            output.write(`prompt: ${promptFilePath}\n`);
            output.write(`log: ${result.logFilePath}\n`);
            output.write(`exit code: ${result.exitCode === null ? "null" : result.exitCode}\n\n`);
          } catch (error) {
            const message = error instanceof Error ? error.message : "不明なエラーです。";
            output.write(`CodexCLI実行に失敗しました: ${message}\n\n`);
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

      state.history.push({ role: "user", content: line });
      state.history = trimHistory(state.history, config.maxHistoryMessages);

      try {
        const response = await ollama.chat(state.history);
        state.history.push({ role: "assistant", content: response });
        state.history = trimHistory(state.history, config.maxHistoryMessages);
        output.write(`assistant> ${response}\n\n`);
      } catch (error) {
        const message = error instanceof Error ? error.message : "不明なエラーです。";
        output.write(`Ollama連携でエラーが発生しました: ${message}\n\n`);
      }
    }
  } finally {
    rl.close();
  }
}
