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
	installerSize?: number | null;
	sha256Url?: string | null;
	expectedSha256?: string | null;
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
	replayGainTrack?: number;
	replayGainAlbum?: number;
	securitySafe?: boolean;
	securityScore?: number;
	securityThreats?: string[];
	verifiedFormat?: string | null;
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
	// Rich presence extended parameters
	title?: string;
	mode?: "spatial" | "lofi" | "video" | "idle" | "normal";
	paused?: boolean;
	currentTime?: number;
	duration?: number;
	trackNumber?: number;
	totalTracks?: number;
	isIdle?: boolean;
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
			publishPlayerState: {
				params: { state: SharedPlayerState };
				response: { ok: boolean };
			};
			getSharedPlayerState: {
				params: {};
				response: { state: SharedPlayerState | null };
			};
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
			checkLatestRelease: {
				params: { repo: string; channel?: "stable" | "canary" };
				response: { release: LatestReleaseInfo | null };
			};
			downloadUpdate: {
				params: { url: string; filename: string };
				response: { path: string; sha256: string };
			};
			runUpdateAndQuit: {
				params: { path: string };
				response: { ok: boolean };
			};
			toggleAutostart: {
				params: {};
				response: { ok: boolean; enabled: boolean };
			};
			saveTrackMetadata: {
				params: {
					path: string;
					title: string;
					artist: string;
					album: string;
					year: number | null;
					genre: string;
					art?: string | null;
				};
				response: { ok: boolean; track?: TrackInfo; error?: string };
			};
			scanMediaIntegrity: {
				params: { path: string };
				response: {
					safe: boolean;
					score: number;
					threats: string[];
					mimeDetected: string;
					sha256: string;
					verifiedFormat: string | null;
					isPolyglot: boolean;
					hasEmbeddedExecutable: boolean;
				};
			};
			setDefaultPlayerAssociations: {
				params: {};
				response: { ok: boolean; message: string };
			};
			getLyrics: {
				params: { artist: string; album: string; title: string; path?: string };
				response: { plain: string | null; synced: Array<{ time: number; text: string }> };
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
			windowStateChanged: { maximized: boolean; fullscreen: boolean; hidden: boolean };
			externalCommand: { action: ExternalCommand; value?: number | string };
			requestStatePush: {};
			updateDownloadProgress: {
				received: number;
				total: number;
				percent: number;
				speedBytesPerSec: number;
				etaSeconds: number;
			};
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

// Strict-enough semver compare. Returns 1 if `a` is newer than `b`,
// -1 if older, 0 if equal.
export function compareVersions(a: string, b: string): number {
	const norm = (v: string) => v.replace(/^v/i, "").trim();
	const splitCore = (v: string): { core: number[]; pre: string } => {
		const [core, pre = ""] = norm(v).split(/[-+]/, 2);
		return { core: core.split(".").map((n) => parseInt(n, 10) || 0), pre };
	};
	const A = splitCore(a);
	const B = splitCore(b);
	const len = Math.max(A.core.length, B.core.length);
	for (let i = 0; i < len; i++) {
		const ai = A.core[i] ?? 0;
		const bi = B.core[i] ?? 0;
		if (ai !== bi) return ai > bi ? 1 : -1;
	}
	if (A.pre === B.pre) return 0;
	if (!A.pre) return 1;
	if (!B.pre) return -1;
	return A.pre > B.pre ? 1 : -1;
}

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
