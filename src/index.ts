async function main(): Promise<void> {
  const mode = (process.argv[2] ?? "cli").toLowerCase();

  if (mode === "cli") {
    const { startCli } = await import("./cli");
    await startCli();
    return;
  }

  if (mode === "bot" || mode === "discord") {
    const { startDiscordBot } = await import("./discord-bot");
    await startDiscordBot();
    return;
  }

  console.error(`不明なモードです: ${mode}`);
  console.error("使い方:");
  console.error("  npm run dev            # CLIモード");
  console.error("  npm run dev -- bot     # Discord Botモード");
  console.error("  npm run start          # CLIモード");
  console.error("  npm run start -- bot   # Discord Botモード");
  process.exit(1);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exit(1);
});
