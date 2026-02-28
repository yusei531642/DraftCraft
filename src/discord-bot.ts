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
  SlashCommandBuilder,
  type TextChannel,
} from "discord.js";
import { loadDiscordConfig, type DiscordConfig } from "./config";
import {
  executorLabel,
  runSelectedExecutor,
  selectExecutor,
  type ExecutorKey,
  type ExecutorMode,
} from "./executor";
import { LlmClient, type ChatMessage } from "./llm";

const CREATE_SESSION_BUTTON_ID = "draftcraft:create-session";
const FINALIZE_BUTTON_ID = "draftcraft:finalize";
const CLOSE_BUTTON_ID = "draftcraft:close";
const SESSION_TOPIC_PREFIX = "draftcraft-owner:";
const LEGACY_PREFIX_COMMANDS = new Set(["!reset", "!finalize", "!close"]);
const APP_COMMAND_DEFINITIONS = [
  new SlashCommandBuilder()
    .setName("reset")
    .setDescription("このチャンネルの会話履歴を初期化します"),
  new SlashCommandBuilder()
    .setName("engine")
    .setDescription("実行モードを表示/変更します")
    .addStringOption((option) =>
      option
        .setName("mode")
        .setDescription("codex / claude / auto")
        .setRequired(false)
        .addChoices(
          { name: "codex", value: "codex" },
          { name: "claude", value: "claude" },
          { name: "auto", value: "auto" },
        ),
    ),
  new SlashCommandBuilder().setName("finalize").setDescription("最終確定して実行器を起動します"),
  new SlashCommandBuilder().setName("close").setDescription("このセッションチャンネルを閉じます"),
].map((command) => command.toJSON());

type DraftSession = {
  ownerId: string;
  executorMode: ExecutorMode;
  history: ChatMessage[];
  finalizing: boolean;
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

let config: DiscordConfig;
let llm: LlmClient;
let hasStarted = false;

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
    executorMode: config.executorMode,
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
        "そのチャンネルでLLMと会話しながら、Codex/Claude向けの指示文を作成できます。",
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

async function registerAppCommands(): Promise<void> {
  const panelChannelRaw = await client.channels.fetch(config.panelChannelId);
  if (!panelChannelRaw || panelChannelRaw.type !== ChannelType.GuildText) {
    throw new Error("PANEL_CHANNEL_ID は通常のテキストチャンネルを指定してください。");
  }
  if (!client.application) {
    throw new Error("Discordアプリケーション情報を取得できませんでした。");
  }

  const panelChannel = panelChannelRaw as TextChannel;
  await client.application.commands.set(APP_COMMAND_DEFINITIONS, panelChannel.guildId);
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
    executorMode: config.executorMode,
    history: [{ role: "system", content: SYSTEM_PROMPT }],
    finalizing: false,
  };
  sessions.set(channel.id, session);

  const embed = new EmbedBuilder()
    .setTitle("指示文作成セッション")
    .setDescription(
      [
        "このチャンネルで要件を書いてください。LLMが整理を手伝います。",
        `LLM: \`${config.llm.provider}\` / model: \`${config.llm.model}\``,
        "最終的に `最終確定して実行` ボタンでCodex/Claudeを起動します。",
        "スラッシュコマンド: `/engine` `/reset` `/finalize` `/close` を利用できます。",
        `現在の実行モード: \`${session.executorMode}\``,
      ].join("\n"),
    )
    .setColor(0x1f883d);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(FINALIZE_BUTTON_ID)
      .setLabel("最終確定して実行")
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

async function callLlmForChat(channel: TextChannel, userContent: string): Promise<void> {
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
    const response = await llm.chat(session.history);
    session.history.push({ role: "assistant", content: response });
    session.history = trimHistory(session.history, config.maxHistoryMessages);
    await sendLongMessage(channel, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : "不明なエラーです。";
    await channel.send(`LLM連携でエラーが発生しました。\n${message}`);
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
): Promise<{ promptFilePath: string; logFilePath: string; runId: string; executor: ExecutorKey }> {
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

    const prompt = await llm.chat([
      { role: "system", content: FINALIZER_SYSTEM_PROMPT },
      { role: "user", content: historyText },
    ]);

    const promptDir = path.resolve(config.outputsDir, "prompts");
    fs.mkdirSync(promptDir, { recursive: true });
    const promptFilePath = path.resolve(promptDir, `prompt-${timestamp()}-${channel.id}.md`);
    fs.writeFileSync(promptFilePath, `${prompt}\n`, "utf8");
    const selected = await selectExecutor({
      mode: session.executorMode,
      llm,
      historyText,
      codexCommandTemplate: config.codexCommandTemplate,
      claudeCommandTemplate: config.claudeCommandTemplate,
    });

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

    const { runId, logFilePath } = runSelectedExecutor({
      executor: selected.executor,
      codexCommandTemplate: config.codexCommandTemplate,
      claudeCommandTemplate: config.claudeCommandTemplate,
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
            `${executorLabel(selected.executor)} 実行が終了しました。`,
            `exit code: ${codeText}`,
            `log: \`${logFilePath}\``,
          ].join("\n"),
        );
      },
    });

    return { promptFilePath, logFilePath, runId, executor: selected.executor };
  } finally {
    session.finalizing = false;
  }
}

client.once("ready", async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  await ensurePanelMessage();
  await registerAppCommands();
  console.log("Panel message is ready.");
});

client.on("interactionCreate", async (interaction) => {
  if (interaction.isChatInputCommand()) {
    if (!interaction.channel || interaction.channel.type !== ChannelType.GuildText) {
      await interaction.reply({
        content: "このコマンドはテキストチャンネル内でのみ実行できます。",
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

    if (interaction.commandName === "reset") {
      session.history = [{ role: "system", content: SYSTEM_PROMPT }];
      await interaction.reply({ content: "会話履歴を初期化しました。", ephemeral: true });
      return;
    }

    if (interaction.commandName === "engine") {
      const requestedMode = interaction.options.getString("mode");
      if (!requestedMode) {
        await interaction.reply({
          content: `現在の実行モード: \`${session.executorMode}\``,
          ephemeral: true,
        });
        return;
      }
      if (requestedMode !== "codex" && requestedMode !== "claude" && requestedMode !== "auto") {
        await interaction.reply({
          content: "無効なモードです。`codex` `claude` `auto` から選択してください。",
          ephemeral: true,
        });
        return;
      }

      session.executorMode = requestedMode;
      await interaction.reply({
        content: `実行モードを \`${session.executorMode}\` に変更しました。`,
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === "finalize") {
      await interaction.deferReply({ ephemeral: true });
      try {
        const result = await finalizeAndRun(channel, interaction.user.id);
        await interaction.editReply(
          [
            "最終確定を実行しました。",
            `executor: \`${result.executor}\` (${executorLabel(result.executor)})`,
            `run id: \`${result.runId}\``,
            `prompt: \`${result.promptFilePath}\``,
            `log: \`${result.logFilePath}\``,
          ].join("\n"),
        );
        await channel.send(
          `<@${interaction.user.id}> ${executorLabel(result.executor)} 実行を開始しました。run id: \`${result.runId}\``,
        );
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "不明なエラーです。";
        await interaction.editReply(`最終確定に失敗しました。\n${errorMessage}`);
      }
      return;
    }

    if (interaction.commandName === "close") {
      await interaction.reply({ content: "チャンネルを閉じます。", ephemeral: true });
      sessions.delete(channel.id);
      await channel.delete("DraftCraft session closed by owner");
      return;
    }

    return;
  }

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
          `executor: \`${result.executor}\` (${executorLabel(result.executor)})`,
          `run id: \`${result.runId}\``,
          `prompt: \`${result.promptFilePath}\``,
          `log: \`${result.logFilePath}\``,
        ].join("\n"),
      );
      await channel.send(
        `<@${interaction.user.id}> ${executorLabel(result.executor)} 実行を開始しました。run id: \`${result.runId}\``,
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
  const trimmed = message.content.trim();
  if (!trimmed) return;

  if (LEGACY_PREFIX_COMMANDS.has(trimmed)) {
    await channel.send(
      "`!`コマンドは廃止しました。`/engine` `/reset` `/finalize` `/close` を使ってください。",
    );
    return;
  }

  await callLlmForChat(channel, trimmed);
});

client.on("channelDelete", (channel) => {
  sessions.delete(channel.id);
  processingChannels.delete(channel.id);
});

export async function startDiscordBot(): Promise<void> {
  if (hasStarted) {
    throw new Error("Discord Botはすでに起動済みです。");
  }
  hasStarted = true;

  config = loadDiscordConfig();
  llm = new LlmClient(config.llm);

  try {
    await client.login(config.discordBotToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : "不明なエラーです。";
    throw new Error(`Bot起動に失敗しました: ${message}`);
  }
}
