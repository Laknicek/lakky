import {
	BrowserWindow,
	BrowserView,
	Tray,
	Updater,
	Utils,
} from "electrobun/bun";
import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, dirname } from "node:path";
import type { PlayerRPC, TrackInfo, SharedPlayerState, ExternalCommand } from "../shared/rpcSchema";
import {
	buildTrackInfo,
	classifyFile,
	copyIntoLibrary,
	walkMedia,
} from "./library";
import { startMediaServer } from "./mediaServer";
import { onDiscordStatus, setDiscordPresence } from "./discord";
import { readM3U, writeM3U } from "./m3u";
import { startWebRemote, stopWebRemote } from "./webRemote";
import { appDataDir, LAKKY_APP_DATA } from "./paths";
import { fetchLatestRelease } from "./updater";

const DEV_SERVER_PORT = 5173;
const DEV_SERVER_URL = `http://localhost:${DEV_SERVER_PORT}`;

async function getMainViewUrl(): Promise<string> {
	const channel = await Updater.localInfo.channel();
	if (channel === "dev") {
		try {
			await fetch(DEV_SERVER_URL, { method: "HEAD" });
			console.log(`HMR enabled: Using Vite dev server at ${DEV_SERVER_URL}`);
			return DEV_SERVER_URL;
		} catch {
			console.log(
				"Vite dev server not running. Run 'bun run dev:hmr' for HMR support.",
			);
		}
	}
	return "views://mainview/index.html";
}

// Local persistence — small JSON store in a stable OS app-data location so
// settings, the library folder, playlists, and play counts survive across
// Electrobun rebuilds (which would wipe anything stored inside build/).
function persistPath(): string {
	return join(appDataDir(LAKKY_APP_DATA), "state.json");
}

// One-time migration: if our current state file doesn't exist but one from
// the old app name does, copy it over. The original is left alone so a
// downgrade can still find it.
function migrateLegacyState() {
	const target = persistPath();
	if (existsSync(target)) return;
	const legacyNames = ["LAK Player", "lak-player"];
	for (const name of legacyNames) {
		const legacy = join(appDataDir(name), "state.json");
		if (existsSync(legacy)) {
			try {
				mkdirSync(dirname(target), { recursive: true });
				copyFileSync(legacy, target);
				console.log(`[state] migrated from ${legacy}`);
				return;
			} catch (err) {
				console.error("[state] migration failed:", err);
			}
		}
	}
}

migrateLegacyState();
console.log("[state] file:", persistPath());

function loadAll(): Record<string, unknown> {
	const path = persistPath();
	try {
		if (!existsSync(path)) return {};
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return {};
	}
}

function saveAll(state: Record<string, unknown>) {
	const path = persistPath();
	try {
		const dir = dirname(path);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
		writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
	} catch (err) {
		console.error("persist write failed:", err);
	}
}

function getLibraryFolder(): string | null {
	const all = loadAll();
	const v = all["libraryFolder"];
	return typeof v === "string" && v.length > 0 ? v : null;
}

function setLibraryFolder(value: string | null) {
	const all = loadAll();
	if (value) all["libraryFolder"] = value;
	else delete all["libraryFolder"];
	saveAll(all);
}

// Spin up the local media-streaming server
const media = startMediaServer();
const streamBase = `http://127.0.0.1:${media.port}`;
console.log(`Media server listening on ${streamBase}`);

// Ingest a single source path: build its track info, and, if the user has set
// a library folder, copy the file into it (organized as Artist/Album/Title.ext)
// and re-point the streaming URL at the local copy.
async function ingestOne(
	srcPath: string,
	libraryFolder: string | null,
): Promise<TrackInfo> {
	const initial = await buildTrackInfo(srcPath, streamBase);
	if (!libraryFolder) return initial;
	try {
		const { path: finalPath } = await copyIntoLibrary(srcPath, libraryFolder, {
			artist: initial.artist,
			album: initial.album,
			title: initial.title,
			trackNumber: initial.trackNumber,
		});
		if (finalPath !== srcPath) {
			return await buildTrackInfo(finalPath, streamBase);
		}
		return initial;
	} catch (err) {
		console.warn("[library] copy failed:", srcPath, (err as Error).message);
		return initial;
	}
}

// Forward-declared to break TS circular inference with the RPC handlers.
let mainWindow!: BrowserWindow<any>;
let miniWindow: BrowserWindow<any> | null = null;

// Latest player snapshot published by the renderer. Mini-player and web
// remote read from this so they can render without polling the renderer.
let latestPlayerState: SharedPlayerState | null = null;

const WEB_REMOTE_PORT = 8484;
let webRemoteUrl: string | null = null;

function broadcastCommand(action: ExternalCommand, value?: number | string) {
	try {
		mainWindow.webview.rpc?.send.externalCommand({ action, value });
	} catch {}
}

// Each BrowserWindow needs its own RPC instance (the transport binds to the
// specific webview). We share the same handlers between the main window and
// the mini-player by wrapping the definition in a factory and calling it
// once per window. Handlers stay inline so TypeScript can infer the param
// types from the PlayerRPC generic.
function makePlayerRPC() {
	return BrowserView.defineRPC<PlayerRPC>({
		maxRequestTime: 60_000,
		handlers: {
		requests: {
			getServerPort: () => ({ port: media.port }),

			pickFiles: async ({ mode }) => {
				const opts = mode === "folder"
					? {
						canChooseFiles: false,
						canChooseDirectory: true,
						allowsMultipleSelection: false,
						allowedFileTypes: "*",
					}
					: {
						canChooseFiles: true,
						canChooseDirectory: false,
						allowsMultipleSelection: true,
						allowedFileTypes:
							"mp3,wav,flac,ogg,m4a,aac,wma,opus,aiff,mp4,m4v,mkv,webm,mov,avi,wmv",
					};
				const paths = await Utils.openFileDialog(opts);
				if (!paths || paths.length === 0) return { tracks: [] };

				const libraryFolder = getLibraryFolder();
				const tracks: TrackInfo[] = [];
				if (mode === "folder") {
					const root = paths[0];
					let scanned = 0;
					for await (const p of walkMedia(root)) {
						const info = await ingestOne(p, libraryFolder);
						tracks.push(info);
						scanned++;
						if (scanned % 5 === 0) {
							mainWindow.webview.rpc?.send.scanProgress({
								scanned,
								total: 0,
								current: info.title,
							});
						}
					}
				} else {
					let idx = 0;
					for (const p of paths) {
						if (!classifyFile(p)) continue;
						const info = await ingestOne(p, libraryFolder);
						tracks.push(info);
						idx++;
						mainWindow.webview.rpc?.send.copyProgress({
							done: idx,
							total: paths.length,
							current: info.title,
						});
					}
				}
				return { tracks };
			},

			scanFolder: async ({ path }) => {
				const libraryFolder = getLibraryFolder();
				const tracks: TrackInfo[] = [];
				let scanned = 0;
				for await (const p of walkMedia(path)) {
					const info = await ingestOne(p, libraryFolder);
					tracks.push(info);
					scanned++;
					if (scanned % 5 === 0) {
						mainWindow.webview.rpc?.send.scanProgress({
							scanned,
							total: 0,
							current: info.title,
						});
					}
				}
				return { tracks };
			},

			pickLibraryFolder: async () => {
				const paths = await Utils.openFileDialog({
					canChooseFiles: false,
					canChooseDirectory: true,
					allowsMultipleSelection: false,
					allowedFileTypes: "*",
				});
				if (!paths || paths.length === 0) return { path: null };
				setLibraryFolder(paths[0]);
				return { path: paths[0] };
			},

			getLibraryFolder: () => ({ path: getLibraryFolder() }),

			clearLibraryFolder: () => {
				setLibraryFolder(null);
				return { ok: true };
			},

			checkLatestRelease: async ({ repo }) => {
				const release = await fetchLatestRelease(repo);
				return { release };
			},

			setDiscordPresence: async ({ presence }) => {
				return await setDiscordPresence(presence);
			},

			openExternal: ({ url }) => {
				try {
					return { ok: Utils.openExternal(url) };
				} catch {
					return { ok: false };
				}
			},

			showInFolder: ({ path }) => {
				try {
					Utils.showItemInFolder(path);
					return { ok: true };
				} catch {
					return { ok: false };
				}
			},

			notify: ({ title, body }) => {
				try {
					Utils.showNotification({ title, body });
					return { ok: true };
				} catch {
					return { ok: false };
				}
			},

			savePersistedState: ({ key, value }) => {
				const all = loadAll();
				all[key] = value;
				saveAll(all);
				return { ok: true };
			},

			loadPersistedState: ({ key }) => {
				const all = loadAll();
				return { value: all[key] ?? null };
			},

			windowMinimize: () => {
				try { mainWindow.minimize(); return { ok: true }; }
				catch { return { ok: false }; }
			},

			windowMaximizeToggle: () => {
				try {
					const isMax = mainWindow.isMaximized();
					if (isMax) mainWindow.unmaximize();
					else mainWindow.maximize();
					return { ok: true, maximized: !isMax };
				} catch {
					return { ok: false, maximized: false };
				}
			},

			windowClose: () => {
				try { mainWindow.close(); return { ok: true }; }
				catch { return { ok: false }; }
			},

			windowIsMaximized: () => {
				try { return { maximized: mainWindow.isMaximized() }; }
				catch { return { maximized: false }; }
			},

			windowToggleFullscreen: async () => {
				// Try the real fullscreen API first. If Electrobun's native side
				// on this platform doesn't actually flip the state, fall back to
				// a maximize toggle so the button always *does* something.
				let isFs = false;
				try { isFs = mainWindow.isFullScreen(); } catch {}
				try { mainWindow.setFullScreen(!isFs); } catch {}

				await new Promise((r) => setTimeout(r, 80));

				let nowFs = false;
				try { nowFs = mainWindow.isFullScreen(); } catch {}

				if (nowFs === isFs) {
					// setFullScreen was a no-op — fall back to maximize.
					try {
						const isMax = mainWindow.isMaximized();
						if (isMax) mainWindow.unmaximize();
						else mainWindow.maximize();
						return { ok: true, fullscreen: !isMax };
					} catch {
						return { ok: false, fullscreen: false };
					}
				}
				return { ok: true, fullscreen: nowFs };
			},

			windowGetPosition: ({ which }) => {
				try {
					const target = which === "mini" ? miniWindow : mainWindow;
					if (!target) return { x: 0, y: 0 };
					const p = target.getPosition();
					return { x: p.x | 0, y: p.y | 0 };
				} catch {
					return { x: 0, y: 0 };
				}
			},

			windowSetPosition: ({ x, y, which }) => {
				try {
					const target = which === "mini" ? miniWindow : mainWindow;
					if (!target) return { ok: false };
					target.setPosition(x | 0, y | 0);
					return { ok: true };
				} catch {
					return { ok: false };
				}
			},

			openMiniPlayer: async () => {
				if (miniWindow) {
					try { miniWindow.activate(); } catch {}
					return { ok: true };
				}
				const miniUrl = url === "views://mainview/index.html"
					? "views://mainview/mini.html"
					: `${url}/mini.html`;
				try {
					// Without an rpc the mini-player has no IPC channel and just
					// shows "Nothing playing" forever. Create a second instance
					// using the same handlers as the main window.
					const miniRpc = makePlayerRPC();
					miniWindow = new BrowserWindow({
						title: "Lakky — Mini",
						url: miniUrl,
						rpc: miniRpc,
						titleBarStyle: "hidden",
						frame: { width: 320, height: 460, x: 100, y: 100 },
					});
					// "Compact mode": hide the full app while the mini is alive,
					// and bring it back when the mini closes. The main window's
					// renderer keeps running while hidden, so audio + state +
					// the publish loop all continue uninterrupted.
					miniWindow.on("close", () => {
						miniWindow = null;
						showMainWindow();
					});
					hideMainWindow();
					return { ok: true };
				} catch (err) {
					console.warn("[mini] open failed:", (err as Error).message);
					miniWindow = null;
					showMainWindow();
					return { ok: false };
				}
			},

			closeMiniPlayer: () => {
				// Closing the mini fires its 'close' handler above, which
				// re-shows the main window.
				try { miniWindow?.close(); } catch {}
				miniWindow = null;
				showMainWindow();
				return { ok: true };
			},

			sendToTray: () => {
				try {
					hideMainWindow();
					Utils.showNotification({
						title: "Lakky",
						body: latestPlayerState?.track
							? `Now playing in the background: ${latestPlayerState.track.title}`
							: "Running in the background — tap the tray icon to come back.",
						silent: true,
					});
					return { ok: true };
				} catch {
					return { ok: false };
				}
			},

			restoreFromTray: () => {
				try {
					showMainWindow();
					return { ok: true };
				} catch {
					return { ok: false };
				}
			},

			addPathsToLibrary: async ({ paths }) => {
				const libraryFolder = getLibraryFolder();
				const out: TrackInfo[] = [];
				for (const p of paths) {
					if (!existsSync(p)) continue;
					// If it's a directory, walk it; otherwise classify the file.
					try {
						const s = await import("node:fs/promises").then((m) => m.stat(p));
						if (s.isDirectory()) {
							for await (const file of walkMedia(p)) {
								out.push(await ingestOne(file, libraryFolder));
							}
						} else if (classifyFile(p)) {
							out.push(await ingestOne(p, libraryFolder));
						}
					} catch (err) {
						console.warn(`[library] skipped ${p}:`, (err as Error).message);
					}
				}
				return { tracks: out };
			},

			importPlaylist: async () => {
				const paths = await Utils.openFileDialog({
					canChooseFiles: true,
					canChooseDirectory: false,
					allowsMultipleSelection: false,
					allowedFileTypes: "m3u,m3u8",
				});
				if (!paths || paths.length === 0) return { name: null, tracks: [] };
				const playlistPath = paths[0];
				let filePaths: string[];
				try {
					filePaths = await readM3U(playlistPath);
				} catch (err) {
					console.warn("[m3u] read failed:", (err as Error).message);
					return { name: null, tracks: [] };
				}
				const libraryFolder = getLibraryFolder();
				const tracks: TrackInfo[] = [];
				for (const p of filePaths) {
					if (!existsSync(p)) continue;
					if (!classifyFile(p)) continue;
					tracks.push(await ingestOne(p, libraryFolder));
				}
				// Use the filename minus extension as the playlist name.
				const name = playlistPath
					.split(/[\\/]/)
					.pop()!
					.replace(/\.m3u8?$/i, "")
					.trim() || "Imported";
				return { name, tracks };
			},

			exportPlaylist: async ({ name, paths }) => {
				const result = await Utils.openFileDialog({
					canChooseFiles: false,
					canChooseDirectory: true,
					allowsMultipleSelection: false,
				});
				if (!result || result.length === 0) return { ok: false, path: null };
				const dir = result[0];
				const safeName = name.replace(/[\\/:*?"<>|]/g, "_") || "playlist";
				const target = join(dir, `${safeName}.m3u8`);
				try {
					await writeM3U(target, name, paths);
					return { ok: true, path: target };
				} catch (err) {
					console.warn("[m3u] write failed:", (err as Error).message);
					return { ok: false, path: null };
				}
			},

			toggleWebRemote: () => {
				if (webRemoteUrl) {
					stopWebRemote();
					webRemoteUrl = null;
					return { ok: true, url: null };
				}
				const r = startWebRemote(WEB_REMOTE_PORT, {
					getState: () => latestPlayerState,
					dispatch: (action, value) => broadcastCommand(action, value),
				});
				if (!r) return { ok: false, url: null };
				webRemoteUrl = r.url;
				return { ok: true, url: r.url };
			},

			publishPlayerState: ({ state }) => {
				// Mini-player and web remote poll getSharedPlayerState — keeping
				// this dead-simple instead of doing a fanout.
				latestPlayerState = state;
				return { ok: true };
			},

			getSharedPlayerState: () => {
				return { state: latestPlayerState };
			},

			dispatchCommand: ({ action, value }) => {
				broadcastCommand(action, value);
				return { ok: true };
			},
		},
		messages: {},
		},
	});
}

const rpc = makePlayerRPC();

const url = await getMainViewUrl();

// Frameless 16:9 window — custom titlebar lives in the renderer.
// 1480 × 860 is a comfortable default that gives the library grid two extra
// columns and the equalizer enough breathing room, while still fitting on
// a 1440p screen with the taskbar visible. Users can resize freely.
mainWindow = new BrowserWindow({
	title: "Lakky",
	url,
	rpc,
	titleBarStyle: "hidden",
	frame: {
		width: 1480,
		height: 860,
		x: 100,
		y: 60,
	},
});

onDiscordStatus((connected) => {
	mainWindow.webview.rpc?.send.discordStatusChanged({ connected });
});

// ---------- Window visibility tracking ----------
// Bun is the only side that knows when the window is hidden (send-to-tray
// or minimize-to-tray). The renderer kills its visualizers and pauses CSS
// animations when it's hidden so we don't burn GPU drawing things nobody
// can see. We broadcast on every hide/show.
let mainWindowHidden = false;
function notifyVisibility() {
	mainWindow.webview.rpc?.send.windowStateChanged({
		maximized: false,
		fullscreen: false,
		hidden: mainWindowHidden,
	});
}
function showMainWindow() {
	try {
		mainWindow.show();
		mainWindow.activate();
		if (mainWindowHidden) {
			mainWindowHidden = false;
			notifyVisibility();
		}
	} catch {}
}
function hideMainWindow() {
	try {
		mainWindow.hide();
		if (!mainWindowHidden) {
			mainWindowHidden = true;
			notifyVisibility();
		}
	} catch {}
}

let trayPlaying = false; // tracks last-known state for tooltip label

// Windows' Shell_NotifyIcon expects an ICO; PNG fails to load on the native
// side. The multi-size .ico we ship for the launcher works perfectly for
// the tray too.
const tray = new Tray({
	image: process.platform === "win32" ? "views://tray.ico" : "views://tray.png",
	template: false,
	width: 32,
	height: 32,
	title: "Lakky",
});

function rebuildTrayMenu() {
	tray.setMenu([
		{ type: "normal", label: trayPlaying ? "Pause" : "Play", action: "toggle" },
		{ type: "normal", label: "Next track", action: "next" },
		{ type: "normal", label: "Previous track", action: "previous" },
		{ type: "separator" },
		{ type: "normal", label: "Show Lakky", action: "show" },
		{ type: "normal", label: "Send to tray", action: "hide" },
		{ type: "separator" },
		{ type: "normal", label: "Quit Lakky", action: "quit" },
	]);
}
rebuildTrayMenu();

tray.on("tray-clicked", (raw: unknown) => {
	const event = raw as { data?: { action?: string } } | undefined;
	const action = event?.data?.action ?? "";
	switch (action) {
		case "":
			// Bare icon click — toggle visibility. Most users left-click the
			// tray icon expecting the window to come back.
			showMainWindow();
			break;
		case "show":
			showMainWindow();
			break;
		case "hide":
			hideMainWindow();
			Utils.showNotification({
				title: "Lakky",
				body: "Still playing in the background — tap the tray icon to come back.",
				silent: true,
			});
			break;
		case "quit":
			Utils.quit();
			break;
		case "toggle":
		case "next":
		case "previous":
			broadcastCommand(action);
			break;
	}
});

// Keep the tray's Play/Pause label in sync with the renderer's published state.
const trayPollTimer = setInterval(() => {
	const playing = !!latestPlayerState && !latestPlayerState.paused;
	if (playing !== trayPlaying) {
		trayPlaying = playing;
		rebuildTrayMenu();
	}
}, 1500);

// Make sure the tray vanishes on app shutdown.
process.on("beforeExit", () => {
	clearInterval(trayPollTimer);
	try { tray.remove(); } catch {}
});

console.log("Lakky ready.");
