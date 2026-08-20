import { open, stat, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { extname, basename } from "node:path";

export interface ScanResult {
	safe: boolean;
	score: number; // 0 = malicious/critical, 100 = completely clean
	threats: string[];
	mimeDetected: string;
	sha256: string;
	fileSize: number;
	verifiedFormat: string | null;
	isPolyglot: boolean;
	hasEmbeddedExecutable: boolean;
}

// Known dangerous executable and script magic byte signatures
const DISGUISED_EXECUTABLE_SIGNATURES: Array<{
	name: string;
	description: string;
	offset?: number;
	match: (buf: Buffer) => boolean;
}> = [
	{
		name: "PE_EXE_DLL",
		description: "Windows Portable Executable (EXE/DLL/SYS/SCR/CPL)",
		match: (buf) => {
			if (buf.length < 64) return false;
			// MZ header
			if (buf[0] === 0x4d && buf[1] === 0x5a) {
				const peOffset = buf.readUInt32LE(0x3c);
				if (peOffset > 0 && peOffset + 4 <= buf.length) {
					// "PE\0\0"
					return (
						buf[peOffset] === 0x50 &&
						buf[peOffset + 1] === 0x45 &&
						buf[peOffset + 2] === 0x00 &&
						buf[peOffset + 3] === 0x00
					);
				}
				// Even if PE header is deep, bare MZ DOS stub is suspicious in media files
				return true;
			}
			return false;
		},
	},
	{
		name: "ELF_BINARY",
		description: "Linux/UNIX Executable (ELF)",
		match: (buf) =>
			buf.length >= 4 &&
			buf[0] === 0x7f &&
			buf[1] === 0x45 &&
			buf[2] === 0x4c &&
			buf[3] === 0x46,
	},
	{
		name: "MACHO_BINARY",
		description: "macOS Mach-O Executable",
		match: (buf) =>
			buf.length >= 4 &&
			((buf[0] === 0xfe && buf[1] === 0xed && buf[2] === 0xfa && (buf[3] === 0xce || buf[3] === 0xcf)) ||
				(buf[0] === 0xcf && buf[1] === 0xfa && buf[2] === 0xed && buf[3] === 0xfe) ||
				(buf[0] === 0xca && buf[1] === 0xfe && buf[2] === 0xba && buf[3] === 0xbe)), // Fat binary
	},
	{
		name: "SHELL_SCRIPT",
		description: "UNIX Shell script with shebang",
		match: (buf) =>
			buf.length >= 2 &&
			buf[0] === 0x23 &&
			buf[1] === 0x21, // "#!"
	},
	{
		name: "WINDOWS_LNK",
		description: "Windows Shell Shortcut (.lnk) payload",
		match: (buf) =>
			buf.length >= 20 &&
			buf[0] === 0x4c &&
			buf[1] === 0x00 &&
			buf[2] === 0x00 &&
			buf[3] === 0x00 &&
			buf[4] === 0x01 &&
			buf[5] === 0x14 &&
			buf[6] === 0x02 &&
			buf[7] === 0x00,
	},
	{
		name: "MSI_COMPOUND",
		description: "Microsoft Compound File (MSI / Office Macro payload)",
		match: (buf) =>
			buf.length >= 8 &&
			buf[0] === 0xd0 &&
			buf[1] === 0xcf &&
			buf[2] === 0x11 &&
			buf[3] === 0xe0 &&
			buf[4] === 0xa1 &&
			buf[5] === 0xb1 &&
			buf[6] === 0x1a &&
			buf[7] === 0xe1,
	},
	{
		name: "JAVA_CLASS",
		description: "Java Class bytecode",
		match: (buf) =>
			buf.length >= 4 &&
			buf[0] === 0xca &&
			buf[1] === 0xfe &&
			buf[2] === 0xba &&
			buf[3] === 0xbe,
	},
];

// Legitimate media magic byte definitions
interface MediaFormatSig {
	ext: string[];
	mime: string;
	verify: (buf: Buffer) => boolean;
}

const MEDIA_SIGNATURES: MediaFormatSig[] = [
	// MP3 with ID3v2 header: "ID3"
	{
		ext: [".mp3"],
		mime: "audio/mpeg",
		verify: (buf) =>
			(buf.length >= 3 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) ||
			// Raw MP3 sync frame (11 bits set: 0xFF followed by 0xFB, 0xF3, 0xF2)
			(buf.length >= 2 && buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0),
	},
	// FLAC: "fLaC"
	{
		ext: [".flac"],
		mime: "audio/flac",
		verify: (buf) =>
			buf.length >= 4 &&
			buf[0] === 0x66 &&
			buf[1] === 0x4c &&
			buf[2] === 0x61 &&
			buf[3] === 0x43,
	},
	// OGG container (Vorbis, Opus, Speex, Theora, FLAC-in-Ogg): "OggS"
	{
		ext: [".ogg", ".oga", ".opus", ".ogv", ".spx"],
		mime: "audio/ogg",
		verify: (buf) =>
			buf.length >= 4 &&
			buf[0] === 0x4f &&
			buf[1] === 0x67 &&
			buf[2] === 0x67 &&
			buf[3] === 0x53,
	},
	// WAV / AIFF (RIFF container)
	{
		ext: [".wav", ".wave", ".avi"],
		mime: "audio/wav",
		verify: (buf) =>
			buf.length >= 12 &&
			buf[0] === 0x52 &&
			buf[1] === 0x49 &&
			buf[2] === 0x46 &&
			buf[3] === 0x46 && // "RIFF"
			((buf[8] === 0x57 && buf[9] === 0x41 && buf[10] === 0x56 && buf[11] === 0x45) || // "WAVE"
				(buf[8] === 0x41 && buf[9] === 0x56 && buf[10] === 0x49 && buf[11] === 0x20)), // "AVI "
	},
	// AIFF: "FORM" ... "AIFF"
	{
		ext: [".aiff", ".aif", ".aifc"],
		mime: "audio/aiff",
		verify: (buf) =>
			buf.length >= 12 &&
			buf[0] === 0x46 &&
			buf[1] === 0x4f &&
			buf[2] === 0x52 &&
			buf[3] === 0x4d && // "FORM"
			buf[8] === 0x41 &&
			buf[9] === 0x49 &&
			buf[10] === 0x46 &&
			buf[11] === 0x46, // "AIFF"
	},
	// MP4 / M4A / M4V / MOV (ISO Base Media File / ftyp atom)
	{
		ext: [".mp4", ".m4a", ".m4v", ".mov", ".3gp", ".3g2", ".alac", ".aac"],
		mime: "video/mp4",
		verify: (buf) => {
			if (buf.length < 8) return false;
			// Atom type at offset 4: "ftyp", "moov", "mdat", "free", "skip", "wide"
			const atom = buf.subarray(4, 8).toString("ascii");
			return (
				atom === "ftyp" ||
				atom === "moov" ||
				atom === "mdat" ||
				atom === "free" ||
				atom === "wide" ||
				atom === "skip"
			);
		},
	},
	// Matroska / WebM: EBML header (0x1A 0x45 0xDF 0xA3)
	{
		ext: [".mkv", ".mka", ".webm"],
		mime: "video/webm",
		verify: (buf) =>
			buf.length >= 4 &&
			buf[0] === 0x1a &&
			buf[1] === 0x45 &&
			buf[2] === 0xdf &&
			buf[3] === 0xa3,
	},
	// AAC ADTS stream (0xFFF...)
	{
		ext: [".aac"],
		mime: "audio/aac",
		verify: (buf) =>
			buf.length >= 2 &&
			buf[0] === 0xff &&
			(buf[1] & 0xf6) === 0xf0,
	},
	// Windows Media (ASF / WMA / WMV): 30 26 B2 75 8E 66 CF 11 A6 D9 00 AA 00 62 CE 6C
	{
		ext: [".wma", ".wmv", ".asf"],
		mime: "audio/x-ms-wma",
		verify: (buf) =>
			buf.length >= 16 &&
			buf[0] === 0x30 &&
			buf[1] === 0x26 &&
			buf[2] === 0xb2 &&
			buf[3] === 0x75 &&
			buf[4] === 0x8e &&
			buf[5] === 0x66 &&
			buf[6] === 0xcf &&
			buf[7] === 0x11,
	},
	// Monkey's Audio: "MAC "
	{
		ext: [".ape"],
		mime: "audio/ape",
		verify: (buf) =>
			buf.length >= 4 &&
			buf[0] === 0x4d &&
			buf[1] === 0x41 &&
			buf[2] === 0x43 &&
			buf[3] === 0x20,
	},
	// WavPack: "wvpk"
	{
		ext: [".wv"],
		mime: "audio/wavpack",
		verify: (buf) =>
			buf.length >= 4 &&
			buf[0] === 0x77 &&
			buf[1] === 0x76 &&
			buf[2] === 0x70 &&
			buf[3] === 0x6b,
	},
	// DSD / DSF: "DSD "
	{
		ext: [".dsf", ".dff", ".dsd"],
		mime: "audio/dsd",
		verify: (buf) =>
			buf.length >= 4 &&
			buf[0] === 0x44 &&
			buf[1] === 0x53 &&
			buf[2] === 0x44 &&
			buf[3] === 0x20,
	},
	// MIDI: "MThd"
	{
		ext: [".mid", ".midi"],
		mime: "audio/midi",
		verify: (buf) =>
			buf.length >= 4 &&
			buf[0] === 0x4d &&
			buf[1] === 0x54 &&
			buf[2] === 0x68 &&
			buf[3] === 0x64,
	},
	// Tracker Module: MOD / S3M / XM / IT
	{
		ext: [".xm", ".s3m", ".it", ".mod"],
		mime: "audio/x-mod",
		verify: (buf) => {
			if (buf.length >= 17 && buf.subarray(0, 17).toString("ascii").startsWith("Extended Module:")) return true; // XM
			if (buf.length >= 4 && buf.subarray(0, 4).toString("ascii") === "IMPM") return true; // IT
			if (buf.length >= 48 && buf.subarray(44, 48).toString("ascii") === "SCRM") return true; // S3M
			if (buf.length >= 1084) {
				const tag = buf.subarray(1080, 1084).toString("ascii");
				if (tag === "M.K." || tag === "M!K!" || tag === "FLT4" || tag === "4CHN" || tag === "8CHN") return true;
			}
			return false;
		},
	},
	// MPEG-TS: 0x47 sync byte
	{
		ext: [".ts", ".mts", ".m2ts"],
		mime: "video/mp2t",
		verify: (buf) => buf.length >= 188 && buf[0] === 0x47 && (buf[188] === 0x47 || buf.length < 376),
	},
	// FLV: "FLV\x01"
	{
		ext: [".flv", ".f4v"],
		mime: "video/x-flv",
		verify: (buf) =>
			buf.length >= 4 &&
			buf[0] === 0x46 &&
			buf[1] === 0x4c &&
			buf[2] === 0x56 &&
			buf[3] === 0x01,
	},
];

/**
 * Calculates Shannon entropy of a buffer slice.
 * Values above 7.85 in non-compressed areas often indicate encrypted shellcode/packers.
 */
function calculateEntropy(buf: Buffer): number {
	if (buf.length === 0) return 0;
	const frequencies = new Uint32Array(256);
	for (let i = 0; i < buf.length; i++) {
		frequencies[buf[i]]++;
	}
	let entropy = 0;
	const len = buf.length;
	for (let i = 0; i < 256; i++) {
		if (frequencies[i] > 0) {
			const p = frequencies[i] / len;
			entropy -= p * Math.log2(p);
		}
	}
	return entropy;
}

/**
 * Searches for embedded PE / DOS / ELF signatures inside media metadata padding or streams.
 */
function scanEmbeddedSignatures(buf: Buffer): { found: boolean; threats: string[] } {
	const threats: string[] = [];
	const len = buf.length;

	// Check for embedded MZ header with valid PE offset deeper in the file
	for (let i = 32; i < Math.min(len - 64, 65536); i += 16) {
		if (buf[i] === 0x4d && buf[i + 1] === 0x5a) {
			// Found "MZ"
			const peRel = buf.readUInt32LE(i + 0x3c);
			const peAbs = i + peRel;
			if (peRel > 0 && peAbs + 4 <= len) {
				if (
					buf[peAbs] === 0x50 &&
					buf[peAbs + 1] === 0x45 &&
					buf[peAbs + 2] === 0x00 &&
					buf[peAbs + 3] === 0x00
				) {
					threats.push(`Embedded Windows PE executable detected at byte offset ${i} (0x${i.toString(16)})`);
				}
			}
		}
	}

	// Check for embedded ZIP / JAR polyglot ("PK\x03\x04") in non-standard offsets
	for (let i = 16; i < Math.min(len - 4, 32768); i += 32) {
		if (
			buf[i] === 0x50 &&
			buf[i + 1] === 0x4b &&
			buf[i + 2] === 0x03 &&
			buf[i + 3] === 0x04
		) {
			threats.push(`Embedded ZIP archive / Java JAR polyglot detected at byte offset ${i}`);
			break;
		}
	}

	// Check for embedded PowerShell / VBS / Bash script injection markers
	const sample = buf.subarray(0, Math.min(buf.length, 16384)).toString("ascii");
	if (/powershell\s+-enc/i.test(sample) || /powershell\.exe/i.test(sample)) {
		threats.push("Obfuscated PowerShell execution command found inside media header");
	}
	if (/wscript\.shell|cscript\.exe|cmd\.exe\s+\/c/i.test(sample)) {
		threats.push("Script shell launcher payload detected in file header");
	}
	if (/<script[\s\S]*?>[\s\S]*?<\/script>/i.test(sample)) {
		threats.push("Embedded executable HTML/SVG script tag detected");
	}

	return {
		found: threats.length > 0,
		threats,
	};
}

/**
 * Performs deep anti-malware and file integrity inspection on a candidate media file.
 */
export async function scanMediaFile(filePath: string): Promise<ScanResult> {
	let score = 100;
	const threats: string[] = [];
	const ext = extname(filePath).toLowerCase();
	const name = basename(filePath);

	// Check for dangerous double extensions (e.g. "song.mp3.exe", "video.mp4.vbs", "audio.wav.{CLSID}")
	const dangerousExtensions = [
		".exe", ".scr", ".bat", ".cmd", ".ps1", ".vbs", ".js", ".wsf",
		".cpl", ".hta", ".lnk", ".pif", ".dll", ".sys", ".com", ".jar",
		".reg", ".app", ".deb", ".rpm", ".sh", ".iso", ".vhd",
	];

	for (const dExt of dangerousExtensions) {
		if (name.toLowerCase().endsWith(dExt)) {
			threats.push(`Critical: File has direct executable extension (${dExt})`);
			score = 0;
		} else if (name.toLowerCase().includes(`${dExt}.`)) {
			threats.push(`High risk: Double-extension camouflage detected (contains ${dExt})`);
			score = Math.min(score, 10);
		}
	}

	// Read file stats and header
	let fileSize = 0;
	let headBuf = Buffer.alloc(0);
	let sha256 = "";

	try {
		const st = await stat(filePath);
		fileSize = st.size;

		if (fileSize === 0) {
			return {
				safe: false,
				score: 0,
				threats: ["File is empty (0 bytes)"],
				mimeDetected: "application/octet-stream",
				sha256: "",
				fileSize: 0,
				verifiedFormat: null,
				isPolyglot: false,
				hasEmbeddedExecutable: false,
			};
		}

		// Read up to 64KB for deep header & atom inspection
		const readSize = Math.min(fileSize, 65536);
		const fileHandle = await open(filePath, "r");
		headBuf = Buffer.alloc(readSize);
		await fileHandle.read(headBuf as any, 0, readSize, 0);
		await fileHandle.close();

		// Calculate SHA-256 hash
		const fullData = await readFile(filePath);
		sha256 = createHash("sha256").update(fullData as any).digest("hex");
	} catch (err) {
		return {
			safe: false,
			score: 0,
			threats: [`File access error: ${(err as Error).message}`],
			mimeDetected: "unknown",
			sha256: "",
			fileSize,
			verifiedFormat: null,
			isPolyglot: false,
			hasEmbeddedExecutable: false,
		};
	}

	// 1. Check for disguised executables (Magic bytes indicate EXE, ELF, Mach-O, LNK, etc.)
	for (const sig of DISGUISED_EXECUTABLE_SIGNATURES) {
		if (sig.match(headBuf)) {
			threats.push(`Disguised binary threat: Detected ${sig.name} (${sig.description}) masquerading as ${ext || "media"}`);
			score = 0;
		}
	}

	// 2. Verify media magic bytes
	let verifiedFormat: string | null = null;
	let mimeDetected = "application/octet-stream";

	for (const sig of MEDIA_SIGNATURES) {
		if (sig.verify(headBuf)) {
			verifiedFormat = sig.ext[0];
			mimeDetected = sig.mime;
			break;
		}
	}

	// If extension claims to be a known media type but magic bytes do not match at all
	const knownMediaExts = MEDIA_SIGNATURES.flatMap((s) => s.ext);
	if (knownMediaExts.includes(ext) && !verifiedFormat) {
		threats.push(`Warning: File extension is ${ext} but headers could not be verified against recognized audio/video container signatures`);
		score = Math.min(score, 60);
	}

	// 3. Scan for embedded stego/polyglot payloads
	const embedded = scanEmbeddedSignatures(headBuf);
	if (embedded.found) {
		for (const t of embedded.threats) {
			threats.push(t);
		}
		score = Math.min(score, 15);
	}

	// 4. Entropy check on file header
	const headerEntropy = calculateEntropy(headBuf.subarray(0, Math.min(headBuf.length, 4096)));
	if (headerEntropy > 7.95 && !ext.endsWith(".opus") && !ext.endsWith(".flac")) {
		threats.push("Caution: Unusually high Shannon entropy in file header (possible packed shellcode)");
		score = Math.min(score, 50);
	}

	const safe = score >= 50 && threats.every((t) => !t.startsWith("Critical") && !t.startsWith("Disguised"));
	const isPolyglot = embedded.found;
	const hasEmbeddedExecutable = threats.some((t) => t.includes("PE") || t.includes("ELF") || t.includes("binary threat"));

	return {
		safe,
		score,
		threats,
		mimeDetected,
		sha256,
		fileSize,
		verifiedFormat,
		isPolyglot,
		hasEmbeddedExecutable,
	};
}

/**
 * Sanitizes metadata strings to prevent XSS, path traversal, control character exploits, and injection.
 */
export function sanitizeMetadata(input: string | null | undefined): string {
	if (!input) return "";
	return input
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "") // Strip dangerous control codes
		.replace(/<[^>]*>?/gm, "") // Strip HTML tags
		.replace(/javascript:/gi, "")
		.replace(/data:text\/html/gi, "")
		.replace(/[\/\\]\.\.[\/\\]/g, "_") // Defeat directory traversal
		.trim();
}
