import type { RPCSchema } from "electrobun/bun";

// Audio file vs video file. Used across the library and player state.
export type MediaKind = "audio" | "video";

// Player loop modes. "all" loops the queue; "one" loops the current track.
export type RepeatMode = "off" | "all" | "one";

// Shape returned by checkLatestRelease. `installerUrl` is the first .exe
// asset on the release, when present.
export type LatestReleaseInfo = {
	tag: string;
	version: string;
	name: string;
	notes: string;
	htmlUrl: string;
	publishedAt: string;
	installerUrl: string | null;
	installerName: string | null;
};

export type TrackInfo = {
	id: string;
	path: string;
	streamUrl: string;
	kind: MediaKind;
	title: string;
	artist: string;
	album: string;
	duration: number;
	year?: number;
	genre?: string;
	trackNumber?: number;
	bitrate?: number;
	sampleRate?: number;
	artDataUrl?: string;
	size: number;
};

export type DiscordPresence = {
	state?: string;
	details?: string;
	startTimestamp?: number;
	endTimestamp?: number;
	largeImageKey?: string;
	largeImageText?: string;
	smallImageKey?: string;
	smallImageText?: string;
	// When provided, the main process tries to resolve a public cover-art URL
	// (via iTunes) and uses it as largeImageKey, falling back to the value
	// above on a miss.
	artist?: string;
	album?: string;
	// Up to two buttons that appear on the user's Discord profile to other
	// viewers — typical use is a "download / website" link.
	buttons?: Array<{ label: string; url: string }>;
};

export type PlayerRPC = {
	bun: RPCSchema<{
		requests: {
			pickFiles: {
				params: { mode: "files" | "folder" };
				response: { tracks: TrackInfo[] };
			};
			scanFolder: {
				params: { path: string };
				response: { tracks: TrackInfo[] };
			};
			getServerPort: {
				params: {};
				response: { port: number };
			};
			setDiscordPresence: {
				params: { presence: DiscordPresence | null };
				response: { ok: boolean; connected: boolean };
			};
			openExternal: {
				params: { url: string };
				response: { ok: boolean };
			};
			showInFolder: {
				params: { path: string };
				response: { ok: boolean };
			};
			notify: {
				params: { title: string; body?: string };
				response: { ok: boolean };
			};
			savePersistedState: {
				params: { key: string; value: unknown };
				response: { ok: boolean };
			};
			loadPersistedState: {
				params: { key: string };
				response: { value: unknown };
			};
			windowMinimize: {
				params: {};
				response: { ok: boolean };
			};
			windowMaximizeToggle: {
				params: {};
				response: { ok: boolean; maximized: boolean };
			};
			windowClose: {
				params: {};
				response: { ok: boolean };
			};
			windowIsMaximized: {
				params: {};
				response: { maximized: boolean };
			};
			windowToggleFullscreen: {
				params: {};
				response: { ok: boolean; fullscreen: boolean };
			};
			windowGetPosition: {
				params: { which?: "main" | "mini" };
				response: { x: number; y: number };
			};
			windowSetPosition: {
				params: { x: number; y: number; which?: "main" | "mini" };
				response: { ok: boolean };
			};
			openMiniPlayer: {
				params: {};
				response: { ok: boolean };
			};
			closeMiniPlayer: {
				params: {};
				response: { ok: boolean };
			};
			sendToTray: {
				params: {};
				response: { ok: boolean };
			};
			restoreFromTray: {
				params: {};
				response: { ok: boolean };
			};
			addPathsToLibrary: {
				params: { paths: string[] };
				response: { tracks: TrackInfo[] };
			};
			importPlaylist: {
				params: {};
				response: { name: string; tracks: TrackInfo[] } | { name: null; tracks: [] };
			};
			exportPlaylist: {
				params: { name: string; paths: string[] };
				response: { ok: boolean; path: string | null };
			};
			toggleWebRemote: {
				params: {};
				response: { ok: boolean; url: string | null };
			};
			// Renderer publishes its current state so the mini-player and web
			// remote can show it without the renderer needing to talk to them.
			publishPlayerState: {
				params: { state: SharedPlayerState };
				response: { ok: boolean };
			};
			// Mini-player + web remote ask for the snapshot directly.
			getSharedPlayerState: {
				params: {};
				response: { state: SharedPlayerState | null };
			};
			// Mini-player / web-remote send playback commands here; main process
			// forwards them to the renderer via the externalCommand message.
			dispatchCommand: {
				params: { action: ExternalCommand; value?: number | string };
				response: { ok: boolean };
			};
			pickLibraryFolder: {
				params: {};
				response: { path: string | null };
			};
			getLibraryFolder: {
				params: {};
				response: { path: string | null };
			};
			clearLibraryFolder: {
				params: {};
				response: { ok: boolean };
			};
			// Polls GitHub releases for `<owner/repo>` and returns the latest
			// public, non-draft release (or null if the repo has none yet).
			// Network failures bubble up as a thrown RPC error so the
			// renderer can show a sensible toast.
			checkLatestRelease: {
				params: { repo: string };
				response: { release: LatestReleaseInfo | null };
			};
		};
		messages: {};
	}>;
	webview: RPCSchema<{
		requests: {};
		messages: {
			scanProgress: { scanned: number; total: number; current: string };
			copyProgress: { done: number; total: number; current: string };
			discordStatusChanged: { connected: boolean };
			windowStateChanged: { maximized: boolean; fullscreen: boolean };
			// External controllers (mini-player, web remote) send commands here.
			externalCommand: { action: ExternalCommand; value?: number | string };
			// Mini-player asks the main window to push its latest state.
			requestStatePush: {};
		};
	}>;
};

export type ExternalCommand =
	| "play"
	| "pause"
	| "toggle"
	| "next"
	| "previous"
	| "seek"
	| "volume"
	| "shuffle"
	| "repeat";

export type SharedPlayerState = {
	track: {
		id: string;
		title: string;
		artist: string;
		album: string;
		duration: number;
		artUrl: string | null;
		kind: MediaKind;
	} | null;
	currentTime: number;
	paused: boolean;
	volume: number;
	shuffle: boolean;
	repeat: RepeatMode;
	queueLen: number;
};
