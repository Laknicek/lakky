import "./style.css";
import Electrobun, { Electroview } from "electrobun/view";
import type {
	PlayerRPC,
	TrackInfo,
	DiscordPresence,
	ExternalCommand,
	SharedPlayerState,
} from "../shared/rpcSchema";
import { AudioEngine, EQ_PRESETS, EQ_BANDS, type RepeatMode } from "./audio";
import { Visualizer, type VizStyle } from "./visualizer";
import { sfx, primeAudio, setSfxEnabled } from "./sfx";
import { iconUrl } from "./logo";
import { installTooltips } from "./tooltip";
import type { NodeGraph } from "./nodes";
import { newGraph } from "./nodes";
import { renderNodeEditor } from "./nodeEditor";

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
			windowStateChanged: () => {},
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
	accent: string; // hex
	theme: "midnight" | "aurora" | "solar" | "rose";
	sleepTimer: number; // 0 = off; minutes
	speed: number; // 0.5 - 2.0
	smartShuffle: boolean; // weighted by play count + recency instead of pure random
	matchAccent: boolean; // override theme accent with one extracted from album art
	customEqPresets: Record<string, number[]>;
	maxFps: number;        // visualizer cap, 15-60
	idleViz: boolean;      // pulse while paused (off saves a touch more GPU)
	vizStyle: VizStyle;    // bars | wave | radial | mirror — for the Now Playing visualizer
	showStripViz: boolean; // when false, the bottom-bar strip visualizer's div is removed entirely
};

const DEFAULT_SETTINGS: Settings = {
	volume: 0.85,
	repeat: "off",
	shuffle: false,
	sfx: true,
	discord: true,
	crossfade: 0,
	eq: [...EQ_PRESETS.Flat],
	eqPreset: "Flat",
	accent: "#a78bfa",
	theme: "midnight",
	sleepTimer: 0,
	speed: 1.0,
	smartShuffle: false,
	matchAccent: true,
	customEqPresets: {},
	maxFps: 30,
	idleViz: true,
	vizStyle: "bars",
	showStripViz: true,
};

const state = {
	view: "home" as View,
	library: [] as TrackInfo[],
	queue: [] as TrackInfo[],
	queueIndex: 0,
	currentTrack: null as TrackInfo | null,
	settings: { ...DEFAULT_SETTINGS } as Settings,
	playStats: {} as Record<string, number>, // trackId -> count
	playlists: [] as { name: string; ids: string[] }[],
	queueOpen: false,
	discordConnected: false,
	searchQuery: "",
	sleepTimerEndsAt: 0, // epoch ms
	libraryFolder: null as string | null,
	bookmarks: {} as Record<string, number>, // trackId → seconds, for resume
	selectedIds: new Set<string>(), // for bulk-edit
	webRemoteUrl: null as string | null,
	miniOpen: false,
	// User's custom audio effect graph. When non-null it replaces the
	// 10-band EQ chain inside the AudioEngine. The node editor view owns
	// the UI for this; we just persist it and push updates to both engines.
	nodeGraph: null as NodeGraph | null,
};

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
	try { await bun().windowMinimize({}); } catch {}
});
document.getElementById("tb-max")?.addEventListener("click", async (e) => {
	e.stopPropagation();
	sfx.click();
	try { await bun().windowMaximizeToggle({}); } catch {}
});
document.getElementById("tb-close")?.addEventListener("click", async (e) => {
	e.stopPropagation();
	sfx.click();
	try { await bun().windowClose({}); } catch {}
});

// Manual window-drag for the frameless titlebar. WebView2 doesn't honor
// -webkit-app-region, so we do it in JS: capture cursor + window position on
// mousedown, then push setPosition() updates on mousemove (throttled to rAF).
{
	const titlebar = document.getElementById("titlebar")!;
	let dragging = false;
	let startScreenX = 0;
	let startScreenY = 0;
	let startWinX = 0;
	let startWinY = 0;
	let queuedX: number | null = null;
	let queuedY: number | null = null;
	let rafScheduled = false;

	const flush = () => {
		rafScheduled = false;
		if (queuedX === null || queuedY === null) return;
		const x = queuedX;
		const y = queuedY;
		queuedX = null;
		queuedY = null;
		bun().windowSetPosition({ x, y }).catch(() => {});
	};

	titlebar.addEventListener("mousedown", async (e) => {
		if (e.button !== 0) return;
		// Don't start a drag from the control buttons.
		if ((e.target as HTMLElement).closest(".tb-btn")) return;
		dragging = true;
		startScreenX = e.screenX;
		startScreenY = e.screenY;
		try {
			const p = await bun().windowGetPosition({});
			startWinX = p.x;
			startWinY = p.y;
		} catch {
			dragging = false;
		}
	});

	window.addEventListener("mousemove", (e) => {
		if (!dragging) return;
		const dx = e.screenX - startScreenX;
		const dy = e.screenY - startScreenY;
		queuedX = startWinX + dx;
		queuedY = startWinY + dy;
		if (!rafScheduled) {
			rafScheduled = true;
			requestAnimationFrame(flush);
		}
	});

	window.addEventListener("mouseup", () => {
		dragging = false;
	});

	// Double-click the drag area to toggle maximize, like a real OS titlebar.
	titlebar.addEventListener("dblclick", async (e) => {
		if ((e.target as HTMLElement).closest(".tb-btn")) return;
		sfx.click();
		try { await bun().windowMaximizeToggle({}); } catch {}
	});
}

// ---------- Audio ----------
// One shared AudioContext for the whole app. Two audio engines (A/B) and a
// video engine all attach their own filter chains here, which is what lets
// crossfade work — two parallel sources can be mixed by the same context.
const sharedAudioCtx: AudioContext = new (
	window.AudioContext || (window as any).webkitAudioContext
)();
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
// 2048 bins → ~21.5 Hz per bin at 44.1 kHz — fine resolution in the bass
// region without adding visible latency.
const sharedAnalyser = sharedAudioCtx.createAnalyser();
sharedAnalyser.fftSize = 2048;
sharedAnalyser.smoothingTimeConstant = 0.72;
sharedAnalyser.minDecibels = -90;
sharedAnalyser.maxDecibels = -20;
sharedAnalyser.connect(sharedAudioCtx.destination);

// Two audio engines + one video engine, all sharing the audio graph. Each
// engine wraps a fixed media element so the MediaElementSourceNode only gets
// created once per element (the API forbids re-wrapping).
const engineA = new AudioEngine(audioElA, sharedAudioCtx, sharedAnalyser);
const engineB = new AudioEngine(audioElB, sharedAudioCtx, sharedAnalyser);
const videoEngine = new AudioEngine(videoEl, sharedAudioCtx, sharedAnalyser);

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
let usingVideo = false;

function attachEngineHandlers() {
	engine.on({
		onTimeUpdate: (cur, dur) => {
			updateNowPlayingProgress(cur, dur);
			updateMediaSessionPosition();
			maybeStartCrossfade(cur, dur);
		},
		onEnded: () => {
			if (crossfading) return; // crossfade will handle the transition
			onTrackEnded();
		},
		onPlay: () => {
			updatePlayButton(true);
			updateNowPlayingArtSpin(true);
			visualizer?.start();
			stripViz?.start();
			if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
			schedulePresenceUpdate();
		},
		onPause: () => {
			updatePlayButton(false);
			updateNowPlayingArtSpin(false);
			visualizer?.stop();
			stripViz?.stop();
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
	} catch {
		return;
	}

	crossfading = true;
	const outgoing = engine;
	const userVol = state.settings.volume;
	const t0 = performance.now();

	const tick = () => {
		const elapsed = (performance.now() - t0) / 1000;
		const t = Math.min(1, elapsed / durationSec);
		// Equal-power crossfade — cos² + sin² = 1, so perceived loudness
		// stays roughly constant through the overlap.
		outgoing.setVolume(userVol * Math.cos((t * Math.PI) / 2));
		incoming.setVolume(userVol * Math.sin((t * Math.PI) / 2));
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
		crossfading = false;
		crossfadeRaf = null;
		mountStripVisualizer();
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
async function loadPersisted() {
	try {
		const r = await bun().loadPersistedState({ key: "settings" });
		if (r.value && typeof r.value === "object") {
			Object.assign(state.settings, r.value);
		}
	} catch {}
	try {
		const r = await bun().loadPersistedState({ key: "library" });
		if (Array.isArray(r.value)) state.library = r.value as TrackInfo[];
	} catch {}
	try {
		const r = await bun().loadPersistedState({ key: "playlists" });
		if (Array.isArray(r.value)) state.playlists = r.value as any;
	} catch {}
	try {
		const r = await bun().loadPersistedState({ key: "stats" });
		if (r.value && typeof r.value === "object") state.playStats = r.value as any;
	} catch {}
	try {
		const r = await bun().loadPersistedState({ key: "bookmarks" });
		if (r.value && typeof r.value === "object") state.bookmarks = r.value as any;
	} catch {}
	try {
		const r = await bun().loadPersistedState({ key: "nodeGraph" });
		if (r.value && typeof r.value === "object" && (r.value as any).nodes) {
			state.nodeGraph = r.value as NodeGraph;
		}
	} catch {}
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

// Update the current audio effect graph: store on state, persist to disk, and
// push to BOTH engineA and engineB so a crossfade in progress doesn't end up
// with one engine routed through the new graph and the other through the old
// chain. The node editor view should call this whenever the user edits the
// graph (or picks a template); pass null to revert to the default 10-band EQ.
async function applyNodeGraph(graph: NodeGraph | null) {
	state.nodeGraph = graph;
	try {
		await bun().savePersistedState({ key: "nodeGraph", value: graph });
	} catch {}
	try { engineA.setNodeGraph(graph); } catch {}
	try { engineB.setNodeGraph(graph); } catch {}
}
// Expose for the node editor sibling agent. It can read state.nodeGraph and
// call window.applyNodeGraph(g) to commit changes without importing this file.
(window as any).applyNodeGraph = applyNodeGraph;
// The node editor reaches through window.__lakkyToast so it doesn't have to
// import this file (which would risk a circular dep at module-eval time).
(window as any).__lakkyToast = toast;

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
};

// ---------- App shell render ----------
function render() {
	appEl.innerHTML = `
		<aside class="sidebar">
			<nav class="sidebar-nav">
				${navItem("home", icons.home, "Home")}
				${navItem("library", icons.library, "Library")}
				${navItem("nowplaying", icons.disc, "Now Playing")}
				${navItem("equalizer", icons.eq, "Equalizer")}
				${navItem("playlists", icons.list, "Playlists")}
				${navItem("stats", icons.chart, "Stats")}
				${navItem("nodes", icons.node, "Nodes")}
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
						<button class="icon-btn" id="btn-shuffle" title="Shuffle">${icons.shuffle}</button>
						<button class="icon-btn" id="btn-prev" title="Previous (Ctrl+←)">${icons.prev}</button>
						<button class="icon-btn play" id="btn-play" title="Play / pause (Space)">${icons.play}</button>
						<button class="icon-btn" id="btn-next" title="Next (Ctrl+→)">${icons.next}</button>
						<button class="icon-btn" id="btn-repeat" title="Repeat">${icons.repeat}</button>
					</div>
					<div class="np-scrub">
						<span class="np-time" id="np-current">0:00</span>
						<div class="scrub" id="scrub" title="Click to seek">
							<div class="scrub-fill" id="scrub-fill"></div>
							<div class="scrub-handle" id="scrub-handle"></div>
						</div>
						<span class="np-time" id="np-duration">0:00</span>
					</div>
				</div>
				<div class="np-right">
					<button class="icon-btn" id="btn-eq-shortcut" data-tip="Equalizer" title="Equalizer">${icons.eq}</button>
						<button class="icon-btn" id="btn-tray-shortcut" data-tip="Send to tray" title="Send to tray">${icons.tray}</button>
						<button class="icon-btn" id="btn-mini-shortcut" data-tip="Mini player" title="Mini player">${icons.mini}</button>
						<button class="icon-btn" id="btn-fullscreen" data-tip="Toggle fullscreen" title="Toggle fullscreen">${icons.maximize}</button>
					<button class="icon-btn" id="btn-queue" data-tip="Open queue" title="Open queue">${icons.queue}</button>
					<div class="volume" title="Volume (↑ / ↓)">
						<span style="opacity:.55;display:inline-flex">${icons.volume}</span>
						<input type="range" id="volume" class="range" min="0" max="100" value="${Math.round(state.settings.volume * 100)}" title="Volume" />
					</div>
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

// Wire interactions on the video stage: single-click toggles play/pause and
// flashes a centered indicator; double-click toggles window fullscreen.
function wireVideoStage() {
	const mount = document.getElementById("video-mount");
	const indicator = document.getElementById("video-indicator");
	if (!mount) return;
	let clickTimer: ReturnType<typeof setTimeout> | null = null;
	mount.addEventListener("click", (e) => {
		if ((e.target as HTMLElement).closest(".video-info")) return;
		if (clickTimer) return; // wait for dblclick to decide
		clickTimer = setTimeout(() => {
			clickTimer = null;
			engine.togglePlay();
			if (indicator) {
				indicator.classList.remove("flash");
				// reflow to restart the animation
				void indicator.offsetWidth;
				indicator.dataset.icon = engine.paused ? "pause" : "play";
				indicator.classList.add("flash");
			}
			engine.paused ? sfx.pause() : sfx.play();
		}, 200);
	});
	mount.addEventListener("dblclick", async (e) => {
		if ((e.target as HTMLElement).closest(".video-info")) return;
		if ((e.target as HTMLElement).closest(".video-pip")) return;
		if (clickTimer) { clearTimeout(clickTimer); clickTimer = null; }
		sfx.click();
		try { await bun().windowToggleFullscreen({}); } catch {}
	});

	document.getElementById("video-pip")?.addEventListener("click", async (e) => {
		e.stopPropagation();
		sfx.click();
		try {
			if (document.pictureInPictureElement) {
				await document.exitPictureInPicture();
			} else if ((videoEl as any).requestPictureInPicture) {
				await (videoEl as any).requestPictureInPicture();
			} else {
				toast("Picture-in-picture isn't supported here.", { ttl: 2400 });
			}
		} catch (err) {
			toast(`PiP failed: ${(err as Error).message}`, { ttl: 3000 });
		}
	});
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
	stripViz = new Visualizer(canvas, engine.analyser, "strip");
	stripViz.setMaxFps(state.settings.maxFps);
	stripViz.setIdleEnabled(state.settings.idleViz);
	if (!engine.paused) stripViz.start();
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

function navItem(view: View, iconSvg: string, label: string) {
	const active = state.view === view ? "active" : "";
	return `<div class="nav-item ${active}" data-view="${view}" title="${label}">${iconSvg}<span>${label}</span></div>`;
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

// ---------- Transport ----------
function wireTransport() {
	const btnPlay = document.getElementById("btn-play")!;
	const btnPrev = document.getElementById("btn-prev")!;
	const btnNext = document.getElementById("btn-next")!;
	const btnShuffle = document.getElementById("btn-shuffle")!;
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
				? state.settings.smartShuffle ? "Smart shuffle on" : "Shuffle on"
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
		toast(`Repeat: ${state.settings.repeat}`, { ttl: 1500 });
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
	document.getElementById("btn-tray-shortcut")?.addEventListener("click", async () => {
		sfx.click();
		try { await bun().sendToTray({}); } catch {}
	});
	document.getElementById("btn-mini-shortcut")?.addEventListener("click", async () => {
		sfx.click();
		try { await bun().openMiniPlayer({}); } catch {}
	});

	applyShuffleVisuals();
	if (state.settings.repeat !== "off") {
		btnRepeat.classList.add("active");
		if (state.settings.repeat === "one") btnRepeat.innerHTML = icons.repeatOne;
	}

	const vol = document.getElementById("volume")! as HTMLInputElement;
	syncRangeFill(vol);
	vol.addEventListener("input", () => {
		const v = parseInt(vol.value, 10) / 100;
		state.settings.volume = v;
		engine.setVolume(v);
		syncRangeFill(vol);
		saveSettings();
	});
	// Sync any other .range slider that the views have already mounted.
	for (const r of document.querySelectorAll<HTMLInputElement>(".range")) syncRangeFill(r);

	const scrub = document.getElementById("scrub")!;
	scrub.addEventListener("click", (e) => {
		const rect = scrub.getBoundingClientRect();
		const ratio = (e.clientX - rect.left) / rect.width;
		if (engine.duration > 0) {
			engine.seek(engine.duration * Math.max(0, Math.min(1, ratio)));
		}
	});

	for (const b of document.querySelectorAll<HTMLButtonElement>(".icon-btn")) {
		b.addEventListener("mouseenter", () => sfx.hover());
	}

	engine.setVolume(state.settings.volume);
}

function updatePlayButton(isPlaying: boolean) {
	const btn = document.getElementById("btn-play");
	if (btn) {
		btn.innerHTML = isPlaying ? icons.pause : icons.play;
		btn.setAttribute("title", isPlaying ? "Pause (Space)" : "Play (Space)");
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
}

function updateNowPlayingProgress(cur: number, dur: number) {
	const f = document.getElementById("scrub-fill") as HTMLDivElement | null;
	const handle = document.getElementById("scrub-handle") as HTMLDivElement | null;
	const c = document.getElementById("np-current");
	const d = document.getElementById("np-duration");
	const ratio = dur > 0 ? cur / dur : 0;
	if (f) f.style.width = `${ratio * 100}%`;
	if (handle) handle.style.left = `${ratio * 100}%`;
	if (c) c.textContent = formatTime(cur);
	if (d && dur > 0) d.textContent = formatTime(dur);

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

function formatTime(s: number) {
	if (!Number.isFinite(s)) return "0:00";
	const m = Math.floor(s / 60);
	const sec = Math.floor(s % 60);
	return `${m}:${sec.toString().padStart(2, "0")}`;
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
		mountStripVisualizer();
	}

	engine.setVolume(state.settings.volume);
	engine.setEq(state.settings.eq);
	engine.setRate(state.settings.speed);

	// Stats
	state.playStats[track.id] = (state.playStats[track.id] ?? 0) + 1;
	saveStats();

	await engine.loadAndPlay(track);
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
	midnight: { accent: "#a78bfa", bg: "rgba(167, 139, 250, 0.18)" },
	aurora:   { accent: "#22d3ee", bg: "rgba(34, 211, 238, 0.18)" },
	solar:    { accent: "#fb923c", bg: "rgba(251, 146, 60, 0.18)" },
	rose:     { accent: "#f472b6", bg: "rgba(244, 114, 182, 0.18)" },
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
	const presence: DiscordPresence = {
		details: t.title.slice(0, 120),
		state: paused ? `Paused • ${t.artist}` : t.artist,
		largeImageKey: "lak_logo",
		largeImageText: `${t.album} — Lakky`,
		smallImageKey: paused ? "pause" : "play",
		smallImageText: paused ? "Paused" : "Playing",
		artist: t.artist,
		album: t.album,
		buttons: [
			// Placeholder — point this at the real download site when it's live.
			{ label: "Player", url: "https://lakky.app" },
		],
	};
	if (!paused && engine.duration > 0) {
		const remaining = (engine.duration - engine.currentTime) * 1000;
		presence.startTimestamp = Math.floor(Date.now() / 1000);
		presence.endTimestamp = Math.floor((Date.now() + remaining) / 1000);
	}
	try {
		await bun().setDiscordPresence({ presence });
	} catch {}
}

// ---------- Main view renderers ----------
function renderMain() {
	// Pull the video element out of the DOM region we're about to wipe so the
	// upcoming innerHTML assignment doesn't take it down with it.
	parkVideoEl();
	closeCtxMenu();
	// The big Now Playing visualizer is per-view: when we navigate away its
	// canvas is removed from the DOM, so kill the instance to stop the rAF
	// loop and free the analyser tap.
	if (state.view !== "nowplaying" && visualizer) {
		visualizer.destroy();
		visualizer = null;
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

function renderLibrary(root: HTMLElement) {
	const q = state.searchQuery.toLowerCase().trim();
	const tracks = q
		? state.library.filter((t) =>
			[t.title, t.artist, t.album].some((s) => s.toLowerCase().includes(q)))
		: state.library;

	root.innerHTML = `
		<div class="topbar">
			<h2>Library</h2>
			<div class="topbar-actions">
				<div class="search-wrap">
					${icons.search}
					<input class="search" id="search-input" placeholder="Search your library…" value="${escapeHtml(state.searchQuery)}" />
				</div>
				<button class="btn" id="btn-add-files">${icons.plus}<span>Add files</span></button>
				<button class="btn btn-primary" id="btn-add-folder">${icons.folder}<span>Add folder</span></button>
			</div>
		</div>
		${tracks.length === 0 ? `
			<div class="empty">${icons.musicNote}<p>${q ? "No matches." : "Empty library."}</p></div>
		` : `
			<div class="tracklist">
				${tracks.map((t, i) => trackRow(t, i)).join("")}
			</div>
		`}
	`;

	document.getElementById("btn-add-folder")?.addEventListener("click", addFolder);
	document.getElementById("btn-add-files")?.addEventListener("click", addFiles);

	for (const row of document.querySelectorAll<HTMLDivElement>(".track-row")) {
		row.addEventListener("click", (e) => {
			const id = row.dataset.id!;
			// Shift / Ctrl click → toggle multi-select instead of play.
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
		row.addEventListener("contextmenu", (e) => {
			e.preventDefault();
			const id = row.dataset.id!;
			// If you right-click a selected row, the menu acts on the whole set.
			if (state.selectedIds.has(id) && state.selectedIds.size > 1) {
				showContextMenu(e.clientX, e.clientY, ctxItemsForBulk());
				return;
			}
			const t = state.library.find((x) => x.id === id);
			if (t) showContextMenu(e.clientX, e.clientY, ctxItemsForTrack(t));
		});
		if (state.selectedIds.has(row.dataset.id!)) row.classList.add("is-selected");
	}
	updateBulkBar();
	highlightPlayingRow();
	wireSearch();
}

function renderNowPlaying(root: HTMLElement) {
	const t = state.currentTrack;
	if (!t) {
		root.innerHTML = `<div class="empty">${icons.disc}<p>Nothing playing yet. Pick a track from your library.</p></div>`;
		return;
	}

	if (t.kind === "video") {
		root.innerHTML = `
			<div class="video-wrap">
				<div class="video-stage" id="video-mount">
					<div class="video-overlay">
						<div class="video-info">
							<div class="video-title">${escapeHtml(t.title)}</div>
							<div class="video-sub">${escapeHtml(t.artist)}${t.album ? ` — ${escapeHtml(t.album)}` : ""}</div>
						</div>
						<button class="video-pip" id="video-pip" title="Picture-in-picture">${icons.pip}</button>
						<div class="video-center-indicator" id="video-indicator"></div>
					</div>
				</div>
				<div class="video-meta">
					${escapeHtml(t.album)}${t.year ? ` • ${t.year}` : ""}${t.genre ? ` • ${escapeHtml(t.genre)}` : ""}${t.bitrate ? ` • ${Math.round(t.bitrate / 1000)} kbps` : ""}
				</div>
			</div>
		`;
		// renderMain() handles the actual mount of videoEl into #video-mount
		// after this function returns. We wire interactions here.
		queueMicrotask(() => wireVideoStage());
		return;
	}

	root.innerHTML = `
		<div class="np-full">
			<div>
				<div class="np-full-art">
					${t.artDataUrl ? `<img src="${t.artDataUrl}" alt="">` : `<div style="display:flex;align-items:center;justify-content:center;height:100%;opacity:.5">${icons.musicNote}</div>`}
				</div>
				<div class="viz"><canvas id="viz-canvas"></canvas></div>
			</div>
			<div class="np-full-info">
				<h1>${escapeHtml(t.title)}</h1>
				<h2>${escapeHtml(t.artist)}</h2>
				<div class="meta">${escapeHtml(t.album)}${t.year ? ` • ${t.year}` : ""}${t.genre ? ` • ${escapeHtml(t.genre)}` : ""}${t.bitrate ? ` • ${Math.round(t.bitrate / 1000)} kbps` : ""}</div>
				<div class="lyrics" style="margin-top:1.3rem">
					<em>No synced lyrics for this track. Drop an .lrc file next to the audio file and it'll show up here in a future update.</em>
				</div>
			</div>
		</div>
	`;

	const canvas = document.getElementById("viz-canvas") as HTMLCanvasElement | null;
	if (canvas) {
		visualizer?.destroy();
		visualizer = new Visualizer(canvas, engine.analyser, "bars", state.settings.vizStyle);
		visualizer.setMaxFps(state.settings.maxFps);
		visualizer.setIdleEnabled(state.settings.idleViz);
		if (t.artDataUrl) updateAccentFromArt(t.artDataUrl);
		if (!engine.paused) visualizer.start();
	}
}

function renderEqualizer(root: HTMLElement) {
	const customNames = Object.keys(state.settings.customEqPresets);
	root.innerHTML = `
		<div class="topbar">
			<h2>Equalizer</h2>
			<div class="topbar-actions">
				<button class="btn" id="eq-save">${icons.plus}<span>Save preset</span></button>
			</div>
		</div>
		<div class="eq-presets" id="eq-presets">
			${Object.keys(EQ_PRESETS).map((p) => `
				<div class="preset ${p === state.settings.eqPreset ? "active" : ""}" data-p="${p}">${p}</div>
			`).join("")}
			${customNames.map((p) => `
				<div class="preset preset-custom ${p === state.settings.eqPreset ? "active" : ""}" data-p="${p}" data-custom="1">
					${escapeHtml(p)}
					<span class="preset-x" data-del="${escapeHtml(p)}" title="Delete">×</span>
				</div>
			`).join("")}
		</div>
		<div class="eq-wrap">
			<div class="eq" id="eq">
				${EQ_BANDS.map((f, i) => `
					<div class="eq-band">
						<span class="eq-band-value" id="eqv-${i}">${state.settings.eq[i].toFixed(0)} dB</span>
						<input type="range" min="-24" max="24" step="1" value="${state.settings.eq[i]}" data-i="${i}" />
						<span class="eq-band-label">${f >= 1000 ? (f / 1000) + "k" : f}</span>
					</div>
				`).join("")}
			</div>
		</div>
	`;

	for (const p of document.querySelectorAll<HTMLDivElement>("#eq-presets .preset")) {
		p.addEventListener("click", (e) => {
			// Delete handle on a custom preset — don't switch to it.
			if ((e.target as HTMLElement).dataset.del) {
				const name = (e.target as HTMLElement).dataset.del!;
				delete state.settings.customEqPresets[name];
				if (state.settings.eqPreset === name) state.settings.eqPreset = "Flat";
				saveSettings();
				sfx.toggle();
				renderEqualizer(root);
				return;
			}
			const name = p.dataset.p!;
			state.settings.eqPreset = name;
			state.settings.eq = [...(
				EQ_PRESETS[name] ?? state.settings.customEqPresets[name] ?? EQ_PRESETS.Flat
			)];
			engine.setEq(state.settings.eq);
			saveSettings();
			sfx.click();
			renderEqualizer(root);
		});
		p.addEventListener("mouseenter", () => sfx.hover());
	}

	document.getElementById("eq-save")?.addEventListener("click", () => {
		const name = prompt("Name this preset:")?.trim();
		if (!name) return;
		if (EQ_PRESETS[name]) {
			toast(`"${name}" is a built-in preset name — pick another.`, { ttl: 3000 });
			return;
		}
		state.settings.customEqPresets[name] = [...state.settings.eq];
		state.settings.eqPreset = name;
		saveSettings();
		sfx.success();
		renderEqualizer(root);
	});

	for (const s of document.querySelectorAll<HTMLInputElement>(".eq-band input")) {
		syncRangeFill(s);
		s.addEventListener("input", () => {
			const i = parseInt(s.dataset.i!, 10);
			const v = parseInt(s.value, 10);
			state.settings.eq[i] = v;
			state.settings.eqPreset = "Custom";
			engine.setEq(state.settings.eq);
			document.getElementById(`eqv-${i}`)!.textContent = `${v} dB`;
			syncRangeFill(s);
			saveSettings();
		});
	}
}

function renderPlaylists(root: HTMLElement) {
	root.innerHTML = `
		<div class="topbar">
			<h2>Playlists</h2>
			<div class="topbar-actions">
				<button class="btn" id="btn-import-pl">${icons.folder}<span>Import M3U…</span></button>
				<button class="btn btn-primary" id="btn-new-pl">${icons.plus}<span>New playlist</span></button>
			</div>
		</div>
		${state.playlists.length === 0 ? `
			<div class="empty">${icons.list}<p>You haven't made any playlists yet.</p></div>
		` : `
			<div class="grid">
				${state.playlists.map((p) => `
					<div class="card" data-pl="${escapeHtml(p.name)}">
						<div class="card-art">${icons.list}</div>
						<p class="card-title">${escapeHtml(p.name)}</p>
						<p class="card-sub">${p.ids.length} track${p.ids.length === 1 ? "" : "s"}</p>
					</div>
				`).join("")}
			</div>
		`}
	`;

	document.getElementById("btn-new-pl")?.addEventListener("click", async () => {
		const name = prompt("Playlist name?")?.trim();
		if (!name) return;
		state.playlists.push({ name, ids: [] });
		await savePlaylists();
		sfx.success();
		renderPlaylists(root);
		renderSidebarPlaylists();
	});

	document.getElementById("btn-import-pl")?.addEventListener("click", async () => {
		sfx.open();
		try {
			const r = await bun().importPlaylist({});
			if (!r.name) return; // cancelled
			// Make sure imported tracks live in the library too.
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

	for (const c of document.querySelectorAll<HTMLDivElement>(".card[data-pl]")) {
		c.addEventListener("click", () => {
			const name = c.dataset.pl!;
			const pl = state.playlists.find((p) => p.name === name);
			if (!pl || pl.ids.length === 0) {
				toast("This playlist is empty. Add tracks from your library.", { ttl: 3000 });
				return;
			}
			const tracks = pl.ids.map((id) => state.library.find((t) => t.id === id)).filter((x): x is TrackInfo => !!x);
			if (tracks.length > 0) {
				playFromList(tracks, 0);
				sfx.play();
			}
		});
		c.addEventListener("contextmenu", async (e) => {
			e.preventDefault();
			const name = c.dataset.pl!;
			const pl = state.playlists.find((p) => p.name === name);
			if (!pl) return;
			showContextMenu(e.clientX, e.clientY, [
				{ label: "Play", onClick: () => {
					const tracks = pl.ids.map((id) => state.library.find((t) => t.id === id)).filter((x): x is TrackInfo => !!x);
					if (tracks.length > 0) { playFromList(tracks, 0); sfx.play(); }
				}},
				{ label: "Export as M3U…", onClick: async () => {
					sfx.open();
					const paths = pl.ids
						.map((id) => state.library.find((t) => t.id === id))
						.filter((x): x is TrackInfo => !!x)
						.map((t) => t.path);
					const r = await bun().exportPlaylist({ name: pl.name, paths });
					if (r.ok && r.path) toast(`Exported to ${r.path}`, { ttl: 3000 });
					else toast("Export cancelled.", { ttl: 1800 });
				}},
				{ label: "Delete", danger: true, onClick: async () => {
					state.playlists = state.playlists.filter((p) => p.name !== name);
					await savePlaylists();
					renderPlaylists(root);
					renderSidebarPlaylists();
					sfx.toggle();
				}},
			]);
		});
	}
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
				<span>Sleep timer</span>
				<select id="set-sleep" class="select">
					${[0, 5, 10, 15, 30, 45, 60, 90, 120].map((m) => `<option value="${m}" ${m === s.sleepTimer ? "selected" : ""}>${m === 0 ? "Off" : `${m} min`}</option>`).join("")}
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
				<div class="theme-row" id="theme-row">
					${(["midnight","aurora","solar","rose"] as const).map((th) => `
						<div class="theme-swatch ${s.theme === th ? "active" : ""}" data-th="${th}" title="${th}">
							<span class="swatch swatch-${th}"></span>
							<span>${th[0].toUpperCase() + th.slice(1)}</span>
						</div>
					`).join("")}
				</div>
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
			<p>Show what you're playing.</p>
			<div class="setting-row">
				<span>Discord rich presence</span>
				<div class="toggle ${s.discord ? "on" : ""}" id="t-discord"></div>
			</div>
			<div class="setting-row">
				<span>UI sound effects</span>
				<div class="toggle ${s.sfx ? "on" : ""}" id="t-sfx"></div>
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
			<h3>About</h3>
			<p>Lakky — built on Electrobun + Bun.</p>
			<div class="setting-row">
				<span>Version</span>
				<span style="color:rgba(232,232,245,.6)">1.0.0</span>
			</div>
			<div class="setting-row">
				<span>Library size</span>
				<span style="color:rgba(232,232,245,.6)">${state.library.length} tracks</span>
			</div>
			<div class="setting-row">
				<span>Plays this session</span>
				<span style="color:rgba(232,232,245,.6)">${engine.getTrackPlayCount()}</span>
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
			try { await bun().showInFolder({ path: state.libraryFolder }); } catch {}
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
			<div class="queue-row ${i === state.queueIndex ? "is-playing" : ""}" data-i="${i}">
				<div class="mini-art">${t.artDataUrl ? `<img src="${t.artDataUrl}">` : ""}</div>
				<div class="mini-info">
					<div class="qt">${escapeHtml(t.title)}</div>
					<div class="qa">${escapeHtml(t.artist)}</div>
				</div>
			</div>
		`)
		.join("");
	for (const r of el.querySelectorAll<HTMLDivElement>(".queue-row")) {
		r.addEventListener("click", () => {
			state.queueIndex = parseInt(r.dataset.i!, 10);
			playCurrent();
			sfx.click();
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

function trackRow(t: TrackInfo, i: number) {
	const isPlaying = state.currentTrack?.id === t.id;
	const isVideo = t.kind === "video";
	return `
		<div class="track-row ${isPlaying ? "is-playing" : ""}" data-id="${t.id}">
			<div class="num">${i + 1}</div>
			<div class="ti">
				<div class="tt">${isVideo ? `<span class="kind-badge inline">VIDEO</span> ` : ""}${escapeHtml(t.title)}</div>
				<div class="ta">${escapeHtml(t.artist)}</div>
			</div>
			<div class="tb">${escapeHtml(t.album)}</div>
			<div class="td">${formatTime(t.duration)}</div>
			<div></div>
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
function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

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
	if (e.code === "Space") {
		e.preventDefault();
		engine.togglePlay();
		engine.paused ? sfx.pause() : sfx.play();
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
	}
});

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
		<span>${n} selected</span>
		<div class="bulk-actions">
			<button class="btn" id="bulk-edit">Edit metadata…</button>
			<button class="btn" id="bulk-queue">Add to queue</button>
			<button class="btn btn-ghost" id="bulk-clear">Clear</button>
		</div>
	`;
	document.getElementById("bulk-edit")?.addEventListener("click", () => {
		openMetadataEditor(Array.from(state.selectedIds));
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
	document.getElementById("bulk-clear")?.addEventListener("click", clearSelection);
}

function clearSelection() {
	state.selectedIds.clear();
	for (const row of document.querySelectorAll<HTMLDivElement>(".track-row.is-selected")) {
		row.classList.remove("is-selected");
	}
	updateBulkBar();
}

function ctxItemsForBulk(): CtxItem[] {
	const ids = Array.from(state.selectedIds);
	return [
		{ label: `Edit metadata for ${ids.length} tracks…`, onClick: () => openMetadataEditor(ids) },
		{ label: `Add ${ids.length} to queue`, onClick: () => {
			for (const id of ids) {
				const t = state.library.find((x) => x.id === id);
				if (t) state.queue.push(t);
			}
			toast(`Queued ${ids.length} tracks`, { ttl: 2200 });
			clearSelection();
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
						for (const id of ids) if (!p.ids.includes(id)) p.ids.push(id);
						savePlaylists();
						toast(`Added ${ids.length} to "${p.name}"`, { ttl: 2200 });
						clearSelection();
						sfx.click();
					},
				})),
		},
		{ label: "Remove from library", danger: true, onClick: () => {
			state.library = state.library.filter((x) => !state.selectedIds.has(x.id));
			saveLibrary();
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

	const overlay = document.createElement("div");
	overlay.className = "modal-overlay";
	overlay.innerHTML = `
		<div class="modal">
			<h3>Edit metadata${tracks.length > 1 ? ` · ${tracks.length} tracks` : ""}</h3>
			<p class="modal-note">Changes apply in your Lakky library. Files on disk are not modified — your tags stay intact.</p>
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
	document.getElementById("md-save")?.addEventListener("click", () => {
		const get = (id: string) => (document.getElementById(id) as HTMLInputElement).value.trim();
		const title = get("md-title");
		const artist = get("md-artist");
		const album = get("md-album");
		const yearStr = get("md-year");
		const genre = get("md-genre");
		const year = yearStr ? parseInt(yearStr, 10) : undefined;

		const byId = new Map(state.library.map((t) => [t.id, t]));
		for (const t of tracks) {
			const updated = { ...t };
			// Single track: blank fields mean "clear". Bulk: blank == leave alone.
			const blankMeansClear = tracks.length === 1;
			if (title || blankMeansClear) updated.title = title || t.title;
			if (artist || blankMeansClear) updated.artist = artist || t.artist;
			if (album || blankMeansClear) updated.album = album || t.album;
			if (yearStr || blankMeansClear) updated.year = year;
			if (genre || blankMeansClear) updated.genre = genre || undefined;
			byId.set(t.id, updated);
		}
		state.library = Array.from(byId.values());
		saveLibrary();
		renderMain();
		toast(`Updated ${tracks.length} track${tracks.length === 1 ? "" : "s"}`, { ttl: 2400 });
		sfx.success();
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
	engine.setEq(state.settings.eq);
	engine.setVolume(state.settings.volume);
	engine.setRate(state.settings.speed);
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
		refreshLibraryFromFolder(state.libraryFolder).catch(() => {});
	}

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
