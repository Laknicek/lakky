import "./style.css";
import Electrobun, { Electroview } from "electrobun/view";
import type {
	PlayerRPC,
	TrackInfo,
	DiscordPresence,
	ExternalCommand,
	SharedPlayerState,
	LatestReleaseInfo,
} from "../shared/rpcSchema";
import { compareVersions } from "../shared/rpcSchema";
import { AudioEngine, EQ_PRESETS, EQ_BANDS, DEFAULT_DSP_SETTINGS, type DspSettings, type RepeatMode } from "./audio";
import { Visualizer, type VizStyle, type AnimeGradient, ANIME_GRADIENTS } from "./visualizer";
import { sfx, primeAudio, setSfxEnabled } from "./sfx";
import { iconUrl } from "./logo";
import { installTooltips } from "./tooltip";
import { installWindowDrag } from "./drag";
import type { NodeGraph } from "./nodes";
import { newGraph } from "./nodes";
import { renderNodeEditor } from "./nodeEditor";
import { escapeHtml } from "./util";
import { Echoes, computeEchoes, type EchoesData } from "./echoes";
import { Stylized3DScene, type ScenePreset, type AudioBands } from "./stylized3d";
import { generateQrSvg } from "./qrcode";
import { toRomaji, findActiveLyricIndex, containsJapanese, type LyricLine, type LyricMode } from "./lyricsUtil";
import { cinemaEngine } from "./video";

// ---------- RPC ----------
const rpc = Electroview.defineRPC<PlayerRPC>({
	maxRequestTime: 120_000,
	handlers: {
		requests: {},
		messages: {
			scanProgress: ({ scanned, current }) => {
				toast(`Scanned ${scanned}: ${current}`, { ttl: 1200, key: "scan" });
			},
			copyProgress: ({ done, total, current }) => {
				toast(`Saved ${done}/${total} — ${current}`, { ttl: 1800, key: "copy" });
			},
			discordStatusChanged: ({ connected }) => {
				state.discordConnected = connected;
				renderSidebarFoot();
			},
			windowStateChanged: ({ hidden }) => {
				setRendererHidden(hidden);
			},
			updateDownloadProgress: (prog) => {
				onDownloadProgress(prog);
			},
			externalCommand: ({ action, value }) => {
				applyExternalCommand(action, value);
			},
			requestStatePush: () => {
				publishPlayerStateSnapshot();
			},
		},
	},
});
const eb = new Electrobun.Electroview({ rpc });

const bun = () => eb.rpc!.request;

// ---------- State ----------
type View = "home" | "library" | "nowplaying" | "equalizer" | "playlists" | "stats" | "settings" | "nodes";

type Settings = {
	volume: number;
	repeat: RepeatMode;
	shuffle: boolean;
	sfx: boolean;
	discord: boolean;
	crossfade: number; // seconds, 0 = off
	eq: number[];
	eqPreset: string;
	dsp: DspSettings;
	accent: string; // hex
	theme: "midnight" | "aurora" | "solar" | "rose" | "sakura_sunset" | "cyber_neotokyo" | "ghibli_emerald" | "ocean_shinkai" | "midnight_shogun";
	scenePreset: ScenePreset;
	sceneOpacity: number; // 0..1 (default 0.25)
	show3DScene: boolean;
	sleepTimer: number; // 0 = off; minutes
	speed: number; // 0.5 - 2.0
	preAmp: number; // pre-amp gain in dB, -12 to 12
	mono: boolean;
	smartShuffle: boolean; // weighted by play count + recency instead of pure random
	matchAccent: boolean; // override theme accent with one extracted from album art
	customEqPresets: Record<string, number[]>;
	maxFps: number;        // visualizer cap, 15-60
	idleViz: boolean;      // pulse while paused (off saves a touch more GPU)
	vizStyle: VizStyle;    // bars | wave | radial | mirror — for the Now Playing visualizer
	showStripViz: boolean; // when false, the bottom-bar strip visualizer's div is removed entirely
	spatial8D: boolean;    // 8D spatial audio binaural rotation
	stripGradient: AnimeGradient; // anime spectrum gradient palette
	pitchMode: "normal" | "nightcore" | "lofi"; // pitch & speed modes
	preservesPitch: boolean; // lock pitch during speed adjustments
	// Auto-updater
	updateRepo: string;
	updateChannel: "stable" | "canary";
	autoCheckUpdates: boolean;
	skippedUpdateTag: string;
	autostartOnBoot: boolean;
	showTrackNotifications: boolean;
	replayGain: "off" | "track" | "album";
	gapless: boolean;
	lyrics: boolean;
	scrobbleLastfm: boolean;
};

const DEFAULT_SETTINGS: Settings = {
	volume: 0.85,
	repeat: "off",
	shuffle: false,
	sfx: true,
	discord: true,
	crossfade: 0,
	eq: [...EQ_PRESETS["Anime J-Pop"]],
	eqPreset: "Anime J-Pop",
	dsp: { ...DEFAULT_DSP_SETTINGS },
	accent: "#a78bfa",
	theme: "sakura_sunset",
	scenePreset: "sakura_sunset",
	sceneOpacity: 0.25,
	show3DScene: true,
	sleepTimer: 0,
	speed: 1.0,
	preAmp: 0,
	mono: false,
	autostartOnBoot: false,
	smartShuffle: false,
	matchAccent: true,
	customEqPresets: {},
	maxFps: 30,
	idleViz: true,
	vizStyle: "bars",
	showStripViz: true,
	spatial8D: false,
	stripGradient: "cyber_neon",
	pitchMode: "normal",
	preservesPitch: true,
	updateRepo: "Laknicek/lakky",
	updateChannel: "stable",
	autoCheckUpdates: true,
	skippedUpdateTag: "",
	showTrackNotifications: true,
	replayGain: "off",
	gapless: true,
	lyrics: true,
	scrobbleLastfm: false,
};

const state = {
	view: "home" as View,
	library: [] as TrackInfo[],
	queue: [] as TrackInfo[],
	queueIndex: 0,
	currentTrack: null as TrackInfo | null,
	settings: { ...DEFAULT_SETTINGS } as Settings,
	playStats: {} as Record<string, number>, // trackId -> count
	playlists: [] as { name: string; ids: string[]; artDataUrl?: string; description?: string }[],
	queueOpen: false,
	discordConnected: false,
	searchQuery: "",
	sleepTimerEndsAt: 0, // epoch ms
	libraryFolder: null as string | null,
	bookmarks: {} as Record<string, number>, // trackId → seconds, for resume
	selectedIds: new Set<string>(), // for bulk-edit
	webRemoteUrl: null as string | null,
	miniOpen: false,
	mutedVolume: 0.85, // pre-mute volume for restore
	recentlyPlayed: [] as string[], // track IDs in most-recent-first order
	libraryTab: "tracks" as "tracks" | "albums" | "artists" | "dropzone",
	libraryFilterTag: "all" as "all" | "hires" | "anime" | "video" | "favorites" | "recent",
	librarySort: "title" as "index" | "title" | "artist" | "album" | "duration" | "codec" | "safety" | "plays" | "year",
	librarySortAsc: true,
	activeAlbumKey: null as string | null,
	activeArtistKey: null as string | null,
	activePlaylistName: null as string | null,
	playlistSearchQuery: "",
	ratings: {} as Record<string, number>, // trackId → 1-5 stars
	playDates: {} as Record<string, number[]>, // trackId → epoch-ms timestamps
	abLoop: null as { a: number; b: number } | null,
	audioDevices: [] as MediaDeviceInfo[],
	selectedDeviceId: "default" as string,
	npImmersive: false,
	libraryFilter: "all" as string, // "all" | genre | artist
	queueAnimDir: 0, // -1, 0, or 1 for slide direction
	// User's custom audio effect graph. When non-null it replaces the
	// 10-band EQ chain inside the AudioEngine. The node editor view owns
	// the UI for this; we just persist it and push updates to both engines.
	nodeGraph: null as NodeGraph | null,
	// Most recent release the updater discovered. Non-null only while the
	// update card is mounted and dismissible.
	pendingUpdate: null as LatestReleaseInfo | null,
	quickEffects: {
		eightD: false,
		bassBoost: false,
		vocalEnhance: false,
		reverbHall: false,
	},
	lyricsMode: "dual" as LyricMode,
	lyricsCache: {} as Record<string, { plain: string | null; synced: LyricLine[] }>,
	lyricsLoading: false,
	activeLyricIndex: -1,
	inspectorOpen: false,
};

// Mirrors package.json so we have something to compare release tags against
// without bundling the JSON. Bump in lockstep on every release.
const APP_VERSION = "1.3.0";

// ---------- DOM ----------
const splashEl = document.getElementById("splash")!;
const splashStep = document.getElementById("splash-step")!;
const tbLogo = document.getElementById("tb-logo")!;
const appEl = document.getElementById("app")! as HTMLDivElement;

// Inject the raster icon into the titlebar — splash is logo-less.
tbLogo.innerHTML = `<img src="${iconUrl}" alt="" draggable="false">`;

// Wire titlebar buttons
document.getElementById("tb-min")?.addEventListener("click", async (e) => {
	e.stopPropagation();
	sfx.click();
	try { await bun().windowMinimize({}); } catch (e) { console.warn("[ui] windowMinimize failed:", (e as Error).message); }
});
document.getElementById("tb-max")?.addEventListener("click", async (e) => {
	e.stopPropagation();
	sfx.click();
	try { await bun().windowMaximizeToggle({}); } catch (e) { console.warn("[ui] windowMaximizeToggle failed:", (e as Error).message); }
});
document.getElementById("tb-close")?.addEventListener("click", async (e) => {
	e.stopPropagation();
	sfx.click();
	try { await bun().windowClose({}); } catch (e) { console.warn("[ui] windowClose failed:", (e as Error).message); }
});

// Manual window-drag for the frameless titlebar. WebView2 doesn't honor
// -webkit-app-region, so we do it in JS: capture cursor + window position on
// mousedown, then push setPosition() updates on mousemove (throttled to rAF).
installWindowDrag(bun, document.getElementById("titlebar")!, undefined, ".tb-btn", () => {
	sfx.click();
	bun().windowMaximizeToggle({}).catch(() => {});
});

// ---------- Audio ----------
// One shared AudioContext for the whole app. Two audio engines (A/B) and a
// video engine all attach their own filter chains here, which is what lets
// crossfade work — two parallel sources can be mixed by the same context.
const sharedAudioCtx: AudioContext = new window.AudioContext();
function createAudioEl(): HTMLAudioElement {
	const a = document.createElement("audio");
	a.crossOrigin = "anonymous";
	a.preload = "auto";
	a.style.display = "none";
	document.body.appendChild(a);
	return a;
}
const audioElA = createAudioEl();
const audioElB = createAudioEl();
// Persistent video element. We never destroy it — we just shuttle it between
// a hidden parking spot on <body> and the visible video stage that the Now
// Playing view mounts. That way re-rendering a view doesn't kill playback.
const videoEl = (() => {
	const v = document.createElement("video");
	v.playsInline = true;
	v.preload = "auto";
	v.style.display = "none";
	document.body.appendChild(v);
	return v;
})();

// One analyser shared across all three engines. The visualizer reads from
// this node, so it sees signal no matter which engine is primary — no stale
// tap after a crossfade, no silence when video kicks in.
// Stable tap point downstream of every engine's gain stage. Engines route
// their output through this identity gain instead of straight to destination,
// which gives visualizers a single node to spawn their own AnalyserNodes off
// of — one per visualizer, so two visualizers on the same screen don't
// double-apply the analyser's internal smoothing.
const monitorTap = sharedAudioCtx.createGain();
monitorTap.connect(sharedAudioCtx.destination);

// Two audio engines + one video engine, all sharing the audio graph. Each
// engine wraps a fixed media element so the MediaElementSourceNode only gets
// created once per element (the API forbids re-wrapping).
const engineA = new AudioEngine(audioElA, sharedAudioCtx, monitorTap);
const engineB = new AudioEngine(audioElB, sharedAudioCtx, monitorTap);
const videoEngine = new AudioEngine(videoEl, sharedAudioCtx, monitorTap);

// Keep the AudioContext alive while the user expects playback. Chromium
// intensively throttles minimized WebView2 windows — the context can drop
// to "suspended" or "interrupted" when the next track loads, which makes
// the song play silently until the user re-focuses the window. The
// watchdog catches this; the visibilitychange/focus listeners catch it
// the moment the user comes back.
function ensureAudioRunning() {
	if (sharedAudioCtx.state !== "running") {
		sharedAudioCtx.resume().catch((err) => {
			console.warn("[audio-watchdog] shared AudioContext resume failed:", (err as Error).message);
		});
	}
}
sharedAudioCtx.addEventListener("statechange", ensureAudioRunning);
document.addEventListener("visibilitychange", () => {
	ensureAudioRunning();
	// Chromium fires this for both tab-hidden and OS-level minimize. Mirror
	// the bun-driven hide flag so a plain minimize also stops the visualizers.
	setRendererHidden(document.visibilityState === "hidden");
});
window.addEventListener("focus", ensureAudioRunning);
setInterval(() => {
	// Keep the AudioContext alive aggressively — no conditional skip.
	// When the window is minimized Chromium can suspend the context
	// between tracks. If we only nudge while an engine is showing as
	// "playing", a track-transition gap becomes a permanent silent
	// hole until the user re-focuses the window.
	ensureAudioRunning();
}, 2000);

let crossfading = false;
let crossfadeRaf: number | null = null;

function parkVideoEl() {
	if (videoEl.parentElement !== document.body) {
		document.body.appendChild(videoEl);
	}
	videoEl.style.display = "none";
	videoEl.style.width = "";
	videoEl.style.height = "";
}

function mountVideoIn(host: HTMLElement) {
	videoEl.style.display = "block";
	videoEl.style.width = "100%";
	videoEl.style.height = "100%";
	host.appendChild(videoEl);
}

// The "primary" engine is whichever of engineA/engineB/videoEngine is
// currently driving playback. Crossfade temporarily promotes the standby
// audio engine; on completion we just retarget this reference.
let engine: AudioEngine = engineA;
let visualizer: Visualizer | null = null;
let stylized3dScene: Stylized3DScene | null = null;
let usingVideo = false;

function attachEngineHandlers() {
	engine.on({
		onTimeUpdate: (cur, dur) => {
			updateNowPlayingProgress(cur, dur);
			updateMediaSessionPosition();
			maybeStartCrossfade(cur, dur);
			if (immersiveActive) updateImmersiveProgress(cur, dur);
			if (usingVideo && state.view === "nowplaying") {
				cinemaEngine.updateProgress(cur, dur);
			}
		},
		onEnded: () => {
			if (crossfading) return;
			onTrackEnded();
		},
		onPlay: () => {
			updatePlayButton(true);
			updateNowPlayingArtSpin(true);
			updateImmersivePlayState();
			visualizer?.start();
			stripViz?.start();
			if (state.settings.show3DScene) stylized3dScene?.start();
			if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
			schedulePresenceUpdate();
		},
		onPause: () => {
			updatePlayButton(false);
			updateNowPlayingArtSpin(false);
			updateImmersivePlayState();
			visualizer?.stop();
			stripViz?.stop();
			stylized3dScene?.stop();
			if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
			maybeRememberPosition();
			schedulePresenceUpdate();
		},
		onError: (msg) => {
			toast(msg, { ttl: 4000 });
			sfx.error();
		},
	});
}
attachEngineHandlers();

// ---------- Crossfade ----------
// Look-ahead at the next index without mutating any state. Mirrors the rules
// in next(): shuffle picks a different random index; otherwise advance, with
// repeat-all wrapping. Returns null if there's no successor (single track, or
// repeat is off at the end of the queue).
function peekNextIndex(): number | null {
	if (state.queue.length === 0) return null;
	if (state.queue.length === 1) return null;
	if (state.settings.shuffle) {
		return state.settings.smartShuffle ? smartShuffleIndex() : (() => {
			let idx: number;
			do {
				idx = Math.floor(Math.random() * state.queue.length);
			} while (idx === state.queueIndex);
			return idx;
		})();
	}
	let idx = state.queueIndex + 1;
	if (idx >= state.queue.length) {
		if (state.settings.repeat === "all") return 0;
		return null;
	}
	return idx;
}

function maybeStartCrossfade(cur: number, dur: number) {
	const cf = state.settings.crossfade;
	if (cf <= 0) return;
	if (crossfading) return;
	if (!dur || !Number.isFinite(dur)) return;
	if (state.currentTrack?.kind === "video") return;
	if (engine === videoEngine) return;
	if (engine.paused) return;
	if (state.settings.repeat === "one") return; // we want to loop this track, not fade out of it
	const remaining = dur - cur;
	// Trigger when remaining ≤ crossfade duration, but not so close to the
	// end that the outgoing engine ends mid-fade in an audible way.
	if (remaining > cf) return;
	if (remaining <= 0.25) return; // already at/past the end — let normal advance run
	const nextIdx = peekNextIndex();
	if (nextIdx === null) return;
	void startCrossfade(nextIdx, Math.max(0.5, Math.min(cf, remaining - 0.05)));
}

async function startCrossfade(targetIdx: number, durationSec: number) {
	const next = state.queue[targetIdx];
	if (!next) return;
	// No crossfade across video boundaries — too jarring and the video element
	// is shared, so it'd fight itself. Hard switch instead.
	if (next.kind === "video" || engine === videoEngine) {
		state.queueIndex = targetIdx;
		return playCurrent();
	}

	// Pick the standby audio engine (the one that isn't primary).
	const incoming = engine === engineA ? engineB : engineA;
	if (incoming === engine) {
		state.queueIndex = targetIdx;
		return playCurrent();
	}

	incoming.setEq(state.settings.eq);
	incoming.setVolume(0);

	try {
		await incoming.loadAndPlay(next);
	} catch (e) {
		console.warn("[audio] crossfade load failed:", (e as Error).message);
		return;
	}

	crossfading = true;
	const outgoing = engine;
	const userVol = state.settings.volume;
	const t0 = performance.now();

	const tick = () => {
		const elapsed = (performance.now() - t0) / 1000;
		const t = Math.min(1, elapsed / durationSec);
		// Linear crossfade with an added midpoint dip so the transition is
		// audibly a fade — the equal-power cos/sin curve hides the fade by
		// keeping perceived loudness constant. The 0→1→0 sine envelope
		// scaled by 0.22 drops the combined level ~5 dB at the centre,
		// which gives the "breath" between tracks the user expects.
		const dip = 1 - 0.22 * Math.sin(t * Math.PI);
		outgoing.setVolume(userVol * (1 - t) * dip);
		incoming.setVolume(userVol * t * dip);
		if (t < 1) {
			crossfadeRaf = requestAnimationFrame(tick);
			return;
		}
		// Promote incoming
		outgoing.pause();
		outgoing.clearListeners();
		outgoing.setVolume(userVol);
		engine = incoming;
		attachEngineHandlers();
		state.currentTrack = next;
		state.queueIndex = targetIdx;
		state.playStats[next.id] = (state.playStats[next.id] ?? 0) + 1;
		saveStats();
		state.recentlyPlayed = [next.id, ...state.recentlyPlayed.filter((id) => id !== next.id)].slice(0, 50);
		saveRecentlyPlayed();
		crossfading = false;
		crossfadeRaf = null;
		updateNowPlayingBar();
		updateAccentFromArt(next.artDataUrl);
		updateMediaSession();
		if (state.view === "nowplaying" || state.view === "library") renderMain();
		if (state.view === "library") highlightPlayingRow();
		schedulePresenceUpdate();
	};
	tick();
}

// ---------- External controller bridge (mini-player + web remote) ----------
function applyExternalCommand(action: ExternalCommand, value?: number | string) {
	switch (action) {
		case "play": engine.play(); break;
		case "pause": engine.pause(); break;
		case "toggle":
			if (!state.currentTrack && state.library.length > 0) {
				playFromList(state.library, 0);
				return;
			}
			engine.togglePlay();
			break;
		case "next": next(); break;
		case "previous": previous(); break;
		case "seek":
			if (typeof value === "number") engine.seek(value);
			break;
		case "volume":
			if (typeof value === "number") {
				const v = Math.max(0, Math.min(1, value));
				state.settings.volume = v;
				engine.setVolume(v);
				const slider = document.getElementById("volume") as HTMLInputElement | null;
				if (slider) { slider.value = String(Math.round(v * 100)); syncRangeFill(slider); }
				saveSettings();
			}
			break;
		case "shuffle":
			state.settings.shuffle = !state.settings.shuffle;
			document.getElementById("btn-shuffle")?.classList.toggle("active", state.settings.shuffle);
			saveSettings();
			break;
		case "repeat": {
			const cycle: RepeatMode[] = ["off", "all", "one"];
			state.settings.repeat = cycle[(cycle.indexOf(state.settings.repeat) + 1) % cycle.length];
			const btn = document.getElementById("btn-repeat");
			if (btn) {
				btn.innerHTML = state.settings.repeat === "one" ? icons.repeatOne : icons.repeat;
				btn.classList.toggle("active", state.settings.repeat !== "off");
			}
			saveSettings();
			break;
		}
	}
	publishPlayerStateSnapshot();
}

function publishPlayerStateSnapshot() {
	const t = state.currentTrack;
	const snap: SharedPlayerState = {
		track: t
			? {
				id: t.id,
				title: t.title,
				artist: t.artist,
				album: t.album,
				duration: t.duration || engine.duration,
				artUrl: t.artDataUrl ?? null,
				kind: t.kind,
			}
			: null,
		currentTime: engine.currentTime,
		paused: engine.paused,
		volume: state.settings.volume,
		shuffle: state.settings.shuffle,
		repeat: state.settings.repeat,
		queueLen: state.queue.length,
	};
	bun().publishPlayerState({ state: snap }).catch(() => {});
}

// Push a state snapshot every 500 ms while a track is loaded so the
// mini-player and web remote stay roughly in sync without us hand-firing
// publishes on every engine event.
setInterval(() => {
	if (state.currentTrack) publishPlayerStateSnapshot();
}, 500);

function cancelCrossfade() {
	if (!crossfading) return;
	if (crossfadeRaf !== null) {
		cancelAnimationFrame(crossfadeRaf);
		crossfadeRaf = null;
	}
	// Pause the standby (whichever one isn't primary) and reset both to user volume.
	const standby = engine === engineA ? engineB : engineA;
	standby.pause();
	standby.setVolume(state.settings.volume);
	engine.setVolume(state.settings.volume);
	crossfading = false;
}

// ---------- Persistence ----------
// Each key is loaded independently — a single corrupted key shouldn't take
// down every other piece of state with it. Failures log to the console so
// state-file corruption stays debuggable instead of silently resetting.
async function loadPersistedKey<T>(
	key: string,
	guard: (v: unknown) => v is T,
	apply: (v: T) => void,
) {
	try {
		const r = await bun().loadPersistedState({ key });
		if (guard(r.value)) apply(r.value);
	} catch (err) {
		console.warn(`[persist] load "${key}" failed:`, (err as Error).message);
	}
}

async function loadPersisted() {
	await loadPersistedKey<Partial<Settings>>(
		"settings",
		(v): v is Partial<Settings> => !!v && typeof v === "object",
		(v) => Object.assign(state.settings, v),
	);
	await loadPersistedKey<TrackInfo[]>(
		"library",
		Array.isArray as (v: unknown) => v is TrackInfo[],
		(v) => { state.library = v; },
	);
	await loadPersistedKey<typeof state.playlists>(
		"playlists",
		Array.isArray as (v: unknown) => v is typeof state.playlists,
		(v) => { state.playlists = v; },
	);
	await loadPersistedKey<Record<string, number>>(
		"stats",
		(v): v is Record<string, number> => !!v && typeof v === "object",
		(v) => { state.playStats = v; },
	);
	await loadPersistedKey<Record<string, number>>(
		"bookmarks",
		(v): v is Record<string, number> => !!v && typeof v === "object",
		(v) => { state.bookmarks = v; },
	);
	await loadPersistedKey<string[]>(
		"recentlyPlayed",
		(v): v is string[] => Array.isArray(v),
		(v) => { state.recentlyPlayed = v; },
	);
	await loadPersistedKey<NodeGraph>(
		"nodeGraph",
		(v): v is NodeGraph => !!v && typeof v === "object" && "nodes" in (v as object),
		(v) => { state.nodeGraph = v; },
	);
	await loadPersistedKey<Record<string, number>>(
		"ratings",
		(v): v is Record<string, number> => !!v && typeof v === "object",
		(v) => { state.ratings = v; },
	);
	await loadPersistedKey<{ a: number; b: number } | null>(
		"abLoop",
		(v): v is { a: number; b: number } | null => v === null || (!!v && typeof v === "object" && typeof (v as any).a === "number" && typeof (v as any).b === "number"),
		(v) => { state.abLoop = v; },
	);
}

async function saveSettings() {
	await bun().savePersistedState({ key: "settings", value: state.settings });
}
async function saveLibrary() {
	// Art is now a tiny URL pointing at our local cache, not inline base64,
	// so we keep it on disk — the UI shows covers immediately on next boot
	// instead of waiting for the rescan to refill them.
	await bun().savePersistedState({ key: "library", value: state.library });
}

// The media server picks a fresh port each launch, so any persisted URL needs
// its host:port portion replaced before we use it. Path/query stay as-is.
function rewriteLocalUrl(url: string | undefined, base: string): string | undefined {
	if (!url) return url;
	return url.replace(/^http:\/\/127\.0\.0\.1:\d+/, base);
}
async function savePlaylists() {
	await bun().savePersistedState({ key: "playlists", value: state.playlists });
}
async function saveStats() {
	await bun().savePersistedState({ key: "stats", value: state.playStats });
}
async function saveBookmarks() {
	await bun().savePersistedState({ key: "bookmarks", value: state.bookmarks });
}
async function saveRatings() {
	await bun().savePersistedState({ key: "ratings", value: state.ratings });
}
async function savePlayDates() {
	await bun().savePersistedState({ key: "playDates", value: state.playDates });
}
async function saveAbLoop() {
	await bun().savePersistedState({ key: "abLoop", value: state.abLoop });
}
async function saveRecentlyPlayed() {
	await bun().savePersistedState({ key: "recentlyPlayed", value: state.recentlyPlayed });
}

// ---------- Auto updater ----------
// Hit GitHub /releases/latest via the bun-side helper. Returns the release
// if it's newer than APP_VERSION and the user hasn't already skipped its
// tag — otherwise null. Errors bubble up so the caller decides whether to
// toast (manual check) or stay silent (boot poll).
async function fetchUpdateIfNewer(silent: boolean): Promise<LatestReleaseInfo | null> {
	const repo = state.settings.updateRepo.trim();
	if (!repo) return null;
	const { release } = await bun().checkLatestRelease({
		repo,
		channel: state.settings.updateChannel,
	});
	if (!release) {
		if (!silent) toast("No releases found on that repo.", { ttl: 2400 });
		return null;
	}
	if (release.tag === state.settings.skippedUpdateTag) {
		if (!silent) toast(`Latest is ${release.version} — you skipped this one.`, { ttl: 2600 });
		return null;
	}
	if (compareVersions(release.version, APP_VERSION) <= 0) {
		if (!silent) toast(`You're on the latest version (${APP_VERSION}).`, { ttl: 2400 });
		return null;
	}
	return release;
}

let updateCheckTimer: ReturnType<typeof setInterval> | null = null;
async function startUpdateChecker() {
	if (updateCheckTimer) {
		clearInterval(updateCheckTimer);
		updateCheckTimer = null;
	}
	if (!state.settings.updateRepo.trim()) return;
	if (!state.settings.autoCheckUpdates) return;
	setTimeout(() => runUpdateCheck("boot"), 4000);
	updateCheckTimer = setInterval(() => runUpdateCheck("background"), 6 * 60 * 60 * 1000);
}

async function manualUpdateCheck() {
	sfx.click();
	void runUpdateCheck("manual");
}

async function runUpdateCheck(kind: "boot" | "manual" | "background") {
	if (kind !== "background") {
		setUpdateState({ phase: "checking" });
	}
	try {
		const release = await fetchUpdateIfNewer(true);
		if (release) {
			setUpdateState({ phase: "available", release });
		} else if (kind === "manual") {
			setUpdateState({ phase: "up-to-date" });
			setTimeout(closeUpdateModal, 2400);
		} else if (kind === "boot") {
			closeUpdateModal();
		}
	} catch (err) {
		if (kind === "background") {
			console.warn("[updater] check failed:", (err as Error).message);
			return;
		}
		setUpdateState({ phase: "error", message: (err as Error).message });
	}
}

// ----- Update modal state machine -----
type UpdatePhase =
	| { phase: "checking" }
	| { phase: "up-to-date" }
	| { phase: "available"; release: LatestReleaseInfo }
	| {
			phase: "downloading";
			release: LatestReleaseInfo;
			received: number;
			total: number;
			percent?: number;
			speedBytesPerSec?: number;
			etaSeconds?: number;
	  }
	| { phase: "installing"; release: LatestReleaseInfo; sha256?: string }
	| { phase: "error"; message: string };

let updateUi: UpdatePhase | null = null;

function setUpdateState(next: UpdatePhase) {
	updateUi = next;
	if (next.phase === "available") state.pendingUpdate = next.release;
	renderUpdateModal();
}

function closeUpdateModal() {
	const prev = updateUi;
	updateUi = null;
	const el = document.getElementById("update-modal");
	if (el) {
		el.classList.add("update-modal-out");
		setTimeout(() => el.remove(), 320);
	}
	if (prev?.phase === "available") state.pendingUpdate = null;
}

function onDownloadProgress(prog: {
	received: number;
	total: number;
	percent?: number;
	speedBytesPerSec?: number;
	etaSeconds?: number;
}) {
	if (updateUi?.phase !== "downloading") return;
	updateUi = { ...updateUi, ...prog };
	const bar = document.getElementById("upd-bar-fill") as HTMLDivElement | null;
	const txt = document.getElementById("upd-bar-text");
	const stats = document.getElementById("upd-bar-stats");
	const pct = prog.total > 0 ? Math.min(100, (prog.received / prog.total) * 100) : prog.percent ?? 0;
	if (bar) bar.style.width = `${pct.toFixed(1)}%`;
	if (txt) {
		const mb = (n: number) => (n / 1048576).toFixed(1);
		txt.textContent = prog.total > 0
			? `${mb(prog.received)} / ${mb(prog.total)} MB (${pct.toFixed(0)}%)`
			: `${mb(prog.received)} MB`;
	}
	if (stats && prog.speedBytesPerSec !== undefined) {
		const speedMb = (prog.speedBytesPerSec / 1048576).toFixed(2);
		const eta = prog.etaSeconds && prog.etaSeconds > 0 ? ` • ${Math.round(prog.etaSeconds)}s remaining` : "";
		stats.textContent = `${speedMb} MB/s${eta}`;
	}
}

async function startUpdateDownload() {
	if (updateUi?.phase !== "available") return;
	const release = updateUi.release;
	if (!release.installerUrl || !release.installerName) {
		setUpdateState({
			phase: "error",
			message: "This release doesn't have a Windows installer attached.",
		});
		return;
	}
	setUpdateState({ phase: "downloading", release, received: 0, total: 0 });
	try {
		const { path, sha256 } = await bun().downloadUpdate({
			url: release.installerUrl,
			filename: release.installerName,
		});
		setUpdateState({ phase: "installing", release, sha256 });
		setTimeout(() => {
			void bun().runUpdateAndQuit({ path });
		}, 800);
	} catch (err) {
		setUpdateState({ phase: "error", message: (err as Error).message });
	}
}

function renderUpdateModal() {
	let el = document.getElementById("update-modal");
	if (!updateUi) {
		if (el) closeUpdateModal();
		return;
	}
	if (!el) {
		el = document.createElement("div");
		el.id = "update-modal";
		el.className = "update-modal";
		document.body.appendChild(el);
		requestAnimationFrame(() => el!.classList.add("update-modal-in"));
	}
	const body = (() => {
		const u = updateUi!;
		if (u.phase === "checking") {
			return `
				<div class="upd-spinner"></div>
				<h2 class="upd-h">Checking for updates…</h2>
				<p class="upd-p">Asking GitHub for ${state.settings.updateChannel === "canary" ? "Canary" : "Latest"} release.</p>
			`;
		}
		if (u.phase === "up-to-date") {
			return `
				<div class="upd-check">✓</div>
				<h2 class="upd-h">You're up to date</h2>
				<p class="upd-p">Lakky v${escapeHtml(APP_VERSION)} is the latest build on the ${state.settings.updateChannel} channel.</p>
			`;
		}
		if (u.phase === "error") {
			return `
				<div class="upd-err">!</div>
				<h2 class="upd-h">Update check failed</h2>
				<p class="upd-p upd-mono">${escapeHtml(u.message)}</p>
				<div class="upd-actions">
					<button class="btn" id="upd-close-btn">Close</button>
				</div>
			`;
		}
		if (u.phase === "available") {
			const notes = (u.release.notes || "No release notes provided.").trim();
			const preview = notes.length > 520 ? notes.slice(0, 517) + "…" : notes;
			return `
				<div class="upd-pill"><span class="upd-pill-dot"></span>NEW ${state.settings.updateChannel.toUpperCase()} BUILD</div>
				<div class="upd-versions">
					<span class="upd-from">v${escapeHtml(APP_VERSION)}</span>
					<span class="upd-arrow">→</span>
					<span class="upd-to">v${escapeHtml(u.release.version)}</span>
				</div>
				<h2 class="upd-h">${escapeHtml(u.release.name)}</h2>
				<div class="upd-notes">${escapeHtml(preview)}</div>
				<div class="upd-actions">
					<button class="btn update-primary" id="upd-install">Install & Restart</button>
					<button class="btn btn-ghost" id="upd-later">Later</button>
					<button class="btn btn-ghost upd-skip-link" id="upd-skip">Skip this version</button>
				</div>
			`;
		}
		if (u.phase === "downloading") {
			return `
				<div class="upd-pill"><span class="upd-pill-dot"></span>DOWNLOADING UPDATE</div>
				<h2 class="upd-h">Updating to v${escapeHtml(u.release.version)}</h2>
				<div class="upd-bar"><div class="upd-bar-fill" id="upd-bar-fill"></div></div>
				<div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.4rem">
					<span class="upd-p upd-mono" id="upd-bar-text">Connecting…</span>
					<span class="upd-p upd-mono" id="upd-bar-stats" style="font-size:0.76rem;color:var(--accent-a)"></span>
				</div>
				<p class="upd-p" style="margin-top:0.6rem;font-size:0.78rem">Lakky will verify SHA-256 integrity and relaunch automatically.</p>
			`;
		}
		// installing
		return `
			<div class="upd-spinner"></div>
			<h2 class="upd-h">Installing v${escapeHtml(u.release.version)}…</h2>
			<p class="upd-p" style="color:#4ade80">✓ SHA-256 verified safe</p>
			<p class="upd-p">Lakky is relaunching. Please do not force close.</p>
		`;
	})();

	el.innerHTML = `
		<div class="update-modal-backdrop"></div>
		<div class="update-modal-card">
			<div class="update-modal-glow"></div>
			${body}
		</div>
	`;

	el.querySelector("#upd-install")?.addEventListener("click", () => {
		sfx.click();
		void startUpdateDownload();
	});
	el.querySelector("#upd-later")?.addEventListener("click", () => {
		sfx.click();
		closeUpdateModal();
	});
	el.querySelector("#upd-skip")?.addEventListener("click", () => {
		if (updateUi?.phase !== "available") return;
		const tag = updateUi.release.tag;
		sfx.click();
		state.settings.skippedUpdateTag = tag;
		void saveSettings();
		toast(`Won't ask again for ${updateUi.release.version}.`, { ttl: 2400 });
		closeUpdateModal();
	});
	el.querySelector("#upd-close-btn")?.addEventListener("click", () => {
		sfx.click();
		closeUpdateModal();
	});
}

function openSecurityAuditModal(t: TrackInfo) {
	let modal = document.getElementById("security-modal");
	if (modal) modal.remove();

	modal = document.createElement("div");
	modal.id = "security-modal";
	modal.className = "update-modal update-modal-in";

	const isClean = t.securitySafe !== false && (t.securityScore ?? 100) >= 80;
	const score = t.securityScore ?? 100;
	const threats = t.securityThreats || [];

	modal.innerHTML = `
		<div class="update-modal-backdrop" id="sec-backdrop"></div>
		<div class="update-modal-card" style="max-width:540px">
			<div class="update-modal-glow" style="background:radial-gradient(circle at 50% 0%, ${isClean ? "rgba(34, 197, 94, 0.25)" : "rgba(239, 68, 68, 0.35)"}, transparent 70%)"></div>
			<div style="display:flex;align-items:center;gap:0.75rem;margin-bottom:1rem">
				<div style="width:40px;height:40px;border-radius:10px;background:${isClean ? "rgba(34, 197, 94, 0.15)" : "rgba(239, 68, 68, 0.2)"};color:${isClean ? "#4ade80" : "#f87171"};display:flex;align-items:center;justify-content:center">
					${isClean ? icons.shieldCheck : icons.shieldAlert}
				</div>
				<div>
					<h2 style="margin:0;font-size:1.15rem;font-weight:700">${isClean ? "Verified Safe Media" : "Security Alert / Inspection"}</h2>
					<div style="font-size:0.78rem;color:rgba(232, 232, 245, 0.6)">File Integrity & Binary Shield Analysis</div>
				</div>
			</div>

			<div style="background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.08);border-radius:10px;padding:0.9rem;margin-bottom:1rem;font-size:0.82rem;display:flex;flex-direction:column;gap:0.5rem">
				<div style="display:flex;justify-content:space-between">
					<span style="color:rgba(232,232,245,0.6)">File:</span>
					<span style="font-weight:600;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(t.title)}</span>
				</div>
				<div style="display:flex;justify-content:space-between">
					<span style="color:rgba(232,232,245,0.6)">Path:</span>
					<span style="font-family:monospace;font-size:0.74rem;max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(t.path)}</span>
				</div>
				<div style="display:flex;justify-content:space-between">
					<span style="color:rgba(232,232,245,0.6)">Verified Container:</span>
					<span style="font-weight:600;color:var(--accent-a)">${t.verifiedFormat ? escapeHtml(t.verifiedFormat.toUpperCase()) : "Standard Media"}</span>
				</div>
				<div style="display:flex;justify-content:space-between">
					<span style="color:rgba(232,232,245,0.6)">Integrity Score:</span>
					<span style="font-weight:700;color:${score >= 80 ? "#4ade80" : score >= 50 ? "#facc15" : "#f87171"}">${score} / 100</span>
				</div>
			</div>

			${threats.length > 0 ? `
				<div style="background:rgba(239, 68, 68, 0.12);border:1px solid rgba(239, 68, 68, 0.3);border-radius:10px;padding:0.85rem;margin-bottom:1.2rem">
					<div style="font-weight:600;color:#f87171;font-size:0.84rem;margin-bottom:0.4rem">Detected Vulnerabilities & Warnings:</div>
					<ul style="margin:0;padding-left:1.2rem;font-size:0.78rem;color:#fca5a5;line-height:1.4">
						${threats.map(threat => `<li>${escapeHtml(threat)}</li>`).join("")}
					</ul>
				</div>
			` : `
				<div style="background:rgba(34, 197, 94, 0.08);border:1px solid rgba(34, 197, 94, 0.25);border-radius:10px;padding:0.8rem;margin-bottom:1.2rem;font-size:0.8rem;color:#86efac">
					✓ Zero disguised binaries or polyglot stego payloads found. Media container headers and atoms conform to safe playback standards.
				</div>
			`}

			<div style="display:flex;justify-content:flex-end;gap:0.6rem">
				<button class="btn btn-ghost" id="sec-folder-btn">${icons.folder} Show file</button>
				<button class="btn btn-primary" id="sec-close-btn">Done</button>
			</div>
		</div>
	`;

	document.body.appendChild(modal);

	modal.querySelector("#sec-close-btn")?.addEventListener("click", () => modal?.remove());
	modal.querySelector("#sec-backdrop")?.addEventListener("click", () => modal?.remove());
	modal.querySelector("#sec-folder-btn")?.addEventListener("click", () => {
		bun().showInFolder({ path: t.path }).catch(() => {});
	});
}

// Update the current audio effect graph: store on state, persist to disk, and
// push to BOTH engineA and engineB so a crossfade in progress doesn't end up
// with one engine routed through the new graph and the other through the old
// chain. The node editor view should call this whenever the user edits the
// graph (or picks a template); pass null to revert to the default 10-band EQ.
async function applyNodeGraph(graph: NodeGraph | null) {
	state.nodeGraph = graph;
	try {
		await bun().savePersistedState({ key: "nodeGraph", value: graph });
	} catch (err) {
		console.warn("[node-graph] persist failed:", (err as Error).message);
	}
	try { engineA.setNodeGraph(graph); } catch (err) {
		console.warn("[node-graph] engineA failed:", err);
		toast(`Audio graph error: ${(err as Error).message}`, { ttl: 4000 });
	}
	try { engineB.setNodeGraph(graph); } catch (err) {
		console.warn("[node-graph] engineB failed:", err);
	}
}


// Expose for the node editor sibling agent. It can read state.nodeGraph and
// call window.applyNodeGraph(g) to commit changes without importing this file.
window.applyNodeGraph = applyNodeGraph;
// The node editor reaches through window.__lakkyToast so it doesn't have to
// import this file (which would risk a circular dep at module-eval time).
window.__lakkyToast = toast;

// Long tracks (audiobooks, podcasts, DJ sets) deserve resume support. We
// remember the last position for anything over 10 minutes and only restore
// if you weren't basically at the end already.
function shouldBookmark(t: TrackInfo): boolean {
	return (t.duration ?? 0) > 600;
}
let bookmarkSaveTimer: ReturnType<typeof setTimeout> | null = null;
function maybeRememberPosition() {
	const t = state.currentTrack;
	if (!t || !shouldBookmark(t)) return;
	const cur = engine.currentTime;
	if (cur < 8 || cur > engine.duration - 8) {
		// Skip "just started" and "basically at the end".
		return;
	}
	state.bookmarks[t.id] = cur;
	// Debounce disk writes.
	if (bookmarkSaveTimer) clearTimeout(bookmarkSaveTimer);
	bookmarkSaveTimer = setTimeout(() => saveBookmarks(), 1500);
}

// ---------- Splash ----------
splashStep.textContent = "Loading";

async function dismissSplash() {
	splashEl.classList.add("splash-out");
	appEl.classList.remove("hidden");
	requestAnimationFrame(() => appEl.classList.add("app-in"));
	setTimeout(() => splashEl.remove(), 500);
}

// ---------- Toasts ----------
const toastStack = document.createElement("div");
toastStack.className = "toast-stack";
document.body.appendChild(toastStack);
const toastByKey = new Map<string, HTMLDivElement>();
function toast(msg: string, opts: { ttl?: number; key?: string } = {}) {
	const ttl = opts.ttl ?? 2200;
	if (opts.key && toastByKey.has(opts.key)) {
		const el = toastByKey.get(opts.key)!;
		el.textContent = msg;
		clearTimeout((el as any)._t);
		(el as any)._t = setTimeout(() => removeToast(el, opts.key), ttl);
		return;
	}
	const el = document.createElement("div");
	el.className = "toast";
	el.textContent = msg;
	toastStack.appendChild(el);
	if (opts.key) toastByKey.set(opts.key, el);
	(el as any)._t = setTimeout(() => removeToast(el, opts.key), ttl);
}
function removeToast(el: HTMLDivElement, key?: string) {
	el.style.opacity = "0";
	el.style.transform = "translateY(8px)";
	el.style.transition = "all 0.3s ease";
	setTimeout(() => {
		el.remove();
		if (key) toastByKey.delete(key);
	}, 320);
}

// ---------- Icons (inline SVGs) ----------
const icons = {
	home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5 12 3l9 6.5V21h-6v-7h-6v7H3z"/></svg>`,
	library: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 12h18M3 18h12"/></svg>`,
	disc: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2"/></svg>`,
	eq: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg>`,
	list: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>`,
	settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
	search: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.3-4.3"/></svg>`,
	play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`,
	pause: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>`,
	prev: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zM9 12l10-7v14z"/></svg>`,
	next: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM5 5v14l10-7z"/></svg>`,
	shuffle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 3h5v5M21 3l-7 7M4 20l16-16M4 4l5 5M16 21h5v-5M15 15l6 6"/></svg>`,
	repeat: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"/></svg>`,
	repeatOne: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"/><text x="9" y="16" font-size="9" font-weight="bold" fill="currentColor" stroke="none">1</text></svg>`,
	queue: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h13M3 12h13M3 18h9M17 16l3 3 3-3M20 5v14"/></svg>`,
	volume: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14"/></svg>`,
	mute: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4zM23 9l-6 6M17 9l6 6"/></svg>`,
	plus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`,
	folder: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>`,
	musicNote: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18V5l12-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM21 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"/></svg>`,
	moon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
	maximize: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`,
	video: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 7l-7 5 7 5V7zM14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z"/></svg>`,
	chart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18M7 16V9M12 16V5M17 16v-7"/></svg>`,
	node: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="12" r="3"/><circle cx="19" cy="12" r="3"/><path d="M8 12h8"/></svg>`,
	pip: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5h18v12H3z"/><path d="M13 11h6v5h-6z" fill="currentColor" stroke="none"/></svg>`,
	mini: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><rect x="12" y="12" width="7" height="7" rx="1.5" fill="currentColor" stroke="none"/></svg>`,
	tray: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 14h4l2 3h6l2-3h4"/><path d="M5 5h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z"/></svg>`,
	sparkle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z"/><path d="M19 3l.5 2L21 5.5 19 6l-.5 2L18 5.5 16 5l2-.5z"/></svg>`,
	abLoop: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 6V2l4 4-4 4V8a6 6 0 1 0 6 6H6a6 6 0 1 0 6-6"/></svg>`,
	shield: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
	shieldCheck: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>`,
	shieldAlert: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
	world3d: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>`,
	eightD: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="9" ry="3.5" transform="rotate(-25 12 12)"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/></svg>`,
	bass: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 10v4M6 6v12M10 3v18M14 7v10M18 5v14M22 10v4"/></svg>`,
	vocal: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>`,
	reverb: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M7 18v-4a5 5 0 0 1 10 0v4"/><circle cx="12" cy="18" r="1.5" fill="currentColor"/></svg>`,
	copy: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`,
	mic: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
	text: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4 7 4 4 20 4 20 7"/><line x1="9" y1="20" x2="15" y2="20"/><line x1="12" y1="4" x2="12" y2="20"/></svg>`,
	sort: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 16 4 4 4-4M7 20V4M21 8l-4-4-4 4M17 4v16"/></svg>`,
	sortAsc: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 8 4-4 4 4M7 4v16M14 8h7M14 12h5M14 16h3"/></svg>`,
	sortDesc: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 16 4 4 4-4M7 20V4M14 8h7M14 12h5M14 16h3"/></svg>`,
	filter: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/></svg>`,
	flame: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c1 3 4 5 4 9 0 3.3-2.7 6-6 6s-6-2.7-6-6c0-3.5 2.5-6.2 4.5-7.8.3-.3.8-.1.8.3 0 1.5.8 2.8 1.8 3.5.3.2.7 0 .7-.4 0-1.8.4-3.4 1.2-4.6z"/></svg>`,
	star: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
	starFill: `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`,
	heart: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>`,
	heartFill: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>`,
	palette: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="13.5" cy="6.5" r=".5" fill="currentColor"/><circle cx="17.5" cy="10.5" r=".5" fill="currentColor"/><circle cx="8.5" cy="7.5" r=".5" fill="currentColor"/><circle cx="6.5" cy="12.5" r=".5" fill="currentColor"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/></svg>`,
	chevronDown: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`,
	chevronUp: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>`,
	chevronRight: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`,
	download: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>`,
	trash: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`,
	edit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`,
	check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
	close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`,
	dots: `<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="5" cy="12" r="2"/></svg>`,
	artist: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`,
	upload: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>`,
	dice: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/><circle cx="15.5" cy="8.5" r="1.5" fill="currentColor"/><circle cx="8.5" cy="15.5" r="1.5" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>`,
	sparkles: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3-1.912 5.813a2 2 0 0 1-1.275 1.275L3 12l5.813 1.912a2 2 0 0 1 1.275 1.275L12 21l1.912-5.813a2 2 0 0 1 1.275-1.275L21 12l-5.813-1.912a2 2 0 0 1-1.275-1.275L12 3Z"/></svg>`,
	spatial: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 18v-6a9 9 0 0 1 18 0v6"/><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z"/><circle cx="12" cy="12" r="2"/></svg>`,
	speedPill: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
	volumeLow: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4zM15.5 8.5a5 5 0 0 1 0 7"/></svg>`,
	cinema: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="2.18" ry="2.18"/><line x1="7" y1="2" x2="7" y2="22"/><line x1="17" y1="2" x2="17" y2="22"/><line x1="2" y1="12" x2="22" y2="12"/><line x1="2" y1="7" x2="7" y2="7"/><line x1="2" y1="17" x2="7" y2="17"/><line x1="17" y1="17" x2="22" y2="17"/><line x1="17" y1="7" x2="22" y2="7"/></svg>`,
	zap: `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
	speaker: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="16" height="20" x="4" y="2" rx="2"/><circle cx="12" cy="14" r="4"/><line x1="12" x2="12.01" y1="6" y2="6"/></svg>`,
	keyboard: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.001M10 8h.001M14 8h.001M18 8h.001M8 12h.001M12 12h.001M16 12h.001M7 16h10"/></svg>`,
	phone: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="14" height="20" x="5" y="2" rx="2" ry="2"/><path d="M12 18h.01"/></svg>`,
	windows: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-12.951-1.801"/></svg>`,
	refresh: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"/><path d="M16 21h5v-5"/></svg>`,
	externalLink: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`,
};

// ---------- App shell render ----------
function render() {
	appEl.innerHTML = `
		<aside class="sidebar">
			<nav class="sidebar-nav">
				${navItem("home", icons.home, "Home", "1")}
				${navItem("library", icons.library, "Library", "2")}
				${navItem("nowplaying", icons.disc, "Now Playing", "3")}
				${navItem("equalizer", icons.eq, "Equalizer", "4")}
				${navItem("playlists", icons.list, "Playlists", "5")}
				${navItem("stats", icons.chart, "Stats", "6")}
				${navItem("nodes", icons.node, "Nodes", "7")}
				${navItem("settings", icons.settings, "Settings")}
			</nav>
			<div class="sidebar-section-title">Your Playlists</div>
			<div class="sidebar-playlists" id="sidebar-playlists"></div>
			<div class="sidebar-foot" id="sidebar-foot"></div>
		</aside>

		<main class="main" id="main"></main>

		<section class="np" id="np">
			${state.settings.showStripViz ? `<div class="np-strip"><canvas id="np-strip-canvas"></canvas></div>` : ""}
			<div class="np-row">
				<div class="np-track">
					<div class="np-art" id="np-art"></div>
					<div class="np-info">
						<div class="np-title" id="np-title">Nothing playing</div>
						<div class="np-artist" id="np-artist">—</div>
					</div>
				</div>
				<div class="np-center">
					<div class="np-buttons">
						<button class="icon-btn cel-btn" id="btn-shuffle" title="Shuffle">${icons.shuffle}<span class="smart-indicator"></span></button>
						<button class="icon-btn cel-btn" id="btn-abloop" title="A-B Loop (B)">${icons.abLoop}</button>
						<button class="icon-btn cel-btn" id="btn-prev" title="Previous (Ctrl+←)">${icons.prev}</button>
						<button class="icon-btn play-btn cel-hero-btn" id="btn-play" title="Play / pause (Space)"><span class="play-btn-inner">${icons.play}</span></button>
						<button class="icon-btn cel-btn" id="btn-next" title="Next (Ctrl+→)">${icons.next}</button>
						<button class="icon-btn cel-btn" id="btn-repeat" title="Repeat">${icons.repeat}</button>
					</div>
					<div class="np-scrub">
						<span class="np-time" id="np-current">0:00</span>
						<div class="scrub" id="scrub" title="Click or drag to seek">
							<div class="scrub-waveform-glow" id="scrub-waveform-glow"></div>
							<div class="scrub-loop-range" id="scrub-loop-range" style="display:none"></div>
							<div class="scrub-fill" id="scrub-fill"></div>
							<div class="scrub-handle" id="scrub-handle"></div>
							<div class="scrub-lo-a" id="scrub-lo-a" data-label="A" style="display:none"></div>
							<div class="scrub-lo-b" id="scrub-lo-b" data-label="B" style="display:none"></div>
							<div class="scrub-tooltip" id="scrub-hover-tooltip">0:00</div>
						</div>
						<span class="np-time" id="np-duration">0:00</span>
					</div>
				</div>
				<div class="np-right">
					<div class="np-audio-tweaks">
						<button class="pill-btn speed-pill" id="btn-speed-selector" data-tip="Speed & Pitch Engine" title="Speed & Pitch Engine">
							<span class="pill-icon">${icons.speedPill}</span>
							<span class="pill-label" id="speed-pill-label">1.0×</span>
						</button>
						<button class="pill-btn boost-pill" id="btn-preamp-pill" data-tip="Pre-Amp Gain Booster" title="Pre-Amp Gain Booster">
							<span class="boost-badge" id="preamp-badge">0dB</span>
						</button>
						<button class="icon-btn spatial-btn" id="btn-spatial-8d" data-tip="8D Spatial Surround (Binaural)" title="8D Spatial Surround">
							<span class="spatial-rings"></span>
							<span class="spatial-label">8D</span>
						</button>
						<button class="icon-btn viz-gradient-btn" id="btn-viz-gradient" data-tip="Visualizer Color Gradient" title="Visualizer Color Gradient">
							${icons.palette}
						</button>
					</div>

					<div class="np-quick-modes">
						<button class="icon-btn cel-btn" id="btn-eq-shortcut" data-tip="Equalizer" title="Equalizer">${icons.eq}</button>
						<button class="icon-btn cel-btn" id="btn-mini-shortcut" data-tip="Mini player" title="Mini player">${icons.mini}</button>
						<button class="icon-btn cel-btn" id="btn-fullscreen" data-tip="Toggle Cinema Fullscreen" title="Toggle Cinema Fullscreen">${icons.cinema}</button>
						<button class="icon-btn cel-btn" id="btn-queue" data-tip="Up Next Queue" title="Up Next Queue">${icons.queue}</button>
					</div>

					<div class="volume" title="Volume (↑ / ↓)">
						<button class="icon-btn" id="btn-mute" data-tip="Mute (M)" style="padding:0">${icons.volume}</button>
						<input type="range" id="volume" class="range" min="0" max="100" value="${Math.round(state.settings.volume * 100)}" title="Volume" />
					</div>
				</div>
			</div>

			<!-- Speed & Pitch Floating Popover -->
			<div class="speed-popover hidden" id="speed-popover">
				<div class="speed-popover-header">
					<span class="popover-title">⚡ SPEED & PITCH</span>
					<button class="speed-popover-close" id="speed-popover-close">✕</button>
				</div>
				<div class="speed-presets-grid">
					<button class="speed-opt-btn" data-speed="0.5">0.5×</button>
					<button class="speed-opt-btn" data-speed="0.75">0.75×</button>
					<button class="speed-opt-btn active" data-speed="1.0">1.0×</button>
					<button class="speed-opt-btn" data-speed="1.25">1.25×</button>
					<button class="speed-opt-btn" data-speed="1.5">1.5×</button>
					<button class="speed-opt-btn" data-speed="2.0">2.0×</button>
				</div>
				<div class="pitch-presets-row">
					<button class="pitch-mode-btn nightcore" id="btn-mode-nightcore">
						<span class="pitch-badge">⚡ NIGHTCORE</span>
						<span class="pitch-sub">1.28× + High Pitch</span>
					</button>
					<button class="pitch-mode-btn lofi" id="btn-mode-lofi">
						<span class="pitch-badge">🌙 LO-FI CHOP</span>
						<span class="pitch-sub">0.84× + Deep Slow</span>
					</button>
				</div>
				<div class="pitch-toggle-row">
					<label class="toggle-label">
						<input type="checkbox" id="pitch-preserve-toggle" ${state.settings.preservesPitch ? "checked" : ""} />
						<span>Lock Pitch (Time Stretch)</span>
					</label>
				</div>
			</div>
		</section>

		<aside class="queue" id="queue-panel">
			<h3>Up Next</h3>
			<div id="queue-body"></div>
		</aside>
	`;

	document.body.dataset.stripViz = state.settings.showStripViz ? "on" : "off";
	wireSidebar();
	wireTransport();
	renderMain();
	renderSidebarFoot();
	renderSidebarPlaylists();
	renderQueuePanel();
	mountStripVisualizer();
}

// Wire interactions on the video stage via VideoCinemaEngine
function wireVideoStage() {
	const mount = document.getElementById("video-mount");
	if (!mount || !state.currentTrack || state.currentTrack.kind !== "video") return;

	cinemaEngine.mount(mount, videoEl, engine, state.currentTrack, {
		onToast: (msg, opts) => toast(msg, opts),
		onTogglePlay: () => {
			engine.togglePlay();
			engine.paused ? sfx.pause() : sfx.play();
		},
		onSeek: (time) => {
			engine.seek(time);
		},
		onPrevious: () => {
			previous();
		},
		onNext: () => {
			next();
		},
		onSetVolume: (vol) => {
			state.settings.volume = vol;
			engine.setVolume(vol);
			const slider = document.getElementById("volume") as HTMLInputElement | null;
			if (slider) {
				slider.value = String(Math.round(vol * 100));
				syncRangeFill(slider);
			}
		},
		onToggleFullscreen: async () => {
			try { await bun().windowToggleFullscreen({}); } catch {}
		},
	});
}

// Shared construction sequence for every Visualizer instantiation site —
// they all differ only in canvas/mode/style/fps/autostart, so this keeps
// the perf-setting wiring (setMaxFps/setIdleEnabled) from drifting out of
// sync between the strip, now-playing, and immersive-view instances.
function createVisualizer(
	canvas: HTMLCanvasElement,
	mode: "bars" | "strip",
	style: VizStyle,
	opts: { maxFps: number; idle: boolean; autoStart: boolean },
): Visualizer {
	const v = new Visualizer(canvas, monitorTap, mode, style);
	v.setMaxFps(opts.maxFps);
	v.setIdleEnabled(opts.idle);
	if (opts.autoStart) v.start();
	return v;
}

let stripViz: Visualizer | null = null;
function mountStripVisualizer() {
	// If the user disabled the strip visualizer entirely the div doesn't
	// exist — tear down any leftover instance and bail.
	if (!state.settings.showStripViz) {
		stripViz?.destroy();
		stripViz = null;
		return;
	}
	const canvas = document.getElementById("np-strip-canvas") as HTMLCanvasElement | null;
	if (!canvas) return;
	stripViz?.destroy();
	stripViz = createVisualizer(canvas, "strip", "bars", {
		maxFps: state.settings.maxFps,
		idle: state.settings.idleViz,
		autoStart: !engine.paused,
	});
	stripViz.setGradient(state.settings.stripGradient);
	const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(state.settings.accent);
	if (m) {
		stripViz.setAccent([parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)]);
	}
}

// Single point that pushes the user's perf settings to whichever visualizers
// happen to exist right now (the strip viz always; the big "Now Playing"
// one only when on that view).
function applyVizPerf() {
	stripViz?.setMaxFps(state.settings.maxFps);
	stripViz?.setIdleEnabled(state.settings.idleViz);
	visualizer?.setMaxFps(state.settings.maxFps);
	visualizer?.setIdleEnabled(state.settings.idleViz);
}

// Bun tells us whenever the window is hidden — send-to-tray, minimize-to-tray,
// the mini-player swap, anything that takes the main window off-screen. We tear
// down the rAF-driven visualizers (which otherwise keep painting an unseen
// canvas) and set a body attribute so CSS animations can suspend themselves
// via a single rule. Audio keeps playing — only the rendering work stops.
let rendererHidden = false;
function setRendererHidden(hidden: boolean) {
	if (rendererHidden === hidden) return;
	rendererHidden = hidden;
	if (hidden) {
		document.body.dataset.appHidden = "1";
		visualizer?.destroy();
		visualizer = null;
		stripViz?.destroy();
		stripViz = null;
	} else {
		delete document.body.dataset.appHidden;
		mountStripVisualizer();
		// If the user comes back on the Now Playing view we need to rebuild
		// the big visualizer too — it lives inside the view's main area.
		if (state.view === "nowplaying") renderMain();
	}
}

// ---------- MediaSession (Windows SMTC + media keys + taskbar flyout) ----------
function setupMediaSession() {
	if (!("mediaSession" in navigator)) return;
	const ms = navigator.mediaSession;
	ms.setActionHandler("play", () => { engine.play(); });
	ms.setActionHandler("pause", () => { engine.pause(); });
	ms.setActionHandler("stop", () => { engine.pause(); });
	ms.setActionHandler("previoustrack", () => { previous(); });
	ms.setActionHandler("nexttrack", () => { next(); });
	ms.setActionHandler("seekbackward", (d) => {
		const off = d.seekOffset ?? 10;
		engine.seek(Math.max(0, engine.currentTime - off));
	});
	ms.setActionHandler("seekforward", (d) => {
		const off = d.seekOffset ?? 10;
		engine.seek(Math.min(engine.duration, engine.currentTime + off));
	});
	try {
		ms.setActionHandler("seekto", (d) => {
			if (typeof d.seekTime === "number") engine.seek(d.seekTime);
		});
	} catch {}
}

function updateMediaSession() {
	if (!("mediaSession" in navigator)) return;
	const t = state.currentTrack;
	if (!t) {
		navigator.mediaSession.metadata = null;
		return;
	}
	const artwork = t.artDataUrl
		? [
			{ src: t.artDataUrl, sizes: "96x96", type: "image/jpeg" },
			{ src: t.artDataUrl, sizes: "256x256", type: "image/jpeg" },
			{ src: t.artDataUrl, sizes: "512x512", type: "image/jpeg" },
		]
		: [];
	navigator.mediaSession.metadata = new MediaMetadata({
		title: t.title,
		artist: t.artist,
		album: t.album,
		artwork,
	});
	navigator.mediaSession.playbackState = engine.paused ? "paused" : "playing";
}

function updateMediaSessionPosition() {
	if (!("mediaSession" in navigator)) return;
	if (!engine.duration || !Number.isFinite(engine.duration)) return;
	try {
		navigator.mediaSession.setPositionState({
			duration: engine.duration,
			playbackRate: 1,
			position: Math.min(engine.currentTime, engine.duration),
		});
	} catch {}
}
setupMediaSession();

function navItem(view: View, iconSvg: string, label: string, num?: string) {
	const active = state.view === view ? "active" : "";
	const badge = num ? `<span class="nav-badge">${num}</span>` : "";
	return `<div class="nav-item ${active}" data-view="${view}" title="${label}">${iconSvg}<span>${label}</span>${badge}</div>`;
}

function wireSidebar() {
	for (const el of document.querySelectorAll<HTMLDivElement>(".nav-item")) {
		el.addEventListener("click", () => {
			const v = el.dataset.view as View;
			navigate(v);
			sfx.click();
		});
		el.addEventListener("mouseenter", () => sfx.hover());
	}
}

function navigate(v: View) {
	state.view = v;
	for (const el of document.querySelectorAll<HTMLDivElement>(".nav-item")) {
		el.classList.toggle("active", el.dataset.view === v);
	}
	renderMain();
}

let isDraggingScrub = false;

function applyPlaybackRate() {
	let rate = state.settings.speed;
	let preserve = state.settings.preservesPitch;
	if (state.settings.pitchMode === "nightcore") {
		rate = 1.28;
		preserve = false;
	} else if (state.settings.pitchMode === "lofi") {
		rate = 0.84;
		preserve = false;
	}
	engineA.setRate(rate, preserve);
	engineB.setRate(rate, preserve);
	videoEngine.setRate(rate, preserve);
	updateSpeedPillUI();
}

function updateSpeedPillUI() {
	const pillLabel = document.getElementById("speed-pill-label");
	if (!pillLabel) return;
	if (state.settings.pitchMode === "nightcore") {
		pillLabel.textContent = "⚡ 1.28×";
	} else if (state.settings.pitchMode === "lofi") {
		pillLabel.textContent = "🌙 0.84×";
	} else {
		pillLabel.textContent = `${state.settings.speed.toFixed(2).replace(/\.?0+$/, "")}×`;
	}
}

function applySpatialAudio() {
	const on = state.settings.spatial8D;
	engineA.setSpatial8D(on);
	engineB.setSpatial8D(on);
	videoEngine.setSpatial8D(on);
	const btn = document.getElementById("btn-spatial-8d");
	if (btn) btn.classList.toggle("active", on);
}

function updateVolumeIcon(v: number) {
	const btn = document.getElementById("btn-mute");
	if (!btn) return;
	if (v === 0) {
		btn.innerHTML = icons.mute;
	} else if (v < 0.35) {
		btn.innerHTML = icons.volumeLow;
	} else {
		btn.innerHTML = icons.volume;
	}
}

function updatePreampUI() {
	const pill = document.getElementById("btn-preamp-pill");
	const badge = document.getElementById("preamp-badge");
	if (!pill || !badge) return;
	const db = Math.round(state.settings.preAmp);
	badge.textContent = db > 0 ? `+${db}dB` : `${db}dB`;
	pill.classList.toggle("boosted", db > 0);
	pill.setAttribute("title", `Pre-Amp Gain Booster: ${db > 0 ? `+${db}dB (Overdrive Boost)` : "0dB (Standard)"}`);
}

// ---------- Transport ----------
function wireTransport() {
	const btnPlay = document.getElementById("btn-play")!;
	const btnPrev = document.getElementById("btn-prev")!;
	const btnNext = document.getElementById("btn-next")!;
	const btnShuffle = document.getElementById("btn-shuffle")!;
	const btnAbloop = document.getElementById("btn-abloop")!;
	const btnRepeat = document.getElementById("btn-repeat")!;
	const btnQueue = document.getElementById("btn-queue")!;

	btnPlay.addEventListener("click", () => {
		if (!state.currentTrack && state.library.length > 0) {
			playFromList(state.library, 0);
			return;
		}
		engine.togglePlay();
		engine.paused ? sfx.pause() : sfx.play();
	});

	btnPrev.addEventListener("click", () => {
		previous();
		sfx.skip();
	});
	btnNext.addEventListener("click", () => {
		next();
		sfx.skip();
	});
	btnShuffle.addEventListener("click", () => {
		state.settings.shuffle = !state.settings.shuffle;
		sfx.toggle();
		saveSettings();
		applyShuffleVisuals();
		toast(
			state.settings.shuffle
				? state.settings.smartShuffle ? "Smart shuffle on (Weighted & Recency)" : "Shuffle on (Random)"
				: "Shuffle off",
			{ ttl: 1500 },
		);
	});
	btnRepeat.addEventListener("click", () => {
		const cycle: RepeatMode[] = ["off", "all", "one"];
		state.settings.repeat = cycle[(cycle.indexOf(state.settings.repeat) + 1) % cycle.length];
		btnRepeat.innerHTML = state.settings.repeat === "one" ? icons.repeatOne : icons.repeat;
		btnRepeat.classList.toggle("active", state.settings.repeat !== "off");
		sfx.toggle();
		saveSettings();
		toast(`Repeat: ${state.settings.repeat.toUpperCase()}`, { ttl: 1500 });
	});
	btnAbloop.addEventListener("click", () => {
		const cur = engine.currentTime;
		const dur = engine.duration;
		if (!state.abLoop) {
			state.abLoop = { a: cur, b: dur > 0 ? dur : Infinity };
			toast(`A-B Loop [A] set: ${formatTime(cur)}`, { ttl: 1800, key: "abloop" });
		} else if (state.abLoop.b >= dur) {
			state.abLoop = { a: state.abLoop.a, b: cur };
			toast(`A-B Loop [A→B] locked: ${formatTime(state.abLoop.a)} → ${formatTime(cur)}`, { ttl: 2000, key: "abloop" });
		} else {
			state.abLoop = null;
			engineA.setABLoop(null);
			engineB.setABLoop(null);
			videoEngine.setABLoop(null);
			toast("A-B Loop cleared", { ttl: 1500, key: "abloop" });
		}
		if (state.abLoop) {
			engineA.setABLoop(state.abLoop);
			engineB.setABLoop(state.abLoop);
			videoEngine.setABLoop(state.abLoop);
		}
		updateLoopMarkers();
		saveAbLoop();
		sfx.toggle();
	});
	btnQueue.addEventListener("click", () => {
		state.queueOpen = !state.queueOpen;
		document.getElementById("queue-panel")?.classList.toggle("open", state.queueOpen);
		btnQueue.classList.toggle("active", state.queueOpen);
		sfx.click();
		if (state.queueOpen) renderQueuePanel();
	});

	document.getElementById("btn-fullscreen")?.addEventListener("click", async () => {
		sfx.click();
		try { await bun().windowToggleFullscreen({}); } catch {}
	});

	document.getElementById("btn-eq-shortcut")?.addEventListener("click", () => {
		sfx.click();
		navigate("equalizer");
	});
	document.getElementById("btn-mini-shortcut")?.addEventListener("click", async () => {
		sfx.click();
		try { await bun().openMiniPlayer({}); } catch {}
	});

	// Pre-amp booster pill (+6dB / +12dB)
	const btnPreamp = document.getElementById("btn-preamp-pill");
	if (btnPreamp) {
		btnPreamp.addEventListener("click", () => {
			const cycle = [0, 6, 12];
			const curDb = Math.round(state.settings.preAmp);
			const nextDb = cycle[(cycle.indexOf(curDb) + 1) % cycle.length];
			state.settings.preAmp = nextDb;
			engineA.setPreAmp(nextDb);
			engineB.setPreAmp(nextDb);
			videoEngine.setPreAmp(nextDb);
			updatePreampUI();
			saveSettings();
			sfx.toggle();
			toast(nextDb > 0 ? `⚡ Pre-Amp Boost: +${nextDb}dB Overdrive` : "Pre-Amp Gain: 0dB Standard", { ttl: 1800 });
		});
	}
	updatePreampUI();

	// 8D Spatial Audio quick button
	const btnSpatial = document.getElementById("btn-spatial-8d");
	if (btnSpatial) {
		btnSpatial.addEventListener("click", () => {
			state.settings.spatial8D = !state.settings.spatial8D;
			applySpatialAudio();
			saveSettings();
			sfx.toggle();
			toast(
				state.settings.spatial8D
					? "🎧 8D Spatial Audio: Enabled (Binaural Orbit)"
					: "8D Spatial Audio: Disabled",
				{ ttl: 2000 },
			);
		});
	}
	applySpatialAudio();

	// Spectrum gradient palette cycler
	const btnVizGradient = document.getElementById("btn-viz-gradient");
	if (btnVizGradient) {
		const gradientCycle: AnimeGradient[] = [
			"cyber_neon",
			"sakura_sunset",
			"ghibli_emerald",
			"midnight_shogun",
			"synthwave_sunset",
			"ocean_shinkai",
			"default",
		];
		btnVizGradient.addEventListener("click", () => {
			const curIdx = gradientCycle.indexOf(state.settings.stripGradient);
			const nextGrad = gradientCycle[(curIdx + 1) % gradientCycle.length];
			state.settings.stripGradient = nextGrad;
			stripViz?.setGradient(nextGrad);
			saveSettings();
			sfx.click();
			const info = ANIME_GRADIENTS[nextGrad];
			toast(`🎨 Spectrum Gradient: ${info ? info.name : nextGrad}`, { ttl: 1800 });
		});
	}

	// Speed & Pitch popover
	const btnSpeed = document.getElementById("btn-speed-selector");
	const speedPopover = document.getElementById("speed-popover");
	const speedClose = document.getElementById("speed-popover-close");
	const pitchPreserveToggle = document.getElementById("pitch-preserve-toggle") as HTMLInputElement | null;

	if (btnSpeed && speedPopover) {
		btnSpeed.addEventListener("click", (e) => {
			e.stopPropagation();
			const isHidden = speedPopover.classList.contains("hidden");
			speedPopover.classList.toggle("hidden", !isHidden);
			btnSpeed.classList.toggle("active", isHidden);
			sfx.click();
		});
		speedClose?.addEventListener("click", (e) => {
			e.stopPropagation();
			speedPopover.classList.add("hidden");
			btnSpeed.classList.remove("active");
		});
		document.addEventListener("click", (e) => {
			if (!speedPopover.classList.contains("hidden") && !speedPopover.contains(e.target as Node) && e.target !== btnSpeed) {
				speedPopover.classList.add("hidden");
				btnSpeed.classList.remove("active");
			}
		});

		// Preset buttons
		for (const opt of speedPopover.querySelectorAll<HTMLButtonElement>(".speed-opt-btn")) {
			opt.addEventListener("click", () => {
				const sp = parseFloat(opt.dataset.speed || "1.0");
				state.settings.speed = sp;
				state.settings.pitchMode = "normal";
				applyPlaybackRate();
				saveSettings();
				sfx.click();
				toast(`Speed: ${sp}×`, { ttl: 1400 });
				for (const o of speedPopover.querySelectorAll(".speed-opt-btn")) o.classList.remove("active");
				opt.classList.add("active");
				speedPopover.querySelectorAll(".pitch-mode-btn").forEach((b) => b.classList.remove("active"));
			});
		}

		// Nightcore mode
		document.getElementById("btn-mode-nightcore")?.addEventListener("click", () => {
			state.settings.pitchMode = "nightcore";
			state.settings.speed = 1.28;
			state.settings.preservesPitch = false;
			applyPlaybackRate();
			saveSettings();
			sfx.play();
			toast("⚡ Nightcore Mode Active (1.28× + High Pitch)", { ttl: 2200 });
			speedPopover.querySelectorAll(".speed-opt-btn").forEach((b) => b.classList.remove("active"));
			speedPopover.querySelectorAll(".pitch-mode-btn").forEach((b) => b.classList.remove("active"));
			document.getElementById("btn-mode-nightcore")?.classList.add("active");
			if (pitchPreserveToggle) pitchPreserveToggle.checked = false;
		});

		// Lo-Fi mode
		document.getElementById("btn-mode-lofi")?.addEventListener("click", () => {
			state.settings.pitchMode = "lofi";
			state.settings.speed = 0.84;
			state.settings.preservesPitch = false;
			applyPlaybackRate();
			saveSettings();
			sfx.play();
			toast("🌙 Lo-Fi Chop Mode Active (0.84× + Deep Slow Pitch)", { ttl: 2200 });
			speedPopover.querySelectorAll(".speed-opt-btn").forEach((b) => b.classList.remove("active"));
			speedPopover.querySelectorAll(".pitch-mode-btn").forEach((b) => b.classList.remove("active"));
			document.getElementById("btn-mode-lofi")?.classList.add("active");
			if (pitchPreserveToggle) pitchPreserveToggle.checked = false;
		});

		if (pitchPreserveToggle) {
			pitchPreserveToggle.addEventListener("change", () => {
				state.settings.preservesPitch = pitchPreserveToggle.checked;
				if (state.settings.pitchMode !== "normal") state.settings.pitchMode = "normal";
				applyPlaybackRate();
				saveSettings();
				sfx.toggle();
			});
		}
	}
	updateSpeedPillUI();

	applyShuffleVisuals();
	if (state.settings.repeat !== "off") {
		btnRepeat.classList.add("active");
		if (state.settings.repeat === "one") btnRepeat.innerHTML = icons.repeatOne;
	}

	const vol = document.getElementById("volume")! as HTMLInputElement;
	syncRangeFill(vol);
	updateVolumeIcon(state.settings.volume);
	vol.addEventListener("input", () => {
		const v = parseInt(vol.value, 10) / 100;
		state.settings.volume = v;
		engineA.setVolume(v);
		engineB.setVolume(v);
		videoEngine.setVolume(v);
		updateVolumeIcon(v);
		syncRangeFill(vol);
		saveSettings();
	});

	const btnMute = document.getElementById("btn-mute");
	if (btnMute) {
		btnMute.addEventListener("click", () => {
			const cur = state.settings.volume;
			if (cur > 0) {
				state.mutedVolume = cur;
				state.settings.volume = 0;
				engineA.setVolume(0);
				engineB.setVolume(0);
				videoEngine.setVolume(0);
				vol.value = "0";
				updateVolumeIcon(0);
				sfx.toggle();
			} else {
				const restore = state.mutedVolume || 0.85;
				state.settings.volume = restore;
				engineA.setVolume(restore);
				engineB.setVolume(restore);
				videoEngine.setVolume(restore);
				vol.value = String(Math.round(restore * 100));
				updateVolumeIcon(restore);
				sfx.toggle();
			}
			syncRangeFill(vol);
			saveSettings();
		});
	}

	// Interactive Scrubber with smooth dragging and floating hover timestamp pill
	const scrub = document.getElementById("scrub")!;
	const scrubFill = document.getElementById("scrub-fill") as HTMLDivElement | null;
	const scrubHandle = document.getElementById("scrub-handle") as HTMLDivElement | null;
	const scrubTooltip = document.getElementById("scrub-hover-tooltip") as HTMLDivElement | null;
	const curTimeEl = document.getElementById("np-current");

	function handleScrubMove(clientX: number, commitSeek = false) {
		const rect = scrub.getBoundingClientRect();
		if (rect.width <= 0) return;
		const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
		const dur = engine.duration;
		const targetSec = dur > 0 ? ratio * dur : 0;
		const pct = ratio * 100;

		if (scrubFill) scrubFill.style.width = `${pct}%`;
		if (scrubHandle) scrubHandle.style.left = `${pct}%`;
		if (scrubTooltip) {
			scrubTooltip.textContent = `${formatTime(targetSec)}${dur > 0 ? ` / ${formatTime(dur)}` : ""}`;
			scrubTooltip.style.left = `${pct}%`;
		}
		if (curTimeEl && isDraggingScrub) {
			curTimeEl.textContent = formatTime(targetSec);
		}
		if (commitSeek && dur > 0) {
			engine.seek(targetSec);
		}
	}

	scrub.addEventListener("pointerdown", (e) => {
		if (e.button !== 0) return;
		isDraggingScrub = true;
		scrub.setPointerCapture(e.pointerId);
		scrub.classList.add("dragging");
		if (scrubTooltip) scrubTooltip.classList.add("visible");
		handleScrubMove(e.clientX, false);
		sfx.click();
	});

	scrub.addEventListener("pointermove", (e) => {
		const rect = scrub.getBoundingClientRect();
		if (rect.width <= 0) return;
		const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
		const dur = engine.duration;
		const targetSec = dur > 0 ? ratio * dur : 0;
		const pct = ratio * 100;

		if (scrubTooltip) {
			scrubTooltip.textContent = `${formatTime(targetSec)}${dur > 0 ? ` / ${formatTime(dur)}` : ""}`;
			scrubTooltip.style.left = `${pct}%`;
		}
		if (isDraggingScrub) {
			handleScrubMove(e.clientX, false);
		}
	});

	scrub.addEventListener("pointerup", (e) => {
		if (!isDraggingScrub) return;
		isDraggingScrub = false;
		try { scrub.releasePointerCapture(e.pointerId); } catch {}
		scrub.classList.remove("dragging");
		if (scrubTooltip) scrubTooltip.classList.remove("visible");
		handleScrubMove(e.clientX, true);
	});

	scrub.addEventListener("pointercancel", (e) => {
		if (!isDraggingScrub) return;
		isDraggingScrub = false;
		try { scrub.releasePointerCapture(e.pointerId); } catch {}
		scrub.classList.remove("dragging");
		if (scrubTooltip) scrubTooltip.classList.remove("visible");
	});

	scrub.addEventListener("pointerenter", () => {
		if (scrubTooltip) scrubTooltip.classList.add("visible");
	});

	scrub.addEventListener("pointerleave", () => {
		if (!isDraggingScrub && scrubTooltip) {
			scrubTooltip.classList.remove("visible");
		}
	});

	for (const b of document.querySelectorAll<HTMLButtonElement>(".icon-btn, .pill-btn")) {
		b.addEventListener("mouseenter", () => sfx.hover());
	}

	engine.setVolume(state.settings.volume);
	updateLoopMarkers();
}

function updatePlayButton(isPlaying: boolean) {
	const btn = document.getElementById("btn-play");
	if (btn) {
		btn.innerHTML = isPlaying
			? `<span class="play-btn-inner pause">${icons.pause}</span>`
			: `<span class="play-btn-inner">${icons.play}</span>`;
		btn.setAttribute("title", isPlaying ? "Pause (Space)" : "Play (Space)");
		btn.classList.toggle("is-playing", isPlaying);
	}
}

// Shuffle visuals: plain accent when on, animated rainbow + glow when smart
// shuffle is also on. Tooltip text updates to match so the hover state
// teaches the user which mode is active.
function applyShuffleVisuals() {
	const btn = document.getElementById("btn-shuffle");
	if (!btn) return;
	const on = state.settings.shuffle;
	const smart = on && state.settings.smartShuffle;
	btn.classList.toggle("active", on);
	btn.classList.toggle("smart-active", smart);
	btn.setAttribute(
		"title",
		smart
			? "Smart shuffle — biased toward fresh & under-played tracks"
			: on ? "Shuffle on (random)" : "Shuffle off",
	);
}

function updateNowPlayingArtSpin(spinning: boolean) {
	document.getElementById("np-art")?.classList.toggle("playing", spinning && !usingVideo);
	const stage = document.getElementById("np-cel-stage");
	const disc = document.getElementById("np-vinyl-disc");
	if (stage) {
		stage.classList.toggle("is-playing", spinning && !usingVideo);
		stage.classList.toggle("is-paused", !spinning || usingVideo);
	}
	if (disc) {
		disc.classList.toggle("spinning", spinning && !usingVideo);
	}
}

function updateNowPlayingProgress(cur: number, dur: number) {
	const f = document.getElementById("scrub-fill") as HTMLDivElement | null;
	const handle = document.getElementById("scrub-handle") as HTMLDivElement | null;
	const c = document.getElementById("np-current");
	const d = document.getElementById("np-duration");
	const ratio = dur > 0 ? cur / dur : 0;
	if (!isDraggingScrub) {
		if (f) f.style.width = `${ratio * 100}%`;
		if (handle) handle.style.left = `${ratio * 100}%`;
		if (c) c.textContent = formatTime(cur);
	}
	if (d && dur > 0) d.textContent = formatTime(dur);

	// Ambient waveform glow pulse on scrubber track
	const glow = document.getElementById("scrub-waveform-glow");
	if (glow) {
		glow.style.opacity = engine.paused ? "0.2" : `${0.35 + Math.sin(cur * 3) * 0.15}`;
	}

	if (state.view === "nowplaying") {
		updateKaraokeLyrics(cur);
		updateStageAudioPulse();
	}

	// Sleep timer
	if (state.sleepTimerEndsAt > 0 && Date.now() >= state.sleepTimerEndsAt) {
		state.sleepTimerEndsAt = 0;
		state.settings.sleepTimer = 0;
		engine.fadeOut(3000, () => {
			toast("Sleep timer — paused playback", { ttl: 4000 });
		});
		saveSettings();
	}
}

function updateLoopMarkers() {
	const f = document.getElementById("scrub-lo-a");
	const g = document.getElementById("scrub-lo-b");
	const range = document.getElementById("scrub-loop-range");
	const btnAbloop = document.getElementById("btn-abloop");
	const dur = engine.duration;

	if (!state.abLoop || dur <= 0) {
		if (f) f.style.display = "none";
		if (g) g.style.display = "none";
		if (range) range.style.display = "none";
		btnAbloop?.classList.remove("active");
		return;
	}

	btnAbloop?.classList.add("active");
	const aPct = Math.max(0, Math.min(100, (state.abLoop.a / dur) * 100));
	if (f) {
		f.style.display = "flex";
		f.style.left = `${aPct}%`;
	}

	if (state.abLoop.b < dur) {
		const bPct = Math.max(0, Math.min(100, (state.abLoop.b / dur) * 100));
		if (g) {
			g.style.display = "flex";
			g.style.left = `${bPct}%`;
		}
		if (range) {
			range.style.display = "block";
			range.style.left = `${aPct}%`;
			range.style.width = `${Math.max(0, bPct - aPct)}%`;
		}
	} else {
		if (g) g.style.display = "none";
		if (range) {
			range.style.display = "block";
			range.style.left = `${aPct}%`;
			range.style.width = `${100 - aPct}%`;
		}
	}
}

function formatTime(s: number) {
	if (!Number.isFinite(s)) return "0:00";
	const m = Math.floor(s / 60);
	const sec = Math.floor(s % 60);
	return `${m}:${sec.toString().padStart(2, "0")}`;
}

function renderStars(id: string, rating: number, interactive = false): string {
	let html = `<span class="stars" data-tid="${escapeHtml(id)}">`;
	for (let i = 1; i <= 5; i++) {
		const filled = i <= rating;
		html += `<span class="star${filled ? " filled" : ""}" data-sv="${i}">${filled ? "★" : "☆"}</span>`;
	}
	html += "</span>";
	return html;
}

function wireStarClicks() {
	for (const star of document.querySelectorAll<HTMLSpanElement>(".star")) {
		if (star.dataset.wired) continue;
		star.dataset.wired = "1";
		star.addEventListener("click", (e) => {
			e.stopPropagation();
			const v = parseInt((e.target as HTMLElement).dataset.sv!, 10);
			const id = ((e.target as HTMLElement).closest(".stars") as HTMLElement)?.dataset.tid;
			if (!id || isNaN(v)) return;
			state.ratings[id] = v;
			saveRatings();
			sfx.click();
			if (state.view === "nowplaying" || state.view === "library") renderMain();
		});
	}
}

function updateNowPlayingStar() {
	const el = document.getElementById("np-rating");
	if (!el) return;
	const id = state.currentTrack?.id;
	const r = id ? (state.ratings[id] ?? 0) : 0;
	el.innerHTML = renderStars(id ?? "", r, true);
	wireStarClicks();
}

function rateTrack(id: string, rating: number) {
	state.ratings[id] = rating;
	saveRatings();
}

// Update the --fill CSS variable so the slider track shows a colored fill
// up to the thumb position. Also handles rotated EQ sliders correctly.
function syncRangeFill(el: HTMLInputElement) {
	const min = parseFloat(el.min || "0");
	const max = parseFloat(el.max || "100");
	const val = parseFloat(el.value);
	const pct = max === min ? 0 : ((val - min) / (max - min)) * 100;
	el.style.setProperty("--fill", `${pct}%`);
}

function wireRange(el: HTMLInputElement, onChange?: (v: number) => void) {
	syncRangeFill(el);
	el.addEventListener("input", () => {
		syncRangeFill(el);
		onChange?.(parseFloat(el.value));
	});
}

// ---------- Playback control ----------
function playFromList(list: TrackInfo[], idx: number) {
	state.queue = [...list];
	state.queueIndex = idx;
	playCurrent();
}

async function playCurrent() {
	const track = state.queue[state.queueIndex];
	if (!track) return;

	// Any in-flight crossfade is overridden by an explicit play.
	if (crossfading) cancelCrossfade();

	state.currentTrack = track;
	usingVideo = track.kind === "video";

	// Pick the engine for this track's kind. For audio we keep using whichever
	// audio engine is already primary (engineA or engineB) so we don't waste
	// the "fresh" engine — the other one stays available for the next crossfade.
	const target: AudioEngine = usingVideo
		? videoEngine
		: engine === videoEngine
			? engineA
			: engine;

	if (target !== engine) {
		engine.pause();
		engine.clearListeners();
		engine = target;
		attachEngineHandlers();
	}

	engine.setVolume(state.settings.volume);
	engine.setEq(state.settings.eq);
	applyPlaybackRate();
	applySpatialAudio();
	engine.setPreAmp(state.settings.preAmp);

	// ReplayGain
	if (state.settings.replayGain !== "off") {
		const rg = state.settings.replayGain === "track"
			? track.replayGainTrack
			: track.replayGainAlbum;
		if (typeof rg === "number" && Number.isFinite(rg)) {
			engine.setPreAmp(state.settings.preAmp + rg);
		}
	}

	if (immersiveActive) refreshImmersiveInfo();

	// Stats
	state.playStats[track.id] = (state.playStats[track.id] ?? 0) + 1;
	saveStats();

	// Recently played — keep most recent 50 tracks, deduplicated.
	state.recentlyPlayed = [track.id, ...state.recentlyPlayed.filter((id) => id !== track.id)].slice(0, 50);
	saveRecentlyPlayed();

	await engine.loadAndPlay(track);

	// Aggressive AudioContext resume: when the window is minimized Chromium
	// can suspend the context between tracks. loadAndPlay() already tries
	// ctx.resume(), but the user-gesture policy may reject it. This retry
	// loop with a slight delay gives the context a second (and third) chance
	// to wake up — without it, the next track loads silently and the pause
	// button flips to "play" even though nothing is audible.
	if ((sharedAudioCtx.state as string) !== "running") {
		for (let attempt = 0; attempt < 3; attempt++) {
			try { await sharedAudioCtx.resume(); } catch {}
			if ((sharedAudioCtx.state as string) === "running") break;
			await new Promise((r) => setTimeout(r, 100));
		}
	}
	// Resume from a saved bookmark if there is one.
	const bm = state.bookmarks[track.id];
	if (bm && shouldBookmark(track) && bm < (engine.duration || track.duration) - 5) {
		engine.seek(bm);
		toast(`Resumed at ${formatTime(bm)}`, { ttl: 2200, key: "bm" });
	}
	updateNowPlayingBar();
	updateAccentFromArt(track.artDataUrl);
	updateMediaSession();
	// Always jump to Now Playing when starting a video — otherwise it's
	// invisible and confusing.
	if (usingVideo && state.view !== "nowplaying") {
		navigate("nowplaying");
	} else if (state.view === "nowplaying" || state.view === "library") {
		renderMain();
	}
	if (state.view === "library") highlightPlayingRow();
	schedulePresenceUpdate();

	// Now Playing toast notification
	if (state.settings.showTrackNotifications && !usingVideo) {
		bun().notify({ title: `Now Playing: ${track.title}`, body: `${track.artist} — ${track.album}` }).catch(() => {});
	}

	// Track play-date recording
	if (!state.playDates[track.id]) state.playDates[track.id] = [];
	state.playDates[track.id].push(Date.now());
	// Keep last 200 timestamps per track
	if (state.playDates[track.id].length > 200) state.playDates[track.id] = state.playDates[track.id].slice(-200);
	savePlayDates();
}

function onTrackEnded() {
	if (state.settings.repeat === "one") {
		engine.seek(0);
		engine.play();
		return;
	}
	next(true);
}

function next(auto = false) {
	if (state.queue.length === 0) return;
	if (crossfading) cancelCrossfade();
	maybeRememberPosition();
	if (state.settings.shuffle) {
		state.queueIndex = state.settings.smartShuffle
			? smartShuffleIndex()
			: Math.floor(Math.random() * state.queue.length);
	} else {
		state.queueIndex++;
		if (state.queueIndex >= state.queue.length) {
			if (state.settings.repeat === "all") {
				state.queueIndex = 0;
			} else if (auto && state.library.length > 0) {
				// Queue ended naturally — pull a fresh track from the library
				// so music doesn't stop. Avoid the track that just played if we
				// can, and prefer ones we haven't heard recently.
				const lastId = state.currentTrack?.id;
				const fresh = state.library.filter((t) => state.queue.findIndex((q) => q.id === t.id) === -1);
				let pick: TrackInfo | undefined;
				if (fresh.length > 0) {
					// 70% of the time pick something with low play count;
					// 30% of the time pick completely at random.
					if (Math.random() < 0.7) {
						const sorted = [...fresh].sort((a, b) => (state.playStats[a.id] ?? 0) - (state.playStats[b.id] ?? 0));
						const pool = sorted.slice(0, Math.max(5, Math.ceil(sorted.length * 0.15)));
						pick = pool[Math.floor(Math.random() * pool.length)];
					} else {
						pick = fresh[Math.floor(Math.random() * fresh.length)];
					}
				}
				// If we couldn't find a track not already in the queue (tiny
				// library), just pick any track that's not the current one.
				if (!pick) {
					const candidates = state.library.filter((t) => t.id !== lastId);
					pick = candidates.length > 0 ? candidates[Math.floor(Math.random() * candidates.length)] : state.library[0];
				}
				if (pick) {
					state.queue.push(pick);
					state.queueIndex = state.queue.length - 1;
					toast("Auto-continue: queue refilled", { ttl: 2000 });
				} else {
					engine.pause();
					return;
				}
			} else if (auto) {
				state.queueIndex = state.queue.length - 1;
				engine.pause();
				return;
			} else {
				state.queueIndex = 0;
			}
		}
	}
	playCurrent();
}

function previous() {
	if (state.queue.length === 0) return;
	if (crossfading) cancelCrossfade();
	maybeRememberPosition();
	if (engine.currentTime > 3) {
		engine.seek(0);
		return;
	}
	state.queueIndex = Math.max(0, state.queueIndex - 1);
	playCurrent();
}

// Weighted shuffle: rarely-played and recently-added tracks rise, while the
// top-5% most-played sink so you don't always hear the same set. Falls back
// to plain random in edge cases.
function smartShuffleIndex(): number {
	const n = state.queue.length;
	if (n <= 1) return state.queueIndex;
	const plays = state.queue.map((t) => state.playStats[t.id] ?? 0);
	const maxPlays = Math.max(1, ...plays);
	const weights: number[] = [];
	let total = 0;
	for (let i = 0; i < n; i++) {
		if (i === state.queueIndex) {
			weights.push(0); // never pick the current track
			continue;
		}
		// Lower play count → higher weight. Recently added tracks (lower
		// index in the original library order) get a small bump too.
		const playWeight = 1 - (plays[i] / maxPlays) * 0.85;
		const recencyBoost = 1 + (1 - i / n) * 0.2;
		const w = Math.max(0.05, playWeight * recencyBoost);
		weights.push(w);
		total += w;
	}
	if (total <= 0) return Math.floor(Math.random() * n);
	let r = Math.random() * total;
	for (let i = 0; i < n; i++) {
		r -= weights[i];
		if (r <= 0) return i;
	}
	return n - 1;
}

function updateNowPlayingBar() {
	const t = state.currentTrack;
	const titleEl = document.getElementById("np-title");
	const artistEl = document.getElementById("np-artist");
	const artEl = document.getElementById("np-art");
	if (titleEl) titleEl.textContent = t?.title ?? "Nothing playing";
	if (artistEl) artistEl.textContent = t ? `${t.artist} — ${t.album}` : "—";
	if (artEl) {
		artEl.innerHTML = t?.artDataUrl
			? `<img src="${t.artDataUrl}" alt="" />`
			: `<div style="display:flex;align-items:center;justify-content:center;height:100%;opacity:.5">${icons.musicNote}</div>`;
	}
}

function highlightPlayingRow() {
	for (const r of document.querySelectorAll<HTMLDivElement>(".track-row")) {
		r.classList.toggle("is-playing", r.dataset.id === state.currentTrack?.id);
	}
}

// Theme presets — each maps to a fallback accent color and a backdrop tint.
const THEMES: Record<Settings["theme"], { accent: string; bg: string }> = {
	midnight:        { accent: "#a78bfa", bg: "rgba(167, 139, 250, 0.18)" },
	aurora:          { accent: "#22d3ee", bg: "rgba(34, 211, 238, 0.18)" },
	solar:           { accent: "#fb923c", bg: "rgba(251, 146, 60, 0.18)" },
	rose:            { accent: "#f472b6", bg: "rgba(244, 114, 182, 0.18)" },
	sakura_sunset:   { accent: "#f08092", bg: "rgba(240, 128, 146, 0.18)" },
	cyber_neotokyo:  { accent: "#00ffff", bg: "rgba(0, 255, 255, 0.18)" },
	ghibli_emerald:  { accent: "#4ade80", bg: "rgba(74, 222, 128, 0.18)" },
	ocean_shinkai:   { accent: "#00d2ff", bg: "rgba(0, 210, 255, 0.18)" },
	midnight_shogun: { accent: "#eab308", bg: "rgba(234, 179, 8, 0.18)" },
};

function applyTheme() {
	const theme = THEMES[state.settings.theme] ?? THEMES.midnight;
	document.documentElement.style.setProperty("--theme-accent", theme.accent);
	document.documentElement.dataset.theme = state.settings.theme;
	// If match-accent is off, the theme's backdrop is locked in. Otherwise the
	// album-art extractor overrides it on every track change.
	if (!state.settings.matchAccent) {
		document.documentElement.style.setProperty("--accent", theme.bg);
	}
}

// ---------- Accent color extraction ----------
function updateAccentFromArt(artDataUrl?: string) {
	if (!state.settings.matchAccent) {
		applyTheme();
		return;
	}
	if (!artDataUrl) {
		applyAccent(state.settings.accent);
		return;
	}
	const img = new Image();
	img.crossOrigin = "anonymous";
	img.onload = () => {
		try {
			const canvas = document.createElement("canvas");
			canvas.width = 32;
			canvas.height = 32;
			const ctx = canvas.getContext("2d")!;
			ctx.drawImage(img, 0, 0, 32, 32);
			const data = ctx.getImageData(0, 0, 32, 32).data;
			let r = 0, g = 0, b = 0, n = 0;
			for (let i = 0; i < data.length; i += 4) {
				const rr = data[i], gg = data[i + 1], bb = data[i + 2];
				const max = Math.max(rr, gg, bb);
				const min = Math.min(rr, gg, bb);
				const sat = max === 0 ? 0 : (max - min) / max;
				const lum = (rr + gg + bb) / 3;
				if (sat < 0.18 || lum < 30 || lum > 230) continue;
				r += rr; g += gg; b += bb; n++;
			}
			if (n === 0) {
				applyAccent(state.settings.accent);
				return;
			}
			r = Math.round(r / n);
			g = Math.round(g / n);
			b = Math.round(b / n);
			applyAccentRgb(r, g, b);
		} catch {
			applyAccent(state.settings.accent);
		}
	};
	img.src = artDataUrl;
}

function applyAccent(hex: string) {
	const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
	if (!m) return;
	applyAccentRgb(parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16));
}

function applyAccentRgb(r: number, g: number, b: number) {
	document.documentElement.style.setProperty(
		"--accent",
		`rgba(${r}, ${g}, ${b}, 0.22)`,
	);
	if (visualizer) visualizer.setAccent([r, g, b]);
}

// ---------- Discord presence ----------
// Discord rate-limits aggressively (5 updates per 20 s per client), so we
// throttle: at most one push every 5 s, with state-change events deferred
// onto the next tick of that interval.
const PRESENCE_MIN_INTERVAL_MS = 5000;
let presenceTimer: ReturnType<typeof setTimeout> | null = null;
let lastPresencePushAt = 0;
let presencePending = false;

function schedulePresenceUpdate() {
	presencePending = true;
	const now = Date.now();
	const elapsed = now - lastPresencePushAt;
	if (elapsed >= PRESENCE_MIN_INTERVAL_MS) {
		// Coalesce: fire on the next microtask so a flurry of state changes
		// (play, art-update, presence text) merge into one push.
		if (presenceTimer) clearTimeout(presenceTimer);
		presenceTimer = setTimeout(flushPresence, 0);
	} else {
		// Inside the throttle window — schedule for the remaining time.
		if (presenceTimer) clearTimeout(presenceTimer);
		presenceTimer = setTimeout(flushPresence, PRESENCE_MIN_INTERVAL_MS - elapsed);
	}
}

async function flushPresence() {
	if (!presencePending) return;
	presencePending = false;
	lastPresencePushAt = Date.now();
	await updatePresenceImmediate();
}

async function updatePresenceImmediate() {
	if (!state.settings.discord) {
		try { await bun().setDiscordPresence({ presence: null }); } catch {}
		return;
	}
	if (!state.currentTrack) {
		try { await bun().setDiscordPresence({ presence: null }); } catch {}
		return;
	}
	const t = state.currentTrack;
	const paused = engine.paused;
	// Discord's CDN can't fetch local files or 127.0.0.1 URLs, so per-track
	// album art needs a public HTTPS URL. The main process resolves one via
	// iTunes Search and persists the result forever — so each album is only
	// ever looked up once and subsequent plays are zero-network.
	const is8D = state.nodeGraph ? true : false;
	const detailsPrefix = is8D ? "🎧 " : "🌸 ";
	const presence: DiscordPresence = {
		details: `${detailsPrefix}${t.title}`.slice(0, 120),
		state: (paused ? `⏸ Paused • ${t.artist}` : `${t.artist}${t.album ? ` — ${t.album}` : ""}`).slice(0, 120),
		largeImageKey: "lak_logo",
		largeImageText: `${t.album || t.title} • Lakky Player v1.3.0`,
		smallImageKey: paused ? "pause" : "play",
		smallImageText: paused ? "⏸ Paused" : "▶ Playing on Lakky",
		artist: t.artist,
		album: t.album,
		buttons: [
			{ label: "🌸 Get Lakky Player", url: "https://github.com/Laknicek/lakky" },
			{ label: "✨ Download Releases", url: "https://github.com/Laknicek/lakky/releases" },
		],
	};
	if (!paused && engine.duration > 0) {
		const elapsed = engine.currentTime;
		presence.startTimestamp = Math.floor((Date.now() - elapsed * 1000) / 1000);
		presence.endTimestamp = Math.floor((Date.now() + (engine.duration - elapsed) * 1000) / 1000);
	}
	try {
		await bun().setDiscordPresence({ presence });
	} catch (e) { console.warn("[discord] setDiscordPresence failed:", (e as Error).message); }
}

// ---------- Main view renderers ----------
function renderMain() {
	// Pull the video element out of the DOM region we're about to wipe so the
	// upcoming innerHTML assignment doesn't take it down with it.
	parkVideoEl();
	closeCtxMenu();
	if (state.view !== "nowplaying") {
		if (visualizer) {
			visualizer.destroy();
			visualizer = null;
		}
		cinemaEngine.unmount();
	}
	const main = document.getElementById("main")!;
	switch (state.view) {
		case "home": renderHome(main); break;
		case "library": renderLibrary(main); break;
		case "nowplaying": renderNowPlaying(main); break;
		case "equalizer": renderEqualizer(main); break;
		case "playlists": renderPlaylists(main); break;
		case "stats": renderStats(main); break;
		case "nodes":
			renderNodeEditor(main, state.nodeGraph ?? newGraph(), (g) => {
				applyNodeGraph(g);
			});
			break;
		case "settings": renderSettings(main); break;
	}
	// If the view rendered a video mount point, hand the element over to it.
	const mount = document.getElementById("video-mount");
	if (mount) mountVideoIn(mount);
}

function renderHome(root: HTMLElement) {
	const hasLib = state.library.length > 0;
	const topTracks = Object.entries(state.playStats)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 8)
		.map(([id]) => state.library.find((t) => t.id === id))
		.filter((t): t is TrackInfo => !!t);

	const recent = state.library.slice(0, 12);

	const recentlyPlayed = state.recentlyPlayed
		.slice(0, 8)
		.map((id) => state.library.find((t) => t.id === id))
		.filter((t): t is TrackInfo => !!t);

	root.innerHTML = `
		<div class="topbar">
			<h2>Home</h2>
			<div class="topbar-actions">
				<div class="search-wrap">
					${icons.search}
					<input class="search" id="search-input" placeholder="Search your library…" value="${escapeHtml(state.searchQuery)}" />
				</div>
				<button class="btn" id="btn-add-files">${icons.plus}<span>Add files</span></button>
				<button class="btn btn-primary" id="btn-add-folder">${icons.folder}<span>Add folder</span></button>
				<select class="select" id="lib-sort" style="min-width:90px;flex-shrink:0">
					${(["title","artist","album","duration","year"] as const).map((k) => `<option value="${k}" ${state.librarySort === k ? "selected" : ""}>${k[0].toUpperCase() + k.slice(1)}</option>`).join("")}
				</select>
			</div>
		</div>
		<section class="hero">
			<h1>Welcome to Lakky</h1>
			<p>A fast, modern media player that plays just about any audio or video file you throw at it — with rich VFX, an immersive visualizer, a 10-band equalizer, Discord rich presence, and a stack of features inspired by the most-loved Spotify mods.</p>
			<div class="hero-cta">
				<button class="btn btn-primary" id="hero-add-folder">${icons.folder}<span>Choose a music folder</span></button>
				<button class="btn" id="hero-add-files">${icons.plus}<span>Pick individual files</span></button>
				${hasLib ? `<button class="btn btn-ghost" id="hero-shuffle">${icons.shuffle}<span>Shuffle all</span></button>` : ""}
			</div>
		</section>

		${topTracks.length > 0 ? `
			<div class="section-title"><span>Most played</span></div>
			<div class="grid">
				${topTracks.map((t) => trackCard(t)).join("")}
			</div>
		` : ""}

		${recentlyPlayed.length > 0 ? `
			<div class="section-title"><span>Recently played</span></div>
			<div class="grid">
				${recentlyPlayed.map((t) => trackCard(t)).join("")}
			</div>
		` : ""}

		${recent.length > 0 ? `
			<div class="section-title"><span>Recently added</span></div>
			<div class="grid">
				${recent.map((t) => trackCard(t)).join("")}
			</div>
		` : `
			<div class="empty">
				${icons.musicNote}
				<p>Your library is empty. Add a folder or some files to get started.</p>
			</div>
		`}
	`;

	document.getElementById("btn-add-folder")?.addEventListener("click", addFolder);
	document.getElementById("btn-add-files")?.addEventListener("click", addFiles);
	document.getElementById("lib-sort")?.addEventListener("change", (e) => {
		state.librarySort = (e.target as HTMLSelectElement).value as typeof state.librarySort;
		renderMain();
	});
	document.getElementById("hero-add-folder")?.addEventListener("click", addFolder);
	document.getElementById("hero-add-files")?.addEventListener("click", addFiles);
	document.getElementById("hero-shuffle")?.addEventListener("click", () => {
		state.settings.shuffle = true;
		playFromList(state.library, Math.floor(Math.random() * state.library.length));
		sfx.success();
	});
	wireCards();
	wireSearch();
}

// ---------- Track Codec, Metadata & Filter Helpers ----------
function getCodecInfo(t: TrackInfo): { label: string; isHiRes: boolean; html: string } {
	const ext = t.path ? t.path.split(".").pop()?.toUpperCase() ?? "" : "";
	const format = (t.verifiedFormat || ext || (t.kind === "video" ? "VIDEO" : "AUDIO")).toUpperCase();
	const sampleKhz = t.sampleRate ? Math.round(t.sampleRate / 1000) : 0;
	const kbps = t.bitrate ? Math.round(t.bitrate / 1000) : 0;
	const isHiRes = ["FLAC", "ALAC", "WAV", "DSD"].includes(format) || sampleKhz >= 48 || kbps >= 800;

	let label = format;
	if (sampleKhz >= 48) label += ` ${sampleKhz}k`;
	else if (kbps > 0) label += ` ${kbps}k`;

	let html = "";
	if (isHiRes) {
		html = `<span class="badge-codec hires" title="Hi-Res Lossless Audio (${sampleKhz ? `${sampleKhz}kHz ` : ""}${kbps ? `${kbps}kbps` : ""})"><span class="hires-dot"></span>HI-RES</span> <span class="badge-codec flac">${escapeHtml(format)}</span>`;
	} else if (t.kind === "video") {
		html = `<span class="badge-codec video" title="Video Media">${icons.video} <span>${escapeHtml(format)}</span></span>`;
	} else {
		html = `<span class="badge-codec lossy" title="${sampleKhz ? `${sampleKhz}kHz ` : ""}${kbps ? `${kbps}kbps` : ""}">${escapeHtml(format)}${kbps ? ` ${kbps}k` : ""}</span>`;
	}

	return { label, isHiRes, html };
}

function isHiResLossless(t: TrackInfo): boolean {
	const ext = t.path ? t.path.split(".").pop()?.toUpperCase() ?? "" : "";
	const format = (t.verifiedFormat || ext || "").toUpperCase();
	const sampleKhz = t.sampleRate ? Math.round(t.sampleRate / 1000) : 0;
	const kbps = t.bitrate ? Math.round(t.bitrate / 1000) : 0;
	return ["FLAC", "ALAC", "WAV", "DSD"].includes(format) || sampleKhz >= 48 || kbps >= 800;
}

function isAnimeTrack(t: TrackInfo): boolean {
	const text = `${t.title} ${t.artist} ${t.album} ${t.genre ?? ""} ${t.path}`.toLowerCase();
	const animeKeywords = [
		"anime", "ost", "soundtrack", "japanese", "j-pop", "jpop", "vocaloid", "touhou",
		"yoasobi", "lisa", "radwimps", "ado", "eve", "aimer", "sawano", "ghibli",
		"monogatari", "k-on", "naruto", "bleach", "evangelion", "suzume", "your name",
		"op", "ed", "theme", "bgm", "miku", "chihara", "myth & roid", "re:zero", "chainsaw",
		"jujutsu", "frieren", "bocchi", "oshi no ko", "attack on titan", "shingeki"
	];
	const hasJapaneseChars = /[\u3000-\u303f\u3040-\u309f\u30a0-\u30ff\uff00-\uff9f\u4e00-\u9faf\u3400-\u4dbf]/.test(text);
	return hasJapaneseChars || animeKeywords.some((k) => text.includes(k));
}

function isFavoriteTrack(t: TrackInfo): boolean {
	return (state.ratings[t.id] ?? 0) >= 4;
}

function isRecentlyAdded(t: TrackInfo): boolean {
	const idx = state.library.findIndex((x) => x.id === t.id);
	return idx >= 0 && idx >= state.library.length - 30;
}

function formatDurationSum(tracks: TrackInfo[]): string {
	const totalSec = tracks.reduce((acc, t) => acc + (t.duration ?? 0), 0);
	const hrs = Math.floor(totalSec / 3600);
	const mins = Math.floor((totalSec % 3600) / 60);
	if (hrs > 0) return `${hrs}h ${mins}m`;
	return `${mins} min`;
}

function getInitials(name: string): string {
	return name.split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "♪";
}

// ---------- Cel-Shaded Track List Table ----------
function trackRow(t: TrackInfo, i: number, opts?: { hideAlbumColumn?: boolean; playlistContext?: string }) {
	const isPlaying = state.currentTrack?.id === t.id;
	const isSelected = state.selectedIds.has(t.id);
	const isVideo = t.kind === "video";
	const isFav = isFavoriteTrack(t);
	const plays = state.playStats[t.id] ?? 0;
	const codec = getCodecInfo(t);
	
	const isThreat = (t.securityThreats && t.securityThreats.length > 0) || (t.securityScore !== undefined && t.securityScore < 80);
	const secScore = t.securityScore ?? 100;
	const secBadge = isThreat
		? `<span class="badge-security threat" title="Security alert: Threat signature detected (${secScore}/100)">${icons.shieldAlert} Alert</span>`
		: `<span class="badge-security safe" title="Verified clean binary & metadata (${secScore}/100)">${icons.shieldCheck} Safe</span>`;

	const playsBadge = plays > 15
		? `<span class="badge-plays hot" title="${plays} plays">${icons.flame} ${plays}</span>`
		: plays > 0
			? `<span class="badge-plays" title="${plays} plays">${plays}</span>`
			: `<span class="badge-plays dim">—</span>`;

	return `
		<div class="cel-track-row track-row ${isPlaying ? "is-playing" : ""} ${isSelected ? "is-selected" : ""}" data-id="${t.id}" ${opts?.playlistContext ? `data-pl-ctx="${escapeHtml(opts.playlistContext)}"` : ""}>
			<div class="col-check" onclick="event.stopPropagation()">
				<input type="checkbox" class="row-checkbox" ${isSelected ? "checked" : ""} data-id="${t.id}" />
			</div>
			<div class="col-num">
				${isPlaying && !engine.paused ? `
					<div class="eq-bars-anim" title="Playing">
						<span></span><span></span><span></span>
					</div>
				` : `
					<span class="row-num-text">${i + 1}</span>
					<button class="row-play-btn" title="Play ${escapeHtml(t.title)}">${icons.play}</button>
				`}
			</div>
			<div class="col-title">
				<div class="row-art-thumb">
					${t.artDataUrl ? `<img src="${t.artDataUrl}" alt="" loading="lazy" />` : `<div class="row-art-placeholder">${isVideo ? icons.video : icons.musicNote}</div>`}
				</div>
				<div class="row-title-meta">
					<div class="row-title-text" title="${escapeHtml(t.title)}">
						${isVideo ? `<span class="kind-badge inline">VIDEO</span> ` : ""}
						${escapeHtml(t.title)}
					</div>
					<div class="row-artist-sub" title="${escapeHtml(t.artist)}">${escapeHtml(t.artist)}</div>
				</div>
			</div>
			<div class="col-artist" title="${escapeHtml(t.artist)}">
				<span class="artist-link" data-artist="${escapeHtml(t.artist)}">${escapeHtml(t.artist)}</span>
			</div>
			${opts?.hideAlbumColumn ? "" : `
				<div class="col-album" title="${escapeHtml(t.album)}">
					<span class="album-link" data-album="${escapeHtml(t.album)}">${escapeHtml(t.album)}</span>
				</div>
			`}
			<div class="col-duration">${formatTime(t.duration)}</div>
			<div class="col-codec">${codec.html}</div>
			<div class="col-safety">${secBadge}</div>
			<div class="col-plays">${playsBadge}</div>
			<div class="col-actions" onclick="event.stopPropagation()">
				<button class="row-fav-btn ${isFav ? "active" : ""}" data-fav-id="${t.id}" title="${isFav ? "Favorited" : "Add to favorites"}">
					${isFav ? icons.heartFill : icons.heart}
				</button>
				${opts?.playlistContext ? `
					<button class="row-remove-pl-btn" data-rem-pl="${escapeHtml(opts.playlistContext)}" data-rem-id="${t.id}" title="Remove from playlist">
						${icons.close}
					</button>
				` : ""}
				<button class="row-more-btn" data-more-id="${t.id}" title="Options">
					${icons.dots}
				</button>
			</div>
		</div>
	`;
}

function renderTrackTable(tracks: TrackInfo[], opts?: { hideAlbumColumn?: boolean; playlistContext?: string }) {
	if (tracks.length === 0) {
		return `
			<div class="empty-table-state">
				<div class="empty-icon">${icons.musicNote}</div>
				<p class="empty-text">No matching tracks in library.</p>
				<button class="btn btn-ghost btn-sm" id="btn-clear-table-filter">Clear search & filters</button>
			</div>
		`;
	}

	const sortArrow = (col: string) => {
		if (state.librarySort !== col) return `<span class="sort-arr dim">${icons.sort}</span>`;
		return state.librarySortAsc
			? `<span class="sort-arr active asc">${icons.sortAsc}</span>`
			: `<span class="sort-arr active desc">${icons.sortDesc}</span>`;
	};

	return `
		<div class="cel-table-wrap">
			<div class="cel-table-header ${opts?.hideAlbumColumn ? "hide-album" : ""}">
				<div class="col-check">
					<input type="checkbox" id="select-all-rows" title="Select all visible tracks" />
				</div>
				<div class="col-num th-sortable" data-sort="index"># ${sortArrow("index")}</div>
				<div class="col-title th-sortable" data-sort="title">Title ${sortArrow("title")}</div>
				<div class="col-artist th-sortable" data-sort="artist">Artist ${sortArrow("artist")}</div>
				${opts?.hideAlbumColumn ? "" : `<div class="col-album th-sortable" data-sort="album">Album ${sortArrow("album")}</div>`}
				<div class="col-duration th-sortable" data-sort="duration">Time ${sortArrow("duration")}</div>
				<div class="col-codec th-sortable" data-sort="codec">Codec ${sortArrow("codec")}</div>
				<div class="col-safety th-sortable" data-sort="safety">Safety ${sortArrow("safety")}</div>
				<div class="col-plays th-sortable" data-sort="plays">Plays ${sortArrow("plays")}</div>
				<div class="col-actions"></div>
			</div>
			<div class="cel-table-body ${opts?.hideAlbumColumn ? "hide-album" : ""}">
				${tracks.map((t, i) => trackRow(t, i, opts)).join("")}
			</div>
		</div>
	`;
}

function wireTrackRows(container: HTMLElement, tracks: TrackInfo[], opts?: { hideAlbumColumn?: boolean; playlistContext?: string }) {
	const allBox = container.querySelector<HTMLInputElement>("#select-all-rows");
	if (allBox) {
		const allSelected = tracks.length > 0 && tracks.every((t) => state.selectedIds.has(t.id));
		allBox.checked = allSelected;
		allBox.addEventListener("change", () => {
			if (allBox.checked) {
				for (const t of tracks) state.selectedIds.add(t.id);
			} else {
				for (const t of tracks) state.selectedIds.delete(t.id);
			}
			updateBulkBar();
			renderMain();
		});
	}

	for (const th of container.querySelectorAll<HTMLElement>(".th-sortable")) {
		th.addEventListener("click", () => {
			const sortKey = th.dataset.sort as typeof state.librarySort;
			if (state.librarySort === sortKey) {
				state.librarySortAsc = !state.librarySortAsc;
			} else {
				state.librarySort = sortKey;
				state.librarySortAsc = true;
			}
			sfx.toggle();
			renderMain();
		});
	}

	for (const row of container.querySelectorAll<HTMLDivElement>(".cel-track-row")) {
		const id = row.dataset.id!;
		const t = tracks.find((x) => x.id === id) || state.library.find((x) => x.id === id);

		row.addEventListener("click", (e) => {
			if (e.shiftKey || e.ctrlKey || e.metaKey) {
				if (state.selectedIds.has(id)) state.selectedIds.delete(id);
				else state.selectedIds.add(id);
				row.classList.toggle("is-selected", state.selectedIds.has(id));
				updateBulkBar();
				return;
			}
			const idx = tracks.findIndex((x) => x.id === id);
			if (idx >= 0) {
				playFromList(tracks, idx);
				sfx.play();
			}
		});

		row.querySelector(".row-checkbox")?.addEventListener("change", (e) => {
			e.stopPropagation();
			const cb = e.target as HTMLInputElement;
			if (cb.checked) state.selectedIds.add(id);
			else state.selectedIds.delete(id);
			row.classList.toggle("is-selected", cb.checked);
			updateBulkBar();
		});

		row.querySelector(".row-fav-btn")?.addEventListener("click", (e) => {
			e.stopPropagation();
			const cur = state.ratings[id] ?? 0;
			const nextVal = cur >= 4 ? 0 : 5;
			state.ratings[id] = nextVal;
			saveRatings();
			sfx.toggle();
			const btn = row.querySelector(".row-fav-btn");
			if (btn) {
				btn.classList.toggle("active", nextVal >= 4);
				btn.innerHTML = nextVal >= 4 ? icons.heartFill : icons.heart;
			}
		});

		row.querySelector(".row-more-btn")?.addEventListener("click", (e) => {
			e.stopPropagation();
			const targetTrack = t || state.library.find((x) => x.id === id);
			if (targetTrack) {
				const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
				showContextMenu(rect.left, rect.bottom + 4, ctxItemsForTrack(targetTrack));
			}
		});

		row.querySelector(".row-remove-pl-btn")?.addEventListener("click", async (e) => {
			e.stopPropagation();
			const plName = (e.currentTarget as HTMLElement).dataset.remPl;
			const pl = state.playlists.find((p) => p.name === plName);
			if (pl) {
				pl.ids = pl.ids.filter((x) => x !== id);
				await savePlaylists();
				sfx.toggle();
				toast(`Removed track from "${pl.name}"`, { ttl: 1800 });
				renderMain();
				renderSidebarPlaylists();
			}
		});

		row.querySelector(".artist-link")?.addEventListener("click", (e) => {
			e.stopPropagation();
			const artist = (e.currentTarget as HTMLElement).dataset.artist;
			if (artist) {
				state.searchQuery = artist;
				state.libraryTab = "tracks";
				sfx.click();
				renderMain();
			}
		});

		row.querySelector(".album-link")?.addEventListener("click", (e) => {
			e.stopPropagation();
			const album = (e.currentTarget as HTMLElement).dataset.album;
			if (album) {
				state.activeAlbumKey = album;
				state.libraryTab = "albums";
				sfx.click();
				renderMain();
			}
		});

		row.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			if (state.selectedIds.has(id) && state.selectedIds.size > 1) {
				showContextMenu(e.clientX, e.clientY, ctxItemsForBulk());
				return;
			}
			const targetTrack = t || state.library.find((x) => x.id === id);
			if (targetTrack) showContextMenu(e.clientX, e.clientY, ctxItemsForTrack(targetTrack));
		});
	}

	container.querySelector("#btn-clear-table-filter")?.addEventListener("click", () => {
		state.searchQuery = "";
		state.libraryFilterTag = "all";
		renderMain();
	});
}

// ---------- Overhauled Library View ----------
function renderLibrary(root: HTMLElement) {
	const q = state.searchQuery.toLowerCase().trim();

	// 1. Filter by Search Query
	let tracks = q
		? state.library.filter((t) =>
			[t.title, t.artist, t.album, t.genre ?? "", t.verifiedFormat ?? ""].some((s) => s.toLowerCase().includes(q)))
		: [...state.library];

	// 2. Filter by Tag Pills
	const allCount = state.library.length;
	const hiresCount = state.library.filter(isHiResLossless).length;
	const animeCount = state.library.filter(isAnimeTrack).length;
	const videoCount = state.library.filter((t) => t.kind === "video").length;
	const favCount = state.library.filter(isFavoriteTrack).length;
	const recentCount = Math.min(30, state.library.length);

	switch (state.libraryFilterTag) {
		case "hires": tracks = tracks.filter(isHiResLossless); break;
		case "anime": tracks = tracks.filter(isAnimeTrack); break;
		case "video": tracks = tracks.filter((t) => t.kind === "video"); break;
		case "favorites": tracks = tracks.filter(isFavoriteTrack); break;
		case "recent": tracks = tracks.filter(isRecentlyAdded); break;
	}

	// 3. Sort tracks
	tracks.sort((a, b) => {
		let res = 0;
		switch (state.librarySort) {
			case "artist":
				res = a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album);
				break;
			case "album":
				res = a.album.localeCompare(b.album) || (a.trackNumber ?? 0) - (b.trackNumber ?? 0);
				break;
			case "duration":
				res = (a.duration ?? 0) - (b.duration ?? 0);
				break;
			case "codec":
				res = getCodecInfo(a).label.localeCompare(getCodecInfo(b).label);
				break;
			case "safety":
				res = (b.securityScore ?? 100) - (a.securityScore ?? 100);
				break;
			case "plays":
				res = (state.playStats[b.id] ?? 0) - (state.playStats[a.id] ?? 0);
				break;
			case "year":
				res = (b.year ?? 0) - (a.year ?? 0) || a.artist.localeCompare(b.artist);
				break;
			case "index":
				res = state.library.indexOf(a) - state.library.indexOf(b);
				break;
			default:
				res = a.title.localeCompare(b.title) || a.artist.localeCompare(b.artist);
				break;
		}
		return state.librarySortAsc ? res : -res;
	});

	// Grouping for tabs
	const uniqueAlbums = Array.from(new Set(state.library.map((t) => `${t.album}///${t.artist}`)));
	const uniqueArtists = Array.from(new Set(state.library.map((t) => t.artist)));

	root.innerHTML = `
		<div class="lib-container">
			<div class="topbar lib-topbar">
				<div class="lib-header-left">
					<h2>Library</h2>
					<div class="lib-subnav-pills">
						<button class="lib-subnav-btn ${state.libraryTab === "tracks" ? "active" : ""}" data-tab="tracks">
							${icons.musicNote}<span>Tracks</span><span class="lib-pill-count">${tracks.length}</span>
						</button>
						<button class="lib-subnav-btn ${state.libraryTab === "albums" ? "active" : ""}" data-tab="albums">
							${icons.disc}<span>Albums</span><span class="lib-pill-count">${uniqueAlbums.length}</span>
						</button>
						<button class="lib-subnav-btn ${state.libraryTab === "artists" ? "active" : ""}" data-tab="artists">
							${icons.artist}<span>Artists</span><span class="lib-pill-count">${uniqueArtists.length}</span>
						</button>
						<button class="lib-subnav-btn ${state.libraryTab === "dropzone" ? "active" : ""}" data-tab="dropzone">
							${icons.download}<span>Import Dropzone</span>
						</button>
					</div>
				</div>
				<div class="topbar-actions">
					<div class="search-wrap cel-search">
						${icons.search}
						<input class="search" id="search-input" placeholder="Instant filter tracks, artists, codecs…" value="${escapeHtml(state.searchQuery)}" />
						${state.searchQuery ? `<button class="search-clear-btn" id="btn-search-clear">${icons.close}</button>` : ""}
					</div>
					<button class="btn" id="btn-add-files">${icons.plus}<span>Add files</span></button>
					<button class="btn btn-primary" id="btn-add-folder">${icons.folder}<span>Add folder</span></button>
					${state.library.length > 0 ? `<button class="btn btn-ghost" id="btn-lib-shuffle" title="Shuffle Library">${icons.shuffle}</button>` : ""}
				</div>
			</div>

			<div class="tag-filter-bar">
				<button class="tag-pill ${state.libraryFilterTag === "all" ? "active" : ""}" data-tag="all">
					<span>✨ All</span><span class="tag-count">${allCount}</span>
				</button>
				<button class="tag-pill ${state.libraryFilterTag === "hires" ? "active" : ""}" data-tag="hires">
					<span class="hires-dot"></span><span>Hi-Res Lossless</span><span class="tag-count">${hiresCount}</span>
				</button>
				<button class="tag-pill ${state.libraryFilterTag === "anime" ? "active" : ""}" data-tag="anime">
					<span>🌸 Anime / OST</span><span class="tag-count">${animeCount}</span>
				</button>
				<button class="tag-pill ${state.libraryFilterTag === "video" ? "active" : ""}" data-tag="video">
					<span>🎬 Video</span><span class="tag-count">${videoCount}</span>
				</button>
				<button class="tag-pill ${state.libraryFilterTag === "favorites" ? "active" : ""}" data-tag="favorites">
					<span>⭐ Favorites</span><span class="tag-count">${favCount}</span>
				</button>
				<button class="tag-pill ${state.libraryFilterTag === "recent" ? "active" : ""}" data-tag="recent">
					<span>⚡ Recently Added</span><span class="tag-count">${recentCount}</span>
				</button>
			</div>

			<div class="lib-tab-content" id="lib-tab-content">
				${state.libraryTab === "tracks" ? renderTrackTable(tracks) : ""}
				${state.libraryTab === "albums" ? `<div id="album-grid-mount"></div>` : ""}
				${state.libraryTab === "artists" ? `<div id="artist-grid-mount"></div>` : ""}
				${state.libraryTab === "dropzone" ? `<div id="dropzone-mount"></div>` : ""}
			</div>
		</div>
	`;

	// Wire Subnav Tab Buttons
	for (const btn of root.querySelectorAll<HTMLButtonElement>(".lib-subnav-btn")) {
		btn.addEventListener("click", () => {
			state.libraryTab = btn.dataset.tab as typeof state.libraryTab;
			sfx.click();
			renderMain();
		});
	}

	// Wire Tag Filter Pills
	for (const pill of root.querySelectorAll<HTMLButtonElement>(".tag-pill")) {
		pill.addEventListener("click", () => {
			state.libraryFilterTag = pill.dataset.tag as typeof state.libraryFilterTag;
			sfx.toggle();
			renderMain();
		});
	}

	// Wire Actions & Search
	document.getElementById("btn-add-folder")?.addEventListener("click", addFolder);
	document.getElementById("btn-add-files")?.addEventListener("click", addFiles);
	document.getElementById("btn-lib-shuffle")?.addEventListener("click", () => {
		if (state.library.length === 0) return;
		state.settings.shuffle = true;
		playFromList(state.library, Math.floor(Math.random() * state.library.length));
		sfx.success();
	});
	document.getElementById("btn-search-clear")?.addEventListener("click", () => {
		state.searchQuery = "";
		renderMain();
	});

	// Mount Tab specific views
	if (state.libraryTab === "tracks") {
		wireTrackRows(root, tracks);
	} else if (state.libraryTab === "albums") {
		const mount = document.getElementById("album-grid-mount");
		if (mount) renderAlbumGrid(mount, tracks);
	} else if (state.libraryTab === "artists") {
		const mount = document.getElementById("artist-grid-mount");
		if (mount) renderArtistGrid(mount, tracks);
	} else if (state.libraryTab === "dropzone") {
		const mount = document.getElementById("dropzone-mount");
		if (mount) renderMediaDropzone(mount);
	}

	updateBulkBar();
	highlightPlayingRow();
	wireSearch();
}

// ---------- Album Grid & Discography Accordion ----------
function renderAlbumGrid(container: HTMLElement, tracks: TrackInfo[]) {
	// Group tracks by album
	const albumMap = new Map<string, { album: string; artist: string; tracks: TrackInfo[]; cover?: string; year?: number; hasHiRes: boolean }>();

	for (const t of tracks) {
		const key = `${t.album}///${t.artist}`;
		if (!albumMap.has(key)) {
			albumMap.set(key, {
				album: t.album,
				artist: t.artist,
				tracks: [],
				cover: t.artDataUrl,
				year: t.year,
				hasHiRes: isHiResLossless(t),
			});
		}
		const group = albumMap.get(key)!;
		group.tracks.push(t);
		if (!group.cover && t.artDataUrl) group.cover = t.artDataUrl;
		if (isHiResLossless(t)) group.hasHiRes = true;
	}

	const albums = Array.from(albumMap.values()).sort((a, b) => a.album.localeCompare(b.album));

	if (albums.length === 0) {
		container.innerHTML = `
			<div class="empty-table-state">
				<div class="empty-icon">${icons.disc}</div>
				<p class="empty-text">No albums found matching criteria.</p>
			</div>
		`;
		return;
	}

	container.innerHTML = `
		<div class="albums-view-wrap">
			${state.activeAlbumKey && albumMap.has(state.activeAlbumKey) ? `
				<div class="discography-drawer-wrap" id="album-drawer">
					${renderAlbumDrawer(albumMap.get(state.activeAlbumKey)!)}
				</div>
			` : ""}

			<div class="cel-album-grid">
				${albums.map((alb) => {
					const albKey = `${alb.album}///${alb.artist}`;
					const isActive = state.activeAlbumKey === albKey;
					return `
						<div class="album-cel-card ${isActive ? "active" : ""}" data-alb-key="${escapeHtml(albKey)}">
							<div class="album-art-stage">
								${alb.cover ? `
									<img src="${alb.cover}" alt="${escapeHtml(alb.album)}" class="album-cover-img" loading="lazy" />
								` : `
									<div class="album-cover-fallback">
										<div class="vinyl-record"><div class="vinyl-grooves"></div><div class="vinyl-label">${icons.disc}</div></div>
									</div>
								`}
								<div class="album-glass-shine"></div>
								${alb.hasHiRes ? `<span class="album-hires-badge">HI-RES</span>` : ""}
								<div class="album-hover-overlay">
									<button class="album-hover-play-btn" title="Play Album">${icons.play}</button>
									<button class="album-hover-shuffle-btn" title="Shuffle Album">${icons.shuffle}</button>
								</div>
							</div>
							<div class="album-card-info">
								<h4 class="album-card-title" title="${escapeHtml(alb.album)}">${escapeHtml(alb.album)}</h4>
								<p class="album-card-artist" title="${escapeHtml(alb.artist)}">${escapeHtml(alb.artist)}</p>
								<div class="album-card-meta">
									<span>${alb.tracks.length} track${alb.tracks.length === 1 ? "" : "s"}</span>
									<span>•</span>
									<span>${formatDurationSum(alb.tracks)}</span>
									${alb.year ? `<span>•</span><span>${alb.year}</span>` : ""}
								</div>
							</div>
						</div>
					`;
				}).join("")}
			</div>
		</div>
	`;

	// Wire Drawer events if mounted
	if (state.activeAlbumKey && albumMap.has(state.activeAlbumKey)) {
		const group = albumMap.get(state.activeAlbumKey)!;
		const drawer = container.querySelector("#album-drawer") as HTMLElement;
		if (drawer) {
			wireTrackRows(drawer, group.tracks, { hideAlbumColumn: true });
			drawer.querySelector("#btn-play-drawer")?.addEventListener("click", () => {
				playFromList(group.tracks, 0);
				sfx.play();
			});
			drawer.querySelector("#btn-shuffle-drawer")?.addEventListener("click", () => {
				state.settings.shuffle = true;
				playFromList(group.tracks, Math.floor(Math.random() * group.tracks.length));
				sfx.success();
			});
			drawer.querySelector("#btn-queue-drawer")?.addEventListener("click", () => {
				for (const tr of group.tracks) state.queue.push(tr);
				toast(`Queued ${group.tracks.length} tracks from "${group.album}"`, { ttl: 2200 });
				sfx.click();
			});
			drawer.querySelector("#btn-pl-drawer")?.addEventListener("click", (e) => {
				const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
				showContextMenu(rect.left, rect.bottom + 4, [
					{
						label: "Add entire album to playlist",
						onClick: () => {},
						sub: state.playlists.length === 0
							? [{ label: "(no playlists yet)", onClick: () => {} }]
							: state.playlists.map((p) => ({
								label: p.name,
								onClick: () => {
									for (const tr of group.tracks) if (!p.ids.includes(tr.id)) p.ids.push(tr.id);
									savePlaylists();
									toast(`Added album to "${p.name}"`, { ttl: 2200 });
									sfx.click();
								},
							})),
					},
				]);
			});
			drawer.querySelector(".drawer-close")?.addEventListener("click", () => {
				state.activeAlbumKey = null;
				sfx.toggle();
				renderMain();
			});
		}
	}

	// Wire Album Card clicks
	for (const card of container.querySelectorAll<HTMLDivElement>(".album-cel-card")) {
		const key = card.dataset.albKey!;
		const group = albumMap.get(key);
		if (!group) continue;

		card.querySelector(".album-hover-play-btn")?.addEventListener("click", (e) => {
			e.stopPropagation();
			playFromList(group.tracks, 0);
			sfx.play();
		});

		card.querySelector(".album-hover-shuffle-btn")?.addEventListener("click", (e) => {
			e.stopPropagation();
			state.settings.shuffle = true;
			playFromList(group.tracks, Math.floor(Math.random() * group.tracks.length));
			sfx.success();
		});

		card.addEventListener("click", () => {
			state.activeAlbumKey = state.activeAlbumKey === key ? null : key;
			sfx.click();
			renderMain();
		});
	}
}

function renderAlbumDrawer(alb: { album: string; artist: string; tracks: TrackInfo[]; cover?: string; year?: number; hasHiRes: boolean }): string {
	return `
		<div class="discography-drawer">
			<div class="drawer-hero">
				<div class="drawer-art">
					${alb.cover ? `<img src="${alb.cover}" alt="">` : `<div class="drawer-art-fallback">${icons.disc}</div>`}
				</div>
				<div class="drawer-info">
					<div class="drawer-tag">ALBUM DISCOGRAPHY</div>
					<h2 class="drawer-title">${escapeHtml(alb.album)}</h2>
					<h3 class="drawer-artist">${escapeHtml(alb.artist)}</h3>
					<div class="drawer-meta-row">
						<span>${alb.tracks.length} tracks</span>
						<span>•</span>
						<span>${formatDurationSum(alb.tracks)}</span>
						${alb.year ? `<span>•</span><span>${alb.year}</span>` : ""}
						${alb.hasHiRes ? `<span class="badge-codec hires"><span class="hires-dot"></span>HI-RES LOSSLESS</span>` : ""}
					</div>
					<div class="drawer-actions">
						<button class="btn btn-primary" id="btn-play-drawer">${icons.play}<span>Play Album</span></button>
						<button class="btn" id="btn-shuffle-drawer">${icons.shuffle}<span>Shuffle</span></button>
						<button class="btn btn-ghost" id="btn-queue-drawer">${icons.plus}<span>Add to Queue</span></button>
						<button class="btn btn-ghost" id="btn-pl-drawer">${icons.list}<span>Add to Playlist</span></button>
						<button class="btn btn-ghost drawer-close" title="Close discography">${icons.close}</button>
					</div>
				</div>
			</div>
			<div class="drawer-tracklist">
				${renderTrackTable(alb.tracks, { hideAlbumColumn: true })}
			</div>
		</div>
	`;
}

// ---------- Artist Grid & Discography View ----------
function renderArtistGrid(container: HTMLElement, tracks: TrackInfo[]) {
	const artistMap = new Map<string, { artist: string; tracks: TrackInfo[]; albums: Set<string>; avatar?: string; totalPlays: number }>();

	for (const t of tracks) {
		if (!artistMap.has(t.artist)) {
			artistMap.set(t.artist, {
				artist: t.artist,
				tracks: [],
				albums: new Set(),
				avatar: t.artDataUrl,
				totalPlays: 0,
			});
		}
		const group = artistMap.get(t.artist)!;
		group.tracks.push(t);
		group.albums.add(t.album);
		group.totalPlays += (state.playStats[t.id] ?? 0);
		if (!group.avatar && t.artDataUrl) group.avatar = t.artDataUrl;
	}

	const artists = Array.from(artistMap.values()).sort((a, b) => a.artist.localeCompare(b.artist));

	if (artists.length === 0) {
		container.innerHTML = `
			<div class="empty-table-state">
				<div class="empty-icon">${icons.artist}</div>
				<p class="empty-text">No artists found matching criteria.</p>
			</div>
		`;
		return;
	}

	container.innerHTML = `
		<div class="artists-view-wrap">
			${state.activeArtistKey && artistMap.has(state.activeArtistKey) ? `
				<div class="artist-discography-wrap" id="artist-drawer">
					${renderArtistDiscography(artistMap.get(state.activeArtistKey)!)}
				</div>
			` : ""}

			<div class="cel-artist-grid">
				${artists.map((art) => {
					const isActive = state.activeArtistKey === art.artist;
					return `
						<div class="artist-cel-card ${isActive ? "active" : ""}" data-artist="${escapeHtml(art.artist)}">
							<div class="artist-avatar-stage">
								<div class="artist-avatar-ring">
									${art.avatar ? `
										<img src="${art.avatar}" alt="${escapeHtml(art.artist)}" class="artist-avatar-img" loading="lazy" />
									` : `
										<div class="artist-avatar-fallback">${getInitials(art.artist)}</div>
									`}
								</div>
								<div class="artist-hover-overlay">
									<button class="artist-hover-play-btn" title="Play All by ${escapeHtml(art.artist)}">${icons.play}</button>
								</div>
							</div>
							<div class="artist-card-info">
								<h4 class="artist-card-title" title="${escapeHtml(art.artist)}">${escapeHtml(art.artist)}</h4>
								<div class="artist-card-meta">
									<span>${art.albums.size} album${art.albums.size === 1 ? "" : "s"}</span>
									<span>•</span>
									<span>${art.tracks.length} track${art.tracks.length === 1 ? "" : "s"}</span>
									<span>•</span>
									<span>${art.totalPlays} plays</span>
								</div>
							</div>
						</div>
					`;
				}).join("")}
			</div>
		</div>
	`;

	// Wire Artist Drawer events if mounted
	if (state.activeArtistKey && artistMap.has(state.activeArtistKey)) {
		const group = artistMap.get(state.activeArtistKey)!;
		const drawer = container.querySelector("#artist-drawer") as HTMLElement;
		if (drawer) {
			wireTrackRows(drawer, group.tracks);
			drawer.querySelector("#btn-play-artist-drawer")?.addEventListener("click", () => {
				playFromList(group.tracks, 0);
				sfx.play();
			});
			drawer.querySelector("#btn-shuffle-artist-drawer")?.addEventListener("click", () => {
				state.settings.shuffle = true;
				playFromList(group.tracks, Math.floor(Math.random() * group.tracks.length));
				sfx.success();
			});
			drawer.querySelector(".artist-drawer-close")?.addEventListener("click", () => {
				state.activeArtistKey = null;
				sfx.toggle();
				renderMain();
			});
		}
	}

	// Wire Artist Card clicks
	for (const card of container.querySelectorAll<HTMLDivElement>(".artist-cel-card")) {
		const artistName = card.dataset.artist!;
		const group = artistMap.get(artistName);
		if (!group) continue;

		card.querySelector(".artist-hover-play-btn")?.addEventListener("click", (e) => {
			e.stopPropagation();
			playFromList(group.tracks, 0);
			sfx.play();
		});

		card.addEventListener("click", () => {
			state.activeArtistKey = state.activeArtistKey === artistName ? null : artistName;
			sfx.click();
			renderMain();
		});
	}
}

function renderArtistDiscography(art: { artist: string; tracks: TrackInfo[]; albums: Set<string>; avatar?: string; totalPlays: number }): string {
	const topTracks = [...art.tracks].sort((a, b) => (state.playStats[b.id] ?? 0) - (state.playStats[a.id] ?? 0)).slice(0, 5);

	return `
		<div class="discography-drawer artist-hero-drawer">
			<div class="drawer-hero">
				<div class="drawer-art artist-avatar-hero">
					${art.avatar ? `<img src="${art.avatar}" alt="">` : `<div class="drawer-art-fallback">${getInitials(art.artist)}</div>`}
				</div>
				<div class="drawer-info">
					<div class="drawer-tag">ARTIST DISCOGRAPHY</div>
					<h2 class="drawer-title">${escapeHtml(art.artist)}</h2>
					<div class="drawer-meta-row">
						<span>${art.albums.size} albums</span>
						<span>•</span>
						<span>${art.tracks.length} tracks</span>
						<span>•</span>
						<span>${art.totalPlays} total plays</span>
					</div>
					<div class="drawer-actions">
						<button class="btn btn-primary" id="btn-play-artist-drawer">${icons.play}<span>Play All Tracks</span></button>
						<button class="btn" id="btn-shuffle-artist-drawer">${icons.shuffle}<span>Shuffle Artist</span></button>
						<button class="btn btn-ghost artist-drawer-close" title="Close discography">${icons.close}</button>
					</div>
				</div>
			</div>
			
			<div class="artist-section-header">Popular Tracks</div>
			<div class="drawer-tracklist">
				${renderTrackTable(topTracks)}
			</div>

			<div class="artist-section-header" style="margin-top:1.5rem">All Tracks (${art.tracks.length})</div>
			<div class="drawer-tracklist">
				${renderTrackTable(art.tracks)}
			</div>
		</div>
	`;
}

// ---------- Media Import Dropzone View ----------
function renderMediaDropzone(container: HTMLElement) {
	container.innerHTML = `
		<div class="import-dropzone-wrap">
			<div class="dropzone-box" id="dropzone-target">
				<div class="dropzone-corner tl"></div>
				<div class="dropzone-corner tr"></div>
				<div class="dropzone-corner bl"></div>
				<div class="dropzone-corner br"></div>
				
				<div class="dropzone-glow-aura"></div>
				<div class="dropzone-content">
					<div class="dropzone-icon-ring">
						<span class="dropzone-disc-icon">${icons.musicNote}</span>
						<div class="dropzone-pulse-wave"></div>
					</div>
					<h3 class="dropzone-title">Drag & Drop Music or Video Files & Folders</h3>
					<p class="dropzone-subtitle">Instant folder scan, lossless codec detection, cover art extraction & security verification</p>
					
					<div class="dropzone-buttons">
						<button class="btn btn-primary btn-lg" id="dz-btn-folder">${icons.folder}<span>Choose Music Folder</span></button>
						<button class="btn btn-lg" id="dz-btn-files">${icons.plus}<span>Select Individual Files</span></button>
					</div>

					<div class="dropzone-formats">
						<span class="fmt-pill">.FLAC</span>
						<span class="fmt-pill">.ALAC</span>
						<span class="fmt-pill">.WAV</span>
						<span class="fmt-pill">.DSD</span>
						<span class="fmt-pill">.MP3</span>
						<span class="fmt-pill">.AAC</span>
						<span class="fmt-pill">.OGG</span>
						<span class="fmt-pill">.OPUS</span>
						<span class="fmt-pill">.MP4</span>
						<span class="fmt-pill">.MKV</span>
					</div>
				</div>

				<div class="dropzone-scan-status hidden" id="dz-scan-status">
					<div class="scan-radar-spinner"></div>
					<div class="scan-status-text" id="dz-status-text">Scanning folder…</div>
					<div class="scan-progress-bar"><div class="scan-progress-fill" id="dz-progress-fill"></div></div>
				</div>
			</div>
		</div>
	`;

	container.querySelector("#dz-btn-folder")?.addEventListener("click", addFolder);
	container.querySelector("#dz-btn-files")?.addEventListener("click", addFiles);

	const dz = container.querySelector("#dropzone-target") as HTMLElement;
	if (dz) {
		dz.addEventListener("dragover", (e) => {
			e.preventDefault();
			dz.classList.add("drag-hover");
		});
		dz.addEventListener("dragleave", () => {
			dz.classList.remove("drag-hover");
		});
		dz.addEventListener("drop", async (e) => {
			e.preventDefault();
			dz.classList.remove("drag-hover");
			if (!e.dataTransfer?.files?.length) return;
			const files = Array.from(e.dataTransfer.files);
			const paths = files
				.map((f) => (f as any).path as string | undefined)
				.filter((p): p is string => typeof p === "string" && p.length > 0);
			if (paths.length === 0) {
				toast("Drag-drop got no paths — try the Choose Folder button.", { ttl: 3000 });
				return;
			}
			toast(`Importing ${paths.length} item${paths.length === 1 ? "" : "s"}…`, { ttl: 2000, key: "scan" });
			try {
				const { tracks } = await bun().addPathsToLibrary({ paths });
				if (tracks.length > 0) {
					mergeIntoLibrary(tracks);
					toast(`Imported ${tracks.length} track${tracks.length === 1 ? "" : "s"}`, { ttl: 2400 });
					sfx.success();
				}
			} catch (err) {
				toast(`Import failed: ${(err as Error).message}`, { ttl: 3500 });
				sfx.error();
			}
		});
	}
}

function getTrackFormatBadge(t: TrackInfo): { label: string; isLossless: boolean; isHiRes: boolean } {
	const ext = t.path.split(".").pop()?.toLowerCase() || "";
	const sr = t.sampleRate || 44100;
	const br = t.bitrate || 0;
	const isHiRes = sr >= 48000 || ext === "flac" || ext === "dsd" || ext === "wav" || ext === "aiff";

	if (ext === "flac") {
		const khz = (sr / 1000).toFixed(sr % 1000 === 0 ? 0 : 1);
		return { label: `FLAC ${khz}kHz`, isLossless: true, isHiRes };
	}
	if (ext === "dsd" || ext === "dsf" || ext === "dff") {
		return { label: "DSD Direct", isLossless: true, isHiRes: true };
	}
	if (ext === "opus") {
		return { label: "OPUS HD", isLossless: false, isHiRes: true };
	}
	if (ext === "wav") {
		return { label: "WAV PCM", isLossless: true, isHiRes };
	}
	if (ext === "aiff" || ext === "aif") {
		return { label: "AIFF HD", isLossless: true, isHiRes };
	}
	if (ext === "alac" || (ext === "m4a" && br > 500000)) {
		return { label: "ALAC Lossless", isLossless: true, isHiRes };
	}
	if (ext === "mp3") {
		const kbps = br ? Math.round(br / 1000) : 320;
		return { label: `MP3 ${kbps}k`, isLossless: false, isHiRes: false };
	}
	if (ext === "aac" || ext === "m4a") {
		return { label: "AAC Master", isLossless: false, isHiRes: false };
	}
	return { label: ext.toUpperCase() || "AUDIO", isLossless: false, isHiRes };
}

function toggleQuickEffect(fx: "eightD" | "bassBoost" | "vocalEnhance" | "reverbHall") {
	state.quickEffects[fx] = !state.quickEffects[fx];
	const val = state.quickEffects[fx];
	engineA.setQuickEffects({ [fx]: val });
	engineB.setQuickEffects({ [fx]: val });
	sfx.toggle();

	const idMap: Record<string, string> = {
		eightD: "fx-8d",
		bassBoost: "fx-bass",
		vocalEnhance: "fx-vocal",
		reverbHall: "fx-reverb",
	};
	const btn = document.getElementById(idMap[fx]);
	if (btn) btn.classList.toggle("active", val);
}

function updateStageAudioPulse() {
	if (state.view !== "nowplaying") return;
	const stage = document.getElementById("np-cel-stage");
	if (!stage || engine.paused) return;
	const bands = engine.getAudioBands();
	const halo = document.getElementById("np-audio-halo");
	const rim = document.getElementById("np-vinyl-rim-pulse");
	if (halo) {
		const scale = 1.0 + bands.bass * 0.35;
		const opacity = 0.4 + bands.energy * 0.6;
		halo.style.setProperty("--halo-scale", scale.toFixed(2));
		halo.style.setProperty("--halo-opacity", opacity.toFixed(2));
	}
	if (rim) {
		const rimOpacity = 0.3 + bands.bass * 0.7;
		rim.style.setProperty("--audio-pulse-opacity", rimOpacity.toFixed(2));
	}
}

let userScrollingLyricsTimer: ReturnType<typeof setTimeout> | null = null;
let isUserScrollingLyrics = false;

async function loadTrackLyrics(t: TrackInfo, forceReload = false) {
	if (!t) return;
	if (!forceReload && state.lyricsCache[t.id]) {
		if (state.view === "nowplaying") renderLyricsContent(t);
		return;
	}
	state.lyricsLoading = true;
	if (state.view === "nowplaying") renderLyricsLoading();
	try {
		const res = await bun().getLyrics({
			artist: t.artist,
			album: t.album,
			title: t.title,
			path: t.path,
		});
		const synced: LyricLine[] = (res?.synced || []).map((line) => ({
			time: line.time,
			text: line.text,
			romaji: containsJapanese(line.text) ? toRomaji(line.text) : undefined,
		}));
		state.lyricsCache[t.id] = {
			plain: res?.plain || null,
			synced,
		};
	} catch (err) {
		console.warn("[lyrics] Failed to fetch lyrics:", err);
		state.lyricsCache[t.id] = { plain: null, synced: [] };
	} finally {
		state.lyricsLoading = false;
		if (state.view === "nowplaying" && state.currentTrack?.id === t.id) {
			renderLyricsContent(t);
		}
	}
}

function renderLyricsLoading() {
	const body = document.getElementById("np-lyrics-body");
	if (!body) return;
	body.innerHTML = `
		<div class="np-lyrics-empty">
			<div class="np-live-dot" style="width:18px;height:18px;margin-bottom:0.5rem"></div>
			<p>Retrieving synced lyrics from database & local tags…</p>
		</div>
	`;
}

function renderLyricsContent(t: TrackInfo) {
	const body = document.getElementById("np-lyrics-body");
	if (!body) return;
	const data = state.lyricsCache[t.id];
	if (!data || (!data.plain && (!data.synced || data.synced.length === 0))) {
		body.innerHTML = `
			<div class="np-lyrics-empty">
				${icons.mic}
				<p>No synced lyrics found for this track. Place a matching <code>.lrc</code> file in the album folder or fetch from LRCLIB.</p>
				<button class="np-lyrics-btn" id="btn-fetch-lyrics">${icons.search} <span>Search Online</span></button>
			</div>
		`;
		document.getElementById("btn-fetch-lyrics")?.addEventListener("click", () => {
			sfx.click();
			loadTrackLyrics(t, true);
		});
		return;
	}

	if (data.synced && data.synced.length > 0) {
		const mode = state.lyricsMode;
		body.innerHTML = `
			<div class="np-lyrics-scroll" id="np-lyrics-scroll">
				${data.synced.map((line, idx) => `
					<div class="lrc-line" data-idx="${idx}" data-time="${line.time}">
						<div class="lrc-text">${escapeHtml(line.text)}</div>
						${mode !== "original" && line.romaji ? `<div class="lrc-romaji">${escapeHtml(line.romaji)}</div>` : ""}
						<div class="lrc-time-stamp">${formatTime(line.time)}</div>
					</div>
				`).join("")}
			</div>
		`;

		const scrollContainer = document.getElementById("np-lyrics-scroll");
		if (scrollContainer) {
			scrollContainer.addEventListener("wheel", () => {
				isUserScrollingLyrics = true;
				if (userScrollingLyricsTimer) clearTimeout(userScrollingLyricsTimer);
				userScrollingLyricsTimer = setTimeout(() => {
					isUserScrollingLyrics = false;
				}, 3000);
			}, { passive: true });
		}

		for (const lineEl of body.querySelectorAll<HTMLDivElement>(".lrc-line")) {
			lineEl.addEventListener("click", () => {
				const time = parseFloat(lineEl.dataset.time || "0");
				engine.seek(time);
				sfx.click();
				updateKaraokeLyrics(time);
			});
		}
		updateKaraokeLyrics(engine.currentTime);
	} else if (data.plain) {
		body.innerHTML = `
			<div class="np-lyrics-scroll" style="white-space: pre-wrap; font-size: 1.05rem; line-height: 1.8; color: rgba(232, 232, 245, 0.75);">
				${escapeHtml(data.plain)}
			</div>
		`;
	}
}

function updateKaraokeLyrics(currentTime: number) {
	const t = state.currentTrack;
	if (!t) return;
	const data = state.lyricsCache[t.id];
	if (!data || !data.synced || data.synced.length === 0) return;

	const activeIdx = findActiveLyricIndex(data.synced, currentTime);
	if (activeIdx === state.activeLyricIndex) return;
	state.activeLyricIndex = activeIdx;

	const lines = document.querySelectorAll<HTMLDivElement>("#np-lyrics-scroll .lrc-line");
	lines.forEach((el, idx) => {
		const isActive = idx === activeIdx;
		const isPassed = idx < activeIdx;
		el.classList.toggle("active", isActive);
		el.classList.toggle("passed", isPassed);
	});

	if (activeIdx >= 0 && !isUserScrollingLyrics) {
		const activeEl = lines[activeIdx];
		if (activeEl) {
			activeEl.scrollIntoView({ behavior: "smooth", block: "center" });
		}
	}
}

function renderTrackInspectorModal(t: TrackInfo) {
	let modal = document.getElementById("np-inspector-modal") as HTMLDivElement | null;
	if (!modal) {
		modal = document.createElement("div");
		modal.id = "np-inspector-modal";
		modal.className = "np-inspector-modal";
		document.body.appendChild(modal);
	}

	const formatInfo = getTrackFormatBadge(t);
	const ext = t.path.split(".").pop()?.toUpperCase() || "AUDIO";
	const fileSizeMb = (t.size / (1024 * 1024)).toFixed(2);
	const srKhz = ((t.sampleRate || 44100) / 1000).toFixed(1);
	const brKbps = t.bitrate ? Math.round(t.bitrate / 1000) : "VBR";
	const threatText = t.securityThreats && t.securityThreats.length > 0 ? t.securityThreats.join(", ") : "None (Clean Media)";
	const secScore = t.securityScore !== undefined ? t.securityScore : 100;
	const isSafe = t.securitySafe !== false;

	modal.innerHTML = `
		<div class="np-inspector-card" id="np-inspector-card">
			<div class="np-inspector-header">
				<div class="np-inspector-title">
					${isSafe ? icons.shieldCheck : icons.shieldAlert}
					<span>Track Inspector & Integrity</span>
				</div>
				<button class="np-inspector-close" id="np-inspector-close">×</button>
			</div>

			<div>
				<div class="np-inspector-section-title">Master Audio Specification</div>
				<div class="np-inspector-grid">
					<div class="np-stat-box">
						<span class="np-stat-label">Codec & Container</span>
						<span class="np-stat-val" style="color:var(--accent-a)">${formatInfo.label} (${ext})</span>
					</div>
					<div class="np-stat-box">
						<span class="np-stat-label">Sample Rate</span>
						<span class="np-stat-val">${srKhz} kHz • Stereo</span>
					</div>
					<div class="np-stat-box">
						<span class="np-stat-label">Bitrate</span>
						<span class="np-stat-val">${brKbps} kbps</span>
					</div>
					<div class="np-stat-box">
						<span class="np-stat-label">File Size / Duration</span>
						<span class="np-stat-val">${fileSizeMb} MB • ${formatTime(t.duration)}</span>
					</div>
				</div>
			</div>

			<div>
				<div class="np-inspector-section-title">Security & Authenticity Clearance</div>
				<div class="np-inspector-grid">
					<div class="np-stat-box">
						<span class="np-stat-label">Security Trust Score</span>
						<span class="np-stat-val" style="color:${isSafe ? '#86efac' : '#f87171'}">${secScore}/100 — ${isSafe ? 'Verified Safe' : 'Threat Detected'}</span>
					</div>
					<div class="np-stat-box">
						<span class="np-stat-label">Binary Payload Scan</span>
						<span class="np-stat-val" style="color:${isSafe ? '#86efac' : '#f87171'}">${threatText}</span>
					</div>
				</div>
			</div>

			<div>
				<div class="np-inspector-section-title">Storage Location</div>
				<div class="np-inspector-path">
					<div class="np-path-text" title="${escapeHtml(t.path)}">${escapeHtml(t.path)}</div>
					<div class="np-path-actions">
						<button class="np-path-btn" id="btn-inspect-copy">${icons.copy} <span>Copy</span></button>
						<button class="np-path-btn" id="btn-inspect-folder">${icons.folder} <span>Show</span></button>
					</div>
				</div>
			</div>
		</div>
	`;

	modal.classList.add("open");

	document.getElementById("np-inspector-close")?.addEventListener("click", () => {
		modal?.classList.remove("open");
	});
	modal.addEventListener("click", (e) => {
		if (e.target === modal) modal?.classList.remove("open");
	});
	document.getElementById("btn-inspect-copy")?.addEventListener("click", () => {
		navigator.clipboard.writeText(t.path);
		toast("File path copied to clipboard", { ttl: 2000 });
		sfx.click();
	});
	document.getElementById("btn-inspect-folder")?.addEventListener("click", () => {
		bun().showInFolder({ path: t.path });
		sfx.open();
	});
}

function renderNowPlaying(root: HTMLElement) {
	const t = state.currentTrack;
	if (!t) {
		root.innerHTML = `<div class="empty">${icons.disc}<p>Nothing playing yet. Pick a track from your library.</p></div>`;
		return;
	}

	if (t.kind === "video") {
		root.innerHTML = `
			<div class="video-cinema-mount" id="video-mount"></div>
		`;
		queueMicrotask(() => wireVideoStage());
		return;
	}

	const isPlaying = !engine.paused;
	const formatInfo = getTrackFormatBadge(t);
	const fx = state.quickEffects;

	root.innerHTML = `
		<div class="np-full">
			<!-- Left Column: 2026 Cel-Shaded Album Art Stage + Quick Effects + Viz -->
			<div class="np-left-column">
				<div class="np-stage-container">
					<div class="np-audio-halo" id="np-audio-halo"></div>
					<div class="np-cel-stage ${isPlaying ? 'is-playing' : 'is-paused'}" id="np-cel-stage">
						<!-- Sleeve Jacket -->
						<div class="np-sleeve-jacket">
							<div class="np-sleeve-art">
								${t.artDataUrl ? `<img src="${t.artDataUrl}" alt="">` : `<div class="np-sleeve-placeholder">${icons.musicNote}</div>`}
								<div class="np-sleeve-gloss"></div>
								<div class="np-sleeve-border"></div>
								<div class="np-sleeve-badge ${formatInfo.isHiRes ? 'hi-res' : ''}">${formatInfo.label}</div>
							</div>
						</div>
						<!-- Emerging Vinyl Record Mockup -->
						<div class="np-vinyl-disc ${isPlaying ? 'spinning' : ''}" id="np-vinyl-disc">
							<div class="np-vinyl-grooves"></div>
							<div class="np-vinyl-shine"></div>
							<div class="np-vinyl-label">
								${t.artDataUrl ? `<img src="${t.artDataUrl}" alt="">` : `<div style="opacity:.4">${icons.musicNote}</div>`}
								<div class="np-vinyl-spindle"></div>
							</div>
							<div class="np-vinyl-rim-pulse" id="np-vinyl-rim-pulse"></div>
						</div>
					</div>
				</div>

				<!-- Quick Audio Effects Toolbar -->
				<div class="np-effects-bar">
					<button class="np-effect-btn btn-8d ${fx.eightD ? 'active' : ''}" id="fx-8d" title="360° Binaural 8D Audio Rotation">
						${icons.eightD}
						<span>8D Audio</span>
					</button>
					<button class="np-effect-btn btn-bass ${fx.bassBoost ? 'active' : ''}" id="fx-bass" title="+7.5dB Sub-Bass Drive">
						${icons.bass}
						<span>Bass Boost</span>
					</button>
					<button class="np-effect-btn ${fx.vocalEnhance ? 'active' : ''}" id="fx-vocal" title="+5.5dB Vocal Presence & Mid Clarity">
						${icons.vocal}
						<span>Vocal</span>
					</button>
					<button class="np-effect-btn ${fx.reverbHall ? 'active' : ''}" id="fx-reverb" title="Concert Hall Spatial Acoustics">
						${icons.reverb}
						<span>Reverb</span>
					</button>
					<button class="np-effect-btn" id="np-btn-cinema" title="Fullscreen Cinema View (F)">
						${icons.maximize}
						<span>Cinema</span>
					</button>
				</div>

				<!-- Visualizer Card -->
				<div class="np-viz-card">
					<canvas id="viz-canvas"></canvas>
					<div class="np-viz-badge">${state.settings.vizStyle}</div>
				</div>
			</div>

			<!-- Right Column: Track Info + Real-time Synced Karaoke Lyrics -->
			<div class="np-right-column">
				<div class="np-header-info">
					<div class="np-badges-row">
						<span class="format-chip ${formatInfo.isHiRes ? 'gold' : ''}">${formatInfo.label}</span>
						${t.securitySafe !== false ? `<span class="format-chip safe">${icons.shieldCheck} Verified Clean</span>` : ""}
						<button class="np-inspect-trigger" id="np-btn-inspect">${icons.shield} <span>Inspector</span></button>
					</div>
					<h1 class="np-title-h1">${escapeHtml(t.title)}</h1>
					<h2 class="np-artist-h2">${escapeHtml(t.artist)}</h2>
					<div class="np-meta-line">
						<span>${escapeHtml(t.album)}</span>
						${t.year ? `<span>• ${t.year}</span>` : ""}
						${t.genre ? `<span>• ${escapeHtml(t.genre)}</span>` : ""}
						${t.bitrate ? `<span>• ${Math.round(t.bitrate / 1000)} kbps</span>` : ""}
					</div>
				</div>

				<!-- Real-time Synced Karaoke Lyrics Side-Panel -->
				<div class="np-lyrics-panel">
					<div class="np-lyrics-header">
						<div class="np-lyrics-label">
							<div class="np-live-dot"></div>
							<span>Karaoke & Lyrics</span>
						</div>
						<div class="np-lyrics-actions">
							<div class="np-lyrics-tab-group">
								<button class="np-lyrics-tab ${state.lyricsMode === 'dual' ? 'active' : ''}" data-mode="dual">Dual</button>
								<button class="np-lyrics-tab ${state.lyricsMode === 'romaji' ? 'active' : ''}" data-mode="romaji">Romaji</button>
								<button class="np-lyrics-tab ${state.lyricsMode === 'original' ? 'active' : ''}" data-mode="original">Original</button>
							</div>
							<button class="np-lyrics-icon-btn" id="btn-reload-lyrics" title="Reload Lyrics">${icons.search}</button>
						</div>
					</div>
					<div id="np-lyrics-body" style="flex:1;display:flex;flex-direction:column;min-height:0">
						<!-- Content populated dynamically -->
					</div>
				</div>
			</div>
		</div>
	`;

	// Visualizer mount
	const canvas = document.getElementById("viz-canvas") as HTMLCanvasElement | null;
	if (canvas) {
		visualizer?.destroy();
		visualizer = createVisualizer(canvas, "bars", state.settings.vizStyle, {
			maxFps: state.settings.maxFps,
			idle: state.settings.idleViz,
			autoStart: !engine.paused,
		});
		if (t.artDataUrl) updateAccentFromArt(t.artDataUrl);
	}

	// Wire Quick Effects
	document.getElementById("fx-8d")?.addEventListener("click", () => toggleQuickEffect("eightD"));
	document.getElementById("fx-bass")?.addEventListener("click", () => toggleQuickEffect("bassBoost"));
	document.getElementById("fx-vocal")?.addEventListener("click", () => toggleQuickEffect("vocalEnhance"));
	document.getElementById("fx-reverb")?.addEventListener("click", () => toggleQuickEffect("reverbHall"));
	document.getElementById("np-btn-cinema")?.addEventListener("click", () => {
		sfx.open();
		enterImmersive();
	});

	// Wire Inspector
	document.getElementById("np-btn-inspect")?.addEventListener("click", () => {
		sfx.click();
		renderTrackInspectorModal(t);
	});

	// Wire Lyrics Mode tabs
	for (const tab of root.querySelectorAll<HTMLButtonElement>(".np-lyrics-tab")) {
		tab.addEventListener("click", () => {
			state.lyricsMode = tab.dataset.mode as LyricMode;
			sfx.click();
			renderNowPlaying(root);
		});
	}
	document.getElementById("btn-reload-lyrics")?.addEventListener("click", () => {
		sfx.click();
		loadTrackLyrics(t, true);
	});

	// Load & render lyrics
	loadTrackLyrics(t);
}

let activeStudioTab: "eq" | "spatial" | "lofi" | "hall" | "matrix" = "eq";
let activeScopeMode: "dual" | "spectrum" | "scope" | "phase" = "dual";
let studioAnimRaf: number | null = null;

function syncDspToEngines() {
	if (!state.settings.dsp) return;
	engineA.setDsp(state.settings.dsp);
	engineB.setDsp(state.settings.dsp);
	videoEngine.setDsp(state.settings.dsp);
	saveSettings();
}

function renderEqualizer(root: HTMLElement) {
	if (studioAnimRaf !== null) {
		cancelAnimationFrame(studioAnimRaf);
		studioAnimRaf = null;
	}

	if (!state.settings.dsp) {
		state.settings.dsp = {
			...DEFAULT_DSP_SETTINGS,
			eq: state.settings.eq ? [...state.settings.eq] : [...DEFAULT_DSP_SETTINGS.eq],
			eqPreset: state.settings.eqPreset ?? DEFAULT_DSP_SETTINGS.eqPreset,
		};
	}

	const dsp = state.settings.dsp;
	const customNames = Object.keys(state.settings.customEqPresets);

	root.innerHTML = `
		<div class="studio-container">
			<!-- Studio Topbar -->
			<div class="studio-topbar">
				<div class="studio-title-block">
					<div class="studio-badge"><span class="badge-dot"></span>DSP STUDIO v2.0</div>
					<h2>Audio DSP & FX Studio</h2>
				</div>
				<div class="studio-topbar-actions">
					<button class="btn btn-outline" id="studio-btn-nodes" data-tip="Switch to visual audio node graph editor" title="Open Node Graph">
						${icons.node}<span>Node Graph</span>
					</button>
					<button class="btn btn-outline" id="studio-btn-reset-fx" data-tip="Reset all DSP parameters to clean state" title="Reset All Effects">
						<span>Reset All FX</span>
					</button>
					<button class="btn btn-primary" id="eq-save" data-tip="Save current EQ as a custom preset" title="Save Preset">
						${icons.plus}<span>Save Preset</span>
					</button>
				</div>
			</div>

			<!-- Master Audio Scope & Spectrum Analyzer Deck -->
			<div class="studio-master-scope-card">
				<div class="scope-card-header">
					<div class="scope-header-left">
						<span class="scope-title-label">MASTER AUDIO ANALYZER</span>
						<div class="scope-mode-pills">
							<button class="scope-pill ${activeScopeMode === "dual" ? "active" : ""}" data-scope="dual">Dual View</button>
							<button class="scope-pill ${activeScopeMode === "spectrum" ? "active" : ""}" data-scope="spectrum">Spectrum FFT</button>
							<button class="scope-pill ${activeScopeMode === "scope" ? "active" : ""}" data-scope="scope">Oscilloscope</button>
							<button class="scope-pill ${activeScopeMode === "phase" ? "active" : ""}" data-scope="phase">Phase Scope</button>
						</div>
					</div>
					<div class="scope-meters-container">
						<div class="meter-channel">
							<span class="meter-ch-label">L</span>
							<div class="meter-track"><div class="meter-bar" id="scope-meter-l"></div></div>
							<span class="meter-val" id="scope-val-l">-inf dB</span>
						</div>
						<div class="meter-channel">
							<span class="meter-ch-label">R</span>
							<div class="meter-track"><div class="meter-bar" id="scope-meter-r"></div></div>
							<span class="meter-val" id="scope-val-r">-inf dB</span>
						</div>
						<div class="meter-clip-led" id="scope-clip-led" title="Clip Indicator">CLIP</div>
					</div>
				</div>
				<div class="scope-canvas-wrap">
					<canvas id="studio-scope-canvas" class="studio-scope-canvas" height="140"></canvas>
					<div class="scope-freq-bands-legend">
						<span class="freq-tag">SUB (&lt;60Hz)</span>
						<span class="freq-tag">BASS (60-250Hz)</span>
						<span class="freq-tag">LOW-MID (250-500Hz)</span>
						<span class="freq-tag">MID (500-2kHz)</span>
						<span class="freq-tag">HIGH-MID (2k-4kHz)</span>
						<span class="freq-tag">PRESENCE (4k-8kHz)</span>
						<span class="freq-tag">BRILLIANCE (8k-20kHz)</span>
					</div>
				</div>
			</div>

			<!-- Studio Navigation Tabs -->
			<div class="studio-nav-tabs">
				<button class="studio-tab-btn ${activeStudioTab === "eq" ? "active" : ""}" data-tab="eq">
					<span class="tab-icon">🎛️</span>
					<span class="tab-label">10-Band Graphic EQ</span>
				</button>
				<button class="studio-tab-btn ${activeStudioTab === "spatial" ? "active" : ""}" data-tab="spatial">
					<span class="tab-icon">🌌</span>
					<span class="tab-label">8D Spatial Studio</span>
					${dsp.spatial8dEnabled ? `<span class="tab-active-dot"></span>` : ""}
				</button>
				<button class="studio-tab-btn ${activeStudioTab === "lofi" ? "active" : ""}" data-tab="lofi">
					<span class="tab-icon">📼</span>
					<span class="tab-label">Lo-Fi Tape & Vinyl</span>
					${dsp.lofiEnabled ? `<span class="tab-active-dot"></span>` : ""}
				</button>
				<button class="studio-tab-btn ${activeStudioTab === "hall" ? "active" : ""}" data-tab="hall">
					<span class="tab-icon">🏛️</span>
					<span class="tab-label">Concert Hall & Widener</span>
					${dsp.reverbEnabled || dsp.widenerEnabled ? `<span class="tab-active-dot"></span>` : ""}
				</button>
				<button class="studio-tab-btn ${activeStudioTab === "matrix" ? "active" : ""}" data-tab="matrix">
					<span class="tab-icon">⚡</span>
					<span class="tab-label">Master FX Matrix</span>
				</button>
			</div>

			<!-- TAB 1: 10-Band Graphic Equalizer -->
			<div class="studio-tab-pane ${activeStudioTab === "eq" ? "active" : ""}" id="pane-eq">
				<!-- Curated EQ Presets -->
				<div class="eq-presets-ribbon" id="eq-presets">
					<div class="presets-label">Curated Profiles:</div>
					${Object.keys(EQ_PRESETS).map((p) => `
						<div class="preset-chip ${p === dsp.eqPreset ? "active" : ""}" data-p="${p}">${escapeHtml(p)}</div>
					`).join("")}
					${customNames.map((p) => `
						<div class="preset-chip preset-custom ${p === dsp.eqPreset ? "active" : ""}" data-p="${p}" data-custom="1">
							<span>${escapeHtml(p)}</span>
							<span class="preset-del-btn" data-del="${escapeHtml(p)}" title="Delete Preset">×</span>
						</div>
					`).join("")}
				</div>

				<!-- Frequency Response Curve Canvas -->
				<div class="eq-curve-card">
					<div class="curve-header">
						<span class="curve-title">FREQUENCY RESPONSE CURVE</span>
						<span class="curve-hint">Drag nodes on canvas or adjust anime sliders below</span>
					</div>
					<canvas id="eq-curve-canvas" class="eq-curve-canvas" height="150"></canvas>
				</div>

				<!-- 10-Band Sliders Grid -->
				<div class="eq-sliders-card">
					<div class="eq-bands-grid" id="eq-bands">
						${EQ_BANDS.map((f, i) => `
							<div class="eq-band-col" data-idx="${i}">
								<button class="eq-val-badge" id="eqv-${i}" data-tip="Click to reset band to 0 dB" title="Reset to 0 dB">
									${dsp.eq[i] > 0 ? "+" : ""}${dsp.eq[i].toFixed(0)} dB
								</button>
								<div class="eq-slider-rail">
									<input type="range" class="eq-slider-input" min="-24" max="24" step="1" value="${dsp.eq[i]}" data-i="${i}" />
								</div>
								<span class="eq-freq-label">${f >= 1000 ? (f / 1000) + "k" : f}</span>
							</div>
						`).join("")}
					</div>

					<!-- Master Pre-Amp -->
					<div class="eq-preamp-bar">
						<span class="preamp-label">PRE-AMP GAIN</span>
						<input type="range" id="eq-preamp-slider" min="-12" max="12" step="0.5" value="${state.settings.preAmp}" />
						<button class="preamp-val-badge" id="preamp-val" title="Click to reset Pre-Amp to 0 dB">
							${state.settings.preAmp > 0 ? "+" : ""}${state.settings.preAmp.toFixed(1)} dB
						</button>
					</div>
				</div>
			</div>

			<!-- TAB 2: 8D Spatial Audio Studio -->
			<div class="studio-tab-pane ${activeStudioTab === "spatial" ? "active" : ""}" id="pane-spatial">
				<div class="spatial-studio-grid">
					<!-- 3D Binaural Radar HUD -->
					<div class="radar-card">
						<div class="radar-header">
							<span class="radar-title">3D BINAURAL RADAR PANNER</span>
							<span class="radar-coords" id="radar-coords-label">X: 0.0m | Z: 0.0m | θ: 0°</span>
						</div>
						<div class="radar-canvas-container">
							<canvas id="radar-8d-canvas" class="radar-8d-canvas" width="280" height="280"></canvas>
							<div class="radar-center-head" title="Listener (Headphones)">🎧</div>
						</div>
						<div class="radar-hint">Click & drag on radar to steer sound position manually</div>
					</div>

					<!-- 8D Orbit Controls -->
					<div class="spatial-controls-card">
						<div class="ctrl-header-row">
							<div class="ctrl-title-group">
								<h3>8D Spatial Rotation Engine</h3>
								<p>Orbits the audio around the listener in full 3D binaural HRTF acoustic space.</p>
							</div>
							<label class="toggle-switch">
								<input type="checkbox" id="spatial-toggle" ${dsp.spatial8dEnabled ? "checked" : ""} />
								<span class="slider-toggle"></span>
							</label>
						</div>

						<div class="studio-param-row">
							<div class="param-meta">
								<span class="param-name">Rotation Speed</span>
								<span class="param-val" id="spatial-speed-val">${dsp.spatial8dSpeed.toFixed(1)} s/cycle</span>
							</div>
							<input type="range" id="spatial-speed-slider" min="1" max="30" step="0.5" value="${dsp.spatial8dSpeed}" />
						</div>

						<div class="studio-param-row">
							<div class="param-meta">
								<span class="param-name">Soundstage Radius</span>
								<span class="param-val" id="spatial-radius-val">${dsp.spatial8dRadius.toFixed(1)} m</span>
							</div>
							<input type="range" id="spatial-radius-slider" min="0.5" max="10" step="0.1" value="${dsp.spatial8dRadius}" />
						</div>

						<div class="studio-param-row">
							<div class="param-meta">
								<span class="param-name">Orbit Pattern</span>
							</div>
							<div class="orbit-pattern-buttons">
								<button class="pattern-btn ${dsp.spatial8dPattern === "circle_cw" ? "active" : ""}" data-pattern="circle_cw">Clockwise</button>
								<button class="pattern-btn ${dsp.spatial8dPattern === "circle_ccw" ? "active" : ""}" data-pattern="circle_ccw">Counter-CW</button>
								<button class="pattern-btn ${dsp.spatial8dPattern === "figure8" ? "active" : ""}" data-pattern="figure8">Figure-8</button>
								<button class="pattern-btn ${dsp.spatial8dPattern === "ellipse" ? "active" : ""}" data-pattern="ellipse">Ellipse</button>
							</div>
						</div>

						<div class="spatial-switches-row">
							<label class="switch-chip">
								<input type="checkbox" id="spatial-doppler-toggle" ${dsp.spatial8dDoppler ? "checked" : ""} />
								<span>Doppler Shift Pitch Detune</span>
							</label>
							<label class="switch-chip">
								<input type="checkbox" id="spatial-elev-toggle" ${dsp.spatial8dElevation ? "checked" : ""} />
								<span>3D Vertical Elevation</span>
							</label>
						</div>
					</div>
				</div>
			</div>

			<!-- TAB 3: Lo-Fi Tape & Vinyl Engine -->
			<div class="studio-tab-pane ${activeStudioTab === "lofi" ? "active" : ""}" id="pane-lofi">
				<div class="lofi-studio-grid">
					<!-- Tape Deck Deck -->
					<div class="lofi-deck-card">
						<div class="ctrl-header-row">
							<div class="ctrl-title-group">
								<h3>Analog Tape Saturation</h3>
								<p>Asymmetrical magnetic tape compression with rich second & third harmonics.</p>
							</div>
							<label class="toggle-switch">
								<input type="checkbox" id="lofi-master-toggle" ${dsp.lofiEnabled ? "checked" : ""} />
								<span class="slider-toggle"></span>
							</label>
						</div>

						<div class="studio-param-row">
							<div class="param-meta">
								<span class="param-name">Tape Warmth / Saturation</span>
								<span class="param-val" id="lofi-warmth-val">${Math.round(dsp.lofiWarmth * 100)}%</span>
							</div>
							<input type="range" id="lofi-warmth-slider" min="0" max="1" step="0.01" value="${dsp.lofiWarmth}" />
						</div>

						<div class="studio-param-row">
							<div class="param-meta">
								<span class="param-name">Tape Head Tone (High Cut)</span>
								<span class="param-val" id="lofi-tone-val">${Math.round(dsp.lofiTone)} Hz</span>
							</div>
							<input type="range" id="lofi-tone-slider" min="2000" max="20000" step="200" value="${dsp.lofiTone}" />
						</div>

						<div class="tape-curve-viz-box">
							<canvas id="tape-curve-canvas" class="tape-curve-canvas" width="260" height="90"></canvas>
						</div>
					</div>

					<!-- Wow, Flutter & Vinyl Deck -->
					<div class="lofi-deck-card">
						<div class="ctrl-header-row">
							<div class="ctrl-title-group">
								<h3>Wow, Flutter & Vinyl Dust</h3>
								<p>Capstan mechanical pitch sway and procedural needle groove friction.</p>
							</div>
						</div>

						<div class="studio-param-row">
							<div class="param-meta">
								<span class="param-name">Pitch Wobble Depth (Wow & Flutter)</span>
								<span class="param-val" id="lofi-wow-val">${Math.round(dsp.lofiWowFlutter * 100)}%</span>
							</div>
							<input type="range" id="lofi-wow-slider" min="0" max="1" step="0.01" value="${dsp.lofiWowFlutter}" />
						</div>

						<div class="studio-param-row">
							<div class="param-meta">
								<span class="param-name">Wobble Speed Rate</span>
								<span class="param-val" id="lofi-wowrate-val">${dsp.lofiWowRate.toFixed(1)} Hz</span>
							</div>
							<input type="range" id="lofi-wowrate-slider" min="0.2" max="4.0" step="0.1" value="${dsp.lofiWowRate}" />
						</div>

						<div class="studio-param-row">
							<div class="param-meta">
								<span class="param-name">Vinyl Dust & Crackle Level</span>
								<span class="param-val" id="lofi-crackle-val">${Math.round(dsp.lofiCrackle * 100)}%</span>
							</div>
							<input type="range" id="lofi-crackle-slider" min="0" max="1" step="0.01" value="${dsp.lofiCrackle}" />
						</div>

						<!-- Cassette Animation Deck -->
						<div class="cassette-anim-box">
							<canvas id="cassette-reels-canvas" class="cassette-reels-canvas" width="260" height="70"></canvas>
						</div>
					</div>
				</div>
			</div>

			<!-- TAB 4: Concert Hall Reverb & Surround Widener -->
			<div class="studio-tab-pane ${activeStudioTab === "hall" ? "active" : ""}" id="pane-hall">
				<div class="hall-studio-grid">
					<!-- Haas Stereo Widener -->
					<div class="hall-deck-card">
						<div class="ctrl-header-row">
							<div class="ctrl-title-group">
								<h3>Haas Stereo Soundstage Widener</h3>
								<p>Expands perceptual acoustic stereo width far beyond physical earcups.</p>
							</div>
							<label class="toggle-switch">
								<input type="checkbox" id="widener-toggle" ${dsp.widenerEnabled ? "checked" : ""} />
								<span class="slider-toggle"></span>
							</label>
						</div>

						<div class="studio-param-row">
							<div class="param-meta">
								<span class="param-name">Stereo Field Expansion</span>
								<span class="param-val" id="widener-width-val">${Math.round(dsp.stereoWidth * 100)}%</span>
							</div>
							<input type="range" id="widener-width-slider" min="0" max="2" step="0.01" value="${dsp.stereoWidth}" />
						</div>

						<div class="widener-phase-box">
							<canvas id="widener-phase-canvas" class="widener-phase-canvas" width="260" height="90"></canvas>
						</div>
					</div>

					<!-- Convolution Reverb -->
					<div class="hall-deck-card">
						<div class="ctrl-header-row">
							<div class="ctrl-title-group">
								<h3>Concert Hall Convolution Reverb</h3>
								<p>Lush early reflections and diffuse acoustic decay impulse responses.</p>
							</div>
							<label class="toggle-switch">
								<input type="checkbox" id="reverb-toggle" ${dsp.reverbEnabled ? "checked" : ""} />
								<span class="slider-toggle"></span>
							</label>
						</div>

						<div class="studio-param-row">
							<div class="param-meta">
								<span class="param-name">Acoustic Space Preset</span>
							</div>
							<div class="reverb-presets-row">
								<button class="reverb-p-btn ${dsp.reverbPreset === "studio" ? "active" : ""}" data-preset="studio">Studio</button>
								<button class="reverb-p-btn ${dsp.reverbPreset === "warm_room" ? "active" : ""}" data-preset="warm_room">Warm Room</button>
								<button class="reverb-p-btn ${dsp.reverbPreset === "concert_hall" ? "active" : ""}" data-preset="concert_hall">Concert Hall</button>
								<button class="reverb-p-btn ${dsp.reverbPreset === "tokyo_arena" ? "active" : ""}" data-preset="tokyo_arena">Tokyo Arena</button>
								<button class="reverb-p-btn ${dsp.reverbPreset === "cosmic_void" ? "active" : ""}" data-preset="cosmic_void">Cosmic Void</button>
							</div>
						</div>

						<div class="studio-param-row">
							<div class="param-meta">
								<span class="param-name">Decay Time</span>
								<span class="param-val" id="reverb-decay-val">${dsp.reverbDecay.toFixed(1)} s</span>
							</div>
							<input type="range" id="reverb-decay-slider" min="0.5" max="8.0" step="0.1" value="${dsp.reverbDecay}" />
						</div>

						<div class="studio-param-row">
							<div class="param-meta">
								<span class="param-name">Wet / Dry Reverb Mix</span>
								<span class="param-val" id="reverb-mix-val">${Math.round(dsp.reverbMix * 100)}%</span>
							</div>
							<input type="range" id="reverb-mix-slider" min="0" max="1" step="0.01" value="${dsp.reverbMix}" />
						</div>
					</div>
				</div>
			</div>

			<!-- TAB 5: Master FX Matrix Deck -->
			<div class="studio-tab-pane ${activeStudioTab === "matrix" ? "active" : ""}" id="pane-matrix">
				<div class="matrix-grid">
					<div class="matrix-module-card ${dsp.spatial8dEnabled ? "is-active" : ""}">
						<div class="module-head">
							<span class="mod-icon">🌌</span>
							<span class="mod-title">8D Binaural Radar</span>
							<span class="mod-status">${dsp.spatial8dEnabled ? "ACTIVE" : "BYPASSED"}</span>
						</div>
						<p>Speed: ${dsp.spatial8dSpeed}s | Radius: ${dsp.spatial8dRadius}m | Pattern: ${dsp.spatial8dPattern}</p>
					</div>

					<div class="matrix-module-card ${dsp.lofiEnabled ? "is-active" : ""}">
						<div class="module-head">
							<span class="mod-icon">📼</span>
							<span class="mod-title">Lo-Fi Tape Saturation</span>
							<span class="mod-status">${dsp.lofiEnabled ? "ACTIVE" : "BYPASSED"}</span>
						</div>
						<p>Warmth: ${Math.round(dsp.lofiWarmth * 100)}% | Wow: ${Math.round(dsp.lofiWowFlutter * 100)}% | Vinyl: ${Math.round(dsp.lofiCrackle * 100)}%</p>
					</div>

					<div class="matrix-module-card ${dsp.widenerEnabled ? "is-active" : ""}">
						<div class="module-head">
							<span class="mod-icon">↔️</span>
							<span class="mod-title">Haas Stereo Expander</span>
							<span class="mod-status">${dsp.widenerEnabled ? "ACTIVE" : "BYPASSED"}</span>
						</div>
						<p>Stereo Width: ${Math.round(dsp.stereoWidth * 100)}%</p>
					</div>

					<div class="matrix-module-card ${dsp.reverbEnabled ? "is-active" : ""}">
						<div class="module-head">
							<span class="mod-icon">🏛️</span>
							<span class="mod-title">Concert Hall Reverb</span>
							<span class="mod-status">${dsp.reverbEnabled ? "ACTIVE" : "BYPASSED"}</span>
						</div>
						<p>Preset: ${dsp.reverbPreset} | Decay: ${dsp.reverbDecay}s | Mix: ${Math.round(dsp.reverbMix * 100)}%</p>
					</div>
				</div>
			</div>
		</div>
	`;

	// Sync DSP to engines right away
	syncDspToEngines();

	// -------------------------------------------------------------
	// TAB SWITCHING
	// -------------------------------------------------------------
	for (const btn of root.querySelectorAll<HTMLButtonElement>(".studio-tab-btn")) {
		btn.addEventListener("click", () => {
			activeStudioTab = btn.dataset.tab as any;
			sfx.click();
			renderEqualizer(root);
		});
	}

	// SCOPE MODE SWITCHING
	for (const pill of root.querySelectorAll<HTMLButtonElement>(".scope-pill")) {
		pill.addEventListener("click", () => {
			activeScopeMode = pill.dataset.scope as any;
			sfx.click();
			root.querySelectorAll(".scope-pill").forEach((p) => p.classList.remove("active"));
			pill.classList.add("active");
		});
	}

	// -------------------------------------------------------------
	// TOP ACTIONS
	// -------------------------------------------------------------
	document.getElementById("studio-btn-nodes")?.addEventListener("click", () => {
		sfx.click();
		navigate("nodes");
	});

	document.getElementById("studio-btn-reset-fx")?.addEventListener("click", () => {
		sfx.toggle();
		state.settings.dsp = { ...DEFAULT_DSP_SETTINGS };
		state.settings.eq = [...DEFAULT_DSP_SETTINGS.eq];
		state.settings.eqPreset = DEFAULT_DSP_SETTINGS.eqPreset;
		state.settings.preAmp = 0;
		syncDspToEngines();
		saveSettings();
		toast("All audio DSP effects reset to default", { ttl: 2000 });
		renderEqualizer(root);
	});

	document.getElementById("eq-save")?.addEventListener("click", () => {
		const name = prompt("Name this custom preset:")?.trim();
		if (!name) return;
		if (EQ_PRESETS[name]) {
			toast(`"${name}" is a built-in preset name — please choose another.`, { ttl: 3000 });
			return;
		}
		state.settings.customEqPresets[name] = [...state.settings.dsp.eq];
		state.settings.dsp.eqPreset = name;
		state.settings.eqPreset = name;
		saveSettings();
		sfx.success();
		renderEqualizer(root);
	});

	// -------------------------------------------------------------
	// 10-BAND EQ SLIDERS & PRESETS
	// -------------------------------------------------------------
	for (const p of root.querySelectorAll<HTMLDivElement>("#eq-presets .preset-chip")) {
		p.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).dataset.del) {
				const name = (e.target as HTMLElement).dataset.del!;
				delete state.settings.customEqPresets[name];
				if (state.settings.dsp.eqPreset === name) {
					state.settings.dsp.eqPreset = "Anime J-Pop";
					state.settings.eqPreset = "Anime J-Pop";
					state.settings.dsp.eq = [...EQ_PRESETS["Anime J-Pop"]];
					state.settings.eq = [...EQ_PRESETS["Anime J-Pop"]];
				}
				syncDspToEngines();
				saveSettings();
				sfx.toggle();
				renderEqualizer(root);
				return;
			}
			const name = p.dataset.p!;
			state.settings.dsp.eqPreset = name;
			state.settings.eqPreset = name;
			const presetGains = EQ_PRESETS[name] ?? state.settings.customEqPresets[name] ?? EQ_PRESETS["Anime J-Pop"];
			state.settings.dsp.eq = [...presetGains];
			state.settings.eq = [...presetGains];
			syncDspToEngines();
			saveSettings();
			sfx.click();
			renderEqualizer(root);
		});
		p.addEventListener("mouseenter", () => sfx.hover());
	}

	for (const s of root.querySelectorAll<HTMLInputElement>(".eq-slider-input")) {
		syncRangeFill(s);
		s.addEventListener("input", () => {
			const i = parseInt(s.dataset.i!, 10);
			const v = parseInt(s.value, 10);
			state.settings.dsp.eq[i] = v;
			state.settings.eq[i] = v;
			state.settings.dsp.eqPreset = "Custom";
			state.settings.eqPreset = "Custom";
			syncDspToEngines();
			const badge = document.getElementById(`eqv-${i}`);
			if (badge) badge.textContent = `${v > 0 ? "+" : ""}${v} dB`;
			syncRangeFill(s);
			saveSettings();
		});
	}

	for (const b of root.querySelectorAll<HTMLButtonElement>(".eq-val-badge")) {
		b.addEventListener("click", () => {
			const col = b.closest<HTMLElement>(".eq-band-col");
			if (!col) return;
			const i = parseInt(col.dataset.idx!, 10);
			state.settings.dsp.eq[i] = 0;
			state.settings.eq[i] = 0;
			state.settings.dsp.eqPreset = "Custom";
			state.settings.eqPreset = "Custom";
			syncDspToEngines();
			const slider = col.querySelector<HTMLInputElement>(".eq-slider-input");
			if (slider) {
				slider.value = "0";
				syncRangeFill(slider);
			}
			b.textContent = "0 dB";
			sfx.toggle();
			saveSettings();
		});
	}

	// PreAmp Slider
	const preampSlider = root.querySelector<HTMLInputElement>("#eq-preamp-slider");
	const preampVal = root.querySelector<HTMLButtonElement>("#preamp-val");
	if (preampSlider && preampVal) {
		syncRangeFill(preampSlider);
		preampSlider.addEventListener("input", () => {
			const v = parseFloat(preampSlider.value);
			state.settings.preAmp = v;
			engineA.setPreAmp(v);
			engineB.setPreAmp(v);
			videoEngine.setPreAmp(v);
			preampVal.textContent = `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`;
			syncRangeFill(preampSlider);
			saveSettings();
		});
		preampVal.addEventListener("click", () => {
			state.settings.preAmp = 0;
			preampSlider.value = "0";
			engineA.setPreAmp(0);
			engineB.setPreAmp(0);
			videoEngine.setPreAmp(0);
			preampVal.textContent = "0.0 dB";
			syncRangeFill(preampSlider);
			sfx.toggle();
			saveSettings();
		});
	}

	// -------------------------------------------------------------
	// 8D SPATIAL CONTROLS
	// -------------------------------------------------------------
	const spatialToggle = root.querySelector<HTMLInputElement>("#spatial-toggle");
	spatialToggle?.addEventListener("change", () => {
		dsp.spatial8dEnabled = spatialToggle.checked;
		syncDspToEngines();
		saveSettings();
		sfx.toggle();
		renderEqualizer(root);
	});

	const spatialSpeedSlider = root.querySelector<HTMLInputElement>("#spatial-speed-slider");
	spatialSpeedSlider?.addEventListener("input", () => {
		dsp.spatial8dSpeed = parseFloat(spatialSpeedSlider.value);
		const label = document.getElementById("spatial-speed-val");
		if (label) label.textContent = `${dsp.spatial8dSpeed.toFixed(1)} s/cycle`;
		syncDspToEngines();
		saveSettings();
	});

	const spatialRadiusSlider = root.querySelector<HTMLInputElement>("#spatial-radius-slider");
	spatialRadiusSlider?.addEventListener("input", () => {
		dsp.spatial8dRadius = parseFloat(spatialRadiusSlider.value);
		const label = document.getElementById("spatial-radius-val");
		if (label) label.textContent = `${dsp.spatial8dRadius.toFixed(1)} m`;
		syncDspToEngines();
		saveSettings();
	});

	for (const pBtn of root.querySelectorAll<HTMLButtonElement>(".pattern-btn")) {
		pBtn.addEventListener("click", () => {
			dsp.spatial8dPattern = pBtn.dataset.pattern as any;
			root.querySelectorAll(".pattern-btn").forEach((b) => b.classList.remove("active"));
			pBtn.classList.add("active");
			syncDspToEngines();
			saveSettings();
			sfx.click();
		});
	}

	const dopplerToggle = root.querySelector<HTMLInputElement>("#spatial-doppler-toggle");
	dopplerToggle?.addEventListener("change", () => {
		dsp.spatial8dDoppler = dopplerToggle.checked;
		syncDspToEngines();
		saveSettings();
	});

	const elevToggle = root.querySelector<HTMLInputElement>("#spatial-elev-toggle");
	elevToggle?.addEventListener("change", () => {
		dsp.spatial8dElevation = elevToggle.checked;
		syncDspToEngines();
		saveSettings();
	});

	// -------------------------------------------------------------
	// LO-FI TAPE & VINYL CONTROLS
	// -------------------------------------------------------------
	const lofiMasterToggle = root.querySelector<HTMLInputElement>("#lofi-master-toggle");
	lofiMasterToggle?.addEventListener("change", () => {
		dsp.lofiEnabled = lofiMasterToggle.checked;
		syncDspToEngines();
		saveSettings();
		sfx.toggle();
		renderEqualizer(root);
	});

	const lofiWarmthSlider = root.querySelector<HTMLInputElement>("#lofi-warmth-slider");
	lofiWarmthSlider?.addEventListener("input", () => {
		dsp.lofiWarmth = parseFloat(lofiWarmthSlider.value);
		const label = document.getElementById("lofi-warmth-val");
		if (label) label.textContent = `${Math.round(dsp.lofiWarmth * 100)}%`;
		syncDspToEngines();
		saveSettings();
	});

	const lofiToneSlider = root.querySelector<HTMLInputElement>("#lofi-tone-slider");
	lofiToneSlider?.addEventListener("input", () => {
		dsp.lofiTone = parseFloat(lofiToneSlider.value);
		const label = document.getElementById("lofi-tone-val");
		if (label) label.textContent = `${Math.round(dsp.lofiTone)} Hz`;
		syncDspToEngines();
		saveSettings();
	});

	const lofiWowSlider = root.querySelector<HTMLInputElement>("#lofi-wow-slider");
	lofiWowSlider?.addEventListener("input", () => {
		dsp.lofiWowFlutter = parseFloat(lofiWowSlider.value);
		const label = document.getElementById("lofi-wow-val");
		if (label) label.textContent = `${Math.round(dsp.lofiWowFlutter * 100)}%`;
		syncDspToEngines();
		saveSettings();
	});

	const lofiWowRateSlider = root.querySelector<HTMLInputElement>("#lofi-wowrate-slider");
	lofiWowRateSlider?.addEventListener("input", () => {
		dsp.lofiWowRate = parseFloat(lofiWowRateSlider.value);
		const label = document.getElementById("lofi-wowrate-val");
		if (label) label.textContent = `${dsp.lofiWowRate.toFixed(1)} Hz`;
		syncDspToEngines();
		saveSettings();
	});

	const lofiCrackleSlider = root.querySelector<HTMLInputElement>("#lofi-crackle-slider");
	lofiCrackleSlider?.addEventListener("input", () => {
		dsp.lofiCrackle = parseFloat(lofiCrackleSlider.value);
		const label = document.getElementById("lofi-crackle-val");
		if (label) label.textContent = `${Math.round(dsp.lofiCrackle * 100)}%`;
		syncDspToEngines();
		saveSettings();
	});

	// -------------------------------------------------------------
	// CONCERT HALL & WIDENER CONTROLS
	// -------------------------------------------------------------
	const widenerToggle = root.querySelector<HTMLInputElement>("#widener-toggle");
	widenerToggle?.addEventListener("change", () => {
		dsp.widenerEnabled = widenerToggle.checked;
		syncDspToEngines();
		saveSettings();
		sfx.toggle();
		renderEqualizer(root);
	});

	const widenerWidthSlider = root.querySelector<HTMLInputElement>("#widener-width-slider");
	widenerWidthSlider?.addEventListener("input", () => {
		dsp.stereoWidth = parseFloat(widenerWidthSlider.value);
		const label = document.getElementById("widener-width-val");
		if (label) label.textContent = `${Math.round(dsp.stereoWidth * 100)}%`;
		syncDspToEngines();
		saveSettings();
	});

	const reverbToggle = root.querySelector<HTMLInputElement>("#reverb-toggle");
	reverbToggle?.addEventListener("change", () => {
		dsp.reverbEnabled = reverbToggle.checked;
		syncDspToEngines();
		saveSettings();
		sfx.toggle();
		renderEqualizer(root);
	});

	for (const rBtn of root.querySelectorAll<HTMLButtonElement>(".reverb-p-btn")) {
		rBtn.addEventListener("click", () => {
			dsp.reverbPreset = rBtn.dataset.preset as any;
			root.querySelectorAll(".reverb-p-btn").forEach((b) => b.classList.remove("active"));
			rBtn.classList.add("active");
			syncDspToEngines();
			saveSettings();
			sfx.click();
		});
	}

	const reverbDecaySlider = root.querySelector<HTMLInputElement>("#reverb-decay-slider");
	reverbDecaySlider?.addEventListener("input", () => {
		dsp.reverbDecay = parseFloat(reverbDecaySlider.value);
		const label = document.getElementById("reverb-decay-val");
		if (label) label.textContent = `${dsp.reverbDecay.toFixed(1)} s`;
		syncDspToEngines();
		saveSettings();
	});

	const reverbMixSlider = root.querySelector<HTMLInputElement>("#reverb-mix-slider");
	reverbMixSlider?.addEventListener("input", () => {
		dsp.reverbMix = parseFloat(reverbMixSlider.value);
		const label = document.getElementById("reverb-mix-val");
		if (label) label.textContent = `${Math.round(dsp.reverbMix * 100)}%`;
		syncDspToEngines();
		saveSettings();
	});

	// -------------------------------------------------------------
	// REAL-TIME CANVASES & ANIMATION LOOP
	// -------------------------------------------------------------
	const scopeCanvas = root.querySelector<HTMLCanvasElement>("#studio-scope-canvas");
	const curveCanvas = root.querySelector<HTMLCanvasElement>("#eq-curve-canvas");
	const radarCanvas = root.querySelector<HTMLCanvasElement>("#radar-8d-canvas");
	const tapeCurveCanvas = root.querySelector<HTMLCanvasElement>("#tape-curve-canvas");
	const cassetteCanvas = root.querySelector<HTMLCanvasElement>("#cassette-reels-canvas");
	const widenerPhaseCanvas = root.querySelector<HTMLCanvasElement>("#widener-phase-canvas");

	// Setup Frequency Response Curve Interaction
	if (curveCanvas) {
		let isDraggingNode = false;
		let dragIndex = -1;

		const getCanvasCoord = (e: MouseEvent) => {
			const rect = curveCanvas.getBoundingClientRect();
			return {
				x: (e.clientX - rect.left) * (curveCanvas.width / rect.width),
				y: (e.clientY - rect.top) * (curveCanvas.height / rect.height),
			};
		};

		curveCanvas.addEventListener("mousedown", (e) => {
			const { x, y } = getCanvasCoord(e);
			const w = curveCanvas.width;
			const h = curveCanvas.height;
			const minF = Math.log10(20);
			const maxF = Math.log10(20000);

			for (let i = 0; i < EQ_BANDS.length; i++) {
				const f = EQ_BANDS[i]!;
				const nodeX = ((Math.log10(f) - minF) / (maxF - minF)) * (w - 40) + 20;
				const gain = dsp.eq[i] ?? 0;
				const nodeY = h / 2 - (gain / 24) * (h / 2 - 15);
				const dist = Math.hypot(x - nodeX, y - nodeY);
				if (dist < 14) {
					isDraggingNode = true;
					dragIndex = i;
					break;
				}
			}
		});

		window.addEventListener("mousemove", (e) => {
			if (!isDraggingNode || dragIndex < 0) return;
			const rect = curveCanvas.getBoundingClientRect();
			const relY = (e.clientY - rect.top) / rect.height;
			const clampedY = Math.max(0, Math.min(1, relY));
			const gain = Math.round((0.5 - clampedY) * 48);
			dsp.eq[dragIndex] = Math.max(-24, Math.min(24, gain));
			state.settings.eq[dragIndex] = dsp.eq[dragIndex];
			dsp.eqPreset = "Custom";
			state.settings.eqPreset = "Custom";
			syncDspToEngines();

			const badge = document.getElementById(`eqv-${dragIndex}`);
			if (badge) badge.textContent = `${gain > 0 ? "+" : ""}${gain} dB`;
			const slider = root.querySelector<HTMLInputElement>(`.eq-slider-input[data-i="${dragIndex}"]`);
			if (slider) {
				slider.value = `${gain}`;
				syncRangeFill(slider);
			}
		});

		window.addEventListener("mouseup", () => {
			if (isDraggingNode) {
				isDraggingNode = false;
				dragIndex = -1;
				saveSettings();
			}
		});
	}

	// Setup Interactive Radar Canvas
	if (radarCanvas) {
		let isDraggingRadar = false;
		const handleRadarMove = (e: MouseEvent) => {
			const rect = radarCanvas.getBoundingClientRect();
			const cx = rect.width / 2;
			const cy = rect.height / 2;
			const nx = (e.clientX - rect.left - cx) / cx;
			const nz = (e.clientY - rect.top - cy) / cy;
			dsp.spatial8dManual = true;
			dsp.spatial8dManualX = Math.max(-1, Math.min(1, nx));
			dsp.spatial8dManualZ = Math.max(-1, Math.min(1, nz));
			syncDspToEngines();
		};

		radarCanvas.addEventListener("mousedown", (e) => {
			isDraggingRadar = true;
			handleRadarMove(e);
		});
		window.addEventListener("mousemove", (e) => {
			if (isDraggingRadar) handleRadarMove(e);
		});
		window.addEventListener("mouseup", () => {
			if (isDraggingRadar) {
				isDraggingRadar = false;
				saveSettings();
			}
		});
		radarCanvas.addEventListener("dblclick", () => {
			dsp.spatial8dManual = false;
			syncDspToEngines();
			sfx.toggle();
			toast("Automated 8D orbital trajectory resumed", { ttl: 2000 });
		});
	}

	// -------------------------------------------------------------
	// MAIN 60FPS STUDIO ANIMATION LOOP
	// -------------------------------------------------------------
	let tapeReelAngle = 0;
	let radarSweepAngle = 0;

	const sampleFreqs = new Float32Array(256);
	const minLog = Math.log10(20);
	const maxLog = Math.log10(20000);
	for (let i = 0; i < 256; i++) {
		sampleFreqs[i] = Math.pow(10, minLog + (i / 255) * (maxLog - minLog));
	}

	const renderStudioFrame = () => {
		if (!document.body.contains(root)) {
			studioAnimRaf = null;
			return;
		}

		const audioData = engine.getRealtimeAudioData(1024);

		// 1. Update VU Meters & Clip Indicator
		const meterL = document.getElementById("scope-meter-l");
		const meterR = document.getElementById("scope-meter-r");
		const valL = document.getElementById("scope-val-l");
		const valR = document.getElementById("scope-val-r");
		const clipLed = document.getElementById("scope-clip-led");

		const dbL = audioData.rmsL > 0.0001 ? Math.max(-60, 20 * Math.log10(audioData.rmsL)) : -60;
		const dbR = audioData.rmsR > 0.0001 ? Math.max(-60, 20 * Math.log10(audioData.rmsR)) : -60;
		const pctL = Math.min(100, Math.max(0, ((dbL + 60) / 60) * 100));
		const pctR = Math.min(100, Math.max(0, ((dbR + 60) / 60) * 100));

		if (meterL) meterL.style.width = `${pctL}%`;
		if (meterR) meterR.style.width = `${pctR}%`;
		if (valL) valL.textContent = `${dbL.toFixed(1)} dB`;
		if (valR) valR.textContent = `${dbR.toFixed(1)} dB`;
		if (clipLed) {
			if (audioData.peakL >= 0.98 || audioData.peakR >= 0.98) {
				clipLed.classList.add("active");
			} else {
				clipLed.classList.remove("active");
			}
		}

		// 2. Render Master Scope Canvas
		if (scopeCanvas) {
			if (scopeCanvas.width !== scopeCanvas.clientWidth) {
				scopeCanvas.width = scopeCanvas.clientWidth;
			}
			const ctx = scopeCanvas.getContext("2d");
			if (ctx) {
				const w = scopeCanvas.width;
				const h = scopeCanvas.height;

				// Background clear with dark phosphor decay
				ctx.fillStyle = "rgba(10, 8, 20, 0.35)";
				ctx.fillRect(0, 0, w, h);

				// Grid Lines
				ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
				ctx.lineWidth = 1;
				ctx.beginPath();
				ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
				ctx.moveTo(0, h / 4); ctx.lineTo(w, h / 4);
				ctx.moveTo(0, (3 * h) / 4); ctx.lineTo(w, (3 * h) / 4);
				for (let x = 0; x < w; x += 60) {
					ctx.moveTo(x, 0); ctx.lineTo(x, h);
				}
				ctx.stroke();

				if (activeScopeMode === "dual" || activeScopeMode === "spectrum") {
					// Render Logarithmic Spectrum Bars
					const freqBins = audioData.frequency;
					const numBars = 84;
					const barWidth = (w / numBars) - 1.5;
					const barHScale = activeScopeMode === "dual" ? h * 0.48 : h * 0.88;
					const baseY = h - 4;

					for (let b = 0; b < numBars; b++) {
						const logIdx = Math.floor(Math.pow(b / numBars, 1.6) * (freqBins.length - 1));
						const val = (freqBins[logIdx] ?? 0) / 255;
						const barHeight = Math.max(2, val * barHScale);
						const x = b * (barWidth + 1.5) + 2;
						const y = baseY - barHeight;

						const grad = ctx.createLinearGradient(0, y, 0, baseY);
						grad.addColorStop(0, "#00f3ff");
						grad.addColorStop(0.5, "#a78bfa");
						grad.addColorStop(1, "#ff2a85");

						ctx.fillStyle = grad;
						ctx.shadowColor = "#a78bfa";
						ctx.shadowBlur = val > 0.6 ? 8 : 2;
						ctx.fillRect(x, y, barWidth, barHeight);
					}
					ctx.shadowBlur = 0;
				}

				if (activeScopeMode === "dual" || activeScopeMode === "scope") {
					// Render Oscilloscope Time-Domain Waveform
					const timeBuf = audioData.timeDomain;
					const waveYOffset = activeScopeMode === "dual" ? h * 0.28 : h * 0.5;
					const waveHeight = activeScopeMode === "dual" ? h * 0.24 : h * 0.45;

					ctx.lineWidth = 2;
					ctx.strokeStyle = "#00f3ff";
					ctx.shadowColor = "rgba(0, 243, 255, 0.8)";
					ctx.shadowBlur = 10;
					ctx.beginPath();

					const slice = w / timeBuf.length;
					for (let i = 0; i < timeBuf.length; i++) {
						const v = (timeBuf[i]! - 128) / 128;
						const y = waveYOffset + v * waveHeight;
						const x = i * slice;
						if (i === 0) ctx.moveTo(x, y);
						else ctx.lineTo(x, y);
					}
					ctx.stroke();
					ctx.shadowBlur = 0;
				}

				if (activeScopeMode === "phase") {
					// Render Lissajous Phase Scope
					const timeBuf = audioData.timeDomain;
					const cx = w / 2;
					const cy = h / 2;
					const scale = Math.min(w, h) * 0.42;

					ctx.lineWidth = 1.5;
					ctx.strokeStyle = "#ff2a85";
					ctx.shadowColor = "#ff2a85";
					ctx.shadowBlur = 8;
					ctx.beginPath();

					for (let i = 0; i < timeBuf.length - 2; i += 2) {
						const l = (timeBuf[i]! - 128) / 128;
						const r = (timeBuf[i + 1]! - 128) / 128;
						const px = cx + (l - r) * 0.707 * scale;
						const py = cy - (l + r) * 0.707 * scale;
						if (i === 0) ctx.moveTo(px, py);
						else ctx.lineTo(px, py);
					}
					ctx.stroke();
					ctx.shadowBlur = 0;
				}
			}
		}

		// 3. Render Frequency Response Curve Canvas
		if (curveCanvas && activeStudioTab === "eq") {
			if (curveCanvas.width !== curveCanvas.clientWidth) {
				curveCanvas.width = curveCanvas.clientWidth;
			}
			const ctx = curveCanvas.getContext("2d");
			if (ctx) {
				const w = curveCanvas.width;
				const h = curveCanvas.height;
				ctx.clearRect(0, 0, w, h);

				// Background
				ctx.fillStyle = "rgba(12, 10, 24, 0.7)";
				ctx.fillRect(0, 0, w, h);

				// Guide Lines
				ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
				ctx.lineWidth = 1;
				ctx.beginPath();
				const midY = h / 2;
				ctx.moveTo(0, midY); ctx.lineTo(w, midY); // 0 dB line
				ctx.moveTo(0, midY - (12 / 24) * (midY - 15)); ctx.lineTo(w, midY - (12 / 24) * (midY - 15)); // +12 dB
				ctx.moveTo(0, midY + (12 / 24) * (midY - 15)); ctx.lineTo(w, midY + (12 / 24) * (midY - 15)); // -12 dB
				ctx.stroke();

				// Evaluate Biquad Filter Response Curve
				const dbs = engine.getBiquadFrequencyResponse(sampleFreqs);

				// Draw Gradient Area Under Curve
				ctx.beginPath();
				ctx.moveTo(20, midY);
				for (let i = 0; i < sampleFreqs.length; i++) {
					const x = (i / (sampleFreqs.length - 1)) * (w - 40) + 20;
					const y = midY - (dbs[i]! / 24) * (midY - 15);
					ctx.lineTo(x, y);
				}
				ctx.lineTo(w - 20, midY);
				ctx.closePath();

				const fillGrad = ctx.createLinearGradient(0, 10, 0, h - 10);
				fillGrad.addColorStop(0, "rgba(167, 139, 250, 0.45)");
				fillGrad.addColorStop(0.5, "rgba(255, 42, 133, 0.15)");
				fillGrad.addColorStop(1, "rgba(0, 243, 255, 0.02)");
				ctx.fillStyle = fillGrad;
				ctx.fill();

				// Draw Curve Line
				ctx.beginPath();
				for (let i = 0; i < sampleFreqs.length; i++) {
					const x = (i / (sampleFreqs.length - 1)) * (w - 40) + 20;
					const y = midY - (dbs[i]! / 24) * (midY - 15);
					if (i === 0) ctx.moveTo(x, y);
					else ctx.lineTo(x, y);
				}
				ctx.strokeStyle = "#a78bfa";
				ctx.lineWidth = 2.5;
				ctx.shadowColor = "#ff2a85";
				ctx.shadowBlur = 10;
				ctx.stroke();
				ctx.shadowBlur = 0;

				// Draw 10 Frequency Band Node Circles
				for (let i = 0; i < EQ_BANDS.length; i++) {
					const f = EQ_BANDS[i]!;
					const nodeX = ((Math.log10(f) - minLog) / (maxLog - minLog)) * (w - 40) + 20;
					const gain = dsp.eq[i] ?? 0;
					const nodeY = midY - (gain / 24) * (midY - 15);

					ctx.beginPath();
					ctx.arc(nodeX, nodeY, 5.5, 0, 2 * Math.PI);
					ctx.fillStyle = "#ffffff";
					ctx.shadowColor = "#00f3ff";
					ctx.shadowBlur = 10;
					ctx.fill();
					ctx.strokeStyle = "#a78bfa";
					ctx.lineWidth = 2;
					ctx.stroke();
					ctx.shadowBlur = 0;
				}
			}
		}

		// 4. Render 3D Binaural Radar Canvas
		if (radarCanvas && activeStudioTab === "spatial") {
			const ctx = radarCanvas.getContext("2d");
			if (ctx) {
				const w = radarCanvas.width;
				const h = radarCanvas.height;
				const cx = w / 2;
				const cy = h / 2;
				const rMax = w / 2 - 12;

				ctx.clearRect(0, 0, w, h);

				// Dark Radar Backdrop
				ctx.fillStyle = "rgba(10, 8, 22, 0.9)";
				ctx.beginPath();
				ctx.arc(cx, cy, rMax, 0, 2 * Math.PI);
				ctx.fill();

				// Concentric Distance Rings
				ctx.strokeStyle = "rgba(0, 243, 255, 0.22)";
				ctx.lineWidth = 1;
				[0.25, 0.5, 0.75, 1.0].forEach((ratio) => {
					ctx.beginPath();
					ctx.arc(cx, cy, rMax * ratio, 0, 2 * Math.PI);
					ctx.stroke();
				});

				// Crosshair axes
				ctx.beginPath();
				ctx.moveTo(cx, cy - rMax); ctx.lineTo(cx, cy + rMax);
				ctx.moveTo(cx - rMax, cy); ctx.lineTo(cx + rMax, cy);
				ctx.stroke();

				// Spinning Radar Phosphor Beam
				if (dsp.spatial8dEnabled && !dsp.spatial8dManual) {
					radarSweepAngle = (radarSweepAngle + 0.035) % (2 * Math.PI);
					ctx.save();
					ctx.translate(cx, cy);
					ctx.rotate(radarSweepAngle);
					const beamGrad = ctx.createLinearGradient(0, 0, rMax, 0);
					beamGrad.addColorStop(0, "rgba(0, 243, 255, 0.4)");
					beamGrad.addColorStop(1, "rgba(0, 243, 255, 0)");
					ctx.fillStyle = beamGrad;
					ctx.beginPath();
					ctx.moveTo(0, 0);
					ctx.arc(0, 0, rMax, -0.3, 0);
					ctx.closePath();
					ctx.fill();
					ctx.restore();
				}

				// Sound Source Particle Coordinates
				const coords = engine.getSpatialCoordinates();
				const coordLabel = document.getElementById("radar-coords-label");
				if (coordLabel) {
					const deg = Math.round((coords.angle * 180) / Math.PI) % 360;
					coordLabel.textContent = `X: ${coords.x > 0 ? "+" : ""}${coords.x.toFixed(1)}m | Z: ${coords.z > 0 ? "+" : ""}${coords.z.toFixed(1)}m | θ: ${deg}°`;
				}

				// Plot Orbiting Sound Source Orb
				const px = cx + (coords.x / 10) * rMax;
				const pz = cy + (coords.z / 10) * rMax;

				// Particle Halo
				ctx.beginPath();
				ctx.arc(px, pz, 10, 0, 2 * Math.PI);
				ctx.fillStyle = "rgba(255, 42, 133, 0.35)";
				ctx.fill();

				// Particle Core
				ctx.beginPath();
				ctx.arc(px, pz, 5.5, 0, 2 * Math.PI);
				ctx.fillStyle = "#ffffff";
				ctx.shadowColor = "#ff2a85";
				ctx.shadowBlur = 14;
				ctx.fill();
				ctx.shadowBlur = 0;
			}
		}

		// 5. Render Cassette Tape Animation Canvas
		if (cassetteCanvas && activeStudioTab === "lofi") {
			const ctx = cassetteCanvas.getContext("2d");
			if (ctx) {
				const w = cassetteCanvas.width;
				const h = cassetteCanvas.height;
				ctx.clearRect(0, 0, w, h);

				if (!engine.paused) {
					tapeReelAngle = (tapeReelAngle + 0.04 * (state.settings.speed || 1)) % (2 * Math.PI);
				}

				// Dual Reel Spindles
				[60, w - 60].forEach((rx) => {
					ctx.save();
					ctx.translate(rx, h / 2);
					ctx.rotate(tapeReelAngle);

					// Outer Hub
					ctx.beginPath();
					ctx.arc(0, 0, 22, 0, 2 * Math.PI);
					ctx.fillStyle = "rgba(255, 255, 255, 0.06)";
					ctx.fill();
					ctx.strokeStyle = "rgba(244, 114, 182, 0.6)";
					ctx.lineWidth = 1.5;
					ctx.stroke();

					// Inner spokes
					for (let s = 0; s < 3; s++) {
						ctx.rotate((2 * Math.PI) / 3);
						ctx.beginPath();
						ctx.moveTo(0, 0); ctx.lineTo(18, 0);
						ctx.stroke();
					}
					ctx.restore();
				});

				// Tape ribbon span
				ctx.beginPath();
				ctx.moveTo(60, h / 2 + 18);
				ctx.lineTo(w - 60, h / 2 + 18);
				ctx.strokeStyle = "rgba(167, 139, 250, 0.4)";
				ctx.lineWidth = 2;
				ctx.stroke();
			}
		}

		// 6. Render Tape Saturation Transfer Curve
		if (tapeCurveCanvas && activeStudioTab === "lofi") {
			const ctx = tapeCurveCanvas.getContext("2d");
			if (ctx) {
				const w = tapeCurveCanvas.width;
				const h = tapeCurveCanvas.height;
				ctx.clearRect(0, 0, w, h);

				ctx.fillStyle = "rgba(12, 10, 22, 0.8)";
				ctx.fillRect(0, 0, w, h);

				ctx.strokeStyle = "rgba(255, 255, 255, 0.06)";
				ctx.beginPath();
				ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2);
				ctx.moveTo(w / 2, 0); ctx.lineTo(w / 2, h);
				ctx.stroke();

				// Plot soft-knee saturation
				ctx.beginPath();
				const warmth = dsp.lofiWarmth;
				const k = warmth * 3.5;
				for (let x = 0; x < w; x++) {
					const inVal = ((x / (w - 1)) * 2 - 1);
					const x2 = inVal + 0.12 * inVal * inVal;
					const sat = Math.tanh(x2 * (1 + k)) / Math.tanh(1 + k);
					const y = h / 2 - sat * (h / 2 - 8);
					if (x === 0) ctx.moveTo(x, y);
					else ctx.lineTo(x, y);
				}
				ctx.strokeStyle = "#f472b6";
				ctx.lineWidth = 2;
				ctx.stroke();
			}
		}

		// 7. Render Haas Widener Phase Scope Canvas
		if (widenerPhaseCanvas && activeStudioTab === "hall") {
			const ctx = widenerPhaseCanvas.getContext("2d");
			if (ctx) {
				const w = widenerPhaseCanvas.width;
				const h = widenerPhaseCanvas.height;
				ctx.clearRect(0, 0, w, h);

				ctx.fillStyle = "rgba(12, 10, 22, 0.8)";
				ctx.fillRect(0, 0, w, h);

				const widthRatio = dsp.widenerEnabled ? dsp.stereoWidth : 1.0;
				const cx = w / 2;
				const cy = h / 2;

				ctx.strokeStyle = "rgba(0, 243, 255, 0.6)";
				ctx.lineWidth = 2;
				ctx.beginPath();
				ctx.ellipse(cx, cy, Math.max(10, widthRatio * 45), 25, 0, 0, 2 * Math.PI);
				ctx.stroke();
			}
		}

		studioAnimRaf = requestAnimationFrame(renderStudioFrame);
	};

	studioAnimRaf = requestAnimationFrame(renderStudioFrame);
}


// ---------- Custom Playlist Art Generator & Playlist Manager ----------
type ArtThemePreset = "sakura_sunset" | "cyber_neotokyo" | "ghibli_emerald" | "midnight_shogun" | "ocean_shinkai" | "retro_synthwave";

const ART_THEMES: Record<ArtThemePreset, { name: string; bg1: string; bg2: string; bg3: string; accent: string; iconRing: string }> = {
	sakura_sunset:   { name: "🌸 Sakura Sunset",   bg1: "#2b0a1f", bg2: "#831843", bg3: "#f472b6", accent: "#fbcfe8", iconRing: "rgba(244, 114, 182, 0.4)" },
	cyber_neotokyo:  { name: "⚡ Cyber NeoTokyo",  bg1: "#060913", bg2: "#1e1b4b", bg3: "#06b6d4", accent: "#22d3ee", iconRing: "rgba(6, 182, 212, 0.45)" },
	ghibli_emerald:  { name: "🍃 Ghibli Emerald",  bg1: "#022c22", bg2: "#065f46", bg3: "#10b981", accent: "#6ee7b7", iconRing: "rgba(16, 185, 129, 0.4)" },
	midnight_shogun: { name: "⚔️ Midnight Shogun", bg1: "#09090b", bg2: "#312e81", bg3: "#6366f1", accent: "#a5b4fc", iconRing: "rgba(99, 102, 241, 0.45)" },
	ocean_shinkai:   { name: "🌊 Ocean Shinkai",   bg1: "#030712", bg2: "#0c4a6e", bg3: "#0284c7", accent: "#38bdf8", iconRing: "rgba(2, 132, 199, 0.45)" },
	retro_synthwave: { name: "🌆 Retro Synthwave", bg1: "#180428", bg2: "#701a75", bg3: "#fb923c", accent: "#fde047", iconRing: "rgba(251, 146, 60, 0.45)" },
};

function renderArtOnCanvas(
	canvas: HTMLCanvasElement,
	opts: {
		title: string;
		subtitle: string;
		theme: ArtThemePreset;
		emblem: string;
		customImg?: HTMLImageElement | null;
	}
) {
	const ctx = canvas.getContext("2d");
	if (!ctx) return;
	const W = canvas.width;
	const H = canvas.height;
	const t = ART_THEMES[opts.theme] ?? ART_THEMES.sakura_sunset;

	ctx.clearRect(0, 0, W, H);

	// 1. Background Gradient
	const grad = ctx.createLinearGradient(0, 0, W, H);
	grad.addColorStop(0, t.bg1);
	grad.addColorStop(0.55, t.bg2);
	grad.addColorStop(1, t.bg3);
	ctx.fillStyle = grad;
	ctx.fillRect(0, 0, W, H);

	// 2. Custom Image Overlay or Themed Generative Elements
	if (opts.customImg && opts.customImg.complete) {
		ctx.save();
		ctx.globalAlpha = 0.45;
		ctx.drawImage(opts.customImg, 0, 0, W, H);
		ctx.restore();
	} else {
		// Generative art elements per theme
		ctx.save();
		if (opts.theme === "cyber_neotokyo" || opts.theme === "retro_synthwave") {
			// Perspective grid
			ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
			ctx.lineWidth = 1.5;
			const horizon = H * 0.62;
			for (let y = horizon; y <= H; y += (y - horizon + 12) * 0.4) {
				ctx.beginPath();
				ctx.moveTo(0, y);
				ctx.lineTo(W, y);
				ctx.stroke();
			}
			for (let x = -W * 0.5; x <= W * 1.5; x += 48) {
				ctx.beginPath();
				ctx.moveTo(W * 0.5, horizon);
				ctx.lineTo(x, H);
				ctx.stroke();
			}
		} else if (opts.theme === "sakura_sunset") {
			// Floating sakura petals
			ctx.fillStyle = "rgba(255, 255, 255, 0.22)";
			for (let i = 0; i < 18; i++) {
				const px = (i * 37 + 23) % W;
				const py = (i * 47 + 51) % (H * 0.7);
				const pr = 6 + (i % 5);
				ctx.beginPath();
				ctx.ellipse(px, py, pr * 1.8, pr, Math.PI / 4 + i * 0.2, 0, Math.PI * 2);
				ctx.fill();
			}
		} else if (opts.theme === "ocean_shinkai") {
			// Caustic circles
			ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
			ctx.lineWidth = 2;
			for (let r = 60; r <= 280; r += 40) {
				ctx.beginPath();
				ctx.arc(W * 0.5, H * 0.45, r, 0, Math.PI * 2);
				ctx.stroke();
			}
		}
		ctx.restore();
	}

	// 3. Central Emblem Stage
	const cx = W * 0.5;
	const cy = H * 0.42;
	const ringR = 88;

	// Outer Glow
	const radial = ctx.createRadialGradient(cx, cy, 30, cx, cy, ringR * 1.4);
	radial.addColorStop(0, t.iconRing);
	radial.addColorStop(1, "transparent");
	ctx.fillStyle = radial;
	ctx.beginPath();
	ctx.arc(cx, cy, ringR * 1.4, 0, Math.PI * 2);
	ctx.fill();

	// Glass Emblem Circle
	ctx.save();
	ctx.fillStyle = "rgba(10, 10, 20, 0.65)";
	ctx.strokeStyle = t.accent;
	ctx.lineWidth = 4;
	ctx.beginPath();
	ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
	ctx.fill();
	ctx.stroke();

	// Emblem Emoji / Icon
	ctx.font = "76px sans-serif";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(opts.emblem || "🌸", cx, cy + 4);
	ctx.restore();

	// 4. Cel-Shaded Typography (Title + Subtitle)
	ctx.save();
	ctx.textAlign = "center";
	
	// Top Header Tag
	ctx.font = "bold 16px 'Space Grotesk', system-ui, sans-serif";
	ctx.fillStyle = t.accent;
	ctx.letterSpacing = "4px";
	ctx.fillText("LAKKY PLAYLIST", cx, 64);

	// Main Title
	const titleText = opts.title.trim() || "Untitled Playlist";
	ctx.font = "bold 34px 'Plus Jakarta Sans', system-ui, sans-serif";
	// Shadow / Cel Outline
	ctx.lineWidth = 7;
	ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
	ctx.strokeText(titleText.slice(0, 22), cx, H - 76);
	ctx.fillStyle = "#ffffff";
	ctx.fillText(titleText.slice(0, 22), cx, H - 76);

	// Subtitle
	const subText = opts.subtitle.trim() || `${t.name.split(" ")[1] || "Curated"} Collection`;
	ctx.font = "500 15px 'Plus Jakarta Sans', system-ui, sans-serif";
	ctx.fillStyle = "rgba(255, 255, 255, 0.75)";
	ctx.fillText(subText.slice(0, 36), cx, H - 42);
	ctx.restore();
}

function openPlaylistArtGenerator(
	existing?: { name: string; artDataUrl?: string; description?: string; ids: string[] },
	onSave?: (name: string, artDataUrl: string, description: string) => void
) {
	let curTheme: ArtThemePreset = "sakura_sunset";
	let curEmblem = "🌸";
	let curTitle = existing?.name ?? "My Favorite Anime Tracks";
	let curDesc = existing?.description ?? "A curated collection in Lakky Player";
	let customImg: HTMLImageElement | null = null;

	const emblems = ["🌸", "💿", "🎵", "⚡", "⚔️", "🎧", "🌙", "💖", "🌌", "📼", "🔥", "📻"];

	const overlay = document.createElement("div");
	overlay.className = "modal-overlay art-generator-modal";
	overlay.innerHTML = `
		<div class="modal art-gen-modal-body">
			<div class="art-gen-layout">
				<div class="art-gen-preview-pane">
					<div class="art-canvas-frame">
						<canvas id="art-gen-canvas" width="512" height="512"></canvas>
					</div>
					<div class="art-gen-quick-actions">
						<button class="btn btn-ghost btn-sm" id="btn-art-randomize">${icons.dice}<span>Randomize</span></button>
						<label class="btn btn-ghost btn-sm" style="cursor:pointer">
							${icons.upload}<span>Upload Image</span>
							<input type="file" id="art-file-input" accept="image/*" style="display:none" />
						</label>
					</div>
				</div>

				<div class="art-gen-controls-pane">
					<h3>${existing ? "Edit Playlist & Cover Art" : "Create New Playlist"}</h3>
					<p class="modal-note">Generate custom cel-shaded vector art for your playlist.</p>

					<label>Playlist Name
						<input type="text" id="art-input-title" value="${escapeHtml(curTitle)}" placeholder="e.g. Neo Tokyo Nights" />
					</label>

					<label>Description / Subtitle
						<input type="text" id="art-input-desc" value="${escapeHtml(curDesc)}" placeholder="e.g. Best Lo-Fi & Synthwave" />
					</label>

					<label>Theme Style</label>
					<div class="art-theme-selector">
						${(Object.keys(ART_THEMES) as ArtThemePreset[]).map((k) => `
							<button class="art-theme-btn ${k === curTheme ? "active" : ""}" data-theme="${k}">
								${ART_THEMES[k].name}
							</button>
						`).join("")}
					</div>

					<label style="margin-top:0.8rem">Emblem Icon</label>
					<div class="art-emblem-selector">
						${emblems.map((em) => `
							<button class="art-emblem-btn ${em === curEmblem ? "active" : ""}" data-emblem="${em}">${em}</button>
						`).join("")}
					</div>

					<div class="modal-actions" style="margin-top:1.5rem">
						<button class="btn btn-ghost" id="art-gen-cancel">Cancel</button>
						<button class="btn btn-primary" id="art-gen-save">${icons.check}<span>${existing ? "Save Changes" : "Create Playlist"}</span></button>
					</div>
				</div>
			</div>
		</div>
	`;
	document.body.appendChild(overlay);

	const canvas = overlay.querySelector("#art-gen-canvas") as HTMLCanvasElement;
	const redraw = () => {
		renderArtOnCanvas(canvas, {
			title: curTitle,
			subtitle: curDesc,
			theme: curTheme,
			emblem: curEmblem,
			customImg,
		});
	};
	redraw();

	const titleInput = overlay.querySelector("#art-input-title") as HTMLInputElement;
	const descInput = overlay.querySelector("#art-input-desc") as HTMLInputElement;

	titleInput.addEventListener("input", () => {
		curTitle = titleInput.value;
		redraw();
	});
	descInput.addEventListener("input", () => {
		curDesc = descInput.value;
		redraw();
	});

	for (const btn of overlay.querySelectorAll<HTMLButtonElement>(".art-theme-btn")) {
		btn.addEventListener("click", () => {
			for (const b of overlay.querySelectorAll(".art-theme-btn")) b.classList.remove("active");
			btn.classList.add("active");
			curTheme = btn.dataset.theme as ArtThemePreset;
			sfx.toggle();
			redraw();
		});
	}

	for (const btn of overlay.querySelectorAll<HTMLButtonElement>(".art-emblem-btn")) {
		btn.addEventListener("click", () => {
			for (const b of overlay.querySelectorAll(".art-emblem-btn")) b.classList.remove("active");
			btn.classList.add("active");
			curEmblem = btn.dataset.emblem!;
			sfx.click();
			redraw();
		});
	}

	overlay.querySelector("#btn-art-randomize")?.addEventListener("click", () => {
		const themeKeys = Object.keys(ART_THEMES) as ArtThemePreset[];
		curTheme = themeKeys[Math.floor(Math.random() * themeKeys.length)];
		curEmblem = emblems[Math.floor(Math.random() * emblems.length)];
		for (const b of overlay.querySelectorAll(".art-theme-btn")) {
			b.classList.toggle("active", (b as HTMLElement).dataset.theme === curTheme);
		}
		for (const b of overlay.querySelectorAll(".art-emblem-btn")) {
			b.classList.toggle("active", (b as HTMLElement).dataset.emblem === curEmblem);
		}
		sfx.success();
		redraw();
	});

	overlay.querySelector("#art-file-input")?.addEventListener("change", (e) => {
		const f = (e.target as HTMLInputElement).files?.[0];
		if (!f) return;
		const reader = new FileReader();
		reader.onload = () => {
			const img = new Image();
			img.onload = () => {
				customImg = img;
				redraw();
			};
			img.src = reader.result as string;
		};
		reader.readAsDataURL(f);
	});

	const cleanup = () => overlay.remove();
	overlay.querySelector("#art-gen-cancel")?.addEventListener("click", cleanup);
	overlay.addEventListener("click", (e) => { if (e.target === overlay) cleanup(); });

	overlay.querySelector("#art-gen-save")?.addEventListener("click", async () => {
		const name = curTitle.trim() || "Untitled Playlist";
		const artDataUrl = canvas.toDataURL("image/png");
		const desc = curDesc.trim();

		if (onSave) {
			onSave(name, artDataUrl, desc);
		} else if (existing) {
			existing.name = name;
			existing.artDataUrl = artDataUrl;
			existing.description = desc;
			await savePlaylists();
			toast(`Updated "${name}"`, { ttl: 2000 });
		} else {
			state.playlists.push({
				name,
				ids: [],
				artDataUrl,
				description: desc,
			});
			await savePlaylists();
			state.activePlaylistName = name;
			toast(`Created playlist "${name}"`, { ttl: 2200 });
			sfx.success();
		}
		cleanup();
		renderMain();
		renderSidebarPlaylists();
	});
}

function openAddTracksToPlaylistModal(playlistName: string) {
	const pl = state.playlists.find((p) => p.name === playlistName);
	if (!pl) return;

	const overlay = document.createElement("div");
	overlay.className = "modal-overlay";
	overlay.innerHTML = `
		<div class="modal add-tracks-modal-body">
			<h3>Add Tracks to "${escapeHtml(pl.name)}"</h3>
			<p class="modal-note">Click any track to instantly add it to this playlist.</p>
			
			<div class="search-wrap cel-search" style="margin-bottom:1rem">
				${icons.search}
				<input class="search" id="modal-track-search" placeholder="Filter library tracks…" />
			</div>

			<div class="modal-track-checklist" id="modal-track-list">
				${renderModalTrackChecklist(pl)}
			</div>

			<div class="modal-actions" style="margin-top:1.2rem">
				<button class="btn btn-primary" id="modal-add-done">Done</button>
			</div>
		</div>
	`;
	document.body.appendChild(overlay);

	const cleanup = () => overlay.remove();
	overlay.querySelector("#modal-add-done")?.addEventListener("click", cleanup);
	overlay.addEventListener("click", (e) => { if (e.target === overlay) cleanup(); });

	const wireChecklist = () => {
		for (const row of overlay.querySelectorAll<HTMLDivElement>(".modal-track-item")) {
			row.addEventListener("click", async () => {
				const id = row.dataset.id!;
				if (!pl.ids.includes(id)) {
					pl.ids.push(id);
					await savePlaylists();
					sfx.click();
					row.classList.add("added");
					row.querySelector(".modal-track-status")!.innerHTML = `${icons.check} Added`;
				}
			});
		}
	};
	wireChecklist();

	const searchInput = overlay.querySelector("#modal-track-search") as HTMLInputElement;
	searchInput.addEventListener("input", () => {
		const q = searchInput.value.toLowerCase().trim();
		const mount = overlay.querySelector("#modal-track-list") as HTMLElement;
		if (mount) {
			mount.innerHTML = renderModalTrackChecklist(pl, q);
			wireChecklist();
		}
	});
}

function renderModalTrackChecklist(pl: { name: string; ids: string[] }, q = ""): string {
	let tracks = state.library;
	if (q) {
		tracks = tracks.filter((t) => [t.title, t.artist, t.album].some((s) => s.toLowerCase().includes(q)));
	}
	if (tracks.length === 0) {
		return `<div style="text-align:center;padding:2rem;color:rgba(255,255,255,0.4)">No tracks found.</div>`;
	}
	return tracks.map((t) => {
		const isAdded = pl.ids.includes(t.id);
		return `
			<div class="modal-track-item ${isAdded ? "added" : ""}" data-id="${t.id}">
				<div class="modal-track-art">${t.artDataUrl ? `<img src="${t.artDataUrl}" alt="">` : icons.musicNote}</div>
				<div class="modal-track-info">
					<div class="modal-track-title">${escapeHtml(t.title)}</div>
					<div class="modal-track-artist">${escapeHtml(t.artist)} • ${escapeHtml(t.album)}</div>
				</div>
				<div class="modal-track-status">${isAdded ? `${icons.check} Added` : `${icons.plus} Add`}</div>
			</div>
		`;
	}).join("");
}

// ---------- Overhauled Playlists View ----------
function renderPlaylists(root: HTMLElement) {
	// If a specific playlist is active, render its detail view
	if (state.activePlaylistName) {
		const pl = state.playlists.find((p) => p.name === state.activePlaylistName);
		if (pl) {
			renderPlaylistDetail(root, pl);
			return;
		} else {
			state.activePlaylistName = null;
		}
	}

	const q = state.playlistSearchQuery.toLowerCase().trim();
	const playlists = q
		? state.playlists.filter((p) => p.name.toLowerCase().includes(q) || (p.description ?? "").toLowerCase().includes(q))
		: state.playlists;

	root.innerHTML = `
		<div class="playlists-view-container">
			<div class="topbar">
				<h2>Playlists</h2>
				<div class="topbar-actions">
					<div class="search-wrap cel-search">
						${icons.search}
						<input class="search" id="pl-search-input" placeholder="Search playlists…" value="${escapeHtml(state.playlistSearchQuery)}" />
					</div>
					<button class="btn" id="btn-import-pl">${icons.folder}<span>Import M3U…</span></button>
					<button class="btn btn-primary" id="btn-new-pl-art">${icons.palette}<span>Create Playlist</span></button>
				</div>
			</div>

			${playlists.length === 0 ? `
				<div class="empty-table-state" style="padding:5rem 2rem">
					<div class="empty-icon">${icons.list}</div>
					<p class="empty-text">${q ? "No playlists match your search." : "You haven't made any playlists yet."}</p>
					<button class="btn btn-primary" id="btn-empty-create-pl" style="margin-top:1rem">${icons.palette}<span>Create Your First Playlist</span></button>
				</div>
			` : `
				<div class="cel-playlist-grid">
					${playlists.map((p) => {
						const tracks = p.ids.map((id) => state.library.find((t) => t.id === id)).filter((x): x is TrackInfo => !!x);
						const totalDur = formatDurationSum(tracks);
						return `
							<div class="playlist-cel-card" data-pl="${escapeHtml(p.name)}">
								<div class="playlist-art-stage">
									${p.artDataUrl ? `
										<img src="${p.artDataUrl}" alt="${escapeHtml(p.name)}" class="playlist-cover-img" loading="lazy" />
									` : `
										<div class="playlist-cover-fallback">
											<span class="pl-fallback-icon">${icons.list}</span>
										</div>
									`}
									<div class="playlist-glass-shine"></div>
									<div class="playlist-hover-overlay">
										<button class="playlist-hover-play-btn" title="Play Playlist">${icons.play}</button>
										<button class="playlist-hover-shuffle-btn" title="Shuffle Playlist">${icons.shuffle}</button>
									</div>
								</div>
								<div class="playlist-card-info">
									<h4 class="playlist-card-title" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</h4>
									<p class="playlist-card-desc">${escapeHtml(p.description || `${p.ids.length} tracks`)}</p>
									<div class="playlist-card-meta">
										<span>${p.ids.length} track${p.ids.length === 1 ? "" : "s"}</span>
										<span>•</span>
										<span>${totalDur}</span>
									</div>
								</div>
							</div>
						`;
					}).join("")}
				</div>
			`}
		</div>
	`;

	// Wire Create Playlist buttons
	const openCreate = () => openPlaylistArtGenerator();
	document.getElementById("btn-new-pl-art")?.addEventListener("click", openCreate);
	document.getElementById("btn-empty-create-pl")?.addEventListener("click", openCreate);

	// Wire Import M3U
	document.getElementById("btn-import-pl")?.addEventListener("click", async () => {
		sfx.open();
		try {
			const r = await bun().importPlaylist({});
			if (!r.name) return;
			mergeIntoLibrary(r.tracks);
			state.playlists.push({
				name: r.name,
				ids: r.tracks.map((t) => t.id),
			});
			await savePlaylists();
			toast(`Imported "${r.name}" with ${r.tracks.length} tracks`, { ttl: 2800 });
			sfx.success();
			renderPlaylists(root);
			renderSidebarPlaylists();
		} catch (err) {
			toast(`Import failed: ${(err as Error).message}`, { ttl: 3500 });
			sfx.error();
		}
	});

	// Wire Search
	const plSearch = document.getElementById("pl-search-input") as HTMLInputElement | null;
	plSearch?.addEventListener("input", () => {
		state.playlistSearchQuery = plSearch.value;
		renderPlaylists(root);
		const input = document.getElementById("pl-search-input") as HTMLInputElement | null;
		if (input) {
			input.focus();
			input.setSelectionRange(input.value.length, input.value.length);
		}
	});

	// Wire Playlist Cards
	for (const card of root.querySelectorAll<HTMLDivElement>(".playlist-cel-card")) {
		const name = card.dataset.pl!;
		const pl = state.playlists.find((p) => p.name === name);
		if (!pl) continue;

		card.querySelector(".playlist-hover-play-btn")?.addEventListener("click", (e) => {
			e.stopPropagation();
			const tracks = pl.ids.map((id) => state.library.find((t) => t.id === id)).filter((x): x is TrackInfo => !!x);
			if (tracks.length > 0) {
				playFromList(tracks, 0);
				sfx.play();
			} else {
				toast("Playlist is empty.", { ttl: 2000 });
			}
		});

		card.querySelector(".playlist-hover-shuffle-btn")?.addEventListener("click", (e) => {
			e.stopPropagation();
			const tracks = pl.ids.map((id) => state.library.find((t) => t.id === id)).filter((x): x is TrackInfo => !!x);
			if (tracks.length > 0) {
				state.settings.shuffle = true;
				playFromList(tracks, Math.floor(Math.random() * tracks.length));
				sfx.success();
			}
		});

		card.addEventListener("click", () => {
			state.activePlaylistName = name;
			sfx.click();
			renderMain();
		});

		card.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			const tracks = pl.ids.map((id) => state.library.find((t) => t.id === id)).filter((x): x is TrackInfo => !!x);
			showContextMenu(e.clientX, e.clientY, [
				{ label: "Play", onClick: () => {
					if (tracks.length > 0) { playFromList(tracks, 0); sfx.play(); }
				}},
				{ label: "Edit cover & metadata…", onClick: () => openPlaylistArtGenerator(pl) },
				{ label: "Export as .M3U8…", onClick: async () => {
					sfx.open();
					const paths = tracks.map((t) => t.path);
					const r = await bun().exportPlaylist({ name: pl.name, paths });
					if (r.ok && r.path) toast(`Exported to ${r.path}`, { ttl: 3000 });
				}},
				{ label: "Delete playlist", danger: true, onClick: async () => {
					state.playlists = state.playlists.filter((p) => p.name !== name);
					await savePlaylists();
					sfx.toggle();
					renderMain();
					renderSidebarPlaylists();
				}},
			]);
		});
	}
}

function renderPlaylistDetail(root: HTMLElement, pl: { name: string; ids: string[]; artDataUrl?: string; description?: string }) {
	const tracks = pl.ids.map((id) => state.library.find((t) => t.id === id)).filter((x): x is TrackInfo => !!x);
	const totalDur = formatDurationSum(tracks);

	root.innerHTML = `
		<div class="playlist-detail-container">
			<div class="detail-back-bar">
				<button class="btn btn-ghost btn-sm" id="btn-pl-back">${icons.prev}<span>All Playlists</span></button>
			</div>

			<div class="playlist-hero-card">
				<div class="playlist-hero-art">
					${pl.artDataUrl ? `
						<img src="${pl.artDataUrl}" alt="${escapeHtml(pl.name)}" />
					` : `
						<div class="playlist-hero-fallback">${icons.list}</div>
					`}
				</div>
				<div class="playlist-hero-info">
					<div class="hero-tag">PLAYLIST</div>
					<h1 class="hero-title" id="hero-pl-title" title="Click to rename">${escapeHtml(pl.name)}</h1>
					<p class="hero-desc">${escapeHtml(pl.description || "Custom Lakky Playlist")}</p>
					<div class="hero-meta-row">
						<span>${tracks.length} track${tracks.length === 1 ? "" : "s"}</span>
						<span>•</span>
						<span>${totalDur}</span>
					</div>
					<div class="hero-action-buttons">
						<button class="btn btn-primary" id="btn-hero-play">${icons.play}<span>Play</span></button>
						<button class="btn" id="btn-hero-shuffle">${icons.shuffle}<span>Shuffle</span></button>
						<button class="btn btn-ghost" id="btn-hero-add">${icons.plus}<span>Add Tracks</span></button>
						<button class="btn btn-ghost" id="btn-hero-art">${icons.palette}<span>Change Art</span></button>
						<button class="btn btn-ghost" id="btn-hero-export">${icons.download}<span>Export .M3U8</span></button>
						<button class="btn btn-ghost btn-danger" id="btn-hero-delete" title="Delete Playlist">${icons.trash}</button>
					</div>
				</div>
			</div>

			<div class="playlist-tracks-section">
				${renderTrackTable(tracks, { playlistContext: pl.name })}
			</div>
		</div>
	`;

	// Wire Back
	document.getElementById("btn-pl-back")?.addEventListener("click", () => {
		state.activePlaylistName = null;
		sfx.click();
		renderMain();
	});

	// Inline Rename
	document.getElementById("hero-pl-title")?.addEventListener("click", async () => {
		const newName = prompt("Rename playlist:", pl.name)?.trim();
		if (newName && newName !== pl.name) {
			pl.name = newName;
			state.activePlaylistName = newName;
			await savePlaylists();
			sfx.success();
			renderMain();
			renderSidebarPlaylists();
		}
	});

	// Hero Actions
	document.getElementById("btn-hero-play")?.addEventListener("click", () => {
		if (tracks.length > 0) {
			playFromList(tracks, 0);
			sfx.play();
		} else {
			toast("Playlist is empty.", { ttl: 2000 });
		}
	});

	document.getElementById("btn-hero-shuffle")?.addEventListener("click", () => {
		if (tracks.length > 0) {
			state.settings.shuffle = true;
			playFromList(tracks, Math.floor(Math.random() * tracks.length));
			sfx.success();
		}
	});

	document.getElementById("btn-hero-add")?.addEventListener("click", () => {
		openAddTracksToPlaylistModal(pl.name);
	});

	document.getElementById("btn-hero-art")?.addEventListener("click", () => {
		openPlaylistArtGenerator(pl);
	});

	document.getElementById("btn-hero-export")?.addEventListener("click", async () => {
		sfx.open();
		const paths = tracks.map((t) => t.path);
		const r = await bun().exportPlaylist({ name: pl.name, paths });
		if (r.ok && r.path) toast(`Exported to ${r.path}`, { ttl: 3000 });
		else toast("Export cancelled.", { ttl: 1800 });
	});

	document.getElementById("btn-hero-delete")?.addEventListener("click", async () => {
		if (confirm(`Delete playlist "${pl.name}"?`)) {
			state.playlists = state.playlists.filter((p) => p.name !== pl.name);
			state.activePlaylistName = null;
			await savePlaylists();
			sfx.toggle();
			renderMain();
			renderSidebarPlaylists();
		}
	});

	wireTrackRows(root, tracks, { playlistContext: pl.name });
}

function renderStats(root: HTMLElement) {
	const lib = state.library;
	const totalPlays = Object.values(state.playStats).reduce((a, b) => a + b, 0);
	// Sum of (duration × play count) across the library — minutes listened.
	const totalSeconds = lib.reduce(
		(acc, t) => acc + (t.duration ?? 0) * (state.playStats[t.id] ?? 0),
		0,
	);
	const totalHours = Math.floor(totalSeconds / 3600);
	const totalMin = Math.floor((totalSeconds % 3600) / 60);

	const topTracks = lib
		.filter((t) => state.playStats[t.id])
		.sort((a, b) => (state.playStats[b.id] ?? 0) - (state.playStats[a.id] ?? 0))
		.slice(0, 12);

	const artistTotals = new Map<string, number>();
	const albumTotals = new Map<string, number>();
	for (const t of lib) {
		const c = state.playStats[t.id] ?? 0;
		if (c === 0) continue;
		artistTotals.set(t.artist, (artistTotals.get(t.artist) ?? 0) + c);
		albumTotals.set(`${t.album} — ${t.artist}`, (albumTotals.get(`${t.album} — ${t.artist}`) ?? 0) + c);
	}
	const topArtists = [...artistTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
	const topAlbums = [...albumTotals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

	root.innerHTML = `
		<div class="topbar"><h2>Listening stats</h2></div>
		<div class="stat-tiles">
			<div class="stat-tile">
				<div class="stat-val">${totalPlays.toLocaleString()}</div>
				<div class="stat-lbl">Total plays</div>
			</div>
			<div class="stat-tile">
				<div class="stat-val">${totalHours}<span class="stat-unit">h</span> ${totalMin}<span class="stat-unit">m</span></div>
				<div class="stat-lbl">Time listened</div>
			</div>
			<div class="stat-tile">
				<div class="stat-val">${lib.length.toLocaleString()}</div>
				<div class="stat-lbl">Tracks in library</div>
			</div>
			<div class="stat-tile">
				<div class="stat-val">${artistTotals.size.toLocaleString()}</div>
				<div class="stat-lbl">Artists with plays</div>
			</div>
		</div>

		${topTracks.length > 0 ? `
			<div class="section-title"><span>Top tracks</span></div>
			<div class="tracklist">
				${topTracks.map((t, i) => `
					<div class="track-row" data-id="${t.id}">
						<div class="num">${i + 1}</div>
						<div class="ti">
							<div class="tt">${escapeHtml(t.title)}</div>
							<div class="ta">${escapeHtml(t.artist)}</div>
						</div>
						<div class="tb">${escapeHtml(t.album)}</div>
						<div class="td">${state.playStats[t.id]} plays</div>
						<div></div>
					</div>
				`).join("")}
			</div>
		` : `<div class="empty">${icons.chart}<p>No plays yet. Start a track to fill these charts.</p></div>`}

		${topArtists.length > 0 ? `
			<div class="section-title"><span>Top artists</span></div>
			<div class="rank-list">
				${topArtists.map(([name, plays], i) => statRow(i + 1, name, `${plays} plays`)).join("")}
			</div>
		` : ""}

		${topAlbums.length > 0 ? `
			<div class="section-title"><span>Top albums</span></div>
			<div class="rank-list">
				${topAlbums.map(([name, plays], i) => statRow(i + 1, name, `${plays} plays`)).join("")}
			</div>
		` : ""}

		<div class="section-title" style="margin-top:1.5rem"><span>Listening calendar</span></div>
		<div class="ec-grid" id="cal-grid"></div>

		<div class="setting-row" style="justify-content:flex-end;margin-top:1rem">
			<button class="btn" id="btn-export-stats">Export stats as JSON</button>
		</div>
	`;

	for (const r of root.querySelectorAll<HTMLDivElement>(".track-row[data-id]")) {
		r.addEventListener("click", () => {
			const id = r.dataset.id!;
			const idx = state.library.findIndex((x) => x.id === id);
			if (idx >= 0) { playFromList(state.library, idx); sfx.play(); }
		});
	}
}

function statRow(rank: number, name: string, sub: string) {
	return `
		<div class="rank">
			<div class="rank-no">${rank}</div>
			<div class="rank-name">${escapeHtml(name)}</div>
			<div class="rank-sub">${escapeHtml(sub)}</div>
		</div>
	`;
}

function renderSettings(root: HTMLElement) {
	const s = state.settings;
	root.innerHTML = `
		<div class="topbar"><h2>Settings</h2></div>

		<div class="settings-card">
			<h3>Audio</h3>
			<p>Tweak how playback feels.</p>
			<div class="setting-row">
				<span>Crossfade between tracks</span>
				<div class="range-row">
					<input type="range" class="range" min="0" max="12" step="1" value="${s.crossfade}" id="set-crossfade" />
					<span class="range-value" id="cf-val">${s.crossfade === 0 ? "Off" : `${s.crossfade}s`}</span>
				</div>
			</div>
			<div class="setting-row">
				<span>Playback speed</span>
				<div class="range-row">
					<input type="range" class="range" min="50" max="200" step="5" value="${Math.round(s.speed * 100)}" id="set-speed" />
					<span class="range-value" id="speed-val">${s.speed.toFixed(2)}×</span>
				</div>
			</div>
			<div class="setting-row">
				<span>Default volume</span>
				<div class="range-row">
					<input type="range" class="range" min="0" max="100" value="${Math.round(s.volume * 100)}" id="set-volume" />
					<span class="range-value" id="vol-val">${Math.round(s.volume * 100)}%</span>
				</div>
			</div>
			<div class="setting-row">
				<span>Pre-amp</span>
				<div class="range-row">
					<input type="range" class="range" min="-12" max="12" step="1" value="${s.preAmp}" id="set-preamp" />
					<span class="range-value" id="preamp-val">${s.preAmp === 0 ? "0 dB" : `${s.preAmp > 0 ? "+" : ""}${s.preAmp} dB`}</span>
				</div>
			</div>
			<div class="setting-row">
				<span>Mono downmix <em style="font-style:normal;opacity:.55;font-size:.78rem;font-weight:400;display:block">Forces stereo → mono output.</em></span>
				<div class="toggle ${s.mono ? "on" : ""}" id="t-mono"></div>
			</div>
			<div class="setting-row">
				<span>Sleep timer</span>
				<select id="set-sleep" class="select">
					${[0, 5, 10, 15, 30, 45, 60, 90, 120].map((m) => `<option value="${m}" ${m === s.sleepTimer ? "selected" : ""}>${m === 0 ? "Off" : `${m} min`}</option>`).join("")}
				</select>
			</div>
			<div class="setting-row">
				<span>Audio output device <em style="font-style:normal;opacity:.55;font-size:.78rem;font-weight:400;display:block">Route audio to a specific speaker or headset.</em></span>
				<select id="set-device" class="select" style="max-width:240px">
					<option value="default" ${state.selectedDeviceId === "default" ? "selected" : ""}>System Default</option>
					${state.audioDevices.map(d => `<option value="${escapeHtml(d.deviceId)}" ${state.selectedDeviceId === d.deviceId ? "selected" : ""}>${escapeHtml(d.label || d.deviceId.slice(0, 8))}</option>`).join("")}
				</select>
			</div>
		</div>

		<div class="settings-card">
			<h3>Shuffle &amp; theme</h3>
			<p>Make playback your own.</p>
			<div class="setting-row">
				<span>Smart shuffle <em style="font-style:normal;opacity:.55;font-size:.78rem;font-weight:400;display:block">Biases toward recently-added and under-played tracks.</em></span>
				<div class="toggle ${s.smartShuffle ? "on" : ""}" id="t-smart"></div>
			</div>
			<div class="setting-row">
				<span>Match accent to album art</span>
				<div class="toggle ${s.matchAccent ? "on" : ""}" id="t-accent"></div>
			</div>
			<div class="setting-row">
				<span>Theme</span>
				<div class="theme-row" id="theme-row" style="display:flex;flex-wrap:wrap;gap:0.5rem">
					${([
						"sakura_sunset", "cyber_neotokyo", "ghibli_emerald", "ocean_shinkai", "midnight_shogun",
						"midnight", "aurora", "solar", "rose"
					] as const).map((th) => `
						<div class="theme-swatch ${s.theme === th ? "active" : ""}" data-th="${th}" title="${th}">
							<span class="swatch swatch-${th}"></span>
							<span>${th.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}</span>
						</div>
					`).join("")}
				</div>
			</div>
		</div>

		<div class="settings-card">
			<h3>3D Anime Cel-Shaded Scene</h3>
			<p>Real-time audio-reactive 3D world with Gerstner ocean waves, Ghibli fluffy foliage trees, anime sky dome, and black manga ink outlines.</p>
			<div class="setting-row">
				<span>Enable 3D Scene background</span>
				<div class="toggle ${s.show3DScene ? "on" : ""}" id="t-3d-scene"></div>
			</div>
			<div class="setting-row">
				<span>Scene Opacity (${Math.round((s.sceneOpacity ?? 0.25) * 100)}%)</span>
				<div style="display:flex;align-items:center;gap:0.75rem">
					<input type="range" id="sl-scene-opacity" min="0" max="100" value="${Math.round((s.sceneOpacity ?? 0.25) * 100)}" style="width:140px;accent-color:var(--accent)" />
					<span id="txt-scene-opacity" style="font-size:0.85rem;color:var(--text-dim);width:36px">${Math.round((s.sceneOpacity ?? 0.25) * 100)}%</span>
				</div>
			</div>
			<div class="setting-row">
				<span>Scene Preset</span>
				<div style="display:flex;gap:0.45rem;flex-wrap:wrap">
					${([
						{ key: "sakura_sunset", label: "Sakura Sunset" },
						{ key: "ocean_shinkai", label: "Ocean Shinkai" },
						{ key: "cyber_lake", label: "Cyber Lake" },
						{ key: "ghibli_forest", label: "Ghibli Forest" },
					] as const).map((p) => `
						<button class="scene-preset-btn ${s.scenePreset === p.key ? "active" : ""}" data-preset="${p.key}">${p.label}</button>
					`).join("")}
				</div>
			</div>
		</div>

		<div class="settings-card">
			<h3>Windows File Associations &amp; Default Player</h3>
			<p>Set Lakky as the primary default player for all audio &amp; video formats (.mp3, .flac, .wav, .opus, .aac, .m4a, .mp4, .mkv, .webm, .avi, etc.).</p>
			<div class="setting-row">
				<span>Associate 60+ audio &amp; video file types</span>
				<button class="btn btn-primary" id="btn-set-default">${icons.disc} <span>Set as Default Media Player</span></button>
			</div>
		</div>

		<div class="settings-card">
			<h3>Binary Security &amp; Anti-Malware</h3>
			<p>Built-in Zero-Trust binary integrity protection scanning magic headers, steganography polyglots, and disguised executables.</p>
			<div class="setting-row">
				<span>Protection Status</span>
				<span class="badge-security safe" style="font-size:0.8rem;padding:0.3rem 0.6rem">${icons.shieldCheck} Zero-Trust Shield Active</span>
			</div>
			<div class="setting-row">
				<span>Scan entire library</span>
				<button class="btn" id="btn-rescan-security">${icons.shield} <span>Run Security Audit</span></button>
			</div>
		</div>

		<div class="settings-card">
			<h3>Windows &amp; remote</h3>
			<p>Open the mini-player or control Lakky from your phone.</p>
			<div class="setting-row">
				<span>Mini-player window</span>
				<button class="btn" id="open-mini">${icons.mini}<span>Open mini-player</span></button>
			</div>
			<div class="setting-row">
				<span>Send to tray <em style="font-style:normal;opacity:.55;font-size:.78rem;font-weight:400;display:block">Hide the window. The tray icon stays visible with full transport controls.</em></span>
				<button class="btn" id="send-tray"><span>Send to tray</span></button>
			</div>
			<div class="setting-row">
				<span>Web remote <em style="font-style:normal;opacity:.55;font-size:.78rem;font-weight:400;display:block">${state.webRemoteUrl ? `Visit <code>${state.webRemoteUrl}</code> from any LAN device.` : "Start a phone-friendly remote on your local network."}</em></span>
				<button class="btn ${state.webRemoteUrl ? "btn-primary" : ""}" id="toggle-remote">
					<span>${state.webRemoteUrl ? "Stop remote" : "Start remote"}</span>
				</button>
			</div>
		</div>

		<div class="settings-card">
			<h3>Integrations</h3>
			<p>Connect Lakky with other services.</p>
			<div class="setting-row">
				<span>Discord rich presence</span>
				<div class="toggle ${s.discord ? "on" : ""}" id="t-discord"></div>
			</div>
			<div class="setting-row">
				<span>UI sound effects</span>
				<div class="toggle ${s.sfx ? "on" : ""}" id="t-sfx"></div>
			</div>
			<div class="setting-row">
				<span>Now Playing notifications <em style="font-style:normal;opacity:.55;font-size:.78rem;font-weight:400;display:block">Windows toast on track change.</em></span>
				<div class="toggle ${s.showTrackNotifications ? "on" : ""}" id="t-track-notifs"></div>
			</div>
			<div class="setting-row">
				<span>Lyrics display <em style="font-style:normal;opacity:.55;font-size:.78rem;font-weight:400;display:block">Fetch synced lyrics from LRCLIB.</em></span>
				<div class="toggle ${s.lyrics ? "on" : ""}" id="t-lyrics"></div>
			</div>
			<div class="setting-row">
				<span>Last.fm scrobbling <em style="font-style:normal;opacity:.55;font-size:.78rem;font-weight:400;display:block">Send plays to last.fm.</em></span>
				<div class="toggle ${s.scrobbleLastfm ? "on" : ""}" id="t-scrobble"></div>
			</div>
			<div class="setting-row">
				<span>Last.fm token</span>
				<input type="password" class="text-input" id="set-lfm-token" placeholder="Session token" value="${escapeHtml(localStorage.getItem("lakky_lastfm_token") ?? "")}" style="min-width:220px" />
			</div>
		</div>

		<div class="settings-card">
			<h3>Library folder</h3>
			<p>Choose a drive or folder and Lakky will save every track you import there, organized as <code>Artist / Album / Title.ext</code>. Leave empty to play files in place.</p>
			<div class="setting-row">
				<span class="lib-path">${state.libraryFolder ? `<code>${escapeHtml(state.libraryFolder)}</code>` : `<em style="opacity:.55">No folder set — files play from their original location.</em>`}</span>
				<div style="display:flex;gap:.5rem;flex-shrink:0">
					<button class="btn" id="set-libfolder">${icons.folder}<span>${state.libraryFolder ? "Change…" : "Choose folder…"}</span></button>
					${state.libraryFolder ? `<button class="btn btn-ghost" id="clear-libfolder">Clear</button>` : ""}
				</div>
			</div>
			${state.libraryFolder ? `
				<div class="setting-row" style="border-top:1px solid rgba(255,255,255,.04);padding-top:.7rem">
					<span>Open library folder</span>
					<button class="btn btn-ghost" id="open-libfolder">Open in Explorer</button>
				</div>
			` : ""}
		</div>

		<div class="settings-card">
			<h3>Performance</h3>
			<p>Cap the visualizer to ease up on GPU and battery. Audio playback is always lossless — these settings only affect the bars on the screen.</p>
			<div class="setting-row">
				<span>Visualizer cap</span>
				<div class="range-row">
					<input type="range" class="range" min="15" max="60" step="1" value="${s.maxFps}" id="set-fps" title="Max frames per second for the visualizer" />
					<span class="range-value" id="fps-val">${s.maxFps} fps</span>
				</div>
			</div>
			<div class="setting-row">
				<span>Animate while paused <em style="font-style:normal;opacity:.55;font-size:.78rem;font-weight:400;display:block">When off, the visualizer freezes during pause for a slight extra resource savings.</em></span>
				<div class="toggle ${s.idleViz ? "on" : ""}" id="t-idle"></div>
			</div>
			<div class="setting-row">
				<span>Bottom strip visualizer <em style="font-style:normal;opacity:.55;font-size:.78rem;font-weight:400;display:block">When off, the slim visualizer above the transport bar is removed entirely — its row collapses so the player bar sits lower.</em></span>
				<div class="toggle ${s.showStripViz ? "on" : ""}" id="t-strip"></div>
			</div>
			<div class="setting-row">
				<span>Now Playing visualizer style <em style="font-style:normal;opacity:.55;font-size:.78rem;font-weight:400;display:block">Only affects the big visualizer on the Now Playing page.</em></span>
				<div class="seg" id="viz-style-seg">
					${(["bars", "wave", "radial", "mirror"] as VizStyle[]).map(st => `
						<button class="seg-btn ${s.vizStyle === st ? "active" : ""}" data-vs="${st}">${st[0].toUpperCase() + st.slice(1)}</button>
					`).join("")}
				</div>
			</div>
			<div class="setting-row">
				<span>Quick preset</span>
				<div style="display:flex;gap:.45rem;flex-shrink:0">
					<button class="btn" data-perf="quality" title="60 fps with idle animation">Quality</button>
					<button class="btn" data-perf="balanced" title="30 fps with idle animation">Balanced</button>
					<button class="btn" data-perf="battery" title="20 fps, no idle animation">Battery</button>
				</div>
			</div>
		</div>

		<div class="settings-card">
			<h3>Updates</h3>
			<p>Lakky checks the GitHub releases page of the repo below for newer versions. Leave the field empty to disable the updater entirely.</p>
			<div class="setting-row">
				<span>GitHub repo <em style="font-style:normal;opacity:.55;font-size:.78rem;font-weight:400;display:block">Format: <code>owner/repo</code></em></span>
				<input type="text" class="text-input" id="set-upd-repo" placeholder="owner/repo" value="${escapeHtml(s.updateRepo)}" style="min-width:220px" />
			</div>
			<div class="setting-row">
				<span>Auto-check on startup <em style="font-style:normal;opacity:.55;font-size:.78rem;font-weight:400;display:block">Also re-checks every 6 hours while the app is open.</em></span>
				<div class="toggle ${s.autoCheckUpdates ? "on" : ""}" id="t-auto-upd"></div>
			</div>
			<div class="setting-row">
				<span>Check now</span>
				<button class="btn" id="upd-check-now" ${s.updateRepo.trim() ? "" : "disabled"}>Check for updates</button>
			</div>
			${s.skippedUpdateTag ? `
				<div class="setting-row">
					<span>Skipped version <em style="font-style:normal;opacity:.55;font-size:.78rem;font-weight:400;display:block">You asked not to be reminded about this tag.</em></span>
					<div style="display:flex;align-items:center;gap:.5rem">
						<span style="color:rgba(232,232,245,.65);font-family:ui-monospace,SFMono-Regular,monospace">${escapeHtml(s.skippedUpdateTag)}</span>
						<button class="btn btn-ghost" id="upd-unskip">Clear</button>
					</div>
				</div>
			` : ""}
		</div>

		<div class="settings-card">
			<h3>About</h3>
			<p>Lakky — built on Electrobun + Bun.</p>
			<div class="setting-row">
				<span>Version</span>
				<span style="color:rgba(232,232,245,.6)">${APP_VERSION}</span>
			</div>
			<div class="setting-row">
				<span>Library size</span>
				<span style="color:rgba(232,232,245,.6)">${state.library.length} tracks</span>
			</div>
			<div class="setting-row">
				<span>Plays this session</span>
				<span style="color:rgba(232,232,245,.6)">${engine.getTrackPlayCount()}</span>
			</div>
			<div class="setting-row">
				<span>Echoes <em style="font-style:normal;opacity:.55;font-size:.78rem;font-weight:400;display:block">Preview your year-in-review for any year (normally unlocks December 1).</em></span>
				<button class="btn" id="echoes-test">${icons.sparkle} Preview</button>
			</div>
		</div>
	`;

	const cf = document.getElementById("set-crossfade") as HTMLInputElement;
	wireRange(cf, (v) => {
		state.settings.crossfade = v;
		document.getElementById("cf-val")!.textContent = v === 0 ? "Off" : `${v}s`;
		saveSettings();
	});
	const sv = document.getElementById("set-volume") as HTMLInputElement;
	wireRange(sv, (v) => {
		const pct = v / 100;
		state.settings.volume = pct;
		engine.setVolume(pct);
		document.getElementById("vol-val")!.textContent = `${v}%`;
		const slider = document.getElementById("volume") as HTMLInputElement | null;
		if (slider) { slider.value = String(Math.round(v)); syncRangeFill(slider); }
		saveSettings();
	});
	const sp = document.getElementById("set-speed") as HTMLInputElement;
	wireRange(sp, (v) => {
		const r = v / 100;
		state.settings.speed = r;
		engine.setRate(r);
		document.getElementById("speed-val")!.textContent = `${r.toFixed(2)}×`;
		saveSettings();
	});
	const pa = document.getElementById("set-preamp") as HTMLInputElement;
	wireRange(pa, (v) => {
		state.settings.preAmp = v;
		engine.setPreAmp(v);
		document.getElementById("preamp-val")!.textContent = v === 0 ? "0 dB" : `${v > 0 ? "+" : ""}${v} dB`;
		saveSettings();
	});
	document.getElementById("t-smart")?.addEventListener("click", (e) => {
		state.settings.smartShuffle = !state.settings.smartShuffle;
		(e.currentTarget as HTMLDivElement).classList.toggle("on", state.settings.smartShuffle);
		saveSettings();
		sfx.toggle();
		applyShuffleVisuals();
	});
	document.getElementById("t-accent")?.addEventListener("click", (e) => {
		state.settings.matchAccent = !state.settings.matchAccent;
		(e.currentTarget as HTMLDivElement).classList.toggle("on", state.settings.matchAccent);
		applyTheme();
		updateAccentFromArt(state.currentTrack?.artDataUrl);
		saveSettings();
		sfx.toggle();
	});
	for (const sw of document.querySelectorAll<HTMLDivElement>(".theme-swatch")) {
		sw.addEventListener("click", () => {
			const th = sw.dataset.th as Settings["theme"];
			state.settings.theme = th;
			applyTheme();
			saveSettings();
			sfx.click();
			renderSettings(root);
		});
	}

	document.getElementById("t-3d-scene")?.addEventListener("click", (e) => {
		state.settings.show3DScene = !state.settings.show3DScene;
		(e.currentTarget as HTMLDivElement).classList.toggle("on", state.settings.show3DScene);
		document.body.classList.toggle("mode-3d-active", state.settings.show3DScene);
		stylized3dScene?.setVisible(state.settings.show3DScene);
		saveSettings();
		sfx.toggle();
	});

	const opacitySlider = document.getElementById("sl-scene-opacity") as HTMLInputElement | null;
	const opacityTxt = document.getElementById("txt-scene-opacity");
	opacitySlider?.addEventListener("input", () => {
		const val = Number(opacitySlider.value) / 100;
		state.settings.sceneOpacity = val;
		if (opacityTxt) opacityTxt.textContent = `${opacitySlider.value}%`;
		stylized3dScene?.setOpacity(val);
		saveSettings();
	});

	for (const pb of document.querySelectorAll<HTMLButtonElement>(".scene-preset-btn")) {
		pb.addEventListener("click", () => {
			const preset = pb.dataset.preset as ScenePreset;
			state.settings.scenePreset = preset;
			stylized3dScene?.setPreset(preset);
			saveSettings();
			sfx.click();
			for (const sib of document.querySelectorAll<HTMLButtonElement>(".scene-preset-btn")) {
				sib.classList.toggle("active", sib === pb);
			}
		});
	}

	document.getElementById("btn-set-default")?.addEventListener("click", async () => {
		sfx.click();
		try {
			const res = await bun().setDefaultPlayerAssociations({});
			if (res.ok) {
				toast(res.message, { ttl: 4000 });
				sfx.success();
			} else {
				toast(`Failed: ${res.message}`, { ttl: 4000 });
				sfx.error();
			}
		} catch (err) {
			toast(`Error: ${(err as Error).message}`, { ttl: 3500 });
			sfx.error();
		}
	});

	document.getElementById("btn-rescan-security")?.addEventListener("click", async () => {
		sfx.click();
		toast("Scanning library for binary integrity and polyglots…", { ttl: 2000 });
		let clean = 0;
		let flagged = 0;
		for (const t of state.library) {
			try {
				const rep = await bun().scanMediaIntegrity({ path: t.path });
				t.securitySafe = rep.safe;
				t.securityScore = rep.score;
				t.securityThreats = rep.threats;
				t.verifiedFormat = rep.verifiedFormat;
				if (rep.safe) clean++; else flagged++;
			} catch {}
		}
		saveLibrary();
		renderMain();
		toast(`Audit complete: ${clean} clean tracks${flagged > 0 ? `, ${flagged} warnings flagged` : ""}`, { ttl: 4000 });
		sfx.success();
	});

	document.getElementById("open-mini")?.addEventListener("click", async () => {
		sfx.click();
		try { await bun().openMiniPlayer({}); } catch {}
	});
	document.getElementById("send-tray")?.addEventListener("click", async () => {
		sfx.click();
		try { await bun().sendToTray({}); } catch {}
	});

	const fpsEl = document.getElementById("set-fps") as HTMLInputElement | null;
	if (fpsEl) {
		wireRange(fpsEl, (v) => {
			state.settings.maxFps = v;
			document.getElementById("fps-val")!.textContent = `${v} fps`;
			applyVizPerf();
			saveSettings();
		});
	}
	document.getElementById("t-idle")?.addEventListener("click", (e) => {
		state.settings.idleViz = !state.settings.idleViz;
		(e.currentTarget as HTMLDivElement).classList.toggle("on", state.settings.idleViz);
		applyVizPerf();
		saveSettings();
		sfx.toggle();
	});
	document.getElementById("t-strip")?.addEventListener("click", (e) => {
		state.settings.showStripViz = !state.settings.showStripViz;
		(e.currentTarget as HTMLDivElement).classList.toggle("on", state.settings.showStripViz);
		document.body.dataset.stripViz = state.settings.showStripViz ? "on" : "off";
		saveSettings();
		sfx.toggle();
		// Re-render the strip's host div (add it back or remove it) and remount
		// the visualizer on the fresh canvas.
		const np = document.getElementById("np");
		if (np) {
			const existing = np.querySelector(".np-strip");
			if (state.settings.showStripViz && !existing) {
				const div = document.createElement("div");
				div.className = "np-strip";
				div.innerHTML = `<canvas id="np-strip-canvas"></canvas>`;
				np.insertBefore(div, np.firstChild);
			} else if (!state.settings.showStripViz && existing) {
				existing.remove();
			}
		}
		mountStripVisualizer();
	});
	for (const b of document.querySelectorAll<HTMLButtonElement>("#viz-style-seg .seg-btn")) {
		b.addEventListener("click", () => {
			const st = b.dataset.vs as VizStyle;
			state.settings.vizStyle = st;
			for (const sib of document.querySelectorAll<HTMLButtonElement>("#viz-style-seg .seg-btn")) {
				sib.classList.toggle("active", sib === b);
			}
			visualizer?.setStyle(st);
			saveSettings();
			sfx.click();
		});
	}

	const repoInput = document.getElementById("set-upd-repo") as HTMLInputElement | null;
	if (repoInput) {
		const commit = () => {
			const next = repoInput.value.trim();
			if (next === state.settings.updateRepo) return;
			state.settings.updateRepo = next;
			// New repo / cleared repo → reset the skip so the user gets one
			// fresh prompt against the new source.
			state.settings.skippedUpdateTag = "";
			saveSettings();
			void startUpdateChecker();
			renderSettings(root);
		};
		repoInput.addEventListener("change", commit);
		repoInput.addEventListener("blur", commit);
	}
	document.getElementById("t-auto-upd")?.addEventListener("click", (e) => {
		state.settings.autoCheckUpdates = !state.settings.autoCheckUpdates;
		(e.currentTarget as HTMLDivElement).classList.toggle("on", state.settings.autoCheckUpdates);
		saveSettings();
		sfx.toggle();
		void startUpdateChecker();
	});
	document.getElementById("upd-check-now")?.addEventListener("click", () => {
		void manualUpdateCheck();
	});
	document.getElementById("echoes-test")?.addEventListener("click", () => {
		sfx.click();
		const data = computeEchoes(state.library, state.playStats, new Date().getFullYear());
		new Echoes(data, {
			onPause: () => engine.pause(),
			onClose: () => {},
		});
		toast("Showing Echoes — press Escape or scroll to exit", { ttl: 3500 });
	});
	document.getElementById("upd-unskip")?.addEventListener("click", () => {
		sfx.click();
		state.settings.skippedUpdateTag = "";
		saveSettings();
		renderSettings(root);
	});
	for (const b of document.querySelectorAll<HTMLButtonElement>("[data-perf]")) {
		b.addEventListener("click", () => {
			const preset = b.dataset.perf!;
			if (preset === "quality")  { state.settings.maxFps = 60; state.settings.idleViz = true;  }
			if (preset === "balanced") { state.settings.maxFps = 30; state.settings.idleViz = true;  }
			if (preset === "battery")  { state.settings.maxFps = 20; state.settings.idleViz = false; }
			applyVizPerf();
			saveSettings();
			sfx.click();
			renderSettings(root);
		});
	}

	document.getElementById("toggle-remote")?.addEventListener("click", async () => {
		sfx.click();
		try {
			const r = await bun().toggleWebRemote({});
			state.webRemoteUrl = r.url;
			renderSettings(root);
			if (r.url) toast(`Remote running at ${r.url}`, { ttl: 4500 });
			else toast("Remote stopped.", { ttl: 1800 });
		} catch (err) {
			toast(`Remote failed: ${(err as Error).message}`, { ttl: 3500 });
			sfx.error();
		}
	});
	document.getElementById("set-sleep")?.addEventListener("change", (e) => {
		const v = parseInt((e.target as HTMLSelectElement).value, 10);
		state.settings.sleepTimer = v;
		state.sleepTimerEndsAt = v > 0 ? Date.now() + v * 60_000 : 0;
		saveSettings();
		toast(v === 0 ? "Sleep timer off" : `Sleep timer: ${v} minutes`, { ttl: 2200 });
	});
	document.getElementById("set-device")?.addEventListener("change", (e) => {
		const v = (e.target as HTMLSelectElement).value;
		state.selectedDeviceId = v;
		engine.setSinkId(v);
		engineA.setSinkId(v);
		engineB.setSinkId(v);
		saveSettings();
	});
	document.getElementById("t-mono")?.addEventListener("click", (e) => {
		state.settings.mono = !state.settings.mono;
		(e.currentTarget as HTMLDivElement).classList.toggle("on", state.settings.mono);
		engine.setMono(state.settings.mono);
		saveSettings();
		sfx.toggle();
	});
	document.getElementById("t-discord")?.addEventListener("click", (e) => {
		state.settings.discord = !state.settings.discord;
		(e.currentTarget as HTMLDivElement).classList.toggle("on", state.settings.discord);
		saveSettings();
		sfx.toggle();
		schedulePresenceUpdate();
	});
	document.getElementById("t-sfx")?.addEventListener("click", (e) => {
		state.settings.sfx = !state.settings.sfx;
		setSfxEnabled(state.settings.sfx);
		(e.currentTarget as HTMLDivElement).classList.toggle("on", state.settings.sfx);
		saveSettings();
		if (state.settings.sfx) sfx.toggle();
	});

	document.getElementById("t-track-notifs")?.addEventListener("click", (e) => {
		state.settings.showTrackNotifications = !state.settings.showTrackNotifications;
		(e.currentTarget as HTMLDivElement).classList.toggle("on", state.settings.showTrackNotifications);
		saveSettings();
		sfx.toggle();
	});
	document.getElementById("t-lyrics")?.addEventListener("click", (e) => {
		state.settings.lyrics = !state.settings.lyrics;
		(e.currentTarget as HTMLDivElement).classList.toggle("on", state.settings.lyrics);
		saveSettings();
		sfx.toggle();
	});
	document.getElementById("t-scrobble")?.addEventListener("click", (e) => {
		state.settings.scrobbleLastfm = !state.settings.scrobbleLastfm;
		(e.currentTarget as HTMLDivElement).classList.toggle("on", state.settings.scrobbleLastfm);
		saveSettings();
		sfx.toggle();
	});
	document.getElementById("set-lfm-token")?.addEventListener("input", (e) => {
		const v = (e.target as HTMLInputElement).value;
		localStorage.setItem("lakky_lastfm_token", v);
	});

	document.getElementById("set-libfolder")?.addEventListener("click", async () => {
		sfx.open();
		try {
			const { path } = await bun().pickLibraryFolder({});
			if (path) {
				state.libraryFolder = path;
				toast(`Library folder set: ${path}`, { ttl: 2400 });
				sfx.success();
				renderSettings(document.getElementById("main")!);
				await refreshLibraryFromFolder(path);
			}
		} catch (err) {
			toast(`Couldn't set folder: ${(err as Error).message}`, { ttl: 3500 });
			sfx.error();
		}
	});
	document.getElementById("clear-libfolder")?.addEventListener("click", async () => {
		await bun().clearLibraryFolder({});
		state.libraryFolder = null;
		toast("Library folder cleared", { ttl: 2200 });
		sfx.toggle();
		renderSettings(document.getElementById("main")!);
	});
	document.getElementById("open-libfolder")?.addEventListener("click", async () => {
		if (state.libraryFolder) {
			try { await bun().showInFolder({ path: state.libraryFolder }); } catch (e) { console.warn("[ui] showInFolder failed:", (e as Error).message); }
			sfx.click();
		}
	});
}

function renderSidebarFoot() {
	const el = document.getElementById("sidebar-foot");
	if (!el) return;
	el.innerHTML = `
		<span class="status-dot ${state.discordConnected ? "on" : ""}"></span>
		<span>Discord: ${state.discordConnected ? "Connected" : "Off"}</span>
	`;
}

function renderSidebarPlaylists() {
	const el = document.getElementById("sidebar-playlists");
	if (!el) return;
	if (state.playlists.length === 0) {
		el.innerHTML = `<div style="font-size:.78rem;color:rgba(232,232,245,.35);padding:.4rem .9rem">No playlists yet</div>`;
		return;
	}
	el.innerHTML = state.playlists
		.map((p) => `<div class="nav-item" data-pl="${escapeHtml(p.name)}">${icons.list}<span>${escapeHtml(p.name)}</span></div>`)
		.join("");
	for (const item of el.querySelectorAll<HTMLDivElement>(".nav-item")) {
		item.addEventListener("click", () => {
			navigate("playlists");
			sfx.click();
		});
	}
}

function renderQueuePanel() {
	const el = document.getElementById("queue-body");
	if (!el) return;
	if (state.queue.length === 0) {
		el.innerHTML = `<div style="color:rgba(232,232,245,.5);padding:.5rem">Queue is empty.</div>`;
		return;
	}
	el.innerHTML = state.queue
		.map((t, i) => `
			<div class="queue-row ${i === state.queueIndex ? "is-playing" : ""}" data-i="${i}" draggable="true">
				<div class="mini-art">${t.artDataUrl ? `<img src="${t.artDataUrl}">` : ""}</div>
				<div class="mini-info">
					<div class="qt">${escapeHtml(t.title)}</div>
					<div class="qa">${escapeHtml(t.artist)}</div>
				</div>
				<button class="queue-remove" data-ri="${i}" title="Remove from queue">&times;</button>
			</div>
		`)
		.join("");
	for (const r of el.querySelectorAll<HTMLDivElement>(".queue-row")) {
		r.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).closest(".queue-remove")) return;
			state.queueIndex = parseInt(r.dataset.i!, 10);
			playCurrent();
			sfx.click();
		});
		// Remove button
		const rm = r.querySelector(".queue-remove") as HTMLButtonElement | null;
		rm?.addEventListener("click", (e) => {
			e.stopPropagation();
			const idx = parseInt(rm.dataset.ri!, 10);
			if (idx < state.queueIndex) state.queueIndex--;
			else if (idx === state.queueIndex && state.queue.length <= 1) return;
			state.queue.splice(idx, 1);
			renderQueuePanel();
		});
		// Drag-to-reorder
		r.addEventListener("dragstart", (e) => {
			e.dataTransfer!.effectAllowed = "move";
			e.dataTransfer!.setData("text/plain", r.dataset.i!);
			r.classList.add("dragging");
		});
		r.addEventListener("dragend", () => {
			r.classList.remove("dragging");
			for (const qr of el.querySelectorAll(".queue-row")) qr.classList.remove("drag-over");
		});
		r.addEventListener("dragover", (e) => {
			e.preventDefault();
			e.dataTransfer!.dropEffect = "move";
			r.classList.add("drag-over");
		});
		r.addEventListener("dragleave", () => r.classList.remove("drag-over"));
		r.addEventListener("drop", (e) => {
			e.preventDefault();
			r.classList.remove("drag-over");
			const fromIdx = parseInt(e.dataTransfer!.getData("text/plain"), 10);
			const toIdx = parseInt(r.dataset.i!, 10);
			if (fromIdx === toIdx || isNaN(fromIdx) || isNaN(toIdx)) return;
			const [item] = state.queue.splice(fromIdx, 1);
			state.queue.splice(toIdx, 0, item);
			if (state.queueIndex === fromIdx) state.queueIndex = toIdx;
			else if (fromIdx < state.queueIndex && toIdx >= state.queueIndex) state.queueIndex--;
			else if (fromIdx > state.queueIndex && toIdx <= state.queueIndex) state.queueIndex++;
			renderQueuePanel();
		});
	}
}

// ---------- Track card & row helpers ----------
function trackCard(t: TrackInfo) {
	const isPlaying = state.currentTrack?.id === t.id;
	const isVideo = t.kind === "video";
	return `
		<div class="card ${isPlaying ? "is-playing" : ""}" data-id="${t.id}">
			<div class="card-art">
				${t.artDataUrl ? `<img src="${t.artDataUrl}" alt="">` : (isVideo ? icons.video : icons.musicNote)}
				${isVideo ? `<span class="kind-badge">VIDEO</span>` : ""}
				<div class="play-overlay">${icons.play}</div>
			</div>
			<p class="card-title">${escapeHtml(t.title)}</p>
			<p class="card-sub">${escapeHtml(t.artist)}</p>
			<p class="card-meta">${formatTime(t.duration)}${t.year ? ` • ${t.year}` : ""}</p>
		</div>
	`;
}

function wireCards() {
	for (const c of document.querySelectorAll<HTMLDivElement>(".card[data-id]")) {
		c.addEventListener("mousemove", (e) => {
			const r = c.getBoundingClientRect();
			c.style.setProperty("--x", `${e.clientX - r.left}px`);
			c.style.setProperty("--y", `${e.clientY - r.top}px`);
		});
		c.addEventListener("click", () => {
			const id = c.dataset.id!;
			const idx = state.library.findIndex((t) => t.id === id);
			if (idx >= 0) {
				playFromList(state.library, idx);
				sfx.play();
			}
		});
		c.addEventListener("mouseenter", () => sfx.hover());
		c.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			const id = c.dataset.id!;
			const t = state.library.find((x) => x.id === id);
			if (t) showContextMenu(e.clientX, e.clientY, ctxItemsForTrack(t));
		});
	}
}

function wireSearch() {
	const input = document.getElementById("search-input") as HTMLInputElement | null;
	if (!input) return;
	input.addEventListener("input", () => {
		state.searchQuery = input.value;
		if (state.view === "library" || state.view === "home") {
			renderMain();
			input.focus();
			input.setSelectionRange(input.value.length, input.value.length);
		}
	});
}

// ---------- Library actions ----------
async function addFiles() {
	primeAudio();
	sfx.open();
	try {
		const { tracks } = await bun().pickFiles({ mode: "files" });
		if (tracks.length === 0) return;
		mergeIntoLibrary(tracks);
		toast(`Added ${tracks.length} track${tracks.length === 1 ? "" : "s"}`, { ttl: 2400 });
		sfx.success();
	} catch (err) {
		toast(`Couldn't add files: ${(err as Error).message}`, { ttl: 3500 });
		sfx.error();
	}
}

async function addFolder() {
	primeAudio();
	sfx.open();
	try {
		toast("Picking a folder…", { ttl: 1500, key: "scan" });
		const { tracks } = await bun().pickFiles({ mode: "folder" });
		if (tracks.length === 0) {
			toast("No media files found in that folder.", { ttl: 3000 });
			return;
		}
		mergeIntoLibrary(tracks);
		toast(`Imported ${tracks.length} track${tracks.length === 1 ? "" : "s"}`, { ttl: 2600 });
		sfx.success();
	} catch (err) {
		toast(`Couldn't scan folder: ${(err as Error).message}`, { ttl: 3500 });
		sfx.error();
	}
}

function mergeIntoLibrary(tracks: TrackInfo[]) {
	const byId = new Map(state.library.map((t) => [t.id, t]));
	for (const t of tracks) byId.set(t.id, t);
	state.library = Array.from(byId.values());
	saveLibrary();
	renderMain();
}

// Pulls every media file from a folder into the library. Used both on boot
// (when a library folder is already set) and right after the user picks a
// new folder in Settings — so users never see an "empty library" when there
// are clearly files on disk.
async function refreshLibraryFromFolder(path: string) {
	try {
		toast(`Scanning ${path}…`, { ttl: 1800, key: "scan" });
		const { tracks } = await bun().scanFolder({ path });
		if (tracks.length === 0) {
			toast("No media files found in that folder.", { ttl: 3000, key: "scan" });
			return;
		}
		mergeIntoLibrary(tracks);
		toast(`Library: ${state.library.length} track${state.library.length === 1 ? "" : "s"}`, { ttl: 2400, key: "scan" });
	} catch (err) {
		toast(`Couldn't scan library: ${(err as Error).message}`, { ttl: 3500, key: "scan" });
	}
}

// ---------- Misc ----------

// ---------- Global hotkeys ----------
// Save bookmark on app exit / window unload for the long tracks.
window.addEventListener("beforeunload", () => {
	maybeRememberPosition();
	if (Object.keys(state.bookmarks).length > 0) {
		try { saveBookmarks(); } catch {}
	}
});

window.addEventListener("keydown", (e) => {
	if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
	if (usingVideo && state.view === "nowplaying" && cinemaEngine.handleKeydown(e)) return;
	if (e.code === "Space") {
		e.preventDefault();
		engine.togglePlay();
		engine.paused ? sfx.pause() : sfx.play();
	} else if (e.code === "KeyF" && !e.ctrlKey && !e.metaKey && !e.altKey) {
		if (immersiveActive) { exitImmersive(); }
		else { enterImmersive(); }
	} else if (e.code === "ArrowRight" && e.ctrlKey) {
		next();
		sfx.skip();
	} else if (e.code === "ArrowLeft" && e.ctrlKey) {
		previous();
		sfx.skip();
	} else if (e.code === "ArrowRight") {
		engine.seek(Math.min(engine.duration, engine.currentTime + 5));
	} else if (e.code === "ArrowLeft") {
		engine.seek(Math.max(0, engine.currentTime - 5));
	} else if (e.code === "ArrowUp") {
		e.preventDefault();
		const v = Math.min(1, state.settings.volume + 0.05);
		state.settings.volume = v;
		engine.setVolume(v);
		const slider = document.getElementById("volume") as HTMLInputElement | null;
		if (slider) { slider.value = String(Math.round(v * 100)); syncRangeFill(slider); }
	} else if (e.code === "ArrowDown") {
		e.preventDefault();
		const v = Math.max(0, state.settings.volume - 0.05);
		state.settings.volume = v;
		engine.setVolume(v);
		const slider = document.getElementById("volume") as HTMLInputElement | null;
		if (slider) { slider.value = String(Math.round(v * 100)); syncRangeFill(slider); }
	} else if (e.code === "KeyM") {
		const cur = state.settings.volume;
		const slider = document.getElementById("volume") as HTMLInputElement | null;
		const btnMute = document.getElementById("btn-mute");
		if (cur > 0) {
			state.mutedVolume = cur;
			engine.setVolume(0);
			if (slider) slider.value = "0";
			if (btnMute) btnMute.innerHTML = icons.mute;
		} else {
			const restore = state.mutedVolume || 0.85;
			state.settings.volume = restore;
			engine.setVolume(restore);
			if (slider) slider.value = String(Math.round(restore * 100));
			if (btnMute) btnMute.innerHTML = icons.volume;
		}
		if (slider) syncRangeFill(slider);
	} else if (e.code === "KeyB" && !e.ctrlKey && !e.metaKey && !e.altKey) {
		// A-B loop toggle: first press sets A, second sets B, third clears
		const cur = engine.currentTime;
		const dur = engine.duration;
		if (!state.abLoop) {
			state.abLoop = { a: cur, b: dur > 0 ? dur : Infinity };
			toast(`Loop point A: ${formatTime(cur)}`, { ttl: 1800, key: "abloop" });
		} else if (state.abLoop.b >= dur) {
			state.abLoop = { a: state.abLoop.a, b: cur };
			toast(`Loop A→B: ${formatTime(state.abLoop.a)} → ${formatTime(cur)}`, { ttl: 2000, key: "abloop" });
		} else {
			state.abLoop = null;
			engine.setABLoop(null);
			toast("Loop cleared", { ttl: 1500, key: "abloop" });
		}
		if (state.abLoop) {
			engine.setABLoop(state.abLoop);
			if (state.abLoop.b >= dur) engine.setABLoop({ a: state.abLoop.a, b: dur });
		}
		updateLoopMarkers();
	} else if (e.code === "Digit1" && !e.ctrlKey && !e.metaKey && !e.altKey) { navigate("home"); }
	  else if (e.code === "Digit2" && !e.ctrlKey && !e.metaKey && !e.altKey) { navigate("library"); }
	  else if (e.code === "Digit3" && !e.ctrlKey && !e.metaKey && !e.altKey) { navigate("nowplaying"); }
	  else if (e.code === "Digit4" && !e.ctrlKey && !e.metaKey && !e.altKey) { navigate("equalizer"); }
	  else if (e.code === "Digit5" && !e.ctrlKey && !e.metaKey && !e.altKey) { navigate("playlists"); }
	  else if (e.code === "Digit6" && !e.ctrlKey && !e.metaKey && !e.altKey) { navigate("stats"); }
	  else if (e.code === "Digit7" && !e.ctrlKey && !e.metaKey && !e.altKey) { navigate("nodes"); }
	  else if (e.code === "Digit8" && !e.ctrlKey && !e.metaKey && !e.altKey) { navigate("settings"); }
});

// ---------- Fullscreen Now Playing (F key) immersive overlay ----------
let immersiveActive = false;
let immersiveIdleTimeout: ReturnType<typeof setTimeout> | null = null;
let immCursorEl: HTMLDivElement | null = null;
let immCursorRing: HTMLDivElement | null = null;
let immCursorRaf: number | null = null;
const IMMERSIVE_IDLE_MS = 2200;

function enterImmersive() {
	if (immersiveActive || state.view !== "nowplaying" || !state.currentTrack || state.currentTrack.kind === "video") return;
	immersiveActive = true;

	// Custom cursor
	immCursorEl = document.createElement("div");
	immCursorEl.className = "imm-cursor";
	immCursorRing = document.createElement("div");
	immCursorRing.className = "imm-cursor-ring";
	// Don't append yet — let overlay mount first via its own transition

	const overlay = document.createElement("div");
	overlay.id = "imm-overlay";
	overlay.className = "imm-overlay";
	overlay.innerHTML = `
		<canvas id="imm-canvas" class="imm-canvas"></canvas>
		<div class="imm-vignette-ring"></div>
		<div class="imm-art" id="imm-art"></div>
		<div class="imm-info" id="imm-info">
			<div class="imm-title" id="imm-title"></div>
			<div class="imm-artist" id="imm-artist"></div>
			<div class="imm-current-lyric" id="imm-current-lyric"></div>
			<div class="imm-scrub" id="imm-scrub"><div class="imm-scrub-fill" id="imm-scrub-fill"></div></div>
			<div class="imm-times"><span id="imm-cur-time">0:00</span><span id="imm-dur-time">0:00</span></div>
			<div class="imm-meta" id="imm-meta"></div>
		</div>
		<div class="imm-controls" id="imm-controls">
			<button class="imm-btn imm-btn-shuffle" id="imm-shuffle">${icons.shuffle}</button>
			<button class="imm-btn" id="imm-prev">${icons.prev}</button>
			<button class="imm-btn imm-btn-play" id="imm-play"><span>${icons.play}</span></button>
			<button class="imm-btn" id="imm-next">${icons.next}</button>
			<button class="imm-btn" id="imm-repeat-imm">${icons.repeat}</button>
		</div>
		<div class="imm-volume-wrap" id="imm-vol-wrap">
			${icons.volume}
			<input type="range" id="imm-volume" min="0" max="100" value="${Math.round(state.settings.volume * 100)}" />
		</div>
		<button class="imm-close" id="imm-close">×</button>
	`;
	document.body.appendChild(overlay);
	document.body.appendChild(immCursorEl!);
	document.body.appendChild(immCursorRing!);

	const canvas = overlay.querySelector("#imm-canvas") as HTMLCanvasElement;
	if (canvas && visualizer) {
		visualizer.destroy();
		visualizer = createVisualizer(canvas, "bars", state.settings.vizStyle, {
			maxFps: 60,
			idle: true,
			autoStart: true,
		});
	}

	refreshImmersiveInfo();
	updateImmersivePlayState();
	updateImmersiveProgress(engine.currentTime, engine.duration);
	updateImmersiveShuffleRepeat();

	document.getElementById("imm-close")?.addEventListener("click", exitImmersive);
	document.getElementById("imm-play")?.addEventListener("click", () => { engine.togglePlay(); sfx.click(); updateImmersivePlayState(); });
	document.getElementById("imm-prev")?.addEventListener("click", () => { previous(); sfx.skip(); });
	document.getElementById("imm-next")?.addEventListener("click", () => { next(); sfx.skip(); });
	document.getElementById("imm-shuffle")?.addEventListener("click", () => { state.settings.shuffle = !state.settings.shuffle; saveSettings(); updateImmersiveShuffleRepeat(); sfx.toggle(); });
	document.getElementById("imm-repeat-imm")?.addEventListener("click", () => { const modes: RepeatMode[] = ["off","all","one"]; state.settings.repeat = modes[(modes.indexOf(state.settings.repeat) + 1) % modes.length]; saveSettings(); updateImmersiveShuffleRepeat(); sfx.toggle(); });

	const scrubEl = document.getElementById("imm-scrub");
	scrubEl?.addEventListener("click", (e) => {
		const rect = scrubEl.getBoundingClientRect();
		engine.seek(engine.duration * Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)));
	});

	const volSlider = document.getElementById("imm-volume") as HTMLInputElement | null;
	volSlider?.addEventListener("input", () => {
		const v = parseInt(volSlider.value, 10) / 100;
		state.settings.volume = v;
		engine.setVolume(v);
		saveSettings();
	});

	requestAnimationFrame(() => overlay.classList.add("imm-in"));
	resetImmersiveIdle();
	startImmersiveCursor();
}

function startImmersiveCursor() {
	if (!immCursorEl || !immCursorRing) return;
	let mx = -100, my = -100;
	window.addEventListener("mousemove", onMove = (e) => { mx = e.clientX; my = e.clientY; });
	const tick = () => {
		if (!immersiveActive) { onMove = null; return; }
		immCursorEl!.style.transform = `translate(calc(${mx}px - 5px), calc(${my}px - 5px))`;
		immCursorRing!.style.transform = `translate(calc(${mx}px - 14px), calc(${my}px - 14px))`;
		immCursorRaf = requestAnimationFrame(tick);
	};
	immCursorRaf = requestAnimationFrame(tick);
}
let onMove: ((e: MouseEvent) => void) | null = null;

function updateImmersiveShuffleRepeat() {
	const sh = document.getElementById("imm-shuffle");
	const rp = document.getElementById("imm-repeat-imm");
	if (sh) sh.classList.toggle("active", state.settings.shuffle);
	if (rp) {
		rp.innerHTML = state.settings.repeat === "one" ? icons.repeatOne : icons.repeat;
		rp.classList.toggle("active", state.settings.repeat !== "off");
	}
}

function exitImmersive() {
	immersiveActive = false;
	if (immersiveIdleTimeout) clearTimeout(immersiveIdleTimeout);
	if (immCursorRaf) cancelAnimationFrame(immCursorRaf);
	immCursorEl?.remove(); immCursorEl = null;
	immCursorRing?.remove(); immCursorRing = null;
	const overlay = document.getElementById("imm-overlay");
	if (overlay) { overlay.classList.remove("imm-in"); setTimeout(() => overlay.remove(), 400); }
	renderMain();
}

function resetImmersiveIdle() {
	if (immersiveIdleTimeout) clearTimeout(immersiveIdleTimeout);
	const controls = document.getElementById("imm-controls");
	const info = document.getElementById("imm-info");
	const close = document.getElementById("imm-close");
	const vol = document.getElementById("imm-vol-wrap");
	if (controls) controls.classList.remove("imm-hidden");
	if (info) info.classList.remove("imm-hidden");
	if (close) close.classList.remove("imm-hidden");
	if (vol) vol.classList.remove("imm-hidden");
	if (immCursorEl) immCursorEl.style.opacity = "1";
	if (immCursorRing) immCursorRing.style.opacity = "1";
	immersiveIdleTimeout = setTimeout(() => {
		if (!immersiveActive) return;
		if (controls) controls.classList.add("imm-hidden");
		if (info) info.classList.add("imm-hidden");
		if (close) close.classList.add("imm-hidden");
		if (vol) vol.classList.add("imm-hidden");
		if (immCursorEl) immCursorEl.style.opacity = "0";
		if (immCursorRing) immCursorRing.style.opacity = "0";
	}, IMMERSIVE_IDLE_MS);
}

function refreshImmersiveInfo() {
	const t = state.currentTrack;
	if (!t) return;
	const artEl = document.getElementById("imm-art");
	const titleEl = document.getElementById("imm-title");
	const artistEl = document.getElementById("imm-artist");
	const metaEl = document.getElementById("imm-meta");
	if (titleEl) titleEl.textContent = t.title;
	if (artistEl) artistEl.textContent = t.artist;
	if (metaEl) metaEl.textContent = `${t.album}${t.year ? ` • ${t.year}` : ""}${t.bitrate ? ` • ${Math.round(t.bitrate / 1000)} kbps` : ""}`;
	if (artEl) {
		if (t.artDataUrl) {
			artEl.innerHTML = `<img src="${t.artDataUrl}" alt="">`;
			artEl.classList.add("has-art");
		} else {
			artEl.innerHTML = "";
			artEl.classList.remove("has-art");
		}
	}
}

function updateImmersivePlayState() {
	const btn = document.getElementById("imm-play");
	if (btn) btn.innerHTML = `<span>${engine.paused ? icons.play : icons.pause}</span>`;
}

function updateImmersiveProgress(cur: number, dur: number) {
	if (!immersiveActive) return;
	const fill = document.getElementById("imm-scrub-fill");
	const curEl = document.getElementById("imm-cur-time");
	const durEl = document.getElementById("imm-dur-time");
	if (fill) fill.style.width = `${dur > 0 ? (cur / dur) * 100 : 0}%`;
	if (curEl) curEl.textContent = formatTime(cur);
	if (durEl) durEl.textContent = dur > 0 ? formatTime(dur) : "0:00";
}

// Mouse idle for immersive
window.addEventListener("mousemove", () => { if (immersiveActive) resetImmersiveIdle(); });
window.addEventListener("mousedown", () => { if (immersiveActive) resetImmersiveIdle(); });

// ---------- Drag-and-drop import ----------
// WebView2 / Chromium exposes a non-standard `.path` on dropped File objects
// when they come from the OS. We rely on it; if it's empty (uncommon on
// desktop), we fall back to opening the native picker.
const dropOverlay = document.createElement("div");
dropOverlay.className = "drop-overlay";
dropOverlay.innerHTML = `<div class="drop-card"><span class="drop-icon">${icons.folder}</span><div>Drop to add to library</div></div>`;
document.body.appendChild(dropOverlay);

let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
	if (!e.dataTransfer?.types?.includes("Files")) return;
	e.preventDefault();
	dragDepth++;
	dropOverlay.classList.add("on");
});
window.addEventListener("dragover", (e) => {
	if (!e.dataTransfer?.types?.includes("Files")) return;
	e.preventDefault();
	if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});
window.addEventListener("dragleave", () => {
	dragDepth = Math.max(0, dragDepth - 1);
	if (dragDepth === 0) dropOverlay.classList.remove("on");
});
window.addEventListener("drop", async (e) => {
	if (!e.dataTransfer?.types?.includes("Files")) return;
	e.preventDefault();
	dragDepth = 0;
	dropOverlay.classList.remove("on");
	const files = Array.from(e.dataTransfer.files);
	const paths = files
		.map((f) => (f as any).path as string | undefined)
		.filter((p): p is string => typeof p === "string" && p.length > 0);
	if (paths.length === 0) {
		toast("Drag-drop got no paths — try the Add files button.", { ttl: 3000 });
		return;
	}
	toast(`Importing ${paths.length} item${paths.length === 1 ? "" : "s"}…`, { ttl: 1800, key: "scan" });
	try {
		const { tracks } = await bun().addPathsToLibrary({ paths });
		if (tracks.length > 0) {
			mergeIntoLibrary(tracks);
			toast(`Imported ${tracks.length} track${tracks.length === 1 ? "" : "s"}`, { ttl: 2400 });
			sfx.success();
		} else {
			toast("No playable media in those files.", { ttl: 2600 });
		}
	} catch (err) {
		toast(`Drop failed: ${(err as Error).message}`, { ttl: 3500 });
		sfx.error();
	}
});

// ---------- Right-click context menu ----------
const ctxMenu = document.createElement("div");
ctxMenu.className = "ctx-menu";
ctxMenu.style.display = "none";
document.body.appendChild(ctxMenu);

function closeCtxMenu() {
	ctxMenu.style.display = "none";
	ctxMenu.innerHTML = "";
}
window.addEventListener("click", (e) => {
	if (!ctxMenu.contains(e.target as Node)) closeCtxMenu();
});
window.addEventListener("scroll", closeCtxMenu, true);
window.addEventListener("keydown", (e) => { if (e.key === "Escape") closeCtxMenu(); });

type CtxItem = { label: string; onClick: () => void; danger?: boolean; sub?: CtxItem[] };

function showContextMenu(x: number, y: number, items: CtxItem[]) {
	ctxMenu.innerHTML = "";
	for (const it of items) {
		const el = document.createElement("div");
		el.className = "ctx-item" + (it.danger ? " danger" : "");
		el.textContent = it.label;
		if (it.sub && it.sub.length > 0) {
			el.classList.add("has-sub");
			const sub = document.createElement("div");
			sub.className = "ctx-sub";
			for (const subItem of it.sub) {
				const subEl = document.createElement("div");
				subEl.className = "ctx-item";
				subEl.textContent = subItem.label;
				subEl.addEventListener("click", (e) => {
					e.stopPropagation();
					closeCtxMenu();
					subItem.onClick();
				});
				sub.appendChild(subEl);
			}
			el.appendChild(sub);
		} else {
			el.addEventListener("click", () => { closeCtxMenu(); it.onClick(); });
		}
		ctxMenu.appendChild(el);
	}
	ctxMenu.style.display = "block";
	// Position with edge clamping.
	const w = ctxMenu.offsetWidth;
	const h = ctxMenu.offsetHeight;
	ctxMenu.style.left = `${Math.min(x, window.innerWidth - w - 8)}px`;
	ctxMenu.style.top = `${Math.min(y, window.innerHeight - h - 8)}px`;
}

// ---------- Bulk-edit ----------
const bulkBar = document.createElement("div");
bulkBar.className = "bulk-bar";
bulkBar.style.display = "none";
document.body.appendChild(bulkBar);

function updateBulkBar() {
	const n = state.selectedIds.size;
	if (n === 0) {
		bulkBar.style.display = "none";
		return;
	}
	bulkBar.style.display = "flex";
	bulkBar.innerHTML = `
		<div class="bulk-count-badge">
			<span class="bulk-count-num">${n}</span>
			<span class="bulk-count-text">track${n === 1 ? "" : "s"} selected</span>
		</div>
		<div class="bulk-actions">
			<button class="btn btn-primary btn-sm" id="bulk-play">${icons.play}<span>Play</span></button>
			<button class="btn btn-sm" id="bulk-queue">${icons.plus}<span>Queue</span></button>
			<button class="btn btn-sm" id="bulk-playlist">${icons.list}<span>Add to Playlist ▾</span></button>
			<button class="btn btn-sm" id="bulk-export">${icons.download}<span>Export .M3U8</span></button>
			<button class="btn btn-sm" id="bulk-edit">${icons.edit}<span>Edit Tags</span></button>
			<button class="btn btn-ghost btn-sm btn-danger" id="bulk-delete" title="Remove">${icons.trash}</button>
			<button class="btn btn-ghost btn-sm" id="bulk-clear" title="Clear selection">${icons.close}</button>
		</div>
	`;

	const getSelectedTracks = () =>
		Array.from(state.selectedIds)
			.map((id) => state.library.find((x) => x.id === id))
			.filter((t): t is TrackInfo => !!t);

	document.getElementById("bulk-play")?.addEventListener("click", () => {
		const tracks = getSelectedTracks();
		if (tracks.length > 0) {
			playFromList(tracks, 0);
			sfx.play();
		}
	});

	document.getElementById("bulk-queue")?.addEventListener("click", () => {
		for (const id of state.selectedIds) {
			const t = state.library.find((x) => x.id === id);
			if (t) state.queue.push(t);
		}
		toast(`Queued ${state.selectedIds.size} track${state.selectedIds.size === 1 ? "" : "s"}`, { ttl: 2200 });
		sfx.click();
		clearSelection();
	});

	document.getElementById("bulk-playlist")?.addEventListener("click", (e) => {
		const ids = Array.from(state.selectedIds);
		const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
		showContextMenu(rect.left, rect.top - 120, [
			{
				label: "➕ Create new playlist from selection…",
				onClick: () => {
					openPlaylistArtGenerator({ name: "My Playlist", ids }, async (name, artDataUrl, description) => {
						state.playlists.push({ name, ids, artDataUrl, description });
						await savePlaylists();
						toast(`Created "${name}" with ${ids.length} tracks`, { ttl: 2400 });
						clearSelection();
						renderMain();
						renderSidebarPlaylists();
					});
				},
			},
			...(state.playlists.length > 0 ? [{
				label: "Existing Playlists",
				onClick: () => {},
				sub: state.playlists.map((p) => ({
					label: `${p.name} (${p.ids.length})`,
					onClick: async () => {
						for (const id of ids) if (!p.ids.includes(id)) p.ids.push(id);
						await savePlaylists();
						toast(`Added ${ids.length} tracks to "${p.name}"`, { ttl: 2200 });
						clearSelection();
						sfx.click();
						renderMain();
						renderSidebarPlaylists();
					},
				})),
			}] : []),
		]);
	});

	document.getElementById("bulk-export")?.addEventListener("click", async () => {
		sfx.open();
		const tracks = getSelectedTracks();
		const paths = tracks.map((t) => t.path);
		const r = await bun().exportPlaylist({ name: `Lakky_Selection_${Date.now().toString().slice(-4)}`, paths });
		if (r.ok && r.path) toast(`Exported ${tracks.length} tracks to ${r.path}`, { ttl: 3000 });
		else toast("Export cancelled.", { ttl: 1800 });
	});

	document.getElementById("bulk-edit")?.addEventListener("click", () => {
		openMetadataEditor(Array.from(state.selectedIds));
	});

	document.getElementById("bulk-delete")?.addEventListener("click", async () => {
		if (confirm(`Remove ${state.selectedIds.size} tracks from your library?`)) {
			state.library = state.library.filter((x) => !state.selectedIds.has(x.id));
			await saveLibrary();
			clearSelection();
			sfx.toggle();
			renderMain();
		}
	});

	document.getElementById("bulk-clear")?.addEventListener("click", clearSelection);
}

function clearSelection() {
	state.selectedIds.clear();
	for (const row of document.querySelectorAll<HTMLDivElement>(".track-row.is-selected, .cel-track-row.is-selected")) {
		row.classList.remove("is-selected");
		const cb = row.querySelector<HTMLInputElement>(".row-checkbox");
		if (cb) cb.checked = false;
	}
	const allBox = document.querySelector<HTMLInputElement>("#select-all-rows");
	if (allBox) allBox.checked = false;
	updateBulkBar();
}

function ctxItemsForBulk(): CtxItem[] {
	const ids = Array.from(state.selectedIds);
	const tracks = ids.map((id) => state.library.find((x) => x.id === id)).filter((x): x is TrackInfo => !!x);
	return [
		{ label: `Play ${ids.length} selected tracks`, onClick: () => {
			if (tracks.length > 0) { playFromList(tracks, 0); sfx.play(); }
		}},
		{ label: `Add ${ids.length} to queue`, onClick: () => {
			for (const t of tracks) state.queue.push(t);
			toast(`Queued ${ids.length} tracks`, { ttl: 2200 });
			clearSelection();
			sfx.click();
		}},
		{
			label: "Add to playlist",
			onClick: () => {},
			sub: [
				{
					label: "➕ New Playlist from selection…",
					onClick: () => {
						openPlaylistArtGenerator({ name: "Selection", ids }, async (name, artDataUrl, description) => {
							state.playlists.push({ name, ids, artDataUrl, description });
							await savePlaylists();
							toast(`Created "${name}" with ${ids.length} tracks`, { ttl: 2400 });
							clearSelection();
							renderMain();
							renderSidebarPlaylists();
						});
					},
				},
				...state.playlists.map((p) => ({
					label: p.name,
					onClick: () => {
						for (const id of ids) if (!p.ids.includes(id)) p.ids.push(id);
						savePlaylists();
						toast(`Added ${ids.length} to "${p.name}"`, { ttl: 2200 });
						clearSelection();
						sfx.click();
					},
				})),
			],
		},
		{ label: `Export ${ids.length} tracks as .M3U8…`, onClick: async () => {
			sfx.open();
			const paths = tracks.map((t) => t.path);
			const r = await bun().exportPlaylist({ name: `Lakky_Selection`, paths });
			if (r.ok && r.path) toast(`Exported to ${r.path}`, { ttl: 3000 });
		}},
		{ label: `Edit metadata for ${ids.length} tracks…`, onClick: () => openMetadataEditor(ids) },
		{ label: `Remove ${ids.length} from library`, danger: true, onClick: async () => {
			state.library = state.library.filter((x) => !state.selectedIds.has(x.id));
			await saveLibrary();
			clearSelection();
			renderMain();
			sfx.toggle();
		}},
	];
}

function openMetadataEditor(ids: string[]) {
	if (ids.length === 0) return;
	const tracks = ids.map((id) => state.library.find((t) => t.id === id)).filter((x): x is TrackInfo => !!x);
	if (tracks.length === 0) return;

	const sample = tracks[0];
	const allSame = (key: keyof TrackInfo) =>
		tracks.every((t) => t[key] === sample[key]);
	const artVaries = tracks.length > 1 && !allSame("artDataUrl");
	const initialArt = !artVaries ? (sample.artDataUrl ?? null) : null;

	// undefined = leave whatever art is already embedded in each file alone,
	// null = strip embedded art, string = replace with this data: URL.
	let pendingArt: string | null | undefined = undefined;

	const overlay = document.createElement("div");
	overlay.className = "modal-overlay";
	overlay.innerHTML = `
		<div class="modal">
			<h3>Edit metadata${tracks.length > 1 ? ` · ${tracks.length} tracks` : ""}</h3>
			<p class="modal-note">Changes are written directly into each file's tags on disk.</p>
			<div class="md-art-row">
				<img id="md-art-preview" class="md-art-preview" src="${initialArt ?? ""}" style="${initialArt ? "" : "display:none"}" alt="" />
				<div id="md-art-none" class="md-art-none" style="${initialArt ? "display:none" : ""}">${artVaries ? "(varies)" : "No art"}</div>
				<div class="md-art-actions">
					<input type="file" id="md-art-input" accept="image/*" style="display:none" />
					<button class="btn btn-ghost" id="md-art-pick" type="button">Change art…</button>
					<button class="btn btn-ghost" id="md-art-remove" type="button">Remove art</button>
				</div>
			</div>
			<label>Title <input type="text" id="md-title" value="${escapeHtml(allSame("title") ? sample.title : "")}" placeholder="${tracks.length > 1 ? "(varies)" : ""}" /></label>
			<label>Artist <input type="text" id="md-artist" value="${escapeHtml(allSame("artist") ? sample.artist : "")}" placeholder="${tracks.length > 1 ? "(varies)" : ""}" /></label>
			<label>Album <input type="text" id="md-album" value="${escapeHtml(allSame("album") ? sample.album : "")}" placeholder="${tracks.length > 1 ? "(varies)" : ""}" /></label>
			<label>Year <input type="number" id="md-year" value="${allSame("year") && sample.year ? sample.year : ""}" placeholder="${tracks.length > 1 ? "(varies)" : ""}" /></label>
			<label>Genre <input type="text" id="md-genre" value="${escapeHtml(allSame("genre") && sample.genre ? sample.genre : "")}" placeholder="${tracks.length > 1 ? "(varies)" : ""}" /></label>
			<div class="modal-actions">
				<button class="btn btn-ghost" id="md-cancel">Cancel</button>
				<button class="btn btn-primary" id="md-save">Save</button>
			</div>
		</div>
	`;
	document.body.appendChild(overlay);

	const cleanup = () => overlay.remove();
	document.getElementById("md-cancel")?.addEventListener("click", cleanup);
	overlay.addEventListener("click", (e) => { if (e.target === overlay) cleanup(); });

	const artPreview = document.getElementById("md-art-preview") as HTMLImageElement;
	const artNone = document.getElementById("md-art-none") as HTMLDivElement;
	const artInput = document.getElementById("md-art-input") as HTMLInputElement;
	document.getElementById("md-art-pick")?.addEventListener("click", () => artInput.click());
	artInput.addEventListener("change", () => {
		const f = artInput.files?.[0];
		if (!f) return;
		const reader = new FileReader();
		reader.onload = () => {
			pendingArt = reader.result as string;
			artPreview.src = pendingArt;
			artPreview.style.display = "";
			artNone.style.display = "none";
		};
		reader.readAsDataURL(f);
	});
	document.getElementById("md-art-remove")?.addEventListener("click", () => {
		pendingArt = null;
		artPreview.style.display = "none";
		artNone.textContent = "No art";
		artNone.style.display = "";
	});

	document.getElementById("md-save")?.addEventListener("click", async () => {
		const get = (id: string) => (document.getElementById(id) as HTMLInputElement).value.trim();
		const title = get("md-title");
		const artist = get("md-artist");
		const album = get("md-album");
		const yearStr = get("md-year");
		const genre = get("md-genre");
		const year = yearStr ? parseInt(yearStr, 10) : undefined;

		const saveBtn = document.getElementById("md-save") as HTMLButtonElement;
		saveBtn.disabled = true;
		saveBtn.textContent = "Saving…";

		const byId = new Map(state.library.map((t) => [t.id, t]));
		let failures = 0;
		await Promise.all(tracks.map(async (t) => {
			const updated = { ...t };
			// Single track: blank fields mean "clear". Bulk: blank == leave alone.
			const blankMeansClear = tracks.length === 1;
			if (title || blankMeansClear) updated.title = title || t.title;
			if (artist || blankMeansClear) updated.artist = artist || t.artist;
			if (album || blankMeansClear) updated.album = album || t.album;
			if (yearStr || blankMeansClear) updated.year = year;
			if (genre || blankMeansClear) updated.genre = genre || undefined;

			try {
				const res = await bun().saveTrackMetadata({
					path: t.path,
					title: updated.title,
					artist: updated.artist,
					album: updated.album,
					year: updated.year ?? null,
					genre: updated.genre ?? "",
					...(pendingArt !== undefined ? { art: pendingArt } : {}),
				});
				byId.set(t.id, res.ok && res.track ? res.track : updated);
				if (!res.ok) failures++;
			} catch (err) {
				console.warn("[ui] saveTrackMetadata failed:", (err as Error).message);
				byId.set(t.id, updated);
				failures++;
			}
		}));

		state.library = Array.from(byId.values());
		saveLibrary();
		// The now-playing bar, immersive view, and Discord presence all read
		// off state.currentTrack directly rather than re-deriving from
		// state.library, so a currently-playing track that just got edited
		// needs an explicit refresh or it'd keep showing stale info/art until
		// the next track change.
		if (state.currentTrack && byId.has(state.currentTrack.id)) {
			state.currentTrack = byId.get(state.currentTrack.id)!;
			updateNowPlayingBar();
			updateAccentFromArt(state.currentTrack.artDataUrl);
			if (immersiveActive) refreshImmersiveInfo();
			schedulePresenceUpdate();
		}
		renderMain();
		if (failures > 0) {
			toast(`Saved ${tracks.length - failures}/${tracks.length} — ${failures} file${failures === 1 ? "" : "s"} failed to write`, { ttl: 3400 });
			sfx.error();
		} else {
			toast(`Updated ${tracks.length} track${tracks.length === 1 ? "" : "s"}`, { ttl: 2400 });
			sfx.success();
		}
		cleanup();
	});
}

function ctxItemsForTrack(t: TrackInfo): CtxItem[] {
	return [
		{ label: "Play now", onClick: () => {
			const idx = state.library.findIndex((x) => x.id === t.id);
			if (idx >= 0) { playFromList(state.library, idx); sfx.play(); }
		}},
		{ label: "Play next", onClick: () => {
			state.queue.splice(state.queueIndex + 1, 0, t);
			toast(`Queued: ${t.title}`, { ttl: 1800 });
			sfx.click();
		}},
		{ label: "Add to queue", onClick: () => {
			state.queue.push(t);
			toast(`Added to queue: ${t.title}`, { ttl: 1800 });
			sfx.click();
		}},
		{
			label: "Add to playlist",
			onClick: () => {},
			sub: state.playlists.length === 0
				? [{ label: "(no playlists yet)", onClick: () => {} }]
				: state.playlists.map((p) => ({
					label: p.name,
					onClick: () => {
						if (!p.ids.includes(t.id)) {
							p.ids.push(t.id);
							savePlaylists();
							toast(`Added to "${p.name}"`, { ttl: 2000 });
							sfx.click();
						}
					},
				})),
		},
		{ label: "Show in folder", onClick: () => {
			bun().showInFolder({ path: t.path }).catch(() => {});
			sfx.click();
		}},
		{ label: "Inspect Security & Integrity…", onClick: () => openSecurityAuditModal(t) },
		{ label: "Edit metadata…", onClick: () => openMetadataEditor([t.id]) },
		{ label: "Remove from library", danger: true, onClick: () => {
			state.library = state.library.filter((x) => x.id !== t.id);
			saveLibrary();
			renderMain();
			sfx.toggle();
		}},
	];
}

// ---------- Boot ----------
(async () => {
	await loadPersisted();

	// Rewrite persisted media-server URLs (stream + art) to point at the
	// current session's port. The path/query parts stay valid — only the
	// host:port changes per launch.
	try {
		const { port } = await bun().getServerPort({});
		const base = `http://127.0.0.1:${port}`;
		state.library = state.library.map((t) => ({
			...t,
			streamUrl: rewriteLocalUrl(t.streamUrl, base) ?? t.streamUrl,
			artDataUrl: rewriteLocalUrl(t.artDataUrl, base),
		}));
	} catch {}

	try {
		const lf = await bun().getLibraryFolder({});
		state.libraryFolder = lf.path;
	} catch {}
	setSfxEnabled(state.settings.sfx);
	applyTheme();
	render();
	installTooltips();
	void startUpdateChecker();
	engine.setEq(state.settings.eq);
	engine.setVolume(state.settings.volume);
	engine.setRate(state.settings.speed);
	engine.setPreAmp(state.settings.preAmp);
	applyAccent(state.settings.accent);

	// Push the persisted node graph (if any) into both engines so the user's
	// custom chain is in place before any track plays.
	if (state.nodeGraph) {
		try { engineA.setNodeGraph(state.nodeGraph); } catch {}
		try { engineB.setNodeGraph(state.nodeGraph); } catch {}
	}

	// If a library folder is configured, refresh from disk in the background
	// so users see whatever's actually there, not a stale snapshot.
	if (state.libraryFolder) {
		refreshLibraryFromFolder(state.libraryFolder).catch((e) => { console.warn("[library] refresh from folder failed:", (e as Error).message); });
	}

	// Initialize 3D Anime Cel-Shaded Scene
	try {
		stylized3dScene = new Stylized3DScene(document.body, state.settings.scenePreset ?? "sakura_sunset", state.settings.sceneOpacity ?? 0.25);
		stylized3dScene.setVisible(state.settings.show3DScene);
		document.body.classList.toggle("mode-3d-active", state.settings.show3DScene);
	} catch (err) {
		console.warn("[3D] Stylized3DScene init skipped:", err);
	}

	// Audio-reactive frame ticker for 3D anime ocean & foliage
	const tick3D = () => {
		if (state.settings.show3DScene && stylized3dScene && !engine.paused) {
			const bands = engine.getAudioBands();
			stylized3dScene.updateAudio(bands);
		}
		requestAnimationFrame(tick3D);
	};
	requestAnimationFrame(tick3D);

	// Brief settle before fading the app in.
	setTimeout(() => dismissSplash(), 650);

	// First-click anywhere primes the AudioContext (autoplay policy)
	const primeOnce = () => {
		primeAudio();
		window.removeEventListener("click", primeOnce);
		window.removeEventListener("keydown", primeOnce);
	};
	window.addEventListener("click", primeOnce);
	window.addEventListener("keydown", primeOnce);
})();
