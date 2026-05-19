// Tiny M3U / M3U8 reader + writer. Spec quirks we handle:
//  • lines starting with '#' are directives or comments, ignored except for
//    informational #EXTINF entries that we strip
//  • each non-comment line is a media file path
//  • paths may be relative; we resolve against the playlist file's dir
//  • mixed CRLF/LF line endings tolerated

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

export async function readM3U(playlistPath: string): Promise<string[]> {
	const raw = await readFile(playlistPath, "utf8");
	const baseDir = dirname(playlistPath);
	const out: string[] = [];
	for (const line of raw.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const resolved = isAbsolute(trimmed) ? trimmed : resolve(baseDir, trimmed);
		out.push(resolved);
	}
	return out;
}

export async function writeM3U(
	playlistPath: string,
	name: string,
	paths: string[],
): Promise<void> {
	const dir = dirname(playlistPath);
	await mkdir(dir, { recursive: true });
	const lines = ["#EXTM3U", `#PLAYLIST:${name}`];
	for (const p of paths) lines.push(p);
	await writeFile(playlistPath, lines.join("\r\n") + "\r\n", "utf8");
}
