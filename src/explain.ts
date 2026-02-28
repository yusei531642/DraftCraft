import { type LlmClient } from "./llm";

type ExplainExecutorResultOptions = {
  llm: LlmClient;
  executorLabel: string;
  exitCode: number | null;
  logText: string;
};

const MAX_LOG_CHARS = 7000;

function compactLogText(logText: string): string {
  const normalized = logText.replace(/\r\n/g, "\n").trim();
  if (normalized.length <= MAX_LOG_CHARS) {
    return normalized;
  }
  return normalized.slice(-MAX_LOG_CHARS);
}

function fallbackExplanation(executorLabel: string, exitCode: number | null): string {
  if (exitCode === 0) {
    return [
      "やさしい説明:",
      `- ${executorLabel} の実行は成功しました。`,
      "- 変更内容や生成物は、表示されたログファイルを開くと確認できます。",
    ].join("\n");
  }

  return [
    "やさしい説明:",
    `- ${executorLabel} の実行でエラーが出ました。`,
    "- ログの最後のエラーメッセージを確認すると原因がわかります。",
    "- 必要なら、エラーログをそのまま貼って再実行方法を相談してください。",
  ].join("\n");
}

export async function explainExecutorResult(
  options: ExplainExecutorResultOptions,
): Promise<string> {
  const clipped = compactLogText(options.logText);
  const exitCodeText = options.exitCode === null ? "null" : String(options.exitCode);

  try {
    const explanation = await options.llm.chat([
      {
        role: "system",
        content: [
          "あなたは初心者向けの技術通訳です。",
          "難しい用語を避け、やさしい日本語で説明してください。",
          "出力は必ず次の形式:",
          "やさしい説明:",
          "- 何をしたか",
          "- 成功/失敗",
          "- 次にやること（1〜2個）",
          "最大6行。不要な前置きは禁止。",
        ].join("\n"),
      },
      {
        role: "user",
        content: [
          `実行器: ${options.executorLabel}`,
          `exit code: ${exitCodeText}`,
          "以下のログを、プログラミングに不慣れな人にもわかる表現で要約してください。",
          "",
          clipped,
        ].join("\n"),
      },
    ]);

    return explanation.trim();
  } catch {
    return fallbackExplanation(options.executorLabel, options.exitCode);
  }
}
