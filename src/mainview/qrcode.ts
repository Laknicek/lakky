// Pure TypeScript QR Code SVG Generator (Zero dependencies, offline)
// Supports Version 1 to 6 with Byte Mode and Level M Error Correction.

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
let x = 1;
for (let i = 0; i < 255; i++) {
	GF_EXP[i] = x;
	GF_EXP[i + 255] = x;
	GF_LOG[x] = i;
	x <<= 1;
	if (x & 256) x ^= 0x11d;
}

function gfMul(a: number, b: number): number {
	if (a === 0 || b === 0) return 0;
	return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGenPoly(n: number): Uint8Array {
	let poly = new Uint8Array([1]);
	for (let i = 0; i < n; i++) {
		const next = new Uint8Array(poly.length + 1);
		for (let j = 0; j < poly.length; j++) {
			next[j] ^= gfMul(poly[j], GF_EXP[i]);
			next[j + 1] ^= poly[j];
		}
		poly = next;
	}
	return poly;
}

function rsEncode(data: Uint8Array, ecCount: number): Uint8Array {
	const gen = rsGenPoly(ecCount);
	const msg = new Uint8Array(data.length + ecCount);
	msg.set(data);
	for (let i = 0; i < data.length; i++) {
		const coef = msg[i];
		if (coef !== 0) {
			for (let j = 0; j < gen.length; j++) {
				msg[i + j] ^= gfMul(gen[j], coef);
			}
		}
	}
	return msg.subarray(data.length);
}

// Version table for Byte Mode (Level M): [totalCodewords, ecCodewords, dataCapacityBytes]
const VERSION_TABLE: Array<{ ver: number; size: number; totalCw: number; ecCw: number; dataCap: number; align: number[] }> = [
	{ ver: 1, size: 21, totalCw: 26, ecCw: 10, dataCap: 14, align: [] },
	{ ver: 2, size: 25, totalCw: 44, ecCw: 16, dataCap: 26, align: [6, 18] },
	{ ver: 3, size: 29, totalCw: 70, ecCw: 26, dataCap: 42, align: [6, 22] },
	{ ver: 4, size: 33, totalCw: 100, ecCw: 36, dataCap: 62, align: [6, 26] },
	{ ver: 5, size: 37, totalCw: 134, ecCw: 48, dataCap: 84, align: [6, 30] },
	{ ver: 6, size: 41, totalCw: 172, ecCw: 64, dataCap: 106, align: [6, 34] },
];

export function generateQrSvg(text: string, options: { size?: number; fg?: string; bg?: string; rounded?: boolean } = {}): string {
	const utf8 = new TextEncoder().encode(text);
	const len = utf8.length;

	let cfg = VERSION_TABLE[0];
	for (const v of VERSION_TABLE) {
		if (len <= v.dataCap) {
			cfg = v;
			break;
		}
	}

	const dataCwCount = cfg.totalCw - cfg.ecCw;
	const bitStream: number[] = [];

	const appendBits = (val: number, count: number) => {
		for (let i = count - 1; i >= 0; i--) {
			bitStream.push((val >> i) & 1);
		}
	};

	// Byte mode indicator: 0100
	appendBits(0b0100, 4);
	// Character count indicator: 8 bits for ver 1-9
	appendBits(len, 8);
	// Data bytes
	for (let i = 0; i < len; i++) {
		appendBits(utf8[i], 8);
	}
	// Terminator (up to 4 zeroes)
	const remainingBits = dataCwCount * 8 - bitStream.length;
	appendBits(0, Math.min(4, remainingBits));

	// Pad to byte boundary
	while (bitStream.length % 8 !== 0) {
		bitStream.push(0);
	}

	// Pad bytes (0xEC, 0x11 alternating)
	const padBytes = [0xec, 0x11];
	let padIdx = 0;
	while (bitStream.length < dataCwCount * 8) {
		appendBits(padBytes[padIdx % 2], 8);
		padIdx++;
	}

	// Convert bitstream to data codewords
	const dataCodewords = new Uint8Array(dataCwCount);
	for (let i = 0; i < dataCwCount; i++) {
		let byte = 0;
		for (let b = 0; b < 8; b++) {
			byte = (byte << 1) | bitStream[i * 8 + b];
		}
		dataCodewords[i] = byte;
	}

	// Calculate Reed-Solomon Error Correction codewords
	const ecCodewords = rsEncode(dataCodewords, cfg.ecCw);

	// Interleave / Combine data + EC
	const allCodewords = new Uint8Array(cfg.totalCw);
	allCodewords.set(dataCodewords, 0);
	allCodewords.set(ecCodewords, dataCwCount);

	// Build Matrix
	const N = cfg.size;
	const matrix: Array<Array<number | null>> = Array.from({ length: N }, () => Array(N).fill(null));
	const isFunction: boolean[][] = Array.from({ length: N }, () => Array(N).fill(false));

	const setModule = (r: number, c: number, val: number, isFunc = true) => {
		if (r >= 0 && r < N && c >= 0 && c < N) {
			matrix[r][c] = val;
			if (isFunc) isFunction[r][c] = true;
		}
	};

	// 1. Finder patterns (7x7) + separators
	const placeFinder = (startR: number, startC: number) => {
		for (let r = -1; r <= 7; r++) {
			for (let c = -1; c <= 7; c++) {
				const pr = startR + r;
				const pc = startC + c;
				if (pr >= 0 && pr < N && pc >= 0 && pc < N) {
					if (r >= 0 && r <= 6 && c >= 0 && c <= 6) {
						const isBlack = r === 0 || r === 6 || c === 0 || c === 6 || (r >= 2 && r <= 4 && c >= 2 && c <= 4);
						setModule(pr, pc, isBlack ? 1 : 0);
					} else {
						setModule(pr, pc, 0);
					}
				}
			}
		}
	};

	placeFinder(0, 0);
	placeFinder(0, N - 7);
	placeFinder(N - 7, 0);

	// 2. Timing patterns
	for (let i = 8; i < N - 8; i++) {
		const val = i % 2 === 0 ? 1 : 0;
		if (matrix[6][i] === null) setModule(6, i, val);
		if (matrix[i][6] === null) setModule(i, 6, val);
	}

	// 3. Alignment patterns
	if (cfg.align.length > 0) {
		const positions = cfg.align;
		for (const r of positions) {
			for (const c of positions) {
				// Avoid finder pattern areas
				if ((r === 6 && c === 6) || (r === 6 && c === positions[positions.length - 1] && c > N - 10) || (r === positions[positions.length - 1] && r > N - 10 && c === 6)) {
					continue;
				}
				// Draw 5x5 alignment pattern
				for (let dr = -2; dr <= 2; dr++) {
					for (let dc = -2; dc <= 2; dc++) {
						const isBlack = Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0);
						setModule(r + dr, c + dc, isBlack ? 1 : 0);
					}
				}
			}
		}
	}

	// 4. Dark module
	setModule(4 * cfg.ver + 9, 8, 1);

	// 5. Reserve format information areas
	for (let i = 0; i <= 8; i++) {
		if (matrix[8][i] === null) setModule(8, i, 0);
		if (matrix[i][8] === null) setModule(i, 8, 0);
	}
	for (let i = N - 8; i < N; i++) {
		if (matrix[8][i] === null) setModule(8, i, 0);
		if (matrix[i][8] === null) setModule(i, 8, 0);
	}

	// 6. Data placement (zigzag)
	let bitIdx = 0;
	const totalBits = allCodewords.length * 8;
	const getNextBit = () => {
		if (bitIdx >= totalBits) return 0;
		const byte = allCodewords[Math.floor(bitIdx / 8)];
		const bit = (byte >> (7 - (bitIdx % 8))) & 1;
		bitIdx++;
		return bit;
	};

	let dir = -1; // -1 = up, 1 = down
	let col = N - 1;
	while (col > 0) {
		if (col === 6) col--; // Skip vertical timing column
		const rows = dir === -1
			? Array.from({ length: N }, (_, i) => N - 1 - i)
			: Array.from({ length: N }, (_, i) => i);

		for (const r of rows) {
			for (const c of [col, col - 1]) {
				if (!isFunction[r][c] && matrix[r][c] === null) {
					matrix[r][c] = getNextBit();
				}
			}
		}
		dir = -dir;
		col -= 2;
	}

	// 7. Apply Mask (Mask 0: (row + col) % 2 == 0)
	for (let r = 0; r < N; r++) {
		for (let c = 0; c < N; c++) {
			if (!isFunction[r][c]) {
				if ((r + c) % 2 === 0) {
					matrix[r][c] = matrix[r][c] === 1 ? 0 : 1;
				}
			}
		}
	}

	// 8. Format Information: EC Level M (00) + Mask 0 (000) = 00000 -> with BCH + XOR 0x5412 = 0x5412 (101010000010010b)
	const formatBits = 0x5412;
	for (let i = 0; i < 15; i++) {
		const bit = (formatBits >> (14 - i)) & 1;
		if (i < 6) setModule(8, i, bit);
		else if (i === 6) setModule(8, 7, bit);
		else if (i === 7) setModule(8, 8, bit);
		else if (i === 8) setModule(7, 8, bit);
		else setModule(14 - i, 8, bit);

		if (i < 8) setModule(8, N - 1 - i, bit);
		else setModule(N - 15 + i, 8, bit);
	}

	// Generate SVG
	const size = options.size ?? 200;
	const fg = options.fg ?? "#e8e8f5";
	const bg = options.bg ?? "transparent";
	const margin = 2;
	const viewBoxSize = N + margin * 2;

	let paths = "";
	for (let r = 0; r < N; r++) {
		for (let c = 0; c < N; c++) {
			if (matrix[r][c] === 1) {
				const xPos = c + margin;
				const yPos = r + margin;
				paths += `M${xPos},${yPos}h1v1h-1z `;
			}
		}
	}

	return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBoxSize} ${viewBoxSize}" width="${size}" height="${size}" shape-rendering="crispEdges">
		${bg !== "transparent" ? `<rect width="${viewBoxSize}" height="${viewBoxSize}" fill="${bg}" rx="1"/>` : ""}
		<path d="${paths.trim()}" fill="${fg}" />
	</svg>`;
}
