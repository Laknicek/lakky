// Discord IPC client implemented directly against the native named-pipe protocol.
// Built for high reliability, zero-crash error resilience, multi-pipe Windows support,
// and rich multimedia state mapping (anime badges, 8D audio, Lo-Fi, live countdowns).
//
// Frame layout: u32 LE opcode (4 bytes) + u32 LE length (4 bytes) + UTF-8 JSON payload.
// Opcodes: 0 HANDSHAKE, 1 FRAME, 2 CLOSE, 3 PING, 4 PONG.

import net from "node:net";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { DiscordPresence } from "../shared/rpcSchema";
import { findCoverArtUrl } from "./coverArt";

const CLIENT_ID = process.env.LAK_DISCORD_CLIENT_ID ?? "1505585532179054744";
const VERBOSE = process.env.LAK_DISCORD_DEBUG === "1";

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

export const BADGE_ASSETS = {
	APP_LOGO: "app_logo",
	APP_LOGO_FALLBACK: "lak_logo",
	VINYL_SPINNING: "vinyl_spinning",
	SAKURA_BLOOM: "sakura_bloom",
	AUDIO_EQUALIZER: "audio_equalizer",
	STATUS_PLAYING: "status_playing",
	STATUS_PAUSED: "status_paused",
	PLAY_LEGACY: "play",
	PAUSE_LEGACY: "pause",
} as const;

export const DEFAULT_DISCORD_BUTTONS: Array<{ label: string; url: string }> = [
	{ label: "🌸 Get Lakky Player", url: "https://github.com/Laknicek/lakky" },
	{ label: "✨ Listen Along", url: "https://github.com/Laknicek/lakky/releases" },
];

export type DiscordUser = {
	id: string;
	username: string;
	discriminator?: string;
	avatar?: string | null;
	global_name?: string | null;
	bot?: boolean;
	flags?: number;
	premium_type?: number;
};

export type DiscordActivity = {
	instance: boolean;
	details?: string;
	state?: string;
	timestamps?: { start?: number; end?: number };
	assets?: {
		large_image?: string;
		large_text?: string;
		small_image?: string;
		small_text?: string;
	};
	buttons?: Array<{ label: string; url: string }>;
	type?: number;
};

export type RichPresenceOptions = {
	title?: string;
	artist?: string;
	album?: string;
	kind?: "audio" | "video";
	mode?: "spatial" | "lofi" | "video" | "idle" | "normal";
	paused?: boolean;
	currentTime?: number;
	duration?: number;
	trackNumber?: number;
	totalTracks?: number;
	isIdle?: boolean;
	largeImageKey?: string;
	largeImageText?: string;
	smallImageKey?: string;
	smallImageText?: string;
	buttons?: Array<{ label: string; url: string }>;
};

function log(...args: unknown[]) {
	if (VERBOSE) console.log("[discord]", ...args);
}

function warn(...args: unknown[]) {
	console.warn("[discord]", ...args);
}

/**
 * Sanitizes strings for Discord Rich Presence.
 * Discord enforces a 128-char limit on details/state and rejects single-character strings.
 */
export function sanitizeDiscordString(text?: string | null, maxLength = 128): string | undefined {
	if (!text) return undefined;
	// Strip ASCII control characters and zero-width spaces/joiners
	let cleaned = text
		.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g, "")
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length === 0) return undefined;
	// Discord protocol rejects 1-character details/state; pad with a trailing space if length is 1
	if (cleaned.length === 1) cleaned = `${cleaned} `;
	if (cleaned.length > maxLength) {
		cleaned = cleaned.slice(0, maxLength).trim();
		if (cleaned.length === 1) cleaned = `${cleaned} `;
	}
	return cleaned;
}

/**
 * Maps input badge names to canonical Discord application asset keys.
 */
export function mapBadgeAsset(key?: string | null): string | undefined {
	if (!key) return undefined;
	const normalized = key.toLowerCase().trim();
	if (normalized === "play" || normalized === "status_playing") return BADGE_ASSETS.STATUS_PLAYING;
	if (normalized === "pause" || normalized === "status_paused") return BADGE_ASSETS.STATUS_PAUSED;
	if (normalized === "lak_logo" || normalized === "app_logo") return BADGE_ASSETS.APP_LOGO;
	if (normalized === "vinyl_spinning") return BADGE_ASSETS.VINYL_SPINNING;
	if (normalized === "sakura_bloom") return BADGE_ASSETS.SAKURA_BLOOM;
	if (normalized === "audio_equalizer" || normalized === "equalizer") return BADGE_ASSETS.AUDIO_EQUALIZER;
	return key;
}

/**
 * Transforms a high-level DiscordPresence object into Discord's wire-format SET_ACTIVITY payload.
 */
export function buildDiscordActivity(
	presence: DiscordPresence,
	opts?: { stripAssets?: boolean; fallbackLargeImage?: string },
): DiscordActivity {
	const activity: DiscordActivity = {
		instance: false,
	};

	const isIdle = Boolean(presence.isIdle || presence.mode === "idle");
	const isPaused = Boolean(
		presence.paused ||
		(presence.state && presence.state.toLowerCase().startsWith("paused")) ||
		presence.smallImageKey === "pause" ||
		presence.smallImageKey === "status_paused"
	);

	// 1. Activity details: Song Title + Artist (with sanitization)
	let detailsStr: string | undefined;
	if (isIdle) {
		detailsStr = "Exploring Music Library";
	} else if (presence.details) {
		detailsStr = presence.details;
	} else if (presence.title) {
		detailsStr = presence.artist ? `${presence.title} — ${presence.artist}` : presence.title;
	}

	const sanitizedDetails = sanitizeDiscordString(detailsStr, 128);
	if (sanitizedDetails) {
		activity.details = sanitizedDetails;
	}

	// 2. State description: Album name, Track position, or special modes
	let stateStr: string | undefined;
	if (isIdle) {
		stateStr = "🌸 Browsing Tracks & Playlists";
	} else if (presence.mode === "spatial" || (presence.state && presence.state.includes("8D Spatial"))) {
		stateStr = isPaused ? "⏸ Paused • 🎧 8D Spatial Audio" : "🎧 8D Spatial Audio";
	} else if (presence.mode === "lofi" || (presence.state && presence.state.includes("Lo-Fi"))) {
		stateStr = isPaused ? "⏸ Paused • 🌸 Relaxing to Lo-Fi" : "🌸 Relaxing to Lo-Fi";
	} else if (presence.mode === "video" || (presence.state && presence.state.includes("Watching Video"))) {
		stateStr = isPaused ? "⏸ Paused • 🎬 Watching Video" : "🎬 Watching Video";
	} else if (presence.state) {
		stateStr = presence.state;
	} else if (isPaused) {
		stateStr = presence.artist ? `⏸ Paused • ${presence.artist}` : "⏸ Paused";
	} else if (presence.trackNumber && presence.totalTracks) {
		stateStr = presence.album
			? `${presence.album} • Track ${presence.trackNumber} of ${presence.totalTracks}`
			: `Track ${presence.trackNumber} of ${presence.totalTracks}`;
	} else if (presence.album) {
		stateStr = presence.album;
	} else if (presence.artist) {
		stateStr = presence.artist;
	}

	const sanitizedState = sanitizeDiscordString(stateStr, 128);
	if (sanitizedState) {
		activity.state = sanitizedState;
	}

	// 3. Accurate live timestamps (Start and End timestamps for synchronized Discord progress bar)
	if (isPaused) {
		// When paused, omit endTimestamp so Discord doesn't render an advancing progress bar
		if (presence.startTimestamp && presence.startTimestamp > 0) {
			activity.timestamps = { start: Math.floor(presence.startTimestamp) };
		}
	} else if (presence.startTimestamp || presence.endTimestamp) {
		activity.timestamps = {};
		if (presence.startTimestamp && presence.startTimestamp > 0) {
			activity.timestamps.start = Math.floor(presence.startTimestamp);
		}
		if (presence.endTimestamp && presence.endTimestamp > 0) {
			activity.timestamps.end = Math.floor(presence.endTimestamp);
		}
	} else if (presence.duration && presence.duration > 0) {
		const cur = Math.max(0, presence.currentTime ?? 0);
		const dur = presence.duration;
		const nowSec = Math.floor(Date.now() / 1000);
		activity.timestamps = {
			start: Math.floor(nowSec - cur),
			end: Math.floor(nowSec + (dur - cur)),
		};
	} else if (isIdle && presence.startTimestamp) {
		activity.timestamps = { start: Math.floor(presence.startTimestamp) };
	}

	// 4. Large and Small image keys with anime fallback badges
	if (!opts?.stripAssets) {
		const assets: NonNullable<DiscordActivity["assets"]> = {};

		// Large Image
		let largeKey = opts?.fallbackLargeImage ?? presence.largeImageKey ?? BADGE_ASSETS.APP_LOGO;
		// If largeKey is a full HTTPS url (e.g. from iTunes coverArt), pass it as is. Otherwise map badge asset.
		if (!/^https?:\/\//i.test(largeKey)) {
			largeKey = mapBadgeAsset(largeKey) ?? BADGE_ASSETS.APP_LOGO;
		}
		assets.large_image = largeKey;

		let largeText = presence.largeImageText;
		if (!largeText) {
			if (presence.album) largeText = `${presence.album} — Lakky`;
			else if (presence.title) largeText = `${presence.title} — Lakky`;
			else largeText = "Lakky Player";
		}
		assets.large_text = sanitizeDiscordString(largeText, 128);

		// Small Image
		let smallKey = presence.smallImageKey;
		let smallText = presence.smallImageText;

		if (!smallKey) {
			if (isPaused) {
				smallKey = BADGE_ASSETS.STATUS_PAUSED;
				smallText = smallText ?? "Paused";
			} else if (presence.mode === "spatial" || (presence.state && presence.state.includes("8D Spatial"))) {
				smallKey = BADGE_ASSETS.AUDIO_EQUALIZER;
				smallText = smallText ?? "8D Spatial Audio";
			} else if (presence.mode === "lofi" || (presence.state && presence.state.includes("Lo-Fi"))) {
				smallKey = BADGE_ASSETS.SAKURA_BLOOM;
				smallText = smallText ?? "Relaxing to Lo-Fi";
			} else if (presence.mode === "video" || (presence.state && presence.state.includes("Watching Video"))) {
				smallKey = BADGE_ASSETS.VINYL_SPINNING;
				smallText = smallText ?? "Watching Video";
			} else if (!isIdle) {
				smallKey = BADGE_ASSETS.STATUS_PLAYING;
				smallText = smallText ?? "Playing";
			}
		}

		if (smallKey) {
			assets.small_image = mapBadgeAsset(smallKey);
			if (smallText) {
				assets.small_text = sanitizeDiscordString(smallText, 128);
			}
		}

		activity.assets = assets;
	}

	// 5. Interactive Discord presence buttons
	let rawButtons = presence.buttons;
	// Upgrade single placeholder button or empty array to high-aesthetic interactive duo
	if (!rawButtons || rawButtons.length === 0 || (rawButtons.length === 1 && rawButtons[0].url === "https://lakky.app")) {
		rawButtons = DEFAULT_DISCORD_BUTTONS;
	}

	if (rawButtons && rawButtons.length > 0) {
		const validButtons = rawButtons
			.filter((b) => b && typeof b.label === "string" && typeof b.url === "string" && /^https?:\/\//i.test(b.url.trim()))
			.slice(0, 2)
			.map((b) => ({
				label: sanitizeDiscordString(b.label, 32) || "Lakky Player",
				url: b.url.trim().slice(0, 512),
			}));

		if (validButtons.length > 0) {
			activity.buttons = validButtons;
		}
	}

	return activity;
}

/**
 * Builds a structured DiscordPresence object from player states and options.
 */
export function formatRichPresence(opts: RichPresenceOptions): DiscordPresence {
	const presence: DiscordPresence = {
		title: opts.title,
		artist: opts.artist,
		album: opts.album,
		mode: opts.mode,
		paused: opts.paused,
		currentTime: opts.currentTime,
		duration: opts.duration,
		trackNumber: opts.trackNumber,
		totalTracks: opts.totalTracks,
		isIdle: opts.isIdle,
		largeImageKey: opts.largeImageKey,
		largeImageText: opts.largeImageText,
		smallImageKey: opts.smallImageKey,
		smallImageText: opts.smallImageText,
		buttons: opts.buttons,
	};

	if (opts.isIdle) {
		presence.details = "Exploring Music Library";
		presence.state = "🌸 Browsing Tracks & Playlists";
		presence.startTimestamp = Math.floor(Date.now() / 1000);
		presence.largeImageKey = BADGE_ASSETS.APP_LOGO;
		presence.largeImageText = "Lakky Player";
		presence.smallImageKey = BADGE_ASSETS.SAKURA_BLOOM;
		presence.smallImageText = "Library Mode";
	}

	return presence;
}

/**
 * Returns candidate pipe/socket paths across Windows (\\\\?\\pipe\\ and \\\\.\\pipe\\)
 * and Unix platforms (XDG, tmpdir, snap, flatpak, /tmp).
 */
function getCandidatePipes(): string[] {
	const candidates: string[] = [];

	if (process.platform === "win32") {
		// Discord listens on pipes 0..9. We scan both \\?\pipe\ and \\.\pipe\ namespaces
		for (let i = 0; i < 10; i++) {
			candidates.push(`\\\\?\\pipe\\discord-ipc-${i}`);
			candidates.push(`\\\\.\\pipe\\discord-ipc-${i}`);
		}
		return candidates;
	}

	// Unix / macOS candidates
	const runtimeDir = process.env.XDG_RUNTIME_DIR;
	const tmpDir = process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp";
	const uid = typeof process.getuid === "function" ? process.getuid() : 1000;

	const baseDirs = [
		runtimeDir,
		tmpDir,
		`/run/user/${uid}`,
		`/run/user/${uid}/app/com.discordapp.Discord`,
		`/run/user/${uid}/snap.discord`,
		process.env.HOME ? `${process.env.HOME}/.config/discord` : null,
		"/tmp",
	].filter((d): d is string => Boolean(d && d.length > 0));

	for (let i = 0; i < 10; i++) {
		for (const dir of baseDirs) {
			const cleanDir = dir.replace(/\/+$/, "");
			const path = `${cleanDir}/discord-ipc-${i}`;
			// On Unix socket files must exist on the filesystem
			if (existsSync(path)) {
				candidates.push(path);
			}
		}
	}

	// Also append fallback paths even if existsSync didn't see them
	if (candidates.length === 0) {
		for (let i = 0; i < 10; i++) {
			candidates.push(`${tmpDir.replace(/\/+$/, "")}/discord-ipc-${i}`);
		}
	}

	return Array.from(new Set(candidates));
}

type Pending = {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
};

class DiscordIpc {
	private sock: net.Socket | null = null;
	private buf: Buffer = Buffer.alloc(0);
	private ready = false;
	private connecting = false;
	private readyWaiters: Array<() => void> = [];
	private pending = new Map<string, Pending>();
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private reconnectDelayMs = 3000;
	private currentUser: DiscordUser | null = null;
	public statusListeners = new Set<(connected: boolean) => void>();

	get isReady(): boolean {
		return this.ready;
	}

	get isConnecting(): boolean {
		return this.connecting;
	}

	get user(): DiscordUser | null {
		return this.currentUser;
	}

	async connect(): Promise<boolean> {
		if (this.ready) return true;
		if (this.connecting) {
			return new Promise((res) => this.readyWaiters.push(() => res(this.ready)));
		}
		this.connecting = true;

		try {
			const sock = await this.openPipe();
			if (!sock) {
				log("no Discord IPC pipe found — is Discord running?");
				this.connecting = false;
				this.scheduleReconnect();
				return false;
			}

			this.sock = sock;
			this.buf = Buffer.alloc(0);

			sock.on("data", (chunk: Buffer) => this.onData(chunk));
			sock.on("error", (err: Error) => {
				warn("socket error:", err.message);
				this.teardown();
			});
			sock.on("close", () => {
				log("socket closed");
				this.teardown();
			});
			sock.on("end", () => {
				log("socket ended");
				this.teardown();
			});

			// Send HANDSHAKE
			this.send(OP_HANDSHAKE, { v: 1, client_id: CLIENT_ID });
			log("sent HANDSHAKE, waiting for READY...");

			// Wait for READY event with timeout
			await new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => {
					reject(new Error("Discord READY timeout"));
				}, 6000);

				this.readyWaiters.push(() => {
					clearTimeout(timer);
					if (this.ready) resolve();
					else reject(new Error("connection closed before READY"));
				});
			});

			// Reset backoff delay on successful connect
			this.reconnectDelayMs = 3000;
			return this.ready;
		} catch (err) {
			warn("connect failed:", (err as Error).message);
			this.connecting = false;
			this.teardown();
			this.scheduleReconnect();
			return false;
		}
	}

	private async openPipe(): Promise<net.Socket | null> {
		const pipes = getCandidatePipes();

		for (const path of pipes) {
			try {
				const sock = await new Promise<net.Socket | null>((resolve) => {
					let settled = false;
					const s = net.createConnection({ path });

					const timeout = setTimeout(() => {
						if (!settled) {
							settled = true;
							try { s.destroy(); } catch {}
							resolve(null);
						}
					}, 1200);

					const onErr = () => {
						if (!settled) {
							settled = true;
							clearTimeout(timeout);
							try { s.destroy(); } catch {}
							resolve(null);
						}
					};

					s.once("error", onErr);
					s.once("connect", () => {
						if (!settled) {
							settled = true;
							clearTimeout(timeout);
							s.off("error", onErr);
							resolve(s);
						}
					});
				});

				if (sock) {
					log(`connected to pipe: ${path}`);
					return sock;
				}
			} catch {
				// Continue to next pipe
			}
		}
		return null;
	}

	private send(op: number, payload: unknown) {
		if (!this.sock || this.sock.destroyed) return;
		try {
			const body = Buffer.from(JSON.stringify(payload), "utf8");
			const header = Buffer.alloc(8);
			header.writeUInt32LE(op, 0);
			header.writeUInt32LE(body.length, 4);
			const frame = Buffer.concat([header as unknown as Uint8Array, body as unknown as Uint8Array]);
			this.sock.write(frame as unknown as Uint8Array);
			log("→ op:", op, payload);
		} catch (err) {
			warn("send failed:", (err as Error).message);
		}
	}

	private onData(chunk: Buffer) {
		this.buf = Buffer.concat([this.buf as unknown as Uint8Array, chunk as unknown as Uint8Array]);

		while (this.buf.length >= 8) {
			const op = this.buf.readUInt32LE(0);
			const len = this.buf.readUInt32LE(4);

			// Safety limit: reject frames larger than 2MB
			if (len > 2 * 1024 * 1024) {
				warn("oversized frame received, resetting buffer");
				this.teardown();
				return;
			}

			if (this.buf.length < 8 + len) return;

			const bodyRaw = this.buf.subarray(8, 8 + len).toString("utf8");
			this.buf = this.buf.subarray(8 + len);

			let body: any = null;
			try {
				body = JSON.parse(bodyRaw);
			} catch {
				warn("non-JSON frame received:", bodyRaw);
				continue;
			}
			log("← op:", op, body);

			if (op === OP_PING) {
				this.send(OP_PONG, body);
				continue;
			}

			if (op === OP_CLOSE) {
				warn("server requested close:", body);
				this.teardown();
				continue;
			}

			if (op === OP_FRAME) {
				if (body.evt === "READY") {
					this.ready = true;
					this.connecting = false;
					if (body.data?.user) {
						this.currentUser = body.data.user;
					}
					this.notifyStatus(true);
					const waiters = this.readyWaiters;
					this.readyWaiters = [];
					for (const cb of waiters) {
						try { cb(); } catch {}
					}
					continue;
				}

				if (body.nonce && this.pending.has(body.nonce)) {
					const p = this.pending.get(body.nonce)!;
					this.pending.delete(body.nonce);
					if (body.evt === "ERROR") {
						p.reject(new Error(body.data?.message ?? "Discord returned ERROR"));
					} else {
						p.resolve(body.data);
					}
				}
			}
		}
	}

	private teardown() {
		const wasReady = this.ready;
		this.ready = false;
		this.connecting = false;
		this.currentUser = null;

		try {
			this.sock?.destroy();
		} catch {}
		this.sock = null;
		this.buf = Buffer.alloc(0);

		for (const p of this.pending.values()) {
			try { p.reject(new Error("Discord disconnected")); } catch {}
		}
		this.pending.clear();

		const waiters = this.readyWaiters;
		this.readyWaiters = [];
		for (const cb of waiters) {
			try { cb(); } catch {}
		}

		if (wasReady) {
			this.notifyStatus(false);
		}

		// If a presence was active, auto-reconnect
		if (lastPresence !== null) {
			this.scheduleReconnect();
		}
	}

	public scheduleReconnect() {
		if (this.reconnectTimer) return;
		if (lastPresence === null) return;

		// Calculate backoff with ±15% jitter
		const jitter = (Math.random() * 0.3 - 0.15) * this.reconnectDelayMs;
		const delay = Math.min(30_000, Math.floor(this.reconnectDelayMs + jitter));

		log(`scheduling reconnect in ${delay}ms`);
		this.reconnectTimer = setTimeout(async () => {
			this.reconnectTimer = null;
			if (lastPresence !== null && !this.ready) {
				const ok = await this.connect();
				if (ok && lastPresence !== null) {
					applyPresence(lastPresence);
				} else {
					// Step up delay on repeated failures
					this.reconnectDelayMs = Math.min(30_000, Math.floor(this.reconnectDelayMs * 1.5));
				}
			}
		}, delay);
	}

	public cancelReconnect() {
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.reconnectDelayMs = 3000;
	}

	private notifyStatus(connected: boolean) {
		for (const cb of this.statusListeners) {
			try { cb(connected); } catch (e) {
				warn("status listener error:", e);
			}
		}
	}

	async request<T = unknown>(cmd: string, args: unknown): Promise<T> {
		if (!this.ready) {
			const ok = await this.connect();
			if (!ok) throw new Error("Discord IPC not connected");
		}

		const nonce = randomUUID();
		return new Promise<T>((resolve, reject) => {
			const timeout = setTimeout(() => {
				if (this.pending.has(nonce)) {
					this.pending.delete(nonce);
					reject(new Error(`Discord command ${cmd} timed out`));
				}
			}, 6000);

			this.pending.set(nonce, {
				resolve: (res) => {
					clearTimeout(timeout);
					resolve(res as T);
				},
				reject: (err) => {
					clearTimeout(timeout);
					reject(err);
				},
			});

			this.send(OP_FRAME, { cmd, args, nonce });
		});
	}
}

let client: DiscordIpc | null = null;
let lastPresence: DiscordPresence | null = null;

function getOrCreateClient(): DiscordIpc {
	if (!client) {
		client = new DiscordIpc();
	}
	return client;
}

/**
 * Dispatches SET_ACTIVITY payload to Discord with automatic asset error recovery.
 */
function applyPresence(presence: DiscordPresence) {
	const c = getOrCreateClient();
	if (!c.isReady) return;

	const activity = buildDiscordActivity(presence);

	c.request("SET_ACTIVITY", { pid: process.pid, activity }).catch((err: Error) => {
		warn("SET_ACTIVITY rejected:", err.message);

		// If error is caused by invalid asset key, fallback to standard app logo or strip assets
		const msg = err.message.toLowerCase();
		if (msg.includes("asset") || msg.includes("image")) {
			log("retrying SET_ACTIVITY with fallback logo badge");
			const fallbackActivity = buildDiscordActivity(presence, {
				fallbackLargeImage: BADGE_ASSETS.APP_LOGO_FALLBACK,
			});

			c.request("SET_ACTIVITY", { pid: process.pid, activity: fallbackActivity }).catch(() => {
				log("retrying SET_ACTIVITY without assets");
				const noAssetActivity = buildDiscordActivity(presence, { stripAssets: true });
				c.request("SET_ACTIVITY", { pid: process.pid, activity: noAssetActivity }).catch(() => {});
			});
		}
	});
}

/**
 * Resolves high-resolution album cover art in the background via iTunes cache
 * and updates Discord presence once resolved.
 */
async function enrichWithCoverArt(presence: DiscordPresence): Promise<DiscordPresence> {
	if (!presence.artist || !presence.album) return presence;
	const url = await findCoverArtUrl(presence.artist, presence.album);
	if (!url) return presence;
	return { ...presence, largeImageKey: url };
}

/**
 * Registers a callback for Discord connection state changes.
 * Returns an unsubscribe function.
 */
export function onDiscordStatus(cb: (connected: boolean) => void): () => void {
	const c = getOrCreateClient();
	c.statusListeners.add(cb);
	return () => {
		c.statusListeners.delete(cb);
	};
}

/**
 * Returns current Discord IPC client status.
 */
export function getDiscordStatus(): {
	connected: boolean;
	connecting: boolean;
	user?: DiscordUser | null;
} {
	if (!client) return { connected: false, connecting: false, user: null };
	return {
		connected: client.isReady,
		connecting: client.isConnecting,
		user: client.user,
	};
}

/**
 * Clears Discord Rich Presence.
 */
export async function clearDiscordPresence(): Promise<{ ok: boolean }> {
	return (await setDiscordPresence(null)).ok ? { ok: true } : { ok: false };
}

/**
 * Primary entrypoint: Updates Discord Rich Presence with rich metadata, live countdown timestamps,
 * anime badges, and cover-art enrichment.
 */
export async function setDiscordPresence(
	presence: DiscordPresence | null,
): Promise<{ ok: boolean; connected: boolean }> {
	lastPresence = presence;
	const c = getOrCreateClient();

	if (presence === null) {
		c.cancelReconnect();
		if (c.isReady) {
			try {
				await c.request("SET_ACTIVITY", { pid: process.pid, activity: null });
			} catch (err) {
				warn("clear activity failed:", (err as Error).message);
			}
		}
		return { ok: true, connected: c.isReady };
	}

	const ok = await c.connect();
	if (ok) {
		// Post fast local badges immediately so Discord activity reflects state with zero lag
		applyPresence(presence);

		// In background, fetch/cache album cover art and upgrade presence once available
		if (presence.artist && presence.album) {
			enrichWithCoverArt(presence)
				.then((enriched) => {
					// Verify presence hasn't changed while awaiting cover art
					if (lastPresence !== presence) return;
					if (enriched.largeImageKey && enriched.largeImageKey !== presence.largeImageKey) {
						applyPresence(enriched);
					}
				})
				.catch(() => {});
		}
	}

	return { ok, connected: c.isReady };
}
