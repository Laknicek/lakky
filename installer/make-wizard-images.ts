// Builds the two PNG images the Inno Setup installer uses for branding:
//   wizard-side.png   164×314   left-side panel on Welcome/Finish pages
//   wizard-small.png   55× 58   small icon on every other wizard page
//
// Run:  bun installer/make-wizard-images.ts

import sharp from "sharp";
import { join } from "node:path";
import { existsSync } from "node:fs";

const ROOT = join(import.meta.dir, "..");
const SOURCE = join(ROOT, "assets", "icon-source.jpg");
const OUT_DIR = join(ROOT, "installer");

if (!existsSync(SOURCE)) {
	console.error(`Missing ${SOURCE} — run scripts/make-icon.ts first.`);
	process.exit(1);
}

async function gradient(w: number, h: number) {
	// Vertical gradient from deep purple to near-black. Sharp doesn't have a
	// native gradient generator, so we build one row-by-row in raw RGBA.
	const buf = Buffer.alloc(w * h * 4);
	for (let y = 0; y < h; y++) {
		const t = y / (h - 1);
		const r = Math.round(26 * (1 - t) + 10 * t);
		const g = Math.round(14 * (1 - t) + 10 * t);
		const b = Math.round(46 * (1 - t) + 20 * t);
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4;
			buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
		}
	}
	return sharp(buf, { raw: { width: w, height: h, channels: 4 } });
}

// --- Side image: 164×314 with the logo near the top half + gradient ---
{
	const W = 164, H = 314;
	const LOGO = 132;
	const logoBuf = await sharp(SOURCE)
		.resize(LOGO, LOGO, { fit: "cover", kernel: "lanczos3" })
		.png({ compressionLevel: 9 })
		.toBuffer();
	await (await gradient(W, H))
		.composite([{
			input: logoBuf,
			left: Math.round((W - LOGO) / 2),
			top: 32,
		}])
		.png({ compressionLevel: 9 })
		.toFile(join(OUT_DIR, "wizard-side.png"));
	console.log(`wrote installer/wizard-side.png (${W}×${H})`);
}

// --- Small image: 55×58 with the logo centered ---
{
	const W = 55, H = 58;
	const LOGO = 48;
	const logoBuf = await sharp(SOURCE)
		.resize(LOGO, LOGO, { fit: "cover", kernel: "lanczos3" })
		.png({ compressionLevel: 9 })
		.toBuffer();
	await (await gradient(W, H))
		.composite([{
			input: logoBuf,
			left: Math.round((W - LOGO) / 2),
			top: Math.round((H - LOGO) / 2),
		}])
		.png({ compressionLevel: 9 })
		.toFile(join(OUT_DIR, "wizard-small.png"));
	console.log(`wrote installer/wizard-small.png (${W}×${H})`);
}
