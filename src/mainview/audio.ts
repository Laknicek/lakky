import type { TrackInfo } from "../shared/rpcSchema";
import { compileGraph, type NodeGraph } from "./nodes";

export type RepeatMode = "off" | "all" | "one";

export const EQ_BANDS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000] as const;

export type EQ = number[]; // 10 gains in dB

export const EQ_PRESETS: Record<string, EQ> = {
	Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
	"Bass Boost": [6, 5, 3, 1, 0, 0, 0, 0, 0, 0],
	"Treble Boost": [0, 0, 0, 0, 0, 1, 3, 5, 6, 6],
	Vocal: [-2, -1, 0, 2, 3, 3, 2, 1, 0, -1],
	"Lo-Fi": [4, 3, 1, -1, -2, -2, -3, -4, -5, -5],
	Electronic: [4, 3, 0, -2, -1, 1, 2, 3, 4, 5],
	Classical: [3, 2, 1, 0, -1, -1, 0, 1, 2, 3],
	Loudness: [5, 3, 0, 0, -2, 0, 0, 3, 5, 6],
};

export type AudioEngineEvents = {
	onTimeUpdate?: (current: number, duration: number) => void;
	onEnded?: () => void;
	onPlay?: () => void;
	onPause?: () => void;
	onLoaded?: () => void;
	onError?: (msg: string) => void;
};

export class AudioEngine {
	media: HTMLMediaElement;
	private ctx: AudioContext;
	private source: MediaElementAudioSourceNode | null = null;
	private filters: BiquadFilterNode[] = [];
	private gain: GainNode;
	analyser: AnalyserNode;
	private cb: AudioEngineEvents = {};
	private fadeRaf: number | null = null;
	private graphConnected = false;
	// When non-null, the user's custom node graph is spliced in where the
	// 10-band EQ chain normally sits. setEq becomes a no-op in this mode
	// because the EQ filters are not in the signal path.
	private nodeGraph: NodeGraph | null = null;
	private nodeEntry: AudioNode | null = null;
	private nodeExit: AudioNode | null = null;
	// Tracks whatever AudioNode is currently feeding `gain`. Without this,
	// swapping between node graphs (or between graph→EQ chain) leaks: the
	// previous "middle" stays connected to gain, the new one also connects,
	// and the analyser ends up seeing a sum of both paths — which presents
	// as "the visualizer goes crazy after I touched the node editor".
	private feedingGain: AudioNode | null = null;
	private trackCount = 0;
	private trackTimes: number[] = []; // wall-clock ms when each play started, for stats

	// When `sharedAnalyser` is passed all engines route their output through
	// the same AnalyserNode. The visualizer reads from that one node, which
	// means crossfades, engine swaps, and audio↔video transitions don't leave
	// it staring at a silent (now-inactive) engine's tap.
	constructor(media: HTMLMediaElement, sharedCtx?: AudioContext, sharedAnalyser?: AnalyserNode) {
		this.media = media;
		this.media.crossOrigin = "anonymous";
		this.ctx =
			sharedCtx ?? new (window.AudioContext || (window as any).webkitAudioContext)();

		this.gain = this.ctx.createGain();
		this.gain.gain.value = 1;

		if (sharedAnalyser) {
			this.analyser = sharedAnalyser;
		} else {
			this.analyser = this.ctx.createAnalyser();
			this.analyser.fftSize = 2048;
			this.analyser.smoothingTimeConstant = 0.78;
		}

		for (const f of EQ_BANDS) {
			const filter = this.ctx.createBiquadFilter();
			filter.type = f === EQ_BANDS[0] ? "lowshelf"
				: f === EQ_BANDS[EQ_BANDS.length - 1] ? "highshelf"
				: "peaking";
			filter.frequency.value = f;
			filter.Q.value = 1.4;
			filter.gain.value = 0;
			this.filters.push(filter);
		}

		this.media.addEventListener("timeupdate", () => {
			this.cb.onTimeUpdate?.(this.media.currentTime, this.media.duration || 0);
		});
		this.media.addEventListener("ended", () => this.cb.onEnded?.());
		this.media.addEventListener("play", () => this.cb.onPlay?.());
		this.media.addEventListener("pause", () => this.cb.onPause?.());
		this.media.addEventListener("loadedmetadata", () => this.cb.onLoaded?.());
		this.media.addEventListener("error", () => {
			this.cb.onError?.(`Playback error (code ${this.media.error?.code ?? "?"})`);
		});
	}

	private ensureGraph() {
		if (this.graphConnected) return;
		this.source = this.ctx.createMediaElementSource(this.media);
		this.gain.connect(this.analyser);
		this.wireMiddle();
		this.graphConnected = true;
	}

	// Wire the section between `source` and `gain` according to the current
	// mode (custom node graph if set, otherwise the default 10-band EQ chain).
	// Safe to call repeatedly — it disconnects whatever was there first.
	private wireMiddle() {
		if (!this.source) return;
		// 1) Explicitly disconnect whatever was previously feeding `gain`.
		//    This is the critical bit: a prior `nodeExit` (from an older
		//    compiled graph) still has a live connection to `gain` and would
		//    keep summing in unless we drop it here.
		if (this.feedingGain) {
			try { this.feedingGain.disconnect(this.gain); } catch {}
			this.feedingGain = null;
		}
		// 2) Detach source from everything and clear the EQ chain so the new
		//    wiring starts from a clean slate.
		try { this.source.disconnect(); } catch {}
		for (const f of this.filters) {
			try { f.disconnect(); } catch {}
		}
		// 3) If there's a previous graph's exit still hanging around with
		//    incoming connections, kill them all too (the graph's internal
		//    wiring otherwise keeps it alive and routing).
		if (this.nodeExit) {
			try { this.nodeExit.disconnect(); } catch {}
		}

		if (this.nodeGraph && this.nodeEntry && this.nodeExit) {
			this.source.connect(this.nodeEntry);
			this.nodeExit.connect(this.gain);
			this.feedingGain = this.nodeExit;
		} else {
			let node: AudioNode = this.source;
			for (const f of this.filters) {
				node.connect(f);
				node = f;
			}
			node.connect(this.gain);
			this.feedingGain = node;
		}
	}

	on(events: AudioEngineEvents) {
		this.cb = { ...this.cb, ...events };
	}

	// Used when this engine is no longer the primary — prevents stale handlers
	// (e.g. the outgoing engine's onTimeUpdate) from clobbering the UI.
	clearListeners() {
		this.cb = {};
	}

	// Update the 10-band EQ gains. When a custom node graph is active the EQ
	// chain is not in the signal path, so this becomes a stored-but-inert
	// update — values are still applied to the filter nodes (so they're
	// correct if/when we revert) but nothing about the audio changes until
	// setNodeGraph(null) restores the default chain.
	setEq(values: number[]) {
		values.forEach((v, i) => {
			if (this.filters[i]) {
				this.filters[i].gain.value = Math.max(-24, Math.min(24, v));
			}
		});
	}

	// Splice a user-built node graph into the signal path in place of the
	// 10-band EQ. Pass null to revert to the default EQ chain. The gain and
	// analyser nodes (and the destination) stay where they are — the graph
	// only replaces the middle section between `source` and `gain`.
	setNodeGraph(graph: NodeGraph | null) {
		this.nodeGraph = graph;
		if (graph) {
			const { entry, exit } = compileGraph(graph, this.ctx);
			this.nodeEntry = entry;
			this.nodeExit = exit;
		} else {
			this.nodeEntry = null;
			this.nodeExit = null;
		}
		// Only rewire if the source already exists. If the graph hasn't been
		// connected yet (no track played), ensureGraph() will pick up the
		// new nodeGraph state on its first call.
		if (this.graphConnected) this.wireMiddle();
	}

	setVolume(v: number) {
		this.gain.gain.cancelScheduledValues(this.ctx.currentTime);
		this.gain.gain.linearRampToValueAtTime(
			Math.max(0, Math.min(1, v)),
			this.ctx.currentTime + 0.02,
		);
	}

	getVolume() {
		return this.gain.gain.value;
	}

	// playbackRate maps directly. preservesPitch (default true in Chromium) keeps
	// the music in key at non-1× speeds — important for audiobooks/podcasts.
	setRate(r: number) {
		const v = Math.max(0.25, Math.min(4, r));
		this.media.playbackRate = v;
		try {
			(this.media as any).preservesPitch = true;
			(this.media as any).webkitPreservesPitch = true;
		} catch {}
	}

	getRate() {
		return this.media.playbackRate;
	}

	async loadAndPlay(track: TrackInfo) {
		if (this.ctx.state === "suspended") await this.ctx.resume();
		this.ensureGraph();
		this.media.src = track.streamUrl;
		try {
			await this.media.play();
			this.trackCount++;
			this.trackTimes.push(Date.now());
		} catch (err) {
			this.cb.onError?.(`Failed to start playback: ${(err as Error).message}`);
		}
	}

	togglePlay() {
		if (this.media.paused) {
			this.media.play().catch((err) => this.cb.onError?.(err.message));
		} else {
			this.media.pause();
		}
	}

	pause() {
		this.media.pause();
	}

	play() {
		this.media.play().catch(() => {});
	}

	seek(time: number) {
		if (Number.isFinite(time)) this.media.currentTime = time;
	}

	get currentTime() {
		return this.media.currentTime;
	}

	get duration() {
		return this.media.duration || 0;
	}

	get paused() {
		return this.media.paused;
	}

	fadeOut(durationMs: number, then?: () => void) {
		const start = this.gain.gain.value;
		const t0 = performance.now();
		const tick = () => {
			const p = Math.min(1, (performance.now() - t0) / durationMs);
			this.gain.gain.value = start * (1 - p);
			if (p < 1) this.fadeRaf = requestAnimationFrame(tick);
			else {
				this.media.pause();
				this.gain.gain.value = start;
				then?.();
			}
		};
		this.fadeRaf = requestAnimationFrame(tick);
	}

	getTrackPlayCount() {
		return this.trackCount;
	}
}
