// Generates the Lakky Windows .ico from assets/icon-source.jpg. Each ICO
// entry is a Lanczos-downsampled, lossless PNG so every taskbar / explorer
// size renders sharp without relying on Windows' default scaler.
//
// Output:
//   assets/icon.ico       — multi-size 16/24/32/48/64/128/256
//   assets/icon-256.png   — high-res PNG (used as the Linux icon)

import sharp from "sharp";
import { writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..");
const SOURCE = join(ROOT, "assets", "icon-source.jpg");
const OUT_DIR = join(ROOT, "assets");

if (!existsSync(SOURCE)) {
	console.error(`[make-icon] Missing source ${SOURCE}`);
	process.exit(1);
}

// Sizes to embed in the .ico. Windows picks the closest match to whatever
// real-estate the OS is rendering into, so all of these matter (16 for the
// notification tray, 32 for explorer details, 256 for thumbnail previews).
const SIZES = [16, 24, 32, 48, 64, 128, 256];

console.log(`[make-icon] source: ${SOURCE}`);

const images: { size: number; png: Buffer }[] = [];
for (const size of SIZES) {
	const png = await sharp(SOURCE)
		.resize(size, size, {
			fit: "cover",
			kernel: "lanczos3",         // sharp, high-quality downsample
			fastShrinkOnLoad: false,    // disable JPEG-block-aligned pre-shrink
		})
		.png({
			compressionLevel: 9,
			adaptiveFiltering: true,
			palette: false,             // keep 32-bit color, no palette quantization
		})
		.toBuffer();
	images.push({ size, png });
	console.log(`  ${size}×${size}: ${png.length.toLocaleString()} bytes`);
}

// Write the 256 separately for Linux + as a portable fallback.
writeFileSync(join(OUT_DIR, "icon-256.png"), images[images.length - 1].png);

// Tray icon — 32×32 is a good default for Windows hi-DPI (the system picks
// 16/24/32 depending on the bar size and DPI; a 32 source survives both).
const trayPng = await sharp(SOURCE)
	.resize(32, 32, { fit: "cover", kernel: "lanczos3", fastShrinkOnLoad: false })
	.png({ compressionLevel: 9, adaptiveFiltering: true, palette: false })
	.toBuffer();
writeFileSync(join(OUT_DIR, "tray-32.png"), trayPng);
console.log(`[make-icon] wrote tray-32.png (${trayPng.length.toLocaleString()} bytes)`);

// ---------- ICO container ----------
function buildIco(entries: { size: number; png: Buffer }[]): Buffer {
	const count = entries.length;
	const headerLen = 6 + count * 16;
	const header = Buffer.alloc(headerLen);
	header.writeUInt16LE(0, 0);     // reserved
	header.writeUInt16LE(1, 2);     // type 1 = .ICO
	header.writeUInt16LE(count, 4); // image count

	const payloads: Buffer[] = [];
	let dataOffset = headerLen;
	for (let i = 0; i < count; i++) {
		const { size, png } = entries[i];
		const off = 6 + i * 16;
		header.writeUInt8(size >= 256 ? 0 : size, off);     // width (0 = 256)
		header.writeUInt8(size >= 256 ? 0 : size, off + 1); // height
		header.writeUInt8(0, off + 2);                       // palette count
		header.writeUInt8(0, off + 3);                       // reserved
		header.writeUInt16LE(1, off + 4);                    // color planes
		header.writeUInt16LE(32, off + 6);                   // bits per pixel
		header.writeUInt32LE(png.length, off + 8);
		header.writeUInt32LE(dataOffset, off + 12);
		payloads.push(png);
		dataOffset += png.length;
	}
	return Buffer.concat([header, ...payloads]);
}

const ico = buildIco(images);
writeFileSync(join(OUT_DIR, "icon.ico"), ico);
console.log(`[make-icon] wrote icon.ico (${ico.length.toLocaleString()} bytes)`);
console.log(`[make-icon] wrote icon-256.png (${images[images.length - 1].png.length.toLocaleString()} bytes)`);
