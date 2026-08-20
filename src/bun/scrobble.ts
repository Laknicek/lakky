// Last.fm scrobbling via the standard Audioscrobbler v2.0 API.
// Uses session token auth — user provides a token, we MD5-sign requests.
// Stores the token in localStorage (renderer side) and state (bun side).

import { createHash } from "node:crypto";
import type { TrackInfo } from "../shared/rpcSchema";

const API_KEY = "d9b8e22f8a0c4f5d6e7a1b2c3d4e5f6a";
const API_SECRET = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6";
const BASE = "https://ws.audioscrobbler.com/2.0/";

let token: string | null = null;

export function setLastfmToken(t: string) {
	token = t || null;
}

function sign(params: Record<string, string>): string {
	const raw = Object.entries(params)
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([k, v]) => `${k}${v}`)
		.join("");
	const sig = createHash("md5").update(raw + API_SECRET).digest("hex");
	return sig;
}

async function apiCall(method: string, extra: Record<string, string> = {}): Promise<boolean> {
	if (!token) return false;
	const params: Record<string, string> = {
		method,
		api_key: API_KEY,
		sk: token,
		...extra,
	};
	params.api_sig = sign(params);

	try {
		const body = new URLSearchParams(params);
		const res = await fetch(BASE, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: body.toString(),
			signal: AbortSignal.timeout(6000),
		});
		if (!res.ok) return false;
		const xml = await res.text();
		return xml.includes('status="ok"');
	} catch {
		return false;
	}
}

export async function scrobbleNowPlaying(track: TrackInfo): Promise<boolean> {
	return apiCall("track.updateNowPlaying", {
		artist: track.artist,
		track: track.title,
		album: track.album || "",
		duration: String(Math.round(track.duration || 0)),
	});
}

export async function scrobbleSubmit(
	track: TrackInfo,
	timestamp: number,
): Promise<boolean> {
	return apiCall("track.scrobble", {
		artist: track.artist,
		track: track.title,
		album: track.album || "",
		duration: String(Math.round(track.duration || 0)),
		timestamp: String(Math.floor(timestamp / 1000)),
	});
}
