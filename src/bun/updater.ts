// GitHub Releases poller + installer download + SHA-256 verification + silent install spawn.

import { createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { LatestReleaseInfo } from "../shared/rpcSchema";

function parseRepo(input: string): { owner: string; repo: string } | null {
	const trimmed = input.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
	const parts = trimmed.split("/").filter(Boolean);
	if (parts.length < 2) return null;
	return { owner: parts[0], repo: parts[1] };
}

type RawAsset = { name?: string; browser_download_url?: string; size?: number };
type RawRelease = {
	tag_name?: string;
	name?: string;
	body?: string;
	html_url?: string;
	published_at?: string;
	assets?: RawAsset[];
	draft?: boolean;
	prerelease?: boolean;
};

export async function fetchLatestRelease(
	repo: string,
	channel: "stable" | "canary" = "stable",
): Promise<LatestReleaseInfo | null> {
	const parsed = parseRepo(repo);
	if (!parsed) {
		throw new Error(`Invalid repo "${repo}". Expected "owner/repo".`);
	}

	const url = channel === "canary"
		? `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/releases`
		: `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/releases/latest`;

	const res = await fetch(url, {
		headers: {
			"User-Agent": "Lakky-Updater/2.0",
			Accept: "application/vnd.github+json",
		},
	});

	if (res.status === 404) return null;
	if (!res.ok) throw new Error(`GitHub ${res.status} ${res.statusText}`);

	const rawData = await res.json();
	let data: RawRelease | undefined;

	if (channel === "canary" && Array.isArray(rawData)) {
		data = rawData.find((r: RawRelease) => !r.draft);
	} else if (!Array.isArray(rawData) && typeof rawData === "object") {
		data = rawData as RawRelease;
	}

	if (!data || !data.tag_name || data.draft) return null;

	const exeAsset = data.assets?.find((a) => a.name?.toLowerCase().endsWith(".exe"));
	const shaAsset = data.assets?.find((a) =>
		a.name?.toLowerCase().endsWith(".sha256") || a.name?.toLowerCase().endsWith(".sha256sum"),
	);

	// Extract expected SHA-256 if present in body or sha256 file
	let expectedSha256: string | null = null;
	const bodyHashMatch = data.body?.match(/([a-fA-F0-9]{64})/);
	if (bodyHashMatch) {
		expectedSha256 = bodyHashMatch[1].toLowerCase();
	}

	return {
		tag: data.tag_name,
		version: data.tag_name.replace(/^v/i, ""),
		name: data.name || data.tag_name,
		notes: data.body || "",
		htmlUrl: data.html_url || `https://github.com/${parsed.owner}/${parsed.repo}/releases/latest`,
		publishedAt: data.published_at || "",
		installerUrl: exeAsset?.browser_download_url ?? null,
		installerName: exeAsset?.name ?? null,
		installerSize: exeAsset?.size ?? null,
		sha256Url: shaAsset?.browser_download_url ?? null,
		expectedSha256,
	};
}

export interface DownloadProgress {
	received: number;
	total: number;
	percent: number;
	speedBytesPerSec: number;
	etaSeconds: number;
}

// Stream a release asset to %TEMP%\lakky-updates\<filename> with speed and hash validation.
export async function downloadInstaller(
	url: string,
	filename: string,
	onProgress: (progress: DownloadProgress) => void,
): Promise<{ path: string; sha256: string }> {
	const dir = join(tmpdir(), "lakky-updates");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	const dest = join(dir, filename);

	const res = await fetch(url, {
		headers: { "User-Agent": "Lakky-Updater/2.0" },
		redirect: "follow",
	});
	if (!res.ok || !res.body) {
		throw new Error(`Download failed: ${res.status} ${res.statusText}`);
	}

	const total = Number(res.headers.get("content-length") ?? -1);
	const out = createWriteStream(dest);
	const hash = createHash("sha256");

	let received = 0;
	let lastTime = performance.now();
	let lastReceived = 0;
	let speedBytesPerSec = 0;

	const reader = res.body.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;

			received += value.length;
			hash.update(value);
			out.write(value);

			const now = performance.now();
			const elapsed = (now - lastTime) / 1000;
			if (elapsed >= 0.25) {
				const bytesDiff = received - lastReceived;
				speedBytesPerSec = bytesDiff / elapsed;
				lastTime = now;
				lastReceived = received;

				const percent = total > 0 ? (received / total) * 100 : 0;
				const remainingBytes = Math.max(0, total - received);
				const etaSeconds = speedBytesPerSec > 0 ? remainingBytes / speedBytesPerSec : 0;

				onProgress({
					received,
					total,
					percent,
					speedBytesPerSec,
					etaSeconds,
				});
			}
		}
	} finally {
		await new Promise<void>((resolve, reject) => {
			out.end((err: Error | null | undefined) => (err ? reject(err) : resolve()));
		});
	}

	const finalSha256 = hash.digest("hex").toLowerCase();
	return { path: dest, sha256: finalSha256 };
}

// Spawn the installer detached with silent install flags and restart the application cleanly.
export function spawnInstallerAndQuit(installerPath: string): void {
	const child = spawn(
		installerPath,
		["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART"],
		{ detached: true, stdio: "ignore" },
	);
	child.unref();

	// Allow a brief delay for Windows process registration before exiting
	setTimeout(() => process.exit(0), 300);
}
