import fs from "node:fs";
import path from "node:path";
import { runSelectedExecutor, selectExecutor, type ExecutorMode, executorLabel } from "./executor";
import { type LlmClient } from "./llm";

type ResolveProjectContextOptions = {
  messageContent: string;
  llm: LlmClient;
  executorMode: ExecutorMode;
  codexCommandTemplate: string | null;
  claudeCommandTemplate: string | null;
  workdir: string;
  outputsDir: string;
  ownerId: string;
  sessionId: string;
  cache: Map<string, string>;
};

type ResolveProjectContextResult = {
  contextText: string | null;
  resolvedProjects: string[];
};

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sanitizeFileSegment(input: string): string {
  return input.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "project";
}

function extractProjectNames(text: string): string[] {
  const names = new Set<string>();

  const bracketRegex = /\[([^\[\]\r\n]{1,80})\]/g;
  for (const match of text.matchAll(bracketRegex)) {
    const value = (match[1] ?? "").trim();
    if (value.length >= 2) {
      names.add(value);
    }
  }

  const quoteRegex = /「([^「」\r\n]{1,80})」/g;
  for (const match of text.matchAll(quoteRegex)) {
    const value = (match[1] ?? "").trim();
    if (value.length >= 2 && /project|プロジェクト/i.test(text)) {
      names.add(value);
    }
  }

  return [...names];
}

async function runExecutorForProjectProbe(options: {
  llm: LlmClient;
  executorMode: ExecutorMode;
  codexCommandTemplate: string | null;
  claudeCommandTemplate: string | null;
  projectName: string;
  workdir: string;
  outputsDir: string;
  ownerId: string;
  sessionId: string;
}): Promise<{ logText: string; executorName: string }> {
  const selected = await selectExecutor({
    mode: options.executorMode,
    llm: options.llm,
    historyText: `プロジェクト調査: ${options.projectName}`,
    codexCommandTemplate: options.codexCommandTemplate,
    claudeCommandTemplate: options.claudeCommandTemplate,
  });

  const promptDir = path.resolve(options.outputsDir, "project-probe-prompts");
  fs.mkdirSync(promptDir, { recursive: true });
  const promptFilePath = path.resolve(
    promptDir,
    `probe-${timestamp()}-${sanitizeFileSegment(options.projectName)}.md`,
  );

  const prompt = [
    `プロジェクト名: ${options.projectName}`,
    `作業ディレクトリ: ${options.workdir}`,
    "",
    "以下を守って回答してください。",
    "- 読み取り専用で調査する（ファイル編集・削除・git変更はしない）",
    "- 目的: このプロジェクトの概要を短く把握する",
    "- 出力: 日本語",
    "",
    "知りたい内容:",
    "1. このプロジェクトは何をするものか",
    "2. 主要な機能やフォルダ",
    "3. 「○○機能を追加したい」と言われたときに最初に確認すべき場所",
    "4. 情報不足なら不足点",
  ].join("\n");
  fs.writeFileSync(promptFilePath, `${prompt}\n`, "utf8");

  const result = await new Promise<{ logFilePath: string }>((resolve) => {
    const { logFilePath } = runSelectedExecutor({
      executor: selected.executor,
      codexCommandTemplate: options.codexCommandTemplate,
      claudeCommandTemplate: options.claudeCommandTemplate,
      prompt,
      promptFilePath,
      ownerId: options.ownerId,
      channelId: options.sessionId,
      workdir: options.workdir,
      outputsDir: options.outputsDir,
      onExit: () => resolve({ logFilePath }),
    });
  });

  const logText = fs.existsSync(result.logFilePath)
    ? fs.readFileSync(result.logFilePath, "utf8")
    : "";
  return {
    logText,
    executorName: executorLabel(selected.executor),
  };
}

async function summarizeProjectProbe(
  llm: LlmClient,
  projectName: string,
  executorName: string,
  rawLogText: string,
): Promise<string> {
  const clipped = rawLogText.slice(-7000);
  try {
    const summary = await llm.chat([
      {
        role: "system",
        content: [
          "あなたは初心者向けのプロジェクト解説者です。",
          "専門用語はやさしく言い換えてください。",
          "出力は短い箇条書き3〜5個。",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `対象プロジェクト: ${projectName}`,
          `調査実行器: ${executorName}`,
          "以下の調査ログから、このプロジェクトの理解メモを作成してください。",
          "",
          clipped || "(ログなし)",
        ].join("\n"),
      },
    ]);
    return summary.trim();
  } catch {
    return [
      `- ${projectName} の調査ログを取得しましたが、自動要約に失敗しました。`,
      "- ログファイルを確認して、主要フォルダと機能を手動で確認してください。",
    ].join("\n");
  }
}

export async function resolveProjectContext(
  options: ResolveProjectContextOptions,
): Promise<ResolveProjectContextResult> {
  const projectNames = extractProjectNames(options.messageContent);
  if (projectNames.length === 0) {
    return { contextText: null, resolvedProjects: [] };
  }

  const resolvedProjects: string[] = [];
  for (const projectName of projectNames) {
    if (options.cache.has(projectName)) {
      resolvedProjects.push(projectName);
      continue;
    }

    const probe = await runExecutorForProjectProbe({
      llm: options.llm,
      executorMode: options.executorMode,
      codexCommandTemplate: options.codexCommandTemplate,
      claudeCommandTemplate: options.claudeCommandTemplate,
      projectName,
      workdir: options.workdir,
      outputsDir: options.outputsDir,
      ownerId: options.ownerId,
      sessionId: options.sessionId,
    });
    const summary = await summarizeProjectProbe(
      options.llm,
      projectName,
      probe.executorName,
      probe.logText,
    );
    options.cache.set(projectName, summary);
    resolvedProjects.push(projectName);
  }

  const contextText = resolvedProjects
    .map((name) => `【${name} の理解メモ】\n${options.cache.get(name) ?? "情報なし"}`)
    .join("\n\n");

  return {
    contextText: contextText.length > 0 ? contextText : null,
    resolvedProjects,
  };
}
