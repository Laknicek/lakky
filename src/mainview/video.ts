import type { TrackInfo } from "../shared/rpcSchema";
import type { AudioEngine } from "./audio";
import { escapeHtml } from "./util";
import { sfx } from "./sfx";

// ---------- Types & Constants ----------

export type VideoAspectRatio = "original" | "16:9" | "4:3" | "21:9" | "fit" | "fill";

export const ASPECT_RATIOS: { key: VideoAspectRatio; label: string; desc: string }[] = [
	{ key: "original", label: "Original", desc: "Native video aspect ratio" },
	{ key: "16:9", label: "16:9", desc: "Widescreen standard" },
	{ key: "4:3", label: "4:3", desc: "Retro classic TV" },
	{ key: "21:9", label: "21:9", desc: "Ultra-wide CinemaScope" },
	{ key: "fit", label: "Fit Window", desc: "Scale to fit without clipping" },
	{ key: "fill", label: "Fill Crop", desc: "Zoom to fill entire container" },
];

export const SPEED_PRESETS = [0.25, 0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0] as const;

export interface SubtitleCue {
	id?: string;
	start: number; // in seconds
	end: number;   // in seconds
	text: string;
	html?: string;
}

export interface SubtitleTrack {
	id: string;
	label: string;
	language?: string;
	kind: "subtitles" | "captions";
	cues: SubtitleCue[];
	origin: "embedded" | "external";
	file?: File;
}

export interface SubtitleStyle {
	fontSize: number; // 18, 24, 32, 42
	color: string;    // #ffffff, #ffe259, #6ee7b7, #f472b6
	outline: "anime" | "subtle" | "shadow" | "none";
	background: boolean;
	bottomOffset: number; // in px
}

export const SUBTITLE_COLORS = [
	{ key: "#ffffff", label: "Pure White" },
	{ key: "#ffe259", label: "Anime Yellow" },
	{ key: "#6ee7b7", label: "Neo Cyan" },
	{ key: "#f472b6", label: "Sakura Pink" },
] as const;

export const SUBTITLE_FONT_SIZES = [
	{ size: 18, label: "Small (18px)" },
	{ size: 24, label: "Medium (24px)" },
	{ size: 32, label: "Large (32px)" },
	{ size: 42, label: "Huge (42px)" },
] as const;

export interface CinemaCallbacks {
	onToast: (msg: string, opts?: { ttl?: number; key?: string }) => void;
	onTogglePlay: () => void;
	onSeek: (time: number) => void;
	onPrevious: () => void;
	onNext: () => void;
	onSetVolume: (vol: number) => void;
	onToggleFullscreen: () => Promise<void> | void;
}

// ---------- Formatting Helpers ----------

export function formatVideoTime(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
	const s = Math.floor(seconds);
	const hrs = Math.floor(s / 3600);
	const mins = Math.floor((s % 3600) / 60);
	const secs = s % 60;

	if (hrs > 0) {
		return `${hrs}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
	}
	return `${mins}:${secs.toString().padStart(2, "0")}`;
}

export function parseTimestamp(raw: string): number {
	const parts = raw.trim().replace(",", ".").split(":");
	if (parts.length === 3) {
		const [h, m, s] = parts;
		return parseFloat(h) * 3600 + parseFloat(m) * 60 + parseFloat(s);
	}
	if (parts.length === 2) {
		const [m, s] = parts;
		return parseFloat(m) * 60 + parseFloat(s);
	}
	return parseFloat(raw) || 0;
}

// ---------- Subtitle Parsers (SRT & WebVTT) ----------

export function parseSRT(raw: string): SubtitleCue[] {
	const cues: SubtitleCue[] = [];
	const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const blocks = normalized.split(/\n\n+/);

	for (const block of blocks) {
		const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
		if (lines.length === 0) continue;

		let timeLineIndex = -1;
		for (let i = 0; i < lines.length; i++) {
			if (lines[i].includes("-->")) {
				timeLineIndex = i;
				break;
			}
		}
		if (timeLineIndex === -1) continue;

		const timeMatch = lines[timeLineIndex].match(/((?:\d+:)?\d+:\d+[,.]\d+)\s*-->\s*((?:\d+:)?\d+:\d+[,.]\d+)/);
		if (!timeMatch) continue;

		const start = parseTimestamp(timeMatch[1]);
		const end = parseTimestamp(timeMatch[2]);
		const textLines = lines.slice(timeLineIndex + 1);
		const rawText = textLines.join("\n");
		if (!rawText.trim()) continue;

		// Clean font/styling tags but preserve linebreaks and basic format
		const text = rawText
			.replace(/<font[^>]*>/gi, "")
			.replace(/<\/font>/gi, "")
			.replace(/{\\an\d+}/gi, "")
			.replace(/{\\[^}]+}/gi, "");

		cues.push({ start, end, text });
	}

	return cues.sort((a, b) => a.start - b.start);
}

export function parseVTT(raw: string): SubtitleCue[] {
	const cues: SubtitleCue[] = [];
	const normalized = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const lines = normalized.split("\n");

	let i = 0;
	// Skip WEBVTT header and comment blocks
	while (i < lines.length && !lines[i].includes("-->")) {
		i++;
	}

	while (i < lines.length) {
		const line = lines[i].trim();
		if (!line) {
			i++;
			continue;
		}

		if (line.includes("-->")) {
			const timeMatch = line.match(/((?:\d+:)?\d+:\d+[,.]\d+)\s*-->\s*((?:\d+:)?\d+:\d+[,.]\d+)/);
			if (timeMatch) {
				const start = parseTimestamp(timeMatch[1]);
				const end = parseTimestamp(timeMatch[2]);
				i++;

				const textLines: string[] = [];
				while (i < lines.length && lines[i].trim() !== "" && !lines[i].includes("-->")) {
					textLines.push(lines[i].trim());
					i++;
				}

				const rawText = textLines.join("\n");
				if (rawText) {
					const text = rawText
						.replace(/<c\.[^>]+>/g, "")
						.replace(/<\/c>/g, "")
						.replace(/<v[^>]*>/g, "")
						.replace(/<\/v>/g, "");
					cues.push({ start, end, text });
				}
				continue;
			}
		}
		i++;
	}

	return cues.sort((a, b) => a.start - b.start);
}

// ---------- Cinema HUD Icons ----------

const cinemaIcons = {
	play: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`,
	pause: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>`,
	prev: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zM9 12l10-7v14z"/></svg>`,
	next: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM5 5v14l10-7z"/></svg>`,
	stepBack: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 20L9 12l10-8v16z"/><line x1="5" y1="19" x2="5" y2="5"/></svg>`,
	stepForward: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 4l10 8-10 8V4z"/><line x1="19" y1="5" x2="19" y2="19"/></svg>`,
	volume: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a9 9 0 0 1 0 14"/></svg>`,
	mute: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5L6 9H2v6h4l5 4z"/><line x1="23" y1="9" x2="17" y2="15"/><line x1="17" y1="9" x2="23" y2="15"/></svg>`,
	aspect: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M7 15h10M7 9h4"/></svg>`,
	speed: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>`,
	subtitles: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="6" y1="14" x2="10" y2="14"/><line x1="14" y1="14" x2="18" y2="14"/><line x1="6" y1="10" x2="18" y2="10"/></svg>`,
	camera: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>`,
	pip: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><rect x="13" y="11" width="6" height="5" rx="1" fill="currentColor" stroke="none"/></svg>`,
	fullscreen: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>`,
	fullscreenExit: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M10 14l-7 7"/></svg>`,
	settings: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33h0a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51h0a1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82v0a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`,
	check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
	upload: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`,
	syncPlus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M12 5v14"/></svg>`,
	syncMinus: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/></svg>`,
	sparkle: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.5 5.5L19 10l-5.5 1.5L12 17l-1.5-5.5L5 10l5.5-1.5z"/></svg>`,
};

// ---------- Video Cinema Engine Class ----------

export class VideoCinemaEngine {
	private container: HTMLElement | null = null;
	private videoEl: HTMLVideoElement | null = null;
	private engine: AudioEngine | null = null;
	private currentTrack: TrackInfo | null = null;
	private callbacks: CinemaCallbacks | null = null;

	// State
	private aspectRatio: VideoAspectRatio = "original";
	private playbackSpeed: number = 1.0;
	private subtitleTracks: SubtitleTrack[] = [];
	private activeSubtitleTrackId: string = "off";
	private subtitleSyncOffset: number = 0; // in seconds
	private subtitleStyle: SubtitleStyle = {
		fontSize: 24,
		color: "#ffffff",
		outline: "anime",
		background: false,
		bottomOffset: 48,
	};
	private isHudHidden: boolean = false;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private isDraggingScrub: boolean = false;
	private activeMenu: "aspect" | "speed" | "subtitles" | "subSettings" | null = null;
	private lastVideoWidth: number = 0;
	private lastVideoHeight: number = 0;
	private activeCue: SubtitleCue | null = null;

	// DOM element caches
	private overlayEl: HTMLElement | null = null;
	private topHudEl: HTMLElement | null = null;
	private bottomHudEl: HTMLElement | null = null;
	private subtitlesOverlayEl: HTMLElement | null = null;
	private indicatorEl: HTMLElement | null = null;
	private flashEl: HTMLElement | null = null;
	private scrubFillEl: HTMLElement | null = null;
	private scrubBufferEl: HTMLElement | null = null;
	private scrubHandleEl: HTMLElement | null = null;
	private timeCurrentEl: HTMLElement | null = null;
	private timeDurationEl: HTMLElement | null = null;
	private playBtnEl: HTMLElement | null = null;
	private timeTooltipEl: HTMLElement | null = null;
	private volumeRangeEl: HTMLInputElement | null = null;
	private subtitlePillEl: HTMLElement | null = null;

	// Cleanup tracking
	private abortController: AbortController | null = null;

	constructor() {
		this.loadSavedSettings();
	}

	private loadSavedSettings() {
		try {
			const savedRatio = localStorage.getItem("lakky_video_aspect_ratio");
			if (savedRatio && ASPECT_RATIOS.some((r) => r.key === savedRatio)) {
				this.aspectRatio = savedRatio as VideoAspectRatio;
			}
			const savedSpeed = localStorage.getItem("lakky_video_speed");
			if (savedSpeed) {
				const num = parseFloat(savedSpeed);
				if (num > 0) this.playbackSpeed = num;
			}
			const savedSubStyle = localStorage.getItem("lakky_video_sub_style");
			if (savedSubStyle) {
				this.subtitleStyle = { ...this.subtitleStyle, ...JSON.parse(savedSubStyle) };
			}
		} catch {}
	}

	private saveSettings() {
		try {
			localStorage.setItem("lakky_video_aspect_ratio", this.aspectRatio);
			localStorage.setItem("lakky_video_speed", String(this.playbackSpeed));
			localStorage.setItem("lakky_video_sub_style", JSON.stringify(this.subtitleStyle));
		} catch {}
	}

	// ---------- Mount & Setup ----------

	mount(
		container: HTMLElement,
		videoEl: HTMLVideoElement,
		engine: AudioEngine,
		track: TrackInfo,
		callbacks: CinemaCallbacks,
	) {
		this.unmount();

		this.container = container;
		this.videoEl = videoEl;
		this.engine = engine;
		this.currentTrack = track;
		this.callbacks = callbacks;
		this.abortController = new AbortController();

		// Apply initial video configuration
		this.videoEl.playbackRate = this.playbackSpeed;
		try { (this.videoEl as any).preservesPitch = true; } catch {}

		this.renderStage();
		this.bindEvents();
		this.detectEmbeddedTracks();
		this.applyAspectRatio(this.aspectRatio);
		this.updateHudVisibility(true);
		this.resetIdleTimer();
	}

	unmount() {
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
		this.container = null;
		this.videoEl = null;
		this.engine = null;
		this.currentTrack = null;
		this.callbacks = null;
		this.activeMenu = null;
		this.activeCue = null;
	}

	// ---------- Rendering Stage HTML ----------

	private renderStage() {
		if (!this.container || !this.currentTrack) return;

		const t = this.currentTrack;
		this.container.className = "video-cinema-stage";
		this.container.innerHTML = `
			<div class="video-canvas-container" id="vc-container">
				<!-- Video element is appended here -->
			</div>

			<!-- Subtitles Overlay -->
			<div class="video-subtitles-overlay" id="vc-subtitles" style="bottom:${this.subtitleStyle.bottomOffset}px;"></div>

			<!-- Visual Feedback Overlays -->
			<div class="video-snapshot-flash" id="vc-flash"></div>
			<div class="video-center-indicator" id="vc-indicator"></div>

			<!-- Cinema Glass HUD Overlay -->
			<div class="video-cinema-hud" id="vc-hud">
				<!-- Top Bar -->
				<div class="vc-top-bar" id="vc-top">
					<div class="vc-title-group">
						<div class="vc-title">${escapeHtml(t.title)}</div>
						<div class="vc-sub">${escapeHtml(t.artist)}${t.album ? ` — ${escapeHtml(t.album)}` : ""}</div>
					</div>

					<div class="vc-top-controls">
						<div class="vc-quality-badge" id="vc-res-badge">HD</div>

						<!-- Aspect Ratio Selector Button -->
						<div class="vc-dropdown-anchor">
							<button class="vc-hud-btn" id="vc-btn-aspect" title="Aspect Ratio">
								${cinemaIcons.aspect}
								<span class="vc-btn-label">${this.aspectRatio.toUpperCase()}</span>
							</button>
							<div class="vc-glass-menu hidden" id="vc-menu-aspect"></div>
						</div>

						<!-- Playback Speed Selector Button -->
						<div class="vc-dropdown-anchor">
							<button class="vc-hud-btn" id="vc-btn-speed" title="Playback Speed">
								${cinemaIcons.speed}
								<span class="vc-btn-label">${this.playbackSpeed}x</span>
							</button>
							<div class="vc-glass-menu hidden" id="vc-menu-speed"></div>
						</div>

						<!-- Subtitles Selector & Settings Button -->
						<div class="vc-dropdown-anchor">
							<button class="vc-hud-btn ${this.activeSubtitleTrackId !== "off" ? "active-glow" : ""}" id="vc-btn-subtitles" title="Subtitles & Anime Cel Styling">
								${cinemaIcons.subtitles}
								<span class="vc-btn-label" id="vc-sub-badge">${this.activeSubtitleTrackId !== "off" ? "CC ON" : "CC"}</span>
							</button>
							<div class="vc-glass-menu vc-subtitles-menu hidden" id="vc-menu-subtitles"></div>
						</div>

						<!-- Snapshot Button -->
						<button class="vc-hud-btn" id="vc-btn-snapshot" title="Capture Native Frame Snapshot (S)">
							${cinemaIcons.camera}
						</button>

						<!-- PiP Button -->
						<button class="vc-hud-btn" id="vc-btn-pip" title="Picture-in-Picture">
							${cinemaIcons.pip}
						</button>

						<!-- Fullscreen Button -->
						<button class="vc-hud-btn" id="vc-btn-fullscreen" title="Cinema Fullscreen (F)">
							${cinemaIcons.fullscreen}
						</button>
					</div>
				</div>

				<!-- Bottom Control Bar -->
				<div class="vc-bottom-bar" id="vc-bottom">
					<!-- Time Scrub Bar -->
					<div class="vc-scrub-container" id="vc-scrub-wrap">
						<div class="vc-scrub-track" id="vc-scrub">
							<div class="vc-scrub-buffer" id="vc-scrub-buffer"></div>
							<div class="vc-scrub-fill" id="vc-scrub-fill"></div>
							<div class="vc-scrub-handle" id="vc-scrub-handle"></div>
						</div>
						<div class="vc-time-tooltip" id="vc-time-tooltip">0:00</div>
					</div>

					<div class="vc-bottom-controls">
						<!-- Left controls -->
						<div class="vc-left-controls">
							<button class="vc-hud-btn vc-play-btn" id="vc-btn-play" title="Play / Pause (Space)">
								${cinemaIcons.play}
							</button>

							<!-- Frame Step Backward -->
							<button class="vc-hud-btn vc-step-btn" id="vc-btn-step-back" title="Step 1 Frame Backward (,)">
								${cinemaIcons.stepBack}
								<span class="vc-step-label">-1f</span>
							</button>

							<!-- Frame Step Forward -->
							<button class="vc-hud-btn vc-step-btn" id="vc-btn-step-fwd" title="Step 1 Frame Forward (.)">
								${cinemaIcons.stepForward}
								<span class="vc-step-label">+1f</span>
							</button>

							<button class="vc-hud-btn" id="vc-btn-prev" title="Previous (Ctrl+←)">
								${cinemaIcons.prev}
							</button>
							<button class="vc-hud-btn" id="vc-btn-next" title="Next (Ctrl+→)">
								${cinemaIcons.next}
							</button>

							<div class="vc-time-display">
								<span id="vc-time-cur">0:00</span>
								<span class="vc-time-sep">/</span>
								<span id="vc-time-dur">0:00</span>
							</div>
						</div>

						<!-- Right controls -->
						<div class="vc-right-controls">
							<!-- Volume control -->
							<div class="vc-volume-wrap">
								<button class="vc-hud-btn" id="vc-btn-mute" title="Mute (M)">
									${cinemaIcons.volume}
								</button>
								<input type="range" class="vc-volume-slider" id="vc-volume" min="0" max="100" value="85" title="Volume">
							</div>

							<!-- Quick Subtitle Pill -->
							<button class="vc-pill-btn ${this.activeSubtitleTrackId !== "off" ? "active" : ""}" id="vc-quick-sub" title="Toggle Subtitles (C)">
								${cinemaIcons.subtitles}
								<span>${this.activeSubtitleTrackId !== "off" ? "ON" : "OFF"}</span>
							</button>

							<!-- Quick Aspect Pill -->
							<button class="vc-pill-btn" id="vc-quick-aspect" title="Cycle Aspect Ratio">
								<span>${this.aspectRatio}</span>
							</button>

							<!-- Fullscreen -->
							<button class="vc-hud-btn" id="vc-btn-fullscreen-bottom" title="Fullscreen (F)">
								${cinemaIcons.fullscreen}
							</button>
						</div>
					</div>
				</div>
			</div>

			<!-- Hidden File Input for Subtitle Loading -->
			<input type="file" id="vc-sub-file-input" accept=".srt,.vtt,.txt" style="display:none;" />
		`;

		// Cache elements
		const canvasContainer = document.getElementById("vc-container")!;
		if (this.videoEl) {
			this.videoEl.style.display = "block";
			canvasContainer.appendChild(this.videoEl);
		}

		this.overlayEl = document.getElementById("vc-hud");
		this.topHudEl = document.getElementById("vc-top");
		this.bottomHudEl = document.getElementById("vc-bottom");
		this.subtitlesOverlayEl = document.getElementById("vc-subtitles");
		this.indicatorEl = document.getElementById("vc-indicator");
		this.flashEl = document.getElementById("vc-flash");
		this.scrubFillEl = document.getElementById("vc-scrub-fill");
		this.scrubBufferEl = document.getElementById("vc-scrub-buffer");
		this.scrubHandleEl = document.getElementById("vc-scrub-handle");
		this.timeCurrentEl = document.getElementById("vc-time-cur");
		this.timeDurationEl = document.getElementById("vc-time-dur");
		this.playBtnEl = document.getElementById("vc-btn-play");
		this.timeTooltipEl = document.getElementById("vc-time-tooltip");
		this.volumeRangeEl = document.getElementById("vc-volume") as HTMLInputElement | null;
		this.subtitlePillEl = document.getElementById("vc-quick-sub");

		this.applySubtitleStyles();
	}

	// ---------- Event Bindings ----------

	private bindEvents() {
		if (!this.container || !this.abortController) return;
		const { signal } = this.abortController;

		// Mouse movement & Idle HUD auto-hide
		const handleMouseMove = () => {
			this.updateHudVisibility(true);
			this.resetIdleTimer();
		};
		this.container.addEventListener("mousemove", handleMouseMove, { signal });
		this.container.addEventListener("mousedown", handleMouseMove, { signal });
		this.container.addEventListener("touchstart", handleMouseMove, { signal, passive: true });

		this.container.addEventListener("mouseleave", () => {
			if (this.videoEl && !this.videoEl.paused && !this.activeMenu) {
				this.updateHudVisibility(false);
			}
		}, { signal });

		// Click video to toggle play/pause & Double-click for fullscreen
		let clickTimer: ReturnType<typeof setTimeout> | null = null;
		const canvasContainer = document.getElementById("vc-container");
		if (canvasContainer) {
			canvasContainer.addEventListener("click", (e) => {
				if ((e.target as HTMLElement).closest(".vc-glass-menu")) return;
				if (clickTimer) return;
				clickTimer = setTimeout(() => {
					clickTimer = null;
					this.togglePlayPause();
				}, 220);
			}, { signal });

			canvasContainer.addEventListener("dblclick", (e) => {
				if (clickTimer) {
					clearTimeout(clickTimer);
					clickTimer = null;
				}
				this.toggleFullscreen();
			}, { signal });
		}

		// Play / Pause Button
		this.playBtnEl?.addEventListener("click", (e) => {
			e.stopPropagation();
			this.togglePlayPause();
		}, { signal });

		// Frame Stepping
		document.getElementById("vc-btn-step-back")?.addEventListener("click", (e) => {
			e.stopPropagation();
			this.stepFrame(-1);
		}, { signal });
		document.getElementById("vc-btn-step-fwd")?.addEventListener("click", (e) => {
			e.stopPropagation();
			this.stepFrame(1);
		}, { signal });

		// Track navigation
		document.getElementById("vc-btn-prev")?.addEventListener("click", (e) => {
			e.stopPropagation();
			sfx.skip();
			this.callbacks?.onPrevious();
		}, { signal });
		document.getElementById("vc-btn-next")?.addEventListener("click", (e) => {
			e.stopPropagation();
			sfx.skip();
			this.callbacks?.onNext();
		}, { signal });

		// Snapshot
		document.getElementById("vc-btn-snapshot")?.addEventListener("click", (e) => {
			e.stopPropagation();
			this.takeSnapshot();
		}, { signal });

		// PiP
		document.getElementById("vc-btn-pip")?.addEventListener("click", (e) => {
			e.stopPropagation();
			this.togglePiP();
		}, { signal });

		// Fullscreen buttons
		document.getElementById("vc-btn-fullscreen")?.addEventListener("click", (e) => {
			e.stopPropagation();
			this.toggleFullscreen();
		}, { signal });
		document.getElementById("vc-btn-fullscreen-bottom")?.addEventListener("click", (e) => {
			e.stopPropagation();
			this.toggleFullscreen();
		}, { signal });

		// Aspect Ratio Menu
		const btnAspect = document.getElementById("vc-btn-aspect");
		btnAspect?.addEventListener("click", (e) => {
			e.stopPropagation();
			this.toggleMenu("aspect");
		}, { signal });
		document.getElementById("vc-quick-aspect")?.addEventListener("click", (e) => {
			e.stopPropagation();
			this.cycleAspectRatio();
		}, { signal });

		// Speed Menu
		const btnSpeed = document.getElementById("vc-btn-speed");
		btnSpeed?.addEventListener("click", (e) => {
			e.stopPropagation();
			this.toggleMenu("speed");
		}, { signal });

		// Subtitles Menu & Quick Toggle
		const btnSubtitles = document.getElementById("vc-btn-subtitles");
		btnSubtitles?.addEventListener("click", (e) => {
			e.stopPropagation();
			this.toggleMenu("subtitles");
		}, { signal });
		this.subtitlePillEl?.addEventListener("click", (e) => {
			e.stopPropagation();
			this.toggleSubtitles();
		}, { signal });

		// Subtitle File Picker
		const fileInput = document.getElementById("vc-sub-file-input") as HTMLInputElement | null;
		fileInput?.addEventListener("change", (e) => {
			const file = fileInput.files?.[0];
			if (file) this.loadSubtitleFile(file);
			fileInput.value = "";
		}, { signal });

		// Drag & Drop Subtitles directly onto video
		this.container.addEventListener("dragover", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.container?.classList.add("drag-over");
		}, { signal });
		this.container.addEventListener("dragleave", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.container?.classList.remove("drag-over");
		}, { signal });
		this.container.addEventListener("drop", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.container?.classList.remove("drag-over");
			const file = e.dataTransfer?.files?.[0];
			if (file && (file.name.endsWith(".srt") || file.name.endsWith(".vtt") || file.name.endsWith(".txt"))) {
				this.loadSubtitleFile(file);
			}
		}, { signal });

		// Volume & Mute
		this.volumeRangeEl?.addEventListener("input", (e) => {
			const val = parseFloat((e.target as HTMLInputElement).value) / 100;
			this.callbacks?.onSetVolume(val);
			this.updateVolumeIcon(val);
		}, { signal });
		document.getElementById("vc-btn-mute")?.addEventListener("click", (e) => {
			e.stopPropagation();
			this.toggleMute();
		}, { signal });

		// Scrubbing interaction
		this.wireScrubBar(signal);

		// Close menus on outside click
		window.addEventListener("click", (e) => {
			if (this.activeMenu && !(e.target as HTMLElement).closest(".vc-dropdown-anchor")) {
				this.closeMenus();
			}
		}, { signal });

		// Video events
		if (this.videoEl) {
			this.videoEl.addEventListener("loadedmetadata", () => {
				this.updateResolutionBadge();
				this.applyAspectRatio(this.aspectRatio);
				this.detectEmbeddedTracks();
			}, { signal });

			this.videoEl.addEventListener("play", () => {
				this.syncPlayState(true);
				this.resetIdleTimer();
			}, { signal });

			this.videoEl.addEventListener("pause", () => {
				this.syncPlayState(false);
				this.updateHudVisibility(true);
			}, { signal });

			this.videoEl.addEventListener("progress", () => {
				this.updateBufferBar();
			}, { signal });

			this.videoEl.addEventListener("enterpictureinpicture", () => {
				document.getElementById("vc-btn-pip")?.classList.add("active-glow");
			}, { signal });
			this.videoEl.addEventListener("leavepictureinpicture", () => {
				document.getElementById("vc-btn-pip")?.classList.remove("active-glow");
			}, { signal });
		}
	}

	// ---------- Scrubbing Engine ----------

	private wireScrubBar(signal: AbortSignal) {
		const scrubWrap = document.getElementById("vc-scrub-wrap");
		const scrubTrack = document.getElementById("vc-scrub");
		const tooltip = this.timeTooltipEl;
		if (!scrubWrap || !scrubTrack) return;

		const getPosition = (e: MouseEvent): number => {
			const rect = scrubTrack.getBoundingClientRect();
			const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
			return x / rect.width;
		};

		scrubWrap.addEventListener("mousemove", (e) => {
			if (!this.videoEl || !tooltip) return;
			const p = getPosition(e);
			const dur = this.videoEl.duration || 0;
			const time = p * dur;

			tooltip.textContent = formatVideoTime(time);
			const rect = scrubTrack.getBoundingClientRect();
			const tooltipX = e.clientX - rect.left;
			tooltip.style.left = `${tooltipX}px`;
			tooltip.classList.add("visible");
		}, { signal });

		scrubWrap.addEventListener("mouseleave", () => {
			if (!this.isDraggingScrub) {
				tooltip?.classList.remove("visible");
			}
		}, { signal });

		scrubWrap.addEventListener("mousedown", (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.isDraggingScrub = true;
			const p = getPosition(e);
			const dur = this.videoEl?.duration || 0;
			const targetTime = p * dur;

			this.callbacks?.onSeek(targetTime);
			this.updateProgress(targetTime, dur);

			const onMouseMove = (moveEv: MouseEvent) => {
				if (!this.isDraggingScrub) return;
				const moveP = getPosition(moveEv);
				const moveDur = this.videoEl?.duration || 0;
				const time = moveP * moveDur;
				this.callbacks?.onSeek(time);
				this.updateProgress(time, moveDur);

				if (tooltip) {
					tooltip.textContent = formatVideoTime(time);
					const rect = scrubTrack.getBoundingClientRect();
					tooltip.style.left = `${moveEv.clientX - rect.left}px`;
				}
			};

			const onMouseUp = () => {
				this.isDraggingScrub = false;
				tooltip?.classList.remove("visible");
				window.removeEventListener("mousemove", onMouseMove);
				window.removeEventListener("mouseup", onMouseUp);
			};

			window.addEventListener("mousemove", onMouseMove);
			window.addEventListener("mouseup", onMouseUp);
		}, { signal });
	}

	// ---------- Auto-Hiding HUD Engine ----------

	private updateHudVisibility(visible: boolean) {
		this.isHudHidden = !visible;
		if (this.container) {
			this.container.classList.toggle("hud-hidden", !visible);
			this.container.classList.toggle("hud-visible", visible);
		}
	}

	private resetIdleTimer() {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}

		// Don't hide if paused, dragging, or menu is open
		if (this.videoEl?.paused || this.isDraggingScrub || this.activeMenu) {
			this.updateHudVisibility(true);
			return;
		}

		this.idleTimer = setTimeout(() => {
			if (!this.videoEl?.paused && !this.isDraggingScrub && !this.activeMenu) {
				this.updateHudVisibility(false);
			}
		}, 2600);
	}

	// ---------- Playback Controls ----------

	togglePlayPause() {
		if (!this.videoEl) return;
		this.callbacks?.onTogglePlay();

		const isNowPaused = this.videoEl.paused;
		this.showCenterIndicator(isNowPaused ? "play" : "pause");
		isNowPaused ? sfx.play() : sfx.pause();
	}

	private syncPlayState(playing: boolean) {
		if (this.playBtnEl) {
			this.playBtnEl.innerHTML = playing ? cinemaIcons.pause : cinemaIcons.play;
			this.playBtnEl.title = playing ? "Pause (Space)" : "Play (Space)";
		}
	}

	private showCenterIndicator(icon: "play" | "pause") {
		if (!this.indicatorEl) return;
		this.indicatorEl.classList.remove("flash");
		void this.indicatorEl.offsetWidth; // force reflow
		this.indicatorEl.dataset.icon = icon;
		this.indicatorEl.classList.add("flash");
	}

	// ---------- Time Update & Subtitle Sync ----------

	updateProgress(current: number, duration: number) {
		if (!this.isDraggingScrub) {
			if (this.timeCurrentEl) this.timeCurrentEl.textContent = formatVideoTime(current);
			if (this.timeDurationEl && duration > 0) this.timeDurationEl.textContent = formatVideoTime(duration);

			if (duration > 0) {
				const pct = Math.max(0, Math.min(100, (current / duration) * 100));
				if (this.scrubFillEl) this.scrubFillEl.style.width = `${pct}%`;
				if (this.scrubHandleEl) this.scrubHandleEl.style.left = `${pct}%`;
			}
		}

		this.updateBufferBar();
		this.renderActiveSubtitle(current);
	}

	private updateBufferBar() {
		if (!this.videoEl || !this.scrubBufferEl) return;
		const dur = this.videoEl.duration || 0;
		if (dur <= 0) return;

		const buffered = this.videoEl.buffered;
		if (buffered.length > 0) {
			const cur = this.videoEl.currentTime;
			for (let i = 0; i < buffered.length; i++) {
				if (buffered.start(i) <= cur && cur <= buffered.end(i)) {
					const endPct = (buffered.end(i) / dur) * 100;
					this.scrubBufferEl.style.width = `${Math.min(100, endPct)}%`;
					break;
				}
			}
		}
	}

	// ---------- Aspect Ratio Engine ----------

	setAspectRatio(ratio: VideoAspectRatio) {
		this.aspectRatio = ratio;
		this.saveSettings();
		this.applyAspectRatio(ratio);

		// Update UI labels
		const badge = document.querySelector("#vc-btn-aspect .vc-btn-label");
		if (badge) badge.textContent = ratio.toUpperCase();
		const quickPill = document.querySelector("#vc-quick-aspect span");
		if (quickPill) quickPill.textContent = ratio;

		const opt = ASPECT_RATIOS.find((r) => r.key === ratio);
		this.callbacks?.onToast(`Aspect Ratio: ${opt?.label ?? ratio}`, { ttl: 1500, key: "aspect" });
		sfx.toggle();
		this.closeMenus();
	}

	private cycleAspectRatio() {
		const idx = ASPECT_RATIOS.findIndex((r) => r.key === this.aspectRatio);
		const nextIdx = (idx + 1) % ASPECT_RATIOS.length;
		this.setAspectRatio(ASPECT_RATIOS[nextIdx].key);
	}

	private applyAspectRatio(ratio: VideoAspectRatio) {
		if (!this.container || !this.videoEl) return;

		// Clean previous ratio classes
		this.container.classList.remove(
			"ratio-original", "ratio-16-9", "ratio-4-3", "ratio-21-9", "ratio-fit", "ratio-fill"
		);

		const vw = this.videoEl.videoWidth || 16;
		const vh = this.videoEl.videoHeight || 9;

		switch (ratio) {
			case "original":
				this.container.classList.add("ratio-original");
				this.container.style.setProperty("--cinema-aspect", `${vw} / ${vh}`);
				this.videoEl.style.objectFit = "contain";
				break;
			case "16:9":
				this.container.classList.add("ratio-16-9");
				this.container.style.setProperty("--cinema-aspect", "16 / 9");
				this.videoEl.style.objectFit = "contain";
				break;
			case "4:3":
				this.container.classList.add("ratio-4-3");
				this.container.style.setProperty("--cinema-aspect", "4 / 3");
				this.videoEl.style.objectFit = "contain";
				break;
			case "21:9":
				this.container.classList.add("ratio-21-9");
				this.container.style.setProperty("--cinema-aspect", "21 / 9");
				this.videoEl.style.objectFit = "contain";
				break;
			case "fit":
				this.container.classList.add("ratio-fit");
				this.container.style.removeProperty("--cinema-aspect");
				this.videoEl.style.objectFit = "contain";
				break;
			case "fill":
				this.container.classList.add("ratio-fill");
				this.container.style.removeProperty("--cinema-aspect");
				this.videoEl.style.objectFit = "cover";
				break;
		}
	}

	// ---------- Playback Speed & Frame Stepping ----------

	setPlaybackSpeed(speed: number) {
		this.playbackSpeed = speed;
		this.saveSettings();

		if (this.videoEl) {
			this.videoEl.playbackRate = speed;
			try { (this.videoEl as any).preservesPitch = true; } catch {}
		}
		if (this.engine) {
			this.engine.setRate(speed);
		}

		const badge = document.querySelector("#vc-btn-speed .vc-btn-label");
		if (badge) badge.textContent = `${speed}x`;

		this.callbacks?.onToast(`Speed: ${speed}x`, { ttl: 1400, key: "speed" });
		sfx.toggle();
		this.closeMenus();
	}

	stepFrame(direction: 1 | -1, fps: number = 30) {
		if (!this.videoEl) return;

		// Pause video on frame step for precise inspection
		if (!this.videoEl.paused) {
			this.callbacks?.onTogglePlay();
		}

		const frameTime = 1 / fps;
		const newTime = Math.max(0, Math.min(this.videoEl.duration || 0, this.videoEl.currentTime + direction * frameTime));
		this.callbacks?.onSeek(newTime);
		this.updateProgress(newTime, this.videoEl.duration || 0);

		this.callbacks?.onToast(`Frame ${direction > 0 ? "+1" : "-1"} (${formatVideoTime(newTime)})`, {
			ttl: 800,
			key: "framestep",
		});
		sfx.click();
	}

	// ---------- Quick Frame Snapshot Engine ----------

	async takeSnapshot() {
		if (!this.videoEl) return;

		try {
			const vw = this.videoEl.videoWidth || this.videoEl.clientWidth || 1920;
			const vh = this.videoEl.videoHeight || this.videoEl.clientHeight || 1080;

			const canvas = document.createElement("canvas");
			canvas.width = vw;
			canvas.height = vh;
			const ctx = canvas.getContext("2d");
			if (!ctx) throw new Error("Could not create 2D canvas context");

			ctx.drawImage(this.videoEl, 0, 0, vw, vh);

			// Flash visual feedback
			if (this.flashEl) {
				this.flashEl.classList.remove("trigger-flash");
				void this.flashEl.offsetWidth;
				this.flashEl.classList.add("trigger-flash");
			}

			// Generate image blob / download link
			canvas.toBlob((blob) => {
				if (!blob) {
					this.callbacks?.onToast("Failed to encode snapshot", { ttl: 2000 });
					return;
				}

				const title = (this.currentTrack?.title ?? "video")
					.replace(/[/\\?%*:|"<>]/g, "-")
					.slice(0, 40);
				const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
				const filename = `lakky-snap-${title}-${timestamp}.png`;

				const url = URL.createObjectURL(blob);
				const a = document.createElement("a");
				a.href = url;
				a.download = filename;
				document.body.appendChild(a);
				a.click();
				a.remove();
				setTimeout(() => URL.revokeObjectURL(url), 5000);

				sfx.success();
				this.callbacks?.onToast(`📸 Snapshot saved: ${vw}×${vh} (${filename})`, { ttl: 2800, key: "snap" });
			}, "image/png");
		} catch (err) {
			console.error("[video-cinema] Snapshot failed:", err);
			this.callbacks?.onToast(`Snapshot failed: ${(err as Error).message}`, { ttl: 2500 });
			sfx.error();
		}
	}

	// ---------- Picture-in-Picture (PiP) ----------

	async togglePiP() {
		if (!this.videoEl) return;

		try {
			if (document.pictureInPictureElement) {
				await document.exitPictureInPicture();
				this.callbacks?.onToast("Exited Picture-in-Picture", { ttl: 1500 });
			} else if ((this.videoEl as any).requestPictureInPicture) {
				await (this.videoEl as any).requestPictureInPicture();
				this.callbacks?.onToast("Entered Picture-in-Picture", { ttl: 1500 });
			} else {
				this.callbacks?.onToast("Picture-in-Picture is not supported in this environment.", { ttl: 2200 });
			}
			sfx.toggle();
		} catch (err) {
			this.callbacks?.onToast(`PiP error: ${(err as Error).message}`, { ttl: 2500 });
		}
	}

	// ---------- Fullscreen Cinema Mode ----------

	async toggleFullscreen() {
		sfx.click();
		if (this.callbacks?.onToggleFullscreen) {
			await this.callbacks.onToggleFullscreen();
		}
	}

	// ---------- Volume & Mute ----------

	private updateVolumeIcon(vol: number) {
		const btn = document.getElementById("vc-btn-mute");
		if (!btn) return;
		btn.innerHTML = vol === 0 ? cinemaIcons.mute : cinemaIcons.volume;
	}

	private toggleMute() {
		if (!this.volumeRangeEl) return;
		const cur = parseFloat(this.volumeRangeEl.value) / 100;
		if (cur > 0) {
			(this.volumeRangeEl as any)._prev = cur;
			this.volumeRangeEl.value = "0";
			this.callbacks?.onSetVolume(0);
			this.updateVolumeIcon(0);
		} else {
			const restore = (this.volumeRangeEl as any)._prev ?? 0.85;
			this.volumeRangeEl.value = String(Math.round(restore * 100));
			this.callbacks?.onSetVolume(restore);
			this.updateVolumeIcon(restore);
		}
		sfx.click();
	}

	// ---------- Subtitle Engine & Anime Cel Styling ----------

	private detectEmbeddedTracks() {
		if (!this.videoEl) return;

		const tracks = this.videoEl.textTracks;
		if (!tracks || tracks.length === 0) return;

		for (let i = 0; i < tracks.length; i++) {
			const tt = tracks[i];
			const id = `embedded-${i}`;
			if (!this.subtitleTracks.some((t) => t.id === id)) {
				const cues: SubtitleCue[] = [];
				if (tt.cues) {
					for (let j = 0; j < tt.cues.length; j++) {
						const c = tt.cues[j] as VTTCue;
						cues.push({ start: c.startTime, end: c.endTime, text: c.text });
					}
				}

				this.subtitleTracks.push({
					id,
					label: tt.label || `Track ${i + 1} (${tt.language || "Undetermined"})`,
					language: tt.language,
					kind: tt.kind === "captions" ? "captions" : "subtitles",
					cues,
					origin: "embedded",
				});
			}
		}
	}

	async loadSubtitleFile(file: File) {
		try {
			const text = await file.text();
			let cues: SubtitleCue[] = [];

			if (file.name.endsWith(".vtt") || text.startsWith("WEBVTT")) {
				cues = parseVTT(text);
			} else {
				cues = parseSRT(text);
			}

			if (cues.length === 0) {
				this.callbacks?.onToast("No subtitle cues found in file", { ttl: 2200 });
				return;
			}

			const id = `ext-${Date.now()}`;
			const track: SubtitleTrack = {
				id,
				label: file.name.replace(/\.[^/.]+$/, ""),
				kind: "subtitles",
				cues,
				origin: "external",
				file,
			};

			this.subtitleTracks.push(track);
			this.setSubtitleTrack(id);
			sfx.success();
			this.callbacks?.onToast(`💬 Subtitles loaded: ${track.label} (${cues.length} cues)`, { ttl: 2500, key: "sub" });
		} catch (err) {
			console.error("[video-cinema] Subtitle parse error:", err);
			this.callbacks?.onToast(`Failed to parse subtitles: ${(err as Error).message}`, { ttl: 2500 });
			sfx.error();
		}
	}

	setSubtitleTrack(id: string) {
		this.activeSubtitleTrackId = id;
		const subBtn = document.getElementById("vc-btn-subtitles");
		const subBadge = document.getElementById("vc-sub-badge");

		if (id === "off") {
			subBtn?.classList.remove("active-glow");
			if (subBadge) subBadge.textContent = "CC";
			if (this.subtitlePillEl) {
				this.subtitlePillEl.classList.remove("active");
				const span = this.subtitlePillEl.querySelector("span");
				if (span) span.textContent = "OFF";
			}
			this.clearActiveSubtitle();
			this.callbacks?.onToast("Subtitles: Off", { ttl: 1200, key: "sub" });
		} else {
			const track = this.subtitleTracks.find((t) => t.id === id);
			subBtn?.classList.add("active-glow");
			if (subBadge) subBadge.textContent = "CC ON";
			if (this.subtitlePillEl) {
				this.subtitlePillEl.classList.add("active");
				const span = this.subtitlePillEl.querySelector("span");
				if (span) span.textContent = "ON";
			}
			this.callbacks?.onToast(`Subtitles: ${track?.label ?? "Active"}`, { ttl: 1600, key: "sub" });
		}

		sfx.toggle();
		this.closeMenus();
	}

	toggleSubtitles() {
		if (this.activeSubtitleTrackId !== "off") {
			this.setSubtitleTrack("off");
		} else {
			if (this.subtitleTracks.length > 0) {
				this.setSubtitleTrack(this.subtitleTracks[0].id);
			} else {
				// Prompt file picker
				document.getElementById("vc-sub-file-input")?.click();
			}
		}
	}

	adjustSubtitleSync(deltaSeconds: number) {
		this.subtitleSyncOffset = Math.round((this.subtitleSyncOffset + deltaSeconds) * 10) / 10;
		const offsetText = this.subtitleSyncOffset > 0 ? `+${this.subtitleSyncOffset}s` : `${this.subtitleSyncOffset}s`;
		this.callbacks?.onToast(`Subtitle Sync: ${offsetText}`, { ttl: 1400, key: "subsync" });
		sfx.click();

		// Update readout in subtitle menu if open
		const readout = document.getElementById("vc-sub-sync-val");
		if (readout) readout.textContent = offsetText;
	}

	resetSubtitleSync() {
		this.subtitleSyncOffset = 0;
		this.callbacks?.onToast("Subtitle Sync: 0.0s", { ttl: 1200, key: "subsync" });
		sfx.click();
		const readout = document.getElementById("vc-sub-sync-val");
		if (readout) readout.textContent = "0.0s";
	}

	setSubtitleStyle(partial: Partial<SubtitleStyle>) {
		this.subtitleStyle = { ...this.subtitleStyle, ...partial };
		this.saveSettings();
		this.applySubtitleStyles();
		sfx.toggle();
	}

	private applySubtitleStyles() {
		if (!this.subtitlesOverlayEl) return;
		this.subtitlesOverlayEl.style.bottom = `${this.subtitleStyle.bottomOffset}px`;
		this.subtitlesOverlayEl.style.fontSize = `${this.subtitleStyle.fontSize}px`;
		this.subtitlesOverlayEl.style.setProperty("--sub-color", this.subtitleStyle.color);

		this.subtitlesOverlayEl.classList.remove("sub-outline-anime", "sub-outline-subtle", "sub-outline-shadow", "sub-outline-none");
		this.subtitlesOverlayEl.classList.add(`sub-outline-${this.subtitleStyle.outline}`);
		this.subtitlesOverlayEl.classList.toggle("sub-bg-pill", this.subtitleStyle.background);
	}

	private renderActiveSubtitle(currentTime: number) {
		if (this.activeSubtitleTrackId === "off" || !this.subtitlesOverlayEl) {
			this.clearActiveSubtitle();
			return;
		}

		const track = this.subtitleTracks.find((t) => t.id === this.activeSubtitleTrackId);
		if (!track || track.cues.length === 0) {
			this.clearActiveSubtitle();
			return;
		}

		const adjustedTime = currentTime - this.subtitleSyncOffset;
		const matchingCue = track.cues.find((c) => adjustedTime >= c.start && adjustedTime <= c.end);

		if (matchingCue) {
			if (this.activeCue !== matchingCue) {
				this.activeCue = matchingCue;
				this.subtitlesOverlayEl.innerHTML = `<div class="vc-sub-cue">${escapeHtml(matchingCue.text).replace(/\n/g, "<br>")}</div>`;
				this.subtitlesOverlayEl.classList.add("has-cue");
			}
		} else {
			this.clearActiveSubtitle();
		}
	}

	private clearActiveSubtitle() {
		if (this.activeCue && this.subtitlesOverlayEl) {
			this.activeCue = null;
			this.subtitlesOverlayEl.innerHTML = "";
			this.subtitlesOverlayEl.classList.remove("has-cue");
		}
	}

	// ---------- Menus & Dropdowns ----------

	private toggleMenu(menu: "aspect" | "speed" | "subtitles" | "subSettings") {
		if (this.activeMenu === menu) {
			this.closeMenus();
			return;
		}
		this.closeMenus();
		this.activeMenu = menu;
		sfx.open();

		switch (menu) {
			case "aspect":
				this.renderAspectMenu();
				break;
			case "speed":
				this.renderSpeedMenu();
				break;
			case "subtitles":
				this.renderSubtitlesMenu();
				break;
		}
	}

	private closeMenus() {
		this.activeMenu = null;
		document.querySelectorAll(".vc-glass-menu").forEach((el) => {
			el.classList.add("hidden");
			el.innerHTML = "";
		});
	}

	private renderAspectMenu() {
		const menu = document.getElementById("vc-menu-aspect");
		if (!menu) return;

		menu.innerHTML = `
			<div class="vc-menu-header">Aspect Ratio</div>
			<div class="vc-menu-items">
				${ASPECT_RATIOS.map((r) => `
					<button class="vc-menu-item ${this.aspectRatio === r.key ? "active" : ""}" data-aspect="${r.key}">
						<div class="vc-item-title">${r.label}</div>
						<div class="vc-item-desc">${r.desc}</div>
						${this.aspectRatio === r.key ? `<span class="vc-check">${cinemaIcons.check}</span>` : ""}
					</button>
				`).join("")}
			</div>
		`;
		menu.classList.remove("hidden");

		menu.querySelectorAll("[data-aspect]").forEach((btn) => {
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				const ratio = (btn as HTMLElement).dataset.aspect as VideoAspectRatio;
				this.setAspectRatio(ratio);
			});
		});
	}

	private renderSpeedMenu() {
		const menu = document.getElementById("vc-menu-speed");
		if (!menu) return;

		menu.innerHTML = `
			<div class="vc-menu-header">Playback Speed</div>
			<div class="vc-menu-grid">
				${SPEED_PRESETS.map((s) => `
					<button class="vc-speed-item ${this.playbackSpeed === s ? "active" : ""}" data-speed="${s}">
						${s}x
					</button>
				`).join("")}
			</div>
		`;
		menu.classList.remove("hidden");

		menu.querySelectorAll("[data-speed]").forEach((btn) => {
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				const speed = parseFloat((btn as HTMLElement).dataset.speed!);
				this.setPlaybackSpeed(speed);
			});
		});
	}

	private renderSubtitlesMenu() {
		const menu = document.getElementById("vc-menu-subtitles");
		if (!menu) return;

		const syncText = this.subtitleSyncOffset > 0 ? `+${this.subtitleSyncOffset}s` : `${this.subtitleSyncOffset}s`;

		menu.innerHTML = `
			<div class="vc-sub-menu-tabs">
				<div class="vc-menu-header" style="padding-bottom:0">Subtitles & Anime Cel Styling</div>
			</div>

			<!-- Track Selection -->
			<div class="vc-menu-section-title">Select Track</div>
			<div class="vc-menu-items">
				<button class="vc-menu-item ${this.activeSubtitleTrackId === "off" ? "active" : ""}" data-sub-track="off">
					<div class="vc-item-title">Off (Disabled)</div>
					${this.activeSubtitleTrackId === "off" ? `<span class="vc-check">${cinemaIcons.check}</span>` : ""}
				</button>
				${this.subtitleTracks.map((t) => `
					<button class="vc-menu-item ${this.activeSubtitleTrackId === t.id ? "active" : ""}" data-sub-track="${t.id}">
						<div class="vc-item-title">${escapeHtml(t.label)}</div>
						<div class="vc-item-desc">${t.origin === "embedded" ? "Embedded Stream Track" : "External Local Subtitle"} • ${t.cues.length} cues</div>
						${this.activeSubtitleTrackId === t.id ? `<span class="vc-check">${cinemaIcons.check}</span>` : ""}
					</button>
				`).join("")}
				<button class="vc-menu-item vc-item-action" id="vc-menu-load-sub">
					<span class="vc-action-icon">${cinemaIcons.upload}</span>
					<div class="vc-item-title">Load Subtitle (.srt / .vtt)...</div>
				</button>
			</div>

			<!-- Sync Adjustment -->
			<div class="vc-menu-section-title">Timing Sync Adjustment</div>
			<div class="vc-sync-row">
				<button class="vc-sync-btn" id="vc-sync-minus" title="Delay -0.5s">${cinemaIcons.syncMinus} 0.5s</button>
				<div class="vc-sync-display" id="vc-sub-sync-val">${syncText}</div>
				<button class="vc-sync-btn" id="vc-sync-plus" title="Advance +0.5s">${cinemaIcons.syncPlus} 0.5s</button>
				<button class="vc-sync-reset" id="vc-sync-reset" title="Reset timing to 0s">Reset</button>
			</div>

			<!-- Anime Cel Outline Styling Options -->
			<div class="vc-menu-section-title">Anime Cel Outline Style</div>
			<div class="vc-style-row">
				<div class="vc-style-group">
					<span class="vc-style-label">Font Size</span>
					<div class="vc-btn-pill-group">
						${SUBTITLE_FONT_SIZES.map((f) => `
							<button class="vc-pill-choice ${this.subtitleStyle.fontSize === f.size ? "active" : ""}" data-sub-size="${f.size}">
								${f.size}
							</button>
						`).join("")}
					</div>
				</div>

				<div class="vc-style-group">
					<span class="vc-style-label">Color</span>
					<div class="vc-color-pill-group">
						${SUBTITLE_COLORS.map((c) => `
							<button class="vc-color-choice ${this.subtitleStyle.color === c.key ? "active" : ""}" style="background:${c.key};" data-sub-color="${c.key}" title="${c.label}"></button>
						`).join("")}
					</div>
				</div>
			</div>

			<div class="vc-style-row" style="margin-top:0.4rem">
				<div class="vc-style-group">
					<span class="vc-style-label">Outline Style</span>
					<div class="vc-btn-pill-group">
						<button class="vc-pill-choice ${this.subtitleStyle.outline === "anime" ? "active" : ""}" data-sub-outline="anime">Cel Outline</button>
						<button class="vc-pill-choice ${this.subtitleStyle.outline === "shadow" ? "active" : ""}" data-sub-outline="shadow">Drop Shadow</button>
						<button class="vc-pill-choice ${this.subtitleStyle.outline === "subtle" ? "active" : ""}" data-sub-outline="subtle">Subtle</button>
					</div>
				</div>

				<div class="vc-style-group">
					<span class="vc-style-label">Glass Pill</span>
					<button class="vc-pill-choice ${this.subtitleStyle.background ? "active" : ""}" id="vc-sub-pill-toggle">
						${this.subtitleStyle.background ? "ON" : "OFF"}
					</button>
				</div>
			</div>
		`;
		menu.classList.remove("hidden");

		// Track selections
		menu.querySelectorAll("[data-sub-track]").forEach((btn) => {
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				const id = (btn as HTMLElement).dataset.subTrack!;
				this.setSubtitleTrack(id);
			});
		});

		// Load file trigger
		document.getElementById("vc-menu-load-sub")?.addEventListener("click", (e) => {
			e.stopPropagation();
			document.getElementById("vc-sub-file-input")?.click();
			this.closeMenus();
		});

		// Sync buttons
		document.getElementById("vc-sync-minus")?.addEventListener("click", (e) => {
			e.stopPropagation();
			this.adjustSubtitleSync(-0.5);
		});
		document.getElementById("vc-sync-plus")?.addEventListener("click", (e) => {
			e.stopPropagation();
			this.adjustSubtitleSync(0.5);
		});
		document.getElementById("vc-sync-reset")?.addEventListener("click", (e) => {
			e.stopPropagation();
			this.resetSubtitleSync();
		});

		// Font sizes
		menu.querySelectorAll("[data-sub-size]").forEach((btn) => {
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				const size = parseInt((btn as HTMLElement).dataset.subSize!, 10);
				this.setSubtitleStyle({ fontSize: size });
				this.renderSubtitlesMenu();
			});
		});

		// Colors
		menu.querySelectorAll("[data-sub-color]").forEach((btn) => {
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				const color = (btn as HTMLElement).dataset.subColor!;
				this.setSubtitleStyle({ color });
				this.renderSubtitlesMenu();
			});
		});

		// Outline styles
		menu.querySelectorAll("[data-sub-outline]").forEach((btn) => {
			btn.addEventListener("click", (e) => {
				e.stopPropagation();
				const outline = (btn as HTMLElement).dataset.subOutline as any;
				this.setSubtitleStyle({ outline });
				this.renderSubtitlesMenu();
			});
		});

		// Pill toggle
		document.getElementById("vc-sub-pill-toggle")?.addEventListener("click", (e) => {
			e.stopPropagation();
			this.setSubtitleStyle({ background: !this.subtitleStyle.background });
			this.renderSubtitlesMenu();
		});
	}

	// ---------- Quality / Resolution Badge ----------

	private updateResolutionBadge() {
		if (!this.videoEl) return;
		const badge = document.getElementById("vc-res-badge");
		if (!badge) return;

		const vw = this.videoEl.videoWidth;
		const vh = this.videoEl.videoHeight;
		this.lastVideoWidth = vw;
		this.lastVideoHeight = vh;

		let tag = "HD";
		if (vh >= 2160 || vw >= 3840) tag = "4K UHD";
		else if (vh >= 1440 || vw >= 2560) tag = "2K QHD";
		else if (vh >= 1080 || vw >= 1920) tag = "1080p";
		else if (vh >= 720 || vw >= 1280) tag = "720p";
		else if (vh > 0) tag = `${vh}p`;

		badge.textContent = tag;
	}

	// ---------- Keyboard Shortcuts Interceptor ----------

	handleKeydown(e: KeyboardEvent): boolean {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return false;

		switch (e.code) {
			case "Space":
			case "KeyK":
				e.preventDefault();
				this.togglePlayPause();
				return true;
			case "KeyF":
				e.preventDefault();
				this.toggleFullscreen();
				return true;
			case "KeyS":
				if (!e.ctrlKey && !e.metaKey) {
					e.preventDefault();
					this.takeSnapshot();
					return true;
				}
				break;
			case "KeyC":
				e.preventDefault();
				this.toggleSubtitles();
				return true;
			case "Comma":
				e.preventDefault();
				this.stepFrame(-1);
				return true;
			case "Period":
				e.preventDefault();
				this.stepFrame(1);
				return true;
			case "BracketLeft":
				e.preventDefault();
				this.adjustSubtitleSync(-0.5);
				return true;
			case "BracketRight":
				e.preventDefault();
				this.adjustSubtitleSync(0.5);
				return true;
		}

		return false;
	}
}

// Global Singleton Instance for clean reuse
export const cinemaEngine = new VideoCinemaEngine();
