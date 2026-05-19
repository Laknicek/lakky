// Embeds assets/icon.ico into Electrobun's built launcher.exe / bun.exe binaries.
// Electrobun tries to do this itself during the build but the rcedit path it
// looks for is baked into its CI environment; we run it ourselves against our
// own rcedit install to make the taskbar icon stick.

import { existsSync } from "node:fs";
import { join } from "node:path";

const ICON = "assets/icon.ico";
const ROOT = join(import.meta.dir, "..");

if (!existsSync(join(ROOT, ICON))) {
	console.error(`[embed-icon] Missing ${ICON}. Run 'bun scripts/make-icon.ts' first.`);
	process.exit(0);
}

const candidates = [
	"build/dev-win-x64/Lakky-dev/bin/launcher.exe",
	"build/dev-win-x64/Lakky-dev/bin/bun.exe",
	"build/win-x64/Lakky/bin/launcher.exe",
	"build/win-x64/Lakky/bin/bun.exe",
	"build/canary-win-x64/Lakky-canary/bin/launcher.exe",
	"build/canary-win-x64/Lakky-canary/bin/bun.exe",
	// Legacy paths from the previous app name; kept so existing dev builds
	// still get their icon embedded until the next clean build.
	"build/dev-win-x64/LAKPlayer-dev/bin/launcher.exe",
	"build/dev-win-x64/LAKPlayer-dev/bin/bun.exe",
];

const { rcedit } = await import("rcedit");

let count = 0;
for (const rel of candidates) {
	const abs = join(ROOT, rel);
	if (!existsSync(abs)) continue;
	try {
		await rcedit(abs, { icon: join(ROOT, ICON) });
		console.log(`[embed-icon] ${rel} ← ${ICON}`);
		count++;
	} catch (err) {
		console.warn(`[embed-icon] ${rel} failed: ${(err as Error).message}`);
	}
}

if (count === 0) {
	console.log("[embed-icon] No launcher binaries found yet; skipping.");
}
