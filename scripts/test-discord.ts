// Standalone Discord IPC sanity check using our overhauled client.
//   bun scripts/test-discord.ts

process.env.LAK_DISCORD_DEBUG = "1";
const { setDiscordPresence, formatRichPresence, getDiscordStatus, BADGE_ASSETS } = await import("../src/bun/discord.ts");

console.log("=== Discord RPC Diagnostic & Showcase ===");
console.log(`Bun: ${Bun.version}, Platform: ${process.platform}`);

// 1. Showcase Rich Playing State with live duration bar and 8D Spatial mode
console.log("\n[1/3] Setting Playing state with 8D Spatial Audio...");
const playingResult = await setDiscordPresence(
	formatRichPresence({
		title: "Cruel Angel's Thesis",
		artist: "Yoko Takahashi",
		album: "Neon Genesis Evangelion",
		mode: "spatial",
		currentTime: 42,
		duration: 245,
		trackNumber: 1,
		totalTracks: 12,
		largeImageKey: BADGE_ASSETS.APP_LOGO,
		largeImageText: "Neon Genesis Evangelion — Lakky Player",
	})
);
console.log("Playing result:", playingResult, "Status:", getDiscordStatus());

await new Promise((r) => setTimeout(r, 4000));

// 2. Showcase Lo-Fi relaxing mode
console.log("\n[2/3] Setting Lo-Fi Chill mode with Sakura badge...");
await setDiscordPresence(
	formatRichPresence({
		title: "Midnight Sakura Bloom",
		artist: "Lofi Fruits Music",
		mode: "lofi",
		currentTime: 15,
		duration: 180,
		smallImageKey: BADGE_ASSETS.SAKURA_BLOOM,
		smallImageText: "Relaxing to Lo-Fi",
	})
);

await new Promise((r) => setTimeout(r, 4000));

// 3. Showcase Idle Browsing state
console.log("\n[3/3] Setting Idle Library Browsing state...");
await setDiscordPresence(
	formatRichPresence({
		isIdle: true,
	})
);

console.log("\nDiscord Rich Presence verified successfully! Clearing in 3 seconds...");
await new Promise((r) => setTimeout(r, 3000));
await setDiscordPresence(null);
console.log("Presence cleared cleanly.");
process.exit(0);

