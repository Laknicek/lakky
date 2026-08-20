// Lyrics fetcher using LRCLIB (free, no API key required).
// Caches results to disk alongside the cover art cache so each track
// is only ever fetched once per machine.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { appDataDir, LAKKY_APP_DATA } from "./paths";

type LrcLine = { time: number; text: string };
type CachedLyrics = { plain: string | null; synced: LrcLine[]; ts: number };

function lyricsDir(): string {
	return join(appDataDir(LAKKY_APP_DATA), "lyrics");
}

function keyFor(artist: string, title: string): string {
	const raw = `${artist.trim().toLowerCase()}||${title.trim().toLowerCase()}`;
	return createHash("sha1").update(raw).digest("hex").slice(0, 16);
}

function cachePath(key: string): string {
	return join(lyricsDir(), `${key}.json`);
}

function loadCache(key: string): CachedLyrics | null {
	const p = cachePath(key);
	try {
		if (!existsSync(p)) return null;
		const raw = JSON.parse(readFileSync(p, "utf8"));
		if (raw && typeof raw === "object" && Array.isArray(raw.synced)) {
			return raw as CachedLyrics;
		}
		return null;
	} catch {
		return null;
	}
}

function saveCache(key: string, entry: CachedLyrics) {
	const dir = lyricsDir();
	try {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(cachePath(key), JSON.stringify(entry), "utf8");
	} catch (err) {
		console.warn("[lyrics] cache write failed:", (err as Error).message);
	}
}

function parseLRC(lrc: string): LrcLine[] {
	const lines = lrc.split(/\r?\n/);
	const result: LrcLine[] = [];
	for (const raw of lines) {
		const m = raw.match(/^\[(\d+):(\d+(?:[\.:]\d+)?)\](.+)/);
		if (!m) continue;
		const min = parseInt(m[1], 10);
		const sec = parseFloat(m[2].replace(":", "."));
		const time = min * 60 + sec;
		const text = m[3].trim();
		if (text) result.push({ time, text });
	}
	result.sort((a, b) => a.time - b.time);
	return result;
}

export async function fetchLyrics(
	artist: string,
	album: string,
	title: string,
): Promise<{ plain: string | null; synced: LrcLine[] } | null> {
	if (!artist || !title) return null;
	const key = keyFor(artist, title);
	const cached = loadCache(key);
	if (cached) return { plain: cached.plain, synced: cached.synced };

	const params = new URLSearchParams({
		artist_name: artist.trim(),
		track_name: title.trim(),
	});
	if (album && album !== "Unknown Album") {
		params.set("album_name", album.trim());
	}

	try {
		const res = await fetch(`https://lrclib.net/api/get?${params}`, {
			headers: { "User-Agent": "Lakky/1.0" },
			signal: AbortSignal.timeout(5000),
		});
		if (!res.ok) return null;
		const json = await res.json();
		const plain = typeof json.plainLyrics === "string" && json.plainLyrics.trim() ? json.plainLyrics.trim() : null;
		const syncedRaw = typeof json.syncedLyrics === "string" ? json.syncedLyrics : null;
		const synced = syncedRaw ? parseLRC(syncedRaw) : [];
		const entry: CachedLyrics = { plain, synced, ts: Date.now() };
		saveCache(key, entry);
		return { plain, synced };
	} catch (err) {
		console.warn("[lyrics] fetch failed:", (err as Error).message);
		return null;
	}
}
