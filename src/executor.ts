import { runCodex } from "./codex-runner";
import { type OllamaClient } from "./ollama";

export type ExecutorKey = "codex" | "claude";
export type ExecutorMode = ExecutorKey | "auto";

type SelectExecutorOptions = {
  mode: ExecutorMode;
  ollama: OllamaClient;
  historyText: string;
  codexCommandTemplate: string | null;
  claudeCommandTemplate: string | null;
};

type RunExecutorOptions = {
  executor: ExecutorKey;
  codexCommandTemplate: string | null;
  claudeCommandTemplate: string | null;
  prompt: string;
  promptFilePath: string;
  ownerId: string;
  channelId: string;
  workdir: string;
  outputsDir: string;
  onLog?: (cleanChunk: string) => void;
  onExit?: (code: number | null) => void | Promise<void>;
};

export function executorLabel(executor: ExecutorKey): string {
  return executor === "codex" ? "CodexCLI" : "Claude Code";
}

function availableExecutors(
  codexCommandTemplate: string | null,
  claudeCommandTemplate: string | null,
): ExecutorKey[] {
  const items: ExecutorKey[] = [];
  if (codexCommandTemplate) {
    items.push("codex");
  }
  if (claudeCommandTemplate) {
    items.push("claude");
  }
  return items;
}

function commandTemplateFor(
  executor: ExecutorKey,
  codexCommandTemplate: string | null,
  claudeCommandTemplate: string | null,
): string {
  if (executor === "codex") {
    if (!codexCommandTemplate) {
      throw new Error("CODEX_COMMAND_TEMPLATE が未設定です。");
    }
    return codexCommandTemplate;
  }
  if (!claudeCommandTemplate) {
    throw new Error("CLAUDE_COMMAND_TEMPLATE が未設定です。");
  }
  return claudeCommandTemplate;
}

export async function selectExecutor(options: SelectExecutorOptions): Promise<{
  executor: ExecutorKey;
  reason: string;
}> {
  const available = availableExecutors(options.codexCommandTemplate, options.claudeCommandTemplate);
  if (available.length === 0) {
    throw new Error(
      "実行テンプレートがありません。CODEX_COMMAND_TEMPLATE または CLAUDE_COMMAND_TEMPLATE を設定してください。",
    );
  }

  if (options.mode === "codex") {
    if (!available.includes("codex")) {
      throw new Error("EXECUTOR_MODE=codex ですが CODEX_COMMAND_TEMPLATE が未設定です。");
    }
    return { executor: "codex", reason: "設定により codex を固定利用" };
  }

  if (options.mode === "claude") {
    if (!available.includes("claude")) {
      throw new Error("EXECUTOR_MODE=claude ですが CLAUDE_COMMAND_TEMPLATE が未設定です。");
    }
    return { executor: "claude", reason: "設定により claude を固定利用" };
  }

  if (available.length === 1) {
    const only = available[0];
    if (!only) {
      throw new Error("利用可能実行器の解決に失敗しました。");
    }
    return {
      executor: only,
      reason: `auto指定だが利用可能実行器が ${only} のみ`,
    };
  }

  try {
    const response = await options.ollama.chat([
      {
        role: "system",
        content: [
          "あなたは実行器ルーターです。",
          "回答は必ず `codex` または `claude` のどちらか1語だけを返してください。",
          "実装変更やリポジトリ編集主体は codex、文章中心や軽量な整形は claude を優先してください。",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          "以下の会話履歴から最適な実行器を選んでください。",
          "利用可能: codex, claude",
          "",
          options.historyText,
        ].join("\n"),
      },
    ]);

    const normalized = response.toLowerCase().trim();
    if (normalized.includes("claude")) {
      return { executor: "claude", reason: "auto選択: Ollamaがclaudeを推奨" };
    }
    return { executor: "codex", reason: "auto選択: Ollamaがcodexを推奨" };
  } catch {
    return { executor: "codex", reason: "auto選択に失敗したためcodexへフォールバック" };
  }
}

export function runSelectedExecutor(options: RunExecutorOptions): {
  runId: string;
  logFilePath: string;
} {
  const commandTemplate = commandTemplateFor(
    options.executor,
    options.codexCommandTemplate,
    options.claudeCommandTemplate,
  );

  return runCodex({
    commandTemplate,
    prompt: options.prompt,
    promptFilePath: options.promptFilePath,
    ownerId: options.ownerId,
    channelId: options.channelId,
    workdir: options.workdir,
    outputsDir: options.outputsDir,
    onLog: options.onLog,
    onExit: options.onExit,
  });
}
