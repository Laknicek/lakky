import { readdir, stat, mkdir, copyFile, writeFile } from "node:fs/promises";
import { join, extname, basename, dirname, sep, normalize } from "node:path";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { parseFile } from "music-metadata";
import type { TrackInfo } from "../shared/rpcSchema";

// ---------- Cover-art cache on disk ----------
// Extracting embedded art on every track and shoving it inline as a data URL
// (the old approach) was both slow on big libraries and far too big to persist
// in state.json — which is why the old code only kept art for the first 200
// tracks. We now write each cover to <appData>/Lakky/art/<id>.<ext> and just
// store the URL, so:
//   • every track in the library has its art (no 200-track cutoff)
//   • state.json stays small
//   • restarts pick up cached art instantly, no rescan needed

let _artDirCache: string | null = null;
export function artCacheDir(): string {
	if (_artDirCache) return _artDirCache;
	const appName = "Lakky";
	let base: string;
	if (process.platform === "win32") {
		base = process.env.APPDATA || join(homedir(), "AppData", "Roaming");
	} else if (process.platform === "darwin") {
		base = join(homedir(), "Library", "Application Support");
	} else {
		base = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
	}
	_artDirCache = join(base, appName, "art");
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

const ART_EXTS = ["jpg", "png", "webp", "gif", "bmp"];

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

const AUDIO_EXTS = new Set([
	".mp3", ".wav", ".flac", ".ogg", ".oga", ".m4a", ".aac",
	".wma", ".opus", ".aiff", ".aif", ".alac", ".ape", ".wv",
	".mka", ".mp2", ".amr", ".ac3", ".dts",
]);

const VIDEO_EXTS = new Set([
	".mp4", ".m4v", ".mkv", ".webm", ".mov", ".avi", ".wmv",
	".flv", ".f4v", ".mpg", ".mpeg", ".3gp", ".3g2", ".ts",
	".mts", ".m2ts", ".ogv", ".vob", ".rm", ".rmvb",
]);

export function classifyFile(path: string): "audio" | "video" | null {
	const ext = extname(path).toLowerCase();
	if (AUDIO_EXTS.has(ext)) return "audio";
	if (VIDEO_EXTS.has(ext)) return "video";
	return null;
}

export function isMediaFile(path: string): boolean {
	return classifyFile(path) !== null;
}

// Deterministic ID derived from the (normalized) file path. The same file on
// disk always yields the same ID across launches — which is what lets the
// renderer persist its library and the queue keep working after a restart.
export function pathToId(path: string): string {
	const normalized = normalize(path).toLowerCase();
	return "t" + createHash("sha1").update(normalized).digest("hex").slice(0, 14);
}

export async function* walkMedia(root: string): AsyncGenerator<string> {
	const queue: string[] = [root];
	while (queue.length > 0) {
		const dir = queue.shift()!;
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
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

function sanitizeSegment(s: string): string {
	const cleaned = s
		.replace(/[\/\\:*?"<>|]/g, "_")
		.replace(/\s+/g, " ")
		.replace(/\.+$/g, "")
		.trim();
	return cleaned.length > 0 ? cleaned.slice(0, 120) : "Unknown";
}

/**
 * Copy a media file into `libraryFolder/Artist/Album/Title.ext`.
 * Returns the destination path. If the destination already exists with the
 * same size, the existing copy is reused. If the source is already inside the
 * library folder, the source path is returned as-is.
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
	_legacyIncludeArtIgnored = true,
): Promise<TrackInfo> {
	const kind = classifyFile(filePath) ?? "audio";
	const stats = await stat(filePath);
	const baseName = basename(filePath, extname(filePath));
	const id = pathToId(filePath);

	let title = baseName;
	let artist = "Unknown Artist";
	let album = "Unknown Album";
	let duration = 0;
	let year: number | undefined;
	let genre: string | undefined;
	let trackNumber: number | undefined;
	let bitrate: number | undefined;
	let sampleRate: number | undefined;
	let artDataUrl: string | undefined;

	// Fast path: if we've already cached this track's art on a previous scan,
	// reuse the file without re-parsing the audio at all for the art portion.
	const cachedFilename = existingArtFile(id);
	if (cachedFilename) {
		artDataUrl = `${streamBase}/art/${cachedFilename}`;
	}

	try {
		const md = await parseFile(filePath, { duration: true });
		title = md.common.title ?? title;
		artist = md.common.artist ?? md.common.albumartist ?? artist;
		album = md.common.album ?? album;
		duration = md.format.duration ?? 0;
		year = md.common.year;
		genre = md.common.genre?.[0];
		trackNumber = md.common.track?.no ?? undefined;
		bitrate = md.format.bitrate;
		sampleRate = md.format.sampleRate;
		// Always extract art when present — no per-scan cutoff. Heavy art is
		// written to the disk cache rather than carried inline.
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
	} catch {
		// metadata parse failed — fall back to filename
	}

	return {
		id,
		path: filePath,
		// Put the path directly in the URL so the media server is stateless.
		// 127.0.0.1-only binding means there's no third-party exposure here.
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
	};
}
