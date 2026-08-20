import { open } from "node:fs/promises";
import { basename, extname } from "node:path";

export interface CodecMetadataResult {
	title: string;
	artist: string;
	album: string;
	duration: number;
	year?: number;
	genre?: string;
	trackNumber?: number;
	bitrate?: number;
	sampleRate?: number;
	channels?: number;
}

/**
 * Clean up a null-terminated or space-padded ASCII/Latin1 string from a binary buffer.
 */
function cleanAscii(buf: Buffer | Uint8Array, start: number, length: number): string {
	const slice = buf.subarray(start, start + length);
	let str = "";
	for (let i = 0; i < slice.length; i++) {
		const code = slice[i];
		if (code === 0) break; // null terminator
		if (code >= 32 && code <= 126) {
			str += String.fromCharCode(code);
		} else if (code > 127) {
			// ISO-8859-1 character
			str += String.fromCharCode(code);
		}
	}
	return str.trim();
}

/**
 * Parses Amiga ProTracker / NoiseTracker / FastTracker MOD modules.
 */
export function parseModHeader(buf: Buffer): CodecMetadataResult | null {
	if (buf.length < 1084) return null;

	const title = cleanAscii(buf, 0, 20);
	const sig = cleanAscii(buf, 1080, 4);

	let channels = 4;
	let isMod = false;

	if (sig === "M.K." || sig === "M!K!" || sig === "FLT4" || sig === "4CHN") {
		channels = 4;
		isMod = true;
	} else if (sig === "6CHN") {
		channels = 6;
		isMod = true;
	} else if (sig === "8CHN" || sig === "CD81" || sig === "OKTA" || sig === "FLT8") {
		channels = 8;
		isMod = true;
	} else if (/^\d\dCH$/.test(sig) || /^\d\dCN$/.test(sig)) {
		channels = parseInt(sig.slice(0, 2), 10) || 4;
		isMod = true;
	} else if (/^\dCHN$/.test(sig)) {
		channels = parseInt(sig[0], 10) || 4;
		isMod = true;
	}

	// 15-sample soundtracker fallback if no 4-byte signature
	if (!isMod && title.length > 0) {
		let asciiCount = 0;
		for (let i = 0; i < 20; i++) {
			if (buf[i] >= 32 && buf[i] <= 126) asciiCount++;
		}
		if (asciiCount >= 3) isMod = true;
	}

	if (!isMod && !title) return null;

	const songLength = buf[950] || 1; // number of pattern table positions
	// MOD playback duration estimation: ~64 rows per pattern, 6 ticks/row, 50 Hz PAL timer = ~7.68s per pattern
	const duration = Math.max(30, Math.round(songLength * 7.68));

	return {
		title: title || "Untitled MOD",
		artist: "Amiga / ProTracker",
		album: "SoundTracker Module",
		duration,
		genre: "Chiptune / Tracker",
		channels,
		sampleRate: 44100,
		bitrate: 352800,
	};
}

/**
 * Parses FastTracker II XM (Extended Module) files.
 */
export function parseXmHeader(buf: Buffer): CodecMetadataResult | null {
	if (buf.length < 80) return null;

	const sig = cleanAscii(buf, 0, 17);
	if (!sig.startsWith("Extended Module:")) return null;

	const title = cleanAscii(buf, 17, 20);
	const trackerName = cleanAscii(buf, 38, 20) || "FastTracker II";
	const songLength = buf.readUInt16LE(64) || 1;
	const channels = buf.readUInt16LE(68) || 8;
	const defaultTempo = buf.readUInt16LE(76) || 125;
	const defaultSpeed = buf.readUInt16LE(78) || 6;

	// XM duration estimate: (songLength * 64 * speed * 2.5) / tempo
	const duration = Math.max(30, Math.round((songLength * 64 * defaultSpeed * 2.5) / (defaultTempo || 125)));

	return {
		title: title || "Untitled XM",
		artist: trackerName,
		album: "FastTracker II Module",
		duration,
		genre: "Chiptune / Tracker",
		channels,
		sampleRate: 44100,
		bitrate: 705600,
	};
}

/**
 * Parses Scream Tracker 3 S3M files.
 */
export function parseS3mHeader(buf: Buffer): CodecMetadataResult | null {
	if (buf.length < 60) return null;

	const sig = cleanAscii(buf, 44, 4);
	if (sig !== "SCRM") return null;

	const title = cleanAscii(buf, 0, 28);
	const orderCount = buf.readUInt16LE(32) || 1;
	const initialSpeed = buf[49] || 6;
	const initialTempo = buf[50] || 125;

	const duration = Math.max(30, Math.round((orderCount * 64 * initialSpeed * 2.5) / (initialTempo || 125)));

	return {
		title: title || "Untitled S3M",
		artist: "Scream Tracker III",
		album: "Scream Tracker 3 Module",
		duration,
		genre: "Chiptune / Tracker",
		channels: 16,
		sampleRate: 44100,
		bitrate: 512000,
	};
}

/**
 * Parses Impulse Tracker IT files.
 */
export function parseItHeader(buf: Buffer): CodecMetadataResult | null {
	if (buf.length < 60) return null;

	const sig = cleanAscii(buf, 0, 4);
	if (sig !== "IMPM") return null;

	const title = cleanAscii(buf, 4, 26);
	const orderCount = buf.readUInt16LE(32) || 1;
	const initialSpeed = buf[48] || 6;
	const initialTempo = buf[49] || 125;

	const duration = Math.max(30, Math.round((orderCount * 64 * initialSpeed * 2.5) / (initialTempo || 125)));

	return {
		title: title || "Untitled IT",
		artist: "Impulse Tracker",
		album: "Impulse Tracker Module",
		duration,
		genre: "Chiptune / Tracker",
		channels: 32,
		sampleRate: 44100,
		bitrate: 705600,
	};
}

/**
 * Parses Standard MIDI File (.mid, .midi) headers and track metadata.
 */
export function parseMidiHeader(buf: Buffer): CodecMetadataResult | null {
	if (buf.length < 14) return null;

	const mthd = cleanAscii(buf, 0, 4);
	if (mthd !== "MThd") return null;

	const format = buf.readUInt16BE(8);
	const numTracks = buf.readUInt16BE(10);
	const division = buf.readUInt16BE(12);

	let title = "";
	let copyright = "";
	let textComment = "";
	let maxTrackTicks = 0;
	let currentTempo = 500000; // microseconds per quarter note (default 120 BPM)

	let offset = 14;
	for (let t = 0; t < numTracks && offset + 8 <= buf.length; t++) {
		const chunkId = cleanAscii(buf, offset, 4);
		const chunkLen = buf.readUInt32BE(offset + 4);
		offset += 8;

		if (chunkId === "MTrk") {
			const trackEnd = Math.min(offset + chunkLen, buf.length);
			let ptr = offset;
			let trackTicks = 0;
			let runningStatus = 0;

			while (ptr < trackEnd) {
				// Read variable length delta time
				let delta = 0;
				let byte = 0;
				do {
					if (ptr >= trackEnd) break;
					byte = buf[ptr++];
					delta = (delta << 7) | (byte & 0x7f);
				} while (byte & 0x80);

				trackTicks += delta;

				if (ptr >= trackEnd) break;
				let eventType = buf[ptr];

				if (eventType === 0xff) {
					// Meta event
					ptr++;
					if (ptr >= trackEnd) break;
					const metaType = buf[ptr++];
					// Read length
					let metaLen = 0;
					do {
						if (ptr >= trackEnd) break;
						byte = buf[ptr++];
						metaLen = (metaLen << 7) | (byte & 0x7f);
					} while (byte & 0x80);

					if (metaType === 0x03 && !title) {
						// Sequence/Track Name
						title = cleanAscii(buf, ptr, metaLen);
					} else if (metaType === 0x02 && !copyright) {
						// Copyright Notice
						copyright = cleanAscii(buf, ptr, metaLen);
					} else if (metaType === 0x01 && !textComment) {
						// Text Event
						textComment = cleanAscii(buf, ptr, metaLen);
					} else if (metaType === 0x51 && metaLen === 3 && ptr + 3 <= buf.length) {
						// Set Tempo
						currentTempo = (buf[ptr] << 16) | (buf[ptr + 1] << 8) | buf[ptr + 2];
					}

					ptr += metaLen;
				} else if (eventType === 0xf0 || eventType === 0xf7) {
					// Sysex
					ptr++;
					let sysexLen = 0;
					do {
						if (ptr >= trackEnd) break;
						byte = buf[ptr++];
						sysexLen = (sysexLen << 7) | (byte & 0x7f);
					} while (byte & 0x80);
					ptr += sysexLen;
				} else {
					// Channel event
					if (eventType >= 0x80) {
						runningStatus = eventType;
						ptr++;
					} else {
						eventType = runningStatus;
					}

					const highNibble = eventType & 0xf0;
					if (highNibble === 0xc0 || highNibble === 0xd0) {
						ptr += 1; // Program change or Channel pressure (1 data byte)
					} else {
						ptr += 2; // Note on/off, Poly pressure, Control change, Pitch bend (2 data bytes)
					}
				}
			}

			if (trackTicks > maxTrackTicks) maxTrackTicks = trackTicks;
		}

		offset += chunkLen;
	}

	// Calculate duration: (total ticks / division) * (microseconds per quarter note) / 1,000,000
	const ticksPerQuarter = division > 0 ? (division & 0x7fff) : 480;
	const durationSeconds = (maxTrackTicks / ticksPerQuarter) * (currentTempo / 1_000_000);
	const duration = Math.max(1, Math.round(durationSeconds));

	return {
		title: title || textComment || "MIDI Sequence",
		artist: copyright || "MIDI Synthesizer",
		album: "Standard MIDI Sequence",
		duration: isFinite(duration) ? duration : 180,
		genre: "General MIDI",
		sampleRate: 44100,
		bitrate: 128000,
	};
}

/**
 * Intelligent filename and path fallback metadata extractor.
 * Extracts Track Number, Artist, and Title from patterns like:
 *   "01 - Daft Punk - Get Lucky.flac"
 *   "Queen - Bohemian Rhapsody (2011 Remaster).opus"
 *   "05. Cyberpunk 2077 Theme.wav"
 */
export function parseFilenameMetadata(filePath: string): { title: string; artist: string; trackNumber?: number } {
	const ext = extname(filePath);
	let name = basename(filePath, ext);

	// Strip release tags like [1080p], [FLAC], (Official Video), (320kbps), etc.
	name = name
		.replace(/\[(1080p|720p|4k|flac|320kbps|lossless|remastered|explicit|hq|hd)\]/gi, "")
		.replace(/\((official\s*(music\s*)?video|official\s*audio|lyrics?|visualizer|remastered)\)/gi, "")
		.trim();

	// Pattern 1: "01 - Artist - Title" or "01. Artist - Title"
	const p1 = /^\s*(\d{1,3})\s*[-._\s]\s*(.+?)\s*[-–—]\s*(.+)$/.exec(name);
	if (p1) {
		const trackNum = parseInt(p1[1], 10);
		const artist = p1[2].trim();
		const title = p1[3].trim();
		if (artist && title) {
			return { title, artist, trackNumber: isNaN(trackNum) ? undefined : trackNum };
		}
	}

	// Pattern 2: "Artist - Title"
	const p2 = /^(.+?)\s*[-–—]\s*(.+)$/.exec(name);
	if (p2) {
		const artist = p2[1].trim();
		const title = p2[2].trim();
		if (artist && title) {
			return { title, artist };
		}
	}

	// Pattern 3: "01 - Title" or "01. Title"
	const p3 = /^\s*(\d{1,3})\s*[-._\s]\s*(.+)$/.exec(name);
	if (p3) {
		const trackNum = parseInt(p3[1], 10);
		const title = p3[2].trim();
		if (title) {
			return { title, artist: "Unknown Artist", trackNumber: isNaN(trackNum) ? undefined : trackNum };
		}
	}

	return {
		title: name || basename(filePath, ext) || "Untitled Track",
		artist: "Unknown Artist",
	};
}

/**
 * Extracts metadata for extended audio formats (MOD, XM, S3M, IT, MID) by reading file headers directly.
 */
export async function parseExtendedCodecMetadata(filePath: string): Promise<CodecMetadataResult | null> {
	const ext = extname(filePath).toLowerCase();

	try {
		const fh = await open(filePath, "r");
		try {
			const buf = Buffer.alloc(16384);
			const { bytesRead } = await fh.read(buf, 0, 16384, 0);
			const activeBuf = buf.subarray(0, bytesRead);

			if (ext === ".mod") {
				return parseModHeader(activeBuf);
			}
			if (ext === ".xm") {
				return parseXmHeader(activeBuf);
			}
			if (ext === ".s3m") {
				return parseS3mHeader(activeBuf);
			}
			if (ext === ".it") {
				return parseItHeader(activeBuf);
			}
			if (ext === ".mid" || ext === ".midi") {
				return parseMidiHeader(activeBuf);
			}

			// Autodetect by magic signature if extension was unusual
			if (activeBuf.subarray(0, 4).toString("ascii") === "MThd") {
				return parseMidiHeader(activeBuf);
			}
			if (activeBuf.subarray(0, 17).toString("ascii").startsWith("Extended Module:")) {
				return parseXmHeader(activeBuf);
			}
			if (activeBuf.subarray(0, 4).toString("ascii") === "IMPM") {
				return parseItHeader(activeBuf);
			}
			if (activeBuf.length >= 48 && activeBuf.subarray(44, 48).toString("ascii") === "SCRM") {
				return parseS3mHeader(activeBuf);
			}
			const modTest = parseModHeader(activeBuf);
			if (modTest) return modTest;
		} finally {
			await fh.close();
		}
	} catch (err) {
		console.warn("[codecMetadata] Extended header parse error:", (err as Error).message);
	}

	return null;
}
