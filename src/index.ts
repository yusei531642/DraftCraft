import fs from "node:fs";
import path from "node:path";
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  PermissionsBitField,
  type Message,
  type TextChannel,
} from "discord.js";
import { loadConfig } from "./config";
import { runCodex } from "./codex-runner";
import { OllamaClient, type ChatMessage } from "./ollama";

const CREATE_SESSION_BUTTON_ID = "draftcraft:create-session";
const FINALIZE_BUTTON_ID = "draftcraft:finalize";
const CLOSE_BUTTON_ID = "draftcraft:close";
const SESSION_TOPIC_PREFIX = "draftcraft-owner:";

type DraftSession = {
  ownerId: string;
  history: ChatMessage[];
  finalizing: boolean;
};

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

const config = loadConfig();
const ollama = new OllamaClient({
  baseUrl: config.ollamaBaseUrl,
  model: config.ollamaModel,
});

const sessions = new Map<string, DraftSession>();
const processingChannels = new Set<string>();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

function chunkText(input: string, maxLength = 1900): string[] {
  if (input.length <= maxLength) return [input];
  const chunks: string[] = [];
  let remaining = input;
  while (remaining.length > maxLength) {
    const chunk = remaining.slice(0, maxLength);
    chunks.push(chunk);
    remaining = remaining.slice(maxLength);
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

async function sendLongMessage(channel: TextChannel, content: string): Promise<void> {
  const chunks = chunkText(content);
  for (const chunk of chunks) {
    await channel.send(chunk);
  }
}

async function sendLongCodeBlock(channel: TextChannel, content: string): Promise<void> {
  const safe = content.replaceAll("```", "'''");
  const chunks = chunkText(safe, 1700);
  for (const chunk of chunks) {
    await channel.send(`\`\`\`text\n${chunk}\n\`\`\``);
  }
}

function trimHistory(history: ChatMessage[], maxHistoryMessages: number): ChatMessage[] {
  if (history.length <= maxHistoryMessages + 1) {
    return history;
  }

  const system = history[0] ?? { role: "system", content: SYSTEM_PROMPT };
  const rest = history.slice(1);
  return [system, ...rest.slice(-maxHistoryMessages)];
}

function extractOwnerId(topic: string | null): string | null {
  if (!topic) return null;
  if (!topic.startsWith(SESSION_TOPIC_PREFIX)) return null;
  const ownerId = topic.slice(SESSION_TOPIC_PREFIX.length).trim();
  return ownerId.length > 0 ? ownerId : null;
}

function ensureSession(channel: TextChannel): DraftSession | null {
  const current = sessions.get(channel.id);
  if (current) return current;

  const ownerId = extractOwnerId(channel.topic);
  if (!ownerId) return null;

  const created: DraftSession = {
    ownerId,
    history: [{ role: "system", content: SYSTEM_PROMPT }],
    finalizing: false,
  };
  sessions.set(channel.id, created);
  return created;
}

function formatHistoryForFinalizer(history: ChatMessage[]): string {
  return history
    .filter((msg) => msg.role !== "system")
    .map((msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`)
    .join("\n\n");
}

async function ensurePanelMessage(): Promise<void> {
  const panelChannelRaw = await client.channels.fetch(config.panelChannelId);
  if (!panelChannelRaw || panelChannelRaw.type !== ChannelType.GuildText) {
    throw new Error("PANEL_CHANNEL_ID は通常のテキストチャンネルを指定してください。");
  }

  const panelChannel = panelChannelRaw as TextChannel;
  const messages = await panelChannel.messages.fetch({ limit: 50 });
  const existingPanel = messages.find(
    (msg) =>
      msg.author.id === client.user?.id && msg.embeds.some((embed) => embed.title === "DraftCraft"),
  );
  if (existingPanel) {
    return;
  }

  const embed = new EmbedBuilder()
    .setTitle("DraftCraft")
    .setDescription(
      [
        "ボタンを押すと、あなただけの作業チャンネルを作成します。",
        "そのチャンネルでOllamaと会話しながら、CodexCLI向けの指示文を作成できます。",
      ].join("\n"),
    )
    .setColor(0x2f81f7);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(CREATE_SESSION_BUTTON_ID)
      .setLabel("作業チャンネルを作成")
      .setStyle(ButtonStyle.Primary),
  );

  await panelChannel.send({
    embeds: [embed],
    components: [row],
  });
}

async function createSessionChannel(guildId: string, ownerId: string): Promise<TextChannel> {
  const guild = await client.guilds.fetch(guildId);
  const category = await guild.channels.fetch(config.sessionCategoryId);

  if (!category || category.type !== ChannelType.GuildCategory) {
    throw new Error("SESSION_CATEGORY_ID はカテゴリチャンネルを指定してください。");
  }

  const suffix = Date.now().toString().slice(-4);
  const channel = await guild.channels.create({
    name: `draft-${suffix}`,
    type: ChannelType.GuildText,
    parent: category.id,
    topic: `${SESSION_TOPIC_PREFIX}${ownerId}`,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionsBitField.Flags.ViewChannel],
      },
      {
        id: ownerId,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
        ],
      },
      {
        id: client.user!.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.ManageChannels,
        ],
      },
    ],
  });

  const session: DraftSession = {
    ownerId,
    history: [{ role: "system", content: SYSTEM_PROMPT }],
    finalizing: false,
  };
  sessions.set(channel.id, session);

  const embed = new EmbedBuilder()
    .setTitle("指示文作成セッション")
    .setDescription(
      [
        "このチャンネルで要件を書いてください。Ollamaが整理を手伝います。",
        "最終的に `最終確定してCodexCLI実行` ボタンでCodexCLIを起動します。",
        "コマンド: `!reset` で会話履歴を初期化。",
      ].join("\n"),
    )
    .setColor(0x1f883d);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(FINALIZE_BUTTON_ID)
      .setLabel("最終確定してCodexCLI実行")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(CLOSE_BUTTON_ID)
      .setLabel("チャンネルを閉じる")
      .setStyle(ButtonStyle.Danger),
  );

  await channel.send({
    content: `<@${ownerId}> セッションを開始しました。`,
    embeds: [embed],
    components: [row],
  });

  return channel;
}

async function callOllamaForChat(channel: TextChannel, userContent: string): Promise<void> {
  const session = ensureSession(channel);
  if (!session) return;

  if (processingChannels.has(channel.id)) {
    await channel.send("前の応答を処理中です。少し待ってから送ってください。");
    return;
  }

  processingChannels.add(channel.id);
  try {
    session.history.push({ role: "user", content: userContent });
    session.history = trimHistory(session.history, config.maxHistoryMessages);
    await channel.sendTyping();
    const response = await ollama.chat(session.history);
    session.history.push({ role: "assistant", content: response });
    session.history = trimHistory(session.history, config.maxHistoryMessages);
    await sendLongMessage(channel, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "不明なエラーです。";
    await channel.send(`Ollama連携でエラーが発生しました。\n${message}`);
  } finally {
    processingChannels.delete(channel.id);
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function finalizeAndRun(
  channel: TextChannel,
  ownerId: string,
): Promise<{ promptFilePath: string; logFilePath: string; runId: string }> {
  const session = ensureSession(channel);
  if (!session) {
    throw new Error("このチャンネルはDraftCraftセッションとして初期化されていません。");
  }
  if (session.ownerId !== ownerId) {
    throw new Error("このセッションを確定できるのは作成者のみです。");
  }
  if (session.finalizing) {
    throw new Error("現在、最終確定を処理中です。");
  }

  session.finalizing = true;
  try {
    const historyText = formatHistoryForFinalizer(session.history);
    if (!historyText) {
      throw new Error("会話履歴が空のため最終確定できません。");
    }

    const prompt = await ollama.chat([
      { role: "system", content: FINALIZER_SYSTEM_PROMPT },
      { role: "user", content: historyText },
    ]);

    const promptDir = path.resolve(config.outputsDir, "prompts");
    fs.mkdirSync(promptDir, { recursive: true });
    const promptFilePath = path.resolve(promptDir, `prompt-${timestamp()}-${channel.id}.md`);
    fs.writeFileSync(promptFilePath, `${prompt}\n`, "utf8");

    let streamBuffer = "";
    let flushTimer: NodeJS.Timeout | null = null;
    let flushing = false;

    const flushStream = async (force: boolean): Promise<void> => {
      if (flushing) return;
      if (!force && streamBuffer.length < 1200) return;

      const output = streamBuffer.trim();
      streamBuffer = "";
      if (!output) return;

      flushing = true;
      try {
        await sendLongCodeBlock(channel, output);
      } finally {
        flushing = false;
      }
    };

    const scheduleFlush = (): void => {
      if (flushTimer) return;
      flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushStream(true);
      }, 2000);
    };

    const { runId, logFilePath } = runCodex({
      commandTemplate: config.codexCommandTemplate,
      prompt,
      promptFilePath,
      ownerId,
      channelId: channel.id,
      workdir: config.codexWorkdir,
      outputsDir: config.outputsDir,
      onLog: (cleanChunk) => {
        streamBuffer += cleanChunk;
        if (streamBuffer.length >= 1200) {
          if (flushTimer) {
            clearTimeout(flushTimer);
            flushTimer = null;
          }
          void flushStream(true);
          return;
        }
        scheduleFlush();
      },
      onExit: async (code) => {
        if (flushTimer) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        await flushStream(true);
        const codeText = code === null ? "null" : String(code);
        await channel.send(
          [
            `CodexCLI実行が終了しました。`,
            `exit code: ${codeText}`,
            `log: \`${logFilePath}\``,
          ].join("\n"),
        );
      },
    });

    return { promptFilePath, logFilePath, runId };
  } finally {
    session.finalizing = false;
  }
}

async function handleSessionCommand(message: Message): Promise<boolean> {
  if (message.channel.type !== ChannelType.GuildText) return false;
  const channel = message.channel as TextChannel;
  const session = ensureSession(channel);
  if (!session || message.author.id !== session.ownerId) {
    return false;
  }

  const trimmed = message.content.trim();
  if (trimmed === "!reset") {
    session.history = [{ role: "system", content: SYSTEM_PROMPT }];
    await channel.send("会話履歴を初期化しました。");
    return true;
  }
  if (trimmed === "!finalize") {
    await channel.send("最終指示文を生成して、CodexCLI実行を開始します...");
    try {
      const result = await finalizeAndRun(channel, message.author.id);
      await channel.send(
        [
          "最終確定を実行しました。",
          `run id: \`${result.runId}\``,
          `prompt: \`${result.promptFilePath}\``,
          `log: \`${result.logFilePath}\``,
        ].join("\n"),
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "不明なエラーです。";
      await channel.send(`最終確定に失敗しました。\n${errorMessage}`);
    }
    return true;
  }
  if (trimmed === "!close") {
    await channel.send("チャンネルを閉じます。");
    sessions.delete(channel.id);
    await channel.delete("DraftCraft session closed by owner");
    return true;
  }
  return false;
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  await ensurePanelMessage();
  console.log("Panel message is ready.");
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isButton()) return;

  if (interaction.customId === CREATE_SESSION_BUTTON_ID) {
    await interaction.deferReply({ ephemeral: true });
    try {
      if (!interaction.guildId) {
        throw new Error("サーバー内でのみ使用できます。");
      }
      const channel = await createSessionChannel(interaction.guildId, interaction.user.id);
      await interaction.editReply(`作業チャンネルを作成しました: <#${channel.id}>`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "不明なエラーです。";
      await interaction.editReply(`作業チャンネル作成に失敗しました。\n${errorMessage}`);
    }
    return;
  }

  if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
    await interaction.reply({
      content: "この操作はテキストチャンネル内でのみ可能です。",
      ephemeral: true,
    });
    return;
  }

  const channel = interaction.channel as TextChannel;
  const session = ensureSession(channel);

  if (!session) {
    await interaction.reply({
      content: "このチャンネルはDraftCraftセッションではありません。",
      ephemeral: true,
    });
    return;
  }
  if (interaction.user.id !== session.ownerId) {
    await interaction.reply({
      content: "この操作はチャンネル作成者のみ実行できます。",
      ephemeral: true,
    });
    return;
  }

  if (interaction.customId === FINALIZE_BUTTON_ID) {
    await interaction.deferReply({ ephemeral: true });
    try {
      const result = await finalizeAndRun(channel, interaction.user.id);
      await interaction.editReply(
        [
          "最終確定を実行しました。",
          `run id: \`${result.runId}\``,
          `prompt: \`${result.promptFilePath}\``,
          `log: \`${result.logFilePath}\``,
        ].join("\n"),
      );
      await channel.send(
        `<@${interaction.user.id}> CodexCLI実行を開始しました。run id: \`${result.runId}\``,
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "不明なエラーです。";
      await interaction.editReply(`最終確定に失敗しました。\n${errorMessage}`);
    }
    return;
  }

  if (interaction.customId === CLOSE_BUTTON_ID) {
    await interaction.reply({ content: "チャンネルを閉じます。", ephemeral: true });
    sessions.delete(channel.id);
    await channel.delete("DraftCraft session closed by owner");
  }
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (message.channel.type !== ChannelType.GuildText) return;

  const channel = message.channel as TextChannel;
  const session = ensureSession(channel);
  if (!session) return;
  if (message.author.id !== session.ownerId) return;

  const handledCommand = await handleSessionCommand(message);
  if (handledCommand) return;

  if (!message.content.trim()) return;
  await callOllamaForChat(channel, message.content.trim());
});

client.on("channelDelete", (channel) => {
  sessions.delete(channel.id);
  processingChannels.delete(channel.id);
});

client.login(config.discordBotToken).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "不明なエラーです。";
  console.error(`Bot起動に失敗しました: ${message}`);
  process.exit(1);
});
