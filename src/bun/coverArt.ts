// Cover-art lookup for Discord rich presence. Discord can't fetch from
// local files or 127.0.0.1, so we resolve a public HTTPS URL per album via
// iTunes Search (no API key required) and persist the result to disk — each
// album is looked up once. The cache survives restarts; misses are cached too
// so we don't keep hitting iTunes for albums it doesn't know about.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appDataDir, LAKKY_APP_DATA } from "./paths";

type CacheEntry = { url: string | null; ts: number };

function cachePath(): string {
	return join(appDataDir(LAKKY_APP_DATA), "discord-cover-cache.json");
}

let cache: Map<string, CacheEntry> | null = null;
const inflight = new Map<string, Promise<string | null>>();

function loadCache(): Map<string, CacheEntry> {
	if (cache) return cache;
	cache = new Map();
	const p = cachePath();
	try {
		if (existsSync(p)) {
			const raw = JSON.parse(readFileSync(p, "utf8"));
			if (raw && typeof raw === "object") {
				for (const [k, v] of Object.entries(raw as Record<string, CacheEntry>)) cache.set(k, v);
			}
		}
	} catch (err) {
		console.warn("[cover-cache] read failed:", (err as Error).message);
	}
	return cache;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveCacheSoon() {
	if (saveTimer) return;
	saveTimer = setTimeout(() => {
		saveTimer = null;
		if (!cache) return;
		const p = cachePath();
		try {
			if (!existsSync(dirname(p))) mkdirSync(dirname(p), { recursive: true });
			const obj: Record<string, CacheEntry> = {};
			for (const [k, v] of cache) obj[k] = v;
			writeFileSync(p, JSON.stringify(obj), "utf8");
		} catch (err) {
			console.warn("[cover-cache] write failed:", (err as Error).message);
		}
	}, 1000);
}

function normaliseKey(artist: string, album: string): string {
	return `${artist.toLowerCase().trim()}::${album.toLowerCase().trim()}`;
}

function cleanForSearch(s: string): string {
	return s
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201C\u201D]/g, '"')
		.replace(/[\(\[][^)\]]*[)\]]/g, " ")
		.replace(/\s*\b(feat|ft|featuring)\.?\b[^&,;-]*$/i, " ")
		.replace(/\s+-\s+(single|ep|remixes|deluxe|live)$/i, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function bumpResolution(url: string): string {
	return url.replace(/\/[0-9]+x[0-9]+bb\./, "/600x600bb.");
}

async function searchITunes(term: string): Promise<string | null> {
	if (!term.trim()) return null;
	try {
		const enc = encodeURIComponent(term);
		const url = `https://itunes.apple.com/search?term=${enc}&entity=album&limit=3`;
		const res = await fetch(url, {
			headers: { "User-Agent": "Lakky/1.0" },
			signal: AbortSignal.timeout(4500),
		});
		if (!res.ok) return null;
		const json = await res.json();
		if (!json || typeof json !== "object" || !Array.isArray((json as any).results)) return null;
		for (const r of (json as any).results) {
			if (r && typeof r.artworkUrl100 === "string") return bumpResolution(r.artworkUrl100);
		}
		return null;
	} catch (err) {
		console.warn("[cover-art] iTunes search failed:", (err as Error).message);
		return null;
	}
}

export async function findCoverArtUrl(
	artist: string,
	album: string,
): Promise<string | null> {
	if (!artist || !album) return null;
	if (artist === "Unknown Artist" || album === "Unknown Album") return null;

	const key = normaliseKey(artist, album);
	const c = loadCache();
	const hit = c.get(key);
	if (hit) return hit.url;

	const existing = inflight.get(key);
	if (existing) return existing;

	const task = (async () => {
		try {
			const cleanArtist = cleanForSearch(artist);
			const cleanAlbum = cleanForSearch(album);
			const queries = [
				`${cleanArtist} ${cleanAlbum}`,
				cleanAlbum,
				`${cleanArtist} ${cleanAlbum}`.replace(/[^\w\s]/g, " ").replace(/\s+/g, " ").trim(),
				`${artist} ${album}`,
			];
			const seen = new Set<string>();
			let found: string | null = null;
			for (const q of queries) {
				const trimmed = q.trim();
				if (!trimmed || seen.has(trimmed)) continue;
				seen.add(trimmed);
				const url = await searchITunes(trimmed);
				if (url) { found = url; break; }
			}
			c.set(key, { url: found, ts: Date.now() });
			saveCacheSoon();
			return found;
		} finally {
			inflight.delete(key);
		}
	})();
	inflight.set(key, task);
	return task;
}
