import { z } from "zod";

export type ChatRole = "system" | "user" | "assistant";

export type ChatMessage = {
  role: ChatRole;
  content: string;
};

type OllamaClientOptions = {
  baseUrl: string;
  model: string;
};

const chatResponseSchema = z.object({
  message: z.object({
    role: z.string(),
    content: z.string(),
  }),
});

export class OllamaClient {
  private readonly baseUrl: string;
  private readonly model: string;

  constructor(options: OllamaClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.model = options.model;
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Ollama APIエラー: ${response.status} ${body}`);
    }

    const data: unknown = await response.json();
    const parsed = chatResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error("Ollama APIレスポンスが想定形式ではありません。");
    }

    return parsed.data.message.content.trim();
  }
}
