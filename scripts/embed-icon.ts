// Post-build: ensure Electrobun's launcher binaries have a `.exe` extension
// (the stable build emits an extension-less binary which Windows refuses to
// CreateProcess) and embed assets/icon.ico into them so the taskbar icon
// sticks. Electrobun tries to embed the icon itself during build but the
// rcedit path it resolves is baked into its CI environment, so we re-do it
// against our own rcedit install.

import { existsSync, renameSync } from "node:fs";
import { join } from "node:path";

const ICON = "assets/icon.ico";
const ROOT = join(import.meta.dir, "..");

if (!existsSync(join(ROOT, ICON))) {
	console.error(`[embed-icon] Missing ${ICON}. Run 'bun scripts/make-icon.ts' first.`);
	process.exit(0);
}

// Every place a launcher / bun binary might land. Stable / canary / dev each
// produce their own folder. We rename extension-less binaries to `.exe` if
// found, then embed the icon.
const candidates = [
	"build/dev-win-x64/Lakky-dev/bin/launcher",
	"build/dev-win-x64/Lakky-dev/bin/bun",
	"build/stable-win-x64/Lakky/bin/launcher",
	"build/stable-win-x64/Lakky/bin/bun",
	"build/canary-win-x64/Lakky-canary/bin/launcher",
	"build/canary-win-x64/Lakky-canary/bin/bun",
];

const { rcedit } = await import("rcedit");

let count = 0;
for (const baseRel of candidates) {
	const baseAbs = join(ROOT, baseRel);
	const exeAbs = `${baseAbs}.exe`;
	let target: string | null = null;
	if (existsSync(exeAbs)) {
		target = exeAbs;
	} else if (existsSync(baseAbs)) {
		renameSync(baseAbs, exeAbs);
		console.log(`[embed-icon] renamed ${baseRel} → ${baseRel}.exe`);
		target = exeAbs;
	}
	if (!target) continue;
	try {
		await rcedit(target, { icon: join(ROOT, ICON) });
		console.log(`[embed-icon] ${baseRel}.exe ← ${ICON}`);
		count++;
	} catch (err) {
		console.warn(`[embed-icon] ${baseRel}.exe failed: ${(err as Error).message}`);
	}
}

if (count === 0) {
	console.log("[embed-icon] No launcher binaries found yet; skipping.");
}
