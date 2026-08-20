import { readdir, stat, mkdir, copyFile, writeFile, unlink } from "node:fs/promises";
import { join, extname, basename, dirname, sep, normalize } from "node:path";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { parseFile } from "music-metadata";
import { File as TagFile, Picture, ByteVector, PictureType } from "node-taglib-sharp";
import type { TrackInfo, MediaKind } from "../shared/rpcSchema";
import { appDataDir, LAKKY_APP_DATA } from "./paths";
import { scanMediaFile, sanitizeMetadata } from "./security";

// ---------- Cover-art cache on disk ----------
let _artDirCache: string | null = null;
export function artCacheDir(): string {
	if (_artDirCache) return _artDirCache;
	_artDirCache = join(appDataDir(LAKKY_APP_DATA), "art");
	return _artDirCache;
}

const ART_EXT_BY_MIME: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/jpg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/bmp": "bmp",
};

function extForMime(mime: string): string {
	const m = mime.toLowerCase().trim();
	return ART_EXT_BY_MIME[m] ?? "jpg";
}

const ART_EXTS = ["jpg", "jpeg", "png", "webp", "gif", "bmp"];

function existingArtFile(id: string): string | null {
	const dir = artCacheDir();
	for (const ext of ART_EXTS) {
		const p = join(dir, `${id}.${ext}`);
		if (existsSync(p)) return `${id}.${ext}`;
	}
	return null;
}

async function cacheArt(
	id: string,
	picture: { data: Uint8Array; format: string },
): Promise<string | null> {
	try {
		const dir = artCacheDir();
		if (!existsSync(dir)) await mkdir(dir, { recursive: true });
		const ext = extForMime(picture.format);
		const filename = `${id}.${ext}`;
		const filePath = join(dir, filename);
		if (existsSync(filePath)) return filename;
		const data = picture.data instanceof Uint8Array
			? picture.data
			: new Uint8Array(picture.data as unknown as ArrayBuffer);
		await writeFile(filePath, data);
		return filename;
	} catch (err) {
		console.warn("[art] write failed:", (err as Error).message);
		return null;
	}
}

export const AUDIO_EXTS = new Set([
	".mp3", ".wav", ".flac", ".ogg", ".oga", ".opus", ".m4a", ".aac",
	".wma", ".aiff", ".aif", ".alac", ".ape", ".wv", ".mka", ".mp2",
	".mp1", ".amr", ".ac3", ".dts", ".eac3", ".dsd", ".dsf", ".dff",
	".au", ".snd", ".ra", ".mid", ".midi", ".mod", ".xm", ".s3m",
	".it", ".spx", ".tak", ".tta", ".caf",
]);

export const VIDEO_EXTS = new Set([
	".mp4", ".m4v", ".mkv", ".webm", ".mov", ".avi", ".wmv", ".flv",
	".f4v", ".mpg", ".mpeg", ".m2v", ".3gp", ".3g2", ".ts", ".mts",
	".m2ts", ".ogv", ".vob", ".rm", ".rmvb", ".asf", ".divx", ".wtv",
	".dvr-ms",
]);

export function classifyFile(path: string): MediaKind | null {
	const ext = extname(path).toLowerCase();
	if (AUDIO_EXTS.has(ext)) return "audio";
	if (VIDEO_EXTS.has(ext)) return "video";
	return null;
}

function isMediaFile(path: string): boolean {
	return classifyFile(path) !== null;
}

export function pathToId(path: string): string {
	const normalized = normalize(path).toLowerCase();
	return "t" + createHash("sha1").update(normalized).digest("hex").slice(0, 14);
}

// Drop any cached art for `id` so a subsequent buildTrackInfo() re-extracts
async function clearArtCache(id: string): Promise<void> {
	const dir = artCacheDir();
	for (const ext of ART_EXTS) {
		const p = join(dir, `${id}.${ext}`);
		if (existsSync(p)) {
			try { await unlink(p); } catch (err) {
				console.warn("[art] cache clear failed:", p, (err as Error).message);
			}
		}
	}
}

export async function* walkMedia(root: string): AsyncGenerator<string> {
	const queue: string[] = [root];
	while (queue.length > 0) {
		const dir = queue.shift()!;
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch (err) {
			console.warn("[library] cannot read directory, skipping:", dir, (err as Error).message);
			continue;
		}
		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			const full = join(dir, entry.name);
			if (entry.isDirectory()) {
				queue.push(full);
			} else if (entry.isFile() && isMediaFile(full)) {
				yield full;
			}
		}
	}
}

export function sanitizeSegment(s: string): string {
	const cleaned = s
		.replace(/[\/\\:*?"<>|\0]/g, "_")
		.replace(/\s+/g, " ")
		.replace(/\.+$/g, "")
		.trim();
	return cleaned.length > 0 ? cleaned.slice(0, 120) : "Unknown";
}

/**
 * Copy a media file into `libraryFolder/Artist/Album/Title.ext`.
 */
export async function copyIntoLibrary(
	srcPath: string,
	libraryFolder: string,
	track: { artist: string; album: string; title: string; trackNumber?: number },
): Promise<{ path: string; copied: boolean }> {
	const normalizedLib = normalize(libraryFolder);
	const normalizedSrc = normalize(srcPath);
	if (normalizedSrc.startsWith(normalizedLib + sep) || normalizedSrc === normalizedLib) {
		return { path: srcPath, copied: false };
	}

	const ext = extname(srcPath);
	const artist = sanitizeSegment(track.artist || "Unknown Artist");
	const album = sanitizeSegment(track.album || "Unknown Album");
	const trackNo = track.trackNumber ? `${String(track.trackNumber).padStart(2, "0")} - ` : "";
	const title = sanitizeSegment(track.title || basename(srcPath, ext));
	const dir = join(libraryFolder, artist, album);
	const baseName = `${trackNo}${title}${ext}`;
	let target = join(dir, baseName);

	let srcStats;
	try {
		srcStats = await stat(srcPath);
	} catch {
		return { path: srcPath, copied: false };
	}

	if (existsSync(target)) {
		try {
			const tStats = await stat(target);
			if (tStats.size === srcStats.size) {
				return { path: target, copied: false };
			}
		} catch {}
		// Collision with different content — append a suffix to keep both.
		let n = 2;
		while (existsSync(target = join(dir, `${trackNo}${title} (${n})${ext}`))) {
			n++;
			if (n > 99) break;
		}
	}

	await mkdir(dir, { recursive: true });
	await copyFile(srcPath, target);
	return { path: target, copied: true };
}

export async function buildTrackInfo(
	filePath: string,
	streamBase: string,
): Promise<TrackInfo> {
	const kind = classifyFile(filePath) ?? "audio";
	const stats = await stat(filePath);
	const baseName = basename(filePath, extname(filePath));
	const id = pathToId(filePath);

	let title = sanitizeMetadata(baseName);
	let artist = "Unknown Artist";
	let album = "Unknown Album";
	let duration = 0;
	let year: number | undefined;
	let genre: string | undefined;
	let trackNumber: number | undefined;
	let bitrate: number | undefined;
	let sampleRate: number | undefined;
	let artDataUrl: string | undefined;
	let replayGainTrack: number | undefined;
	let replayGainAlbum: number | undefined;

	// 1. Anti-Malware / Binary Security Scan
	const secReport = await scanMediaFile(filePath);

	// Fast path for cached art
	const cachedFilename = existingArtFile(id);
	if (cachedFilename) {
		artDataUrl = `${streamBase}/art/${cachedFilename}`;
	}

	try {
		const md = await parseFile(filePath, { duration: true });
		if (md.common.title) title = sanitizeMetadata(md.common.title);
		if (md.common.artist || md.common.albumartist) {
			artist = sanitizeMetadata(md.common.artist ?? md.common.albumartist ?? "Unknown Artist");
		}
		if (md.common.album) album = sanitizeMetadata(md.common.album);
		duration = md.format.duration ?? 0;
		year = md.common.year;
		if (md.common.genre?.[0]) genre = sanitizeMetadata(md.common.genre[0]);
		trackNumber = md.common.track?.no ?? undefined;
		bitrate = md.format.bitrate;
		sampleRate = md.format.sampleRate;

		// ReplayGain tags
		const rgTrack = (md as any).native?.vorbis?.["REPLAYGAIN_TRACK_GAIN"]
			?? (md as any).native?.id3v2?.find((f: any) => f.id === "TXXX" && f.value?.description === "REPLAYGAIN_TRACK_GAIN")?.value?.data;
		const rgAlbum = (md as any).native?.vorbis?.["REPLAYGAIN_ALBUM_GAIN"]
			?? (md as any).native?.id3v2?.find((f: any) => f.id === "TXXX" && f.value?.description === "REPLAYGAIN_ALBUM_GAIN")?.value?.data;
		if (typeof rgTrack === "string") replayGainTrack = parseFloat(rgTrack.split(" ")[0]);
		else if (typeof rgTrack === "number") replayGainTrack = rgTrack;
		if (typeof rgAlbum === "string") replayGainAlbum = parseFloat(rgAlbum.split(" ")[0]);
		else if (typeof rgAlbum === "number") replayGainAlbum = rgAlbum;

		if (!cachedFilename && md.common.picture && md.common.picture.length > 0) {
			const pic = md.common.picture[0];
			const filename = await cacheArt(id, {
				data: pic.data as unknown as Uint8Array,
				format: pic.format,
			});
			if (filename) {
				artDataUrl = `${streamBase}/art/${filename}`;
			}
		}
	} catch (err) {
		console.warn("[library] metadata parse failed, using fallback filename:", filePath, (err as Error).message);
	}

	return {
		id,
		path: filePath,
		streamUrl: `${streamBase}/stream?p=${encodeURIComponent(filePath)}`,
		kind,
		title,
		artist,
		album,
		duration,
		year,
		genre,
		trackNumber,
		bitrate,
		sampleRate,
		artDataUrl,
		size: stats.size,
		replayGainTrack,
		replayGainAlbum,
		securitySafe: secReport.safe,
		securityScore: secReport.score,
		securityThreats: secReport.threats,
		verifiedFormat: secReport.verifiedFormat,
	};
}

function parseDataUrl(dataUrl: string): { mime: string; data: Uint8Array } | null {
	const m = /^data:([^;,]+);base64,([\s\S]*)$/.exec(dataUrl);
	if (!m) return null;
	return { mime: m[1], data: new Uint8Array(Buffer.from(m[2], "base64")) };
}

export type MetadataFields = {
	title: string;
	artist: string;
	album: string;
	year: number | null;
	genre: string;
	art?: string | null;
};

/**
 * Writes tags directly into the audio file on disk and returns updated TrackInfo.
 */
export async function writeTrackMetadata(
	filePath: string,
	streamBase: string,
	fields: MetadataFields,
): Promise<TrackInfo> {
	const file = TagFile.createFromPath(filePath);
	try {
		const tag = file.tag;
		tag.title = sanitizeMetadata(fields.title);
		tag.performers = fields.artist ? [sanitizeMetadata(fields.artist)] : [];
		tag.album = sanitizeMetadata(fields.album);
		tag.year = fields.year ?? 0;
		tag.genres = fields.genre ? [sanitizeMetadata(fields.genre)] : [];
		if (fields.art === null) {
			tag.pictures = [];
		} else if (fields.art) {
			const parsed = parseDataUrl(fields.art);
			if (parsed) {
				tag.pictures = [
					Picture.fromFullData(ByteVector.fromByteArray(parsed.data), PictureType.FrontCover, parsed.mime, "Cover"),
				];
			}
		}
		file.save();
	} finally {
		file.dispose();
	}

	if (fields.art !== undefined) {
		await clearArtCache(pathToId(filePath));
	}
	return buildTrackInfo(filePath, streamBase);
}
