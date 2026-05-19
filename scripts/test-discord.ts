// Standalone Discord IPC sanity check using our own client.
//   bun scripts/test-discord.ts

process.env.LAK_DISCORD_DEBUG = "1";
const { setDiscordPresence } = await import("../src/bun/discord.ts");

console.log("=== Discord RPC diagnostic ===");
console.log(`Bun: ${Bun.version}, platform: ${process.platform}`);

const result = await setDiscordPresence({
	details: "Lakky",
	state: "Diagnostic test",
	startTimestamp: Math.floor(Date.now() / 1000),
	largeImageKey: "lak_logo",
	largeImageText: "Lakky",
	smallImageKey: "play",
	smallImageText: "Playing",
});

console.log("\nResult:", result);
console.log("\nIf connected:true, look at your Discord profile — the activity should be live.");
console.log("Press Ctrl+C to exit (the activity will clear automatically).");

// Keep the process alive briefly so the user can see it on Discord.
await new Promise((r) => setTimeout(r, 20000));
await setDiscordPresence(null);
process.exit(0);
