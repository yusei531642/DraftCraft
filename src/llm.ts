import { z } from "zod";

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

export type LlmProvider = "ollama" | "lmstudio" | "openai" | "anthropic";

export type LlmConfig = {
  provider: LlmProvider;
  model: string;
  ollamaBaseUrl: string;
  lmstudioBaseUrl: string;
  openaiBaseUrl: string;
  openaiApiKey: string | null;
  anthropicBaseUrl: string;
  anthropicApiKey: string | null;
};

const ollamaResponseSchema = z.object({
  message: z.object({
    content: z.string(),
  }),
});

const openAiResponseSchema = z.object({
  choices: z
    .array(
      z.object({
        message: z.object({
          content: z.union([z.string(), z.array(z.unknown())]).optional(),
        }),
      }),
    )
    .min(1),
});

const anthropicResponseSchema = z.object({
  content: z.array(
    z.object({
      type: z.string(),
      text: z.string().optional(),
    }),
  ),
});

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/$/, "");
}

function extractTextContent(value: string | unknown[] | undefined): string {
  if (typeof value === "string") {
    return value.trim();
  }
  if (!Array.isArray(value)) {
    return "";
  }

  const textParts = value
    .map((part) => {
      if (typeof part === "object" && part && "text" in part) {
        const text = (part as { text?: unknown }).text;
        return typeof text === "string" ? text : "";
      }
      return "";
    })
    .filter((text) => text.length > 0);
  return textParts.join("\n").trim();
}

export class LlmClient {
  private readonly config: LlmConfig;

  constructor(config: LlmConfig) {
    this.config = config;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    if (this.config.provider === "ollama") {
      return this.chatWithOllama(messages);
    }
    if (this.config.provider === "lmstudio") {
      return this.chatWithOpenAiCompatible(
        this.config.lmstudioBaseUrl,
        null,
        messages,
        "LM Studio",
      );
    }
    if (this.config.provider === "openai") {
      if (!this.config.openaiApiKey) {
        throw new Error("OPENAI_API_KEY が未設定です。");
      }
      return this.chatWithOpenAiCompatible(
        this.config.openaiBaseUrl,
        this.config.openaiApiKey,
        messages,
        "OpenAI",
      );
    }
    if (!this.config.anthropicApiKey) {
      throw new Error("ANTHROPIC_API_KEY が未設定です。");
    }
    return this.chatWithAnthropic(messages);
  }

  private async chatWithOllama(messages: ChatMessage[]): Promise<string> {
    const response = await fetch(`${normalizeBaseUrl(this.config.ollamaBaseUrl)}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.model,
        stream: false,
        messages,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama APIエラー: ${response.status} ${body}`);
    }

    const data: unknown = await response.json();
    const parsed = ollamaResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error("Ollama APIレスポンスが想定形式ではありません。");
    }

    return parsed.data.message.content.trim();
  }

  private async chatWithOpenAiCompatible(
    baseUrl: string,
    apiKey: string | null,
    messages: ChatMessage[],
    providerLabel: string,
  ): Promise<string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const response = await fetch(`${normalizeBaseUrl(baseUrl)}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: this.config.model,
        messages,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${providerLabel} APIエラー: ${response.status} ${body}`);
    }

    const data: unknown = await response.json();
    const parsed = openAiResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error(`${providerLabel} APIレスポンスが想定形式ではありません。`);
    }
    const content = extractTextContent(parsed.data.choices[0]?.message.content);
    if (!content) {
      throw new Error(`${providerLabel} APIレスポンスにテキストがありません。`);
    }
    return content;
  }

  private async chatWithAnthropic(messages: ChatMessage[]): Promise<string> {
    const systemMessages = messages
      .filter((message) => message.role === "system")
      .map((message) => message.content);
    const system = systemMessages.join("\n\n").trim();
    const convertedMessages = messages
      .filter((message) => message.role !== "system")
      .map((message) => ({
        role: message.role,
        content: message.content,
      }));

    const response = await fetch(`${normalizeBaseUrl(this.config.anthropicBaseUrl)}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.config.anthropicApiKey ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: this.config.model,
        max_tokens: 2048,
        system: system.length > 0 ? system : undefined,
        messages: convertedMessages,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic APIエラー: ${response.status} ${body}`);
    }

    const data: unknown = await response.json();
    const parsed = anthropicResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error("Anthropic APIレスポンスが想定形式ではありません。");
    }

    const text = parsed.data.content
      .filter((item) => item.type === "text" && typeof item.text === "string")
      .map((item) => item.text ?? "")
      .join("\n")
      .trim();
    if (!text) {
      throw new Error("Anthropic APIレスポンスにテキストがありません。");
    }
    return text;
  }
}
