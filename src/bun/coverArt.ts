// Cover-art lookup for Discord rich presence. Because Discord can't fetch
// from local files or 127.0.0.1, we resolve a public HTTPS URL per album
// via iTunes Search (no API key required) and **persist** the result to
// disk so each album is only ever looked up once. After a few listening
// sessions your library is fully cached and lookups effectively stop.
//
// The cache survives restarts; misses are cached too so we don't keep
// hitting iTunes for albums it doesn't know about.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

type CacheEntry = { url: string | null; ts: number };

function cacheDir(): string {
	const name = "Lakky";
	if (process.platform === "win32") {
		return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), name);
	}
	if (process.platform === "darwin") {
		return join(homedir(), "Library", "Application Support", name);
	}
	return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), name);
}
function cachePath(): string {
	return join(cacheDir(), "discord-cover-cache.json");
}

let cache: Map<string, CacheEntry> | null = null;
const inflight = new Map<string, Promise<string | null>>();
let allowNetwork = true;

function loadCache(): Map<string, CacheEntry> {
	if (cache) return cache;
	cache = new Map();
	const p = cachePath();
	try {
		if (existsSync(p)) {
			const raw = JSON.parse(readFileSync(p, "utf8")) as Record<string, CacheEntry>;
			for (const [k, v] of Object.entries(raw)) cache.set(k, v);
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

/** Set whether new (uncached) artist/album combos are allowed to hit iTunes.
 *  When false, only previously-cached entries are returned; everything else
 *  comes back as null and the caller falls back to lak_logo. */
export function setCoverArtNetworkAllowed(on: boolean) {
	allowNetwork = on;
}

function normaliseKey(artist: string, album: string): string {
	return `${artist.toLowerCase().trim()}::${album.toLowerCase().trim()}`;
}

function cleanForSearch(s: string): string {
	return s
		.replace(/[‘’]/g, "'")
		.replace(/[“”]/g, '"')
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
		const json = (await res.json()) as { results?: Array<{ artworkUrl100?: string }> };
		for (const r of json.results ?? []) {
			if (r.artworkUrl100) return bumpResolution(r.artworkUrl100);
		}
		return null;
	} catch {
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

	if (!allowNetwork) {
		// Offline mode: don't look up, don't cache a miss either (so the next
		// time the user re-enables online it can try this album).
		return null;
	}
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
