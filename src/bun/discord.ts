// Discord IPC client implemented directly against the named-pipe protocol.
// We avoid the `discord-rpc` npm package because its login() hangs silently
// under Bun on Windows. The wire protocol is simple enough that talking to
// the pipe ourselves is more reliable.
//
// Frame layout: u32 LE opcode + u32 LE length + UTF-8 JSON payload.
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

function pipePath(i: number): string {
	// Discord listens on pipes 0..9. On Windows they're named, on macOS/Linux
	// they're Unix sockets under XDG_RUNTIME_DIR / $TMPDIR.
	if (process.platform === "win32") {
		return `\\\\.\\pipe\\discord-ipc-${i}`;
	}
	const dir =
		process.env.XDG_RUNTIME_DIR ||
		process.env.TMPDIR ||
		process.env.TMP ||
		process.env.TEMP ||
		"/tmp";
	return `${dir.replace(/\/+$/, "")}/discord-ipc-${i}`;
}

function log(...args: unknown[]) {
	if (VERBOSE) console.log("[discord]", ...args);
}
function warn(...args: unknown[]) {
	console.warn("[discord]", ...args);
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
	onStatus: ((connected: boolean) => void) | null = null;

	get isReady() {
		return this.ready;
	}

	async connect(): Promise<boolean> {
		if (this.ready) return true;
		if (this.connecting) return new Promise((res) => this.readyWaiters.push(() => res(this.ready)));
		this.connecting = true;

		try {
			const sock = await this.openPipe();
			if (!sock) {
				log("no IPC pipe found — is Discord running?");
				this.connecting = false;
				this.scheduleReconnect();
				return false;
			}
			this.sock = sock;
			sock.on("data", (chunk: Buffer) => this.onData(chunk));
			sock.on("error", (err: Error) => {
				warn("socket error:", err.message);
				this.teardown();
			});
			sock.on("close", () => {
				log("socket closed");
				this.teardown();
			});

			// HANDSHAKE
			this.send(OP_HANDSHAKE, { v: 1, client_id: CLIENT_ID });
			log("sent HANDSHAKE, waiting for READY...");

			// Wait for READY (handled in onData → resolves readyPromise)
			await new Promise<void>((resolve, reject) => {
				const t = setTimeout(() => {
					reject(new Error("READY timeout"));
				}, 5000);
				this.readyWaiters.push(() => {
					clearTimeout(t);
					resolve();
				});
			});
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
		for (let i = 0; i < 10; i++) {
			const path = pipePath(i);
			// On Unix the socket file must exist; on Windows we just try and let
			// connect fail-fast if the pipe isn't published.
			if (process.platform !== "win32" && !existsSync(path)) continue;

			try {
				const sock = await new Promise<net.Socket | null>((resolve) => {
					const s = net.createConnection({ path });
					const onErr = () => {
						s.destroy();
						resolve(null);
					};
					s.once("error", onErr);
					s.once("connect", () => {
						s.off("error", onErr);
						resolve(s);
					});
				});
				if (sock) {
					log(`connected to ${path}`);
					return sock;
				}
			} catch {
				// try the next pipe
			}
		}
		return null;
	}

	private send(op: number, payload: unknown) {
		if (!this.sock) return;
		const body = Buffer.from(JSON.stringify(payload), "utf8");
		const header = Buffer.alloc(8);
		header.writeUInt32LE(op, 0);
		header.writeUInt32LE(body.length, 4);
		const parts: Uint8Array[] = [header as unknown as Uint8Array, body as unknown as Uint8Array];
		const frame = Buffer.concat(parts);
		this.sock.write(frame as unknown as Uint8Array);
		log("→", op, payload);
	}

	private onData(chunk: Buffer) {
		const parts: Uint8Array[] = [this.buf as unknown as Uint8Array, chunk as unknown as Uint8Array];
		this.buf = Buffer.concat(parts);
		while (this.buf.length >= 8) {
			const op = this.buf.readUInt32LE(0);
			const len = this.buf.readUInt32LE(4);
			if (this.buf.length < 8 + len) return;
			const bodyRaw = this.buf.subarray(8, 8 + len).toString("utf8");
			this.buf = this.buf.subarray(8 + len);

			let body: any = null;
			try {
				body = JSON.parse(bodyRaw);
			} catch {
				warn("non-JSON frame:", bodyRaw);
				continue;
			}
			log("←", op, body);

			if (op === OP_PING) {
				this.send(OP_PONG, body);
				continue;
			}
			if (op === OP_CLOSE) {
				warn("server closed:", body);
				this.teardown();
				continue;
			}
			if (op === OP_FRAME) {
				if (body.evt === "READY") {
					this.ready = true;
					this.connecting = false;
					this.onStatus?.(true);
					const w = this.readyWaiters;
					this.readyWaiters = [];
					for (const cb of w) cb();
					continue;
				}
				if (body.nonce && this.pending.has(body.nonce)) {
					const p = this.pending.get(body.nonce)!;
					this.pending.delete(body.nonce);
					if (body.evt === "ERROR") p.reject(new Error(body.data?.message ?? "ERROR"));
					else p.resolve(body.data);
				}
			}
		}
	}

	private teardown() {
		const wasReady = this.ready;
		this.ready = false;
		this.connecting = false;
		try { this.sock?.destroy(); } catch {}
		this.sock = null;
		this.buf = Buffer.alloc(0);
		for (const p of this.pending.values()) p.reject(new Error("disconnected"));
		this.pending.clear();
		const w = this.readyWaiters;
		this.readyWaiters = [];
		for (const cb of w) cb();
		if (wasReady) this.onStatus?.(false);
	}

	private scheduleReconnect() {
		if (this.reconnectTimer) return;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			if (lastPresence) this.connect().then((ok) => {
				if (ok) applyPresence(lastPresence!);
			});
		}, 15_000);
	}

	async request<T = unknown>(cmd: string, args: unknown): Promise<T> {
		if (!this.ready) {
			const ok = await this.connect();
			if (!ok) throw new Error("not connected");
		}
		const nonce = randomUUID();
		const p = new Promise<T>((resolve, reject) => {
			this.pending.set(nonce, { resolve: resolve as (v: unknown) => void, reject });
			setTimeout(() => {
				if (this.pending.has(nonce)) {
					this.pending.delete(nonce);
					reject(new Error(`${cmd} timeout`));
				}
			}, 5000);
		});
		this.send(OP_FRAME, { cmd, args, nonce });
		return p;
	}
}

let client: DiscordIpc | null = null;
let lastPresence: DiscordPresence | null = null;

// The shape Discord's IPC accepts in SET_ACTIVITY. Keys are snake_case
// per Discord's protocol — keep them that way.
type DiscordActivity = {
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
};

function applyPresence(presence: DiscordPresence) {
	if (!client || !client.isReady) return;
	const activity: DiscordActivity = { instance: false };
	if (presence.details) activity.details = presence.details.slice(0, 128);
	if (presence.state) activity.state = presence.state.slice(0, 128);
	if (presence.startTimestamp || presence.endTimestamp) {
		activity.timestamps = {};
		if (presence.startTimestamp) activity.timestamps.start = presence.startTimestamp;
		if (presence.endTimestamp) activity.timestamps.end = presence.endTimestamp;
	}
	if (presence.largeImageKey || presence.largeImageText || presence.smallImageKey || presence.smallImageText) {
		activity.assets = {};
		if (presence.largeImageKey) activity.assets.large_image = presence.largeImageKey;
		if (presence.largeImageText) activity.assets.large_text = presence.largeImageText;
		if (presence.smallImageKey) activity.assets.small_image = presence.smallImageKey;
		if (presence.smallImageText) activity.assets.small_text = presence.smallImageText;
	}
	if (presence.buttons && presence.buttons.length > 0) {
		// Discord caps at two buttons, label ≤ 32 chars, URL ≤ 512 chars.
		activity.buttons = presence.buttons.slice(0, 2).map((b) => ({
			label: b.label.slice(0, 32),
			url: b.url.slice(0, 512),
		}));
	}
	client.request("SET_ACTIVITY", { pid: process.pid, activity }).catch((err: Error) => {
		warn("setActivity rejected:", err.message);
		// Most common cause: an `*ImageKey` references an asset key that hasn't
		// been uploaded yet. Retry without assets so the text still shows up.
		if (activity.assets && err.message.toLowerCase().includes("asset")) {
			delete activity.assets;
			client?.request("SET_ACTIVITY", { pid: process.pid, activity }).catch(() => {});
		}
	});
}

// Discord's `large_image` won't accept localhost URLs or local file paths,
// so per-track album art needs a public HTTPS URL. We resolve one via iTunes
// Search (cached aggressively to disk — see ./coverArt), then patch the
// presence with `large_image` set to the resolved URL once it arrives.
async function enrichWithCoverArt(presence: DiscordPresence): Promise<DiscordPresence> {
	if (!presence.artist || !presence.album) return presence;
	const url = await findCoverArtUrl(presence.artist, presence.album);
	if (!url) return presence;
	return { ...presence, largeImageKey: url };
}

let _onStatus: ((connected: boolean) => void) | null = null;

export function onDiscordStatus(cb: (connected: boolean) => void) {
	_onStatus = cb;
	if (client) client.onStatus = cb;
}

export async function setDiscordPresence(
	presence: DiscordPresence | null,
): Promise<{ ok: boolean; connected: boolean }> {
	lastPresence = presence;

	if (presence === null) {
		if (client && client.isReady) {
			try {
				await client.request("SET_ACTIVITY", { pid: process.pid, activity: null });
			} catch (err) {
				warn("clear failed:", (err as Error).message);
			}
		}
		return { ok: true, connected: client?.isReady ?? false };
	}

	if (!client) {
		client = new DiscordIpc();
		client.onStatus = _onStatus;
	}
	const ok = await client.connect();
	if (ok) {
		// Post the fallback (lak_logo) immediately so the activity appears
		// without waiting on the network. Then fire-and-forget the cover-art
		// lookup; a second SET_ACTIVITY upgrades to the real album art once
		// it resolves (cached hits are synchronous-ish, network <500 ms).
		applyPresence(presence);
		enrichWithCoverArt(presence)
			.then((enriched) => {
				if (lastPresence !== presence) return;
				if (enriched.largeImageKey !== presence.largeImageKey) {
					applyPresence(enriched);
				}
			})
			.catch(() => {});
	}
	return { ok, connected: client.isReady };
}
