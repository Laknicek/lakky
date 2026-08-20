import type { TrackInfo, RepeatMode } from "../shared/rpcSchema";
import { compileGraph, type NodeGraph } from "./nodes";

export type { RepeatMode };

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
	private preAmp: GainNode;
	monitorTap: AudioNode;
	private cb: AudioEngineEvents = {};
	private fadeRaf: number | null = null;
	private graphConnected = false;
	private nodeGraph: NodeGraph | null = null;
	private nodeEntry: AudioNode | null = null;
	private nodeExit: AudioNode | null = null;
	private feedingGain: AudioNode | null = null;
	private trackCount = 0;
	private trackTimes: number[] = [];
	private abLoop: { a: number; b: number } | null = null;
	private monoMerge: ChannelMergerNode | null = null;
	private _mono = false;

	constructor(media: HTMLMediaElement, sharedCtx?: AudioContext, monitorTap?: AudioNode) {
		this.media = media;
		this.media.crossOrigin = "anonymous";
		this.ctx =
			sharedCtx ?? new window.AudioContext();

		this.gain = this.ctx.createGain();
		this.gain.gain.value = 1;
		this.preAmp = this.ctx.createGain();
		this.preAmp.gain.value = 1;
		this.preAmp.connect(this.gain);
		this.monitorTap = monitorTap ?? this.ctx.destination;

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
			const cur = this.media.currentTime;
			const dur = this.media.duration || 0;
			this.cb.onTimeUpdate?.(cur, dur);
			// AB repeat check
			if (this.abLoop && this.abLoop.a < this.abLoop.b && dur > 0) {
				if (cur >= this.abLoop.b) {
					this.media.currentTime = this.abLoop.a;
				}
			}
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
		this.gain.connect(this.monitorTap);
		this.wireMiddle();
		this.graphConnected = true;
	}

	private wireMiddle() {
		if (!this.source) return;
		if (this.feedingGain) {
			try { this.feedingGain.disconnect(this.preAmp); } catch {}
			this.feedingGain = null;
		}
		try { this.source.disconnect(); } catch {}
		for (const f of this.filters) { try { f.disconnect(); } catch {} }
		if (this.nodeExit) { try { this.nodeExit.disconnect(); } catch {} }
		if (this.monoMerge) { try { this.monoMerge.disconnect(); } catch {} }

		const tail = this.monoMerge ?? this.preAmp;

		if (this.nodeGraph && this.nodeEntry && this.nodeExit) {
			this.source.connect(this.nodeEntry);
			this.nodeExit.connect(tail);
			this.feedingGain = this.nodeExit;
		} else {
			let node: AudioNode = this.source;
			for (const f of this.filters) { node.connect(f); node = f; }
			node.connect(tail);
			this.feedingGain = node;
		}
	}

	on(events: AudioEngineEvents) { this.cb = { ...this.cb, ...events }; }
	clearListeners() { this.cb = {}; }

	setEq(values: number[]) {
		values.forEach((v, i) => {
			if (this.filters[i]) this.filters[i].gain.value = Math.max(-24, Math.min(24, v));
		});
	}

	setNodeGraph(graph: NodeGraph | null) {
		this.nodeGraph = graph;
		if (graph) {
			const { entry, exit } = compileGraph(graph, this.ctx);
			this.nodeEntry = entry; this.nodeExit = exit;
		} else { this.nodeEntry = null; this.nodeExit = null; }
		if (this.graphConnected) this.wireMiddle();
	}

	setVolume(v: number) {
		this.gain.gain.cancelScheduledValues(this.ctx.currentTime);
		this.gain.gain.linearRampToValueAtTime(Math.max(0, Math.min(1, v)), this.ctx.currentTime + 0.02);
	}

	setPreAmp(db: number) {
		this.preAmp.gain.value = Math.pow(10, Math.max(-12, Math.min(12, db)) / 20);
	}

	setMono(on: boolean) {
		this._mono = on;
		if (on && !this.monoMerge && this.source) {
			const splitter = this.ctx.createChannelSplitter(2);
			this.monoMerge = this.ctx.createChannelMerger(1);
			splitter.connect(this.monoMerge, 0);
			splitter.connect(this.monoMerge, 1);
			try { this.source.disconnect(splitter); } catch {}
			this.source.connect(splitter);
			this.wireMiddle();
		}
	}

	setABLoop(loop: { a: number; b: number } | null) { this.abLoop = loop; }

	async setSinkId(deviceId: string) {
		if ("setSinkId" in this.media) {
			try { await (this.media as any).setSinkId(deviceId); } catch (e) {
				console.warn("[audio] setSinkId failed:", (e as Error).message);
			}
		}
	}

	setRate(r: number) {
		const v = Math.max(0.25, Math.min(4, r));
		this.media.playbackRate = v;
		try { (this.media as any).preservesPitch = true; } catch {}
	}

	async loadAndPlay(track: TrackInfo) {
		if (this.ctx.state !== "running") {
			try { await this.ctx.resume(); } catch (err) {
				console.warn("[audio] AudioContext resume failed (pre-play):", (err as Error).message);
			}
		}
		this.monoMerge = null;
		this.ensureGraph();
		if (this._mono) this.setMono(true);
		this.media.src = track.streamUrl;
		try {
			await this.media.play();
			if (this.ctx.state !== "running") {
				try { await this.ctx.resume(); } catch (err) {
					console.warn("[audio] AudioContext resume failed (post-play):", (err as Error).message);
				}
			}
			this.trackCount++;
			this.trackTimes.push(Date.now());
		} catch (err) {
			this.cb.onError?.(`Failed to start playback: ${(err as Error).message}`);
		}
	}

	togglePlay() {
		if (this.media.paused) {
			this.media.play().catch((err) => this.cb.onError?.(err.message));
		} else { this.media.pause(); }
	}

	pause() { this.media.pause(); }

	play() {
		this.media.play().catch((err) => this.cb.onError?.(`Play failed: ${err.message}`));
	}

	seek(time: number) { if (Number.isFinite(time)) this.media.currentTime = time; }

	get currentTime() { return this.media.currentTime; }
	get duration() { return this.media.duration || 0; }
	get paused() { return this.media.paused; }

	fadeOut(durationMs: number, then?: () => void) {
		const start = this.gain.gain.value;
		const t0 = performance.now();
		const tick = () => {
			const p = Math.min(1, (performance.now() - t0) / durationMs);
			this.gain.gain.value = start * (1 - p);
			if (p < 1) this.fadeRaf = requestAnimationFrame(tick);
			else { this.media.pause(); this.gain.gain.value = start; then?.(); }
		};
		this.fadeRaf = requestAnimationFrame(tick);
	}

	private sharedAnalyser: AnalyserNode | null = null;
	private freqBuffer: Uint8Array | null = null;

	getAudioBands(): { bass: number; mid: number; treble: number; energy: number } {
		if (!this.sharedAnalyser) {
			try {
				this.sharedAnalyser = this.ctx.createAnalyser();
				this.sharedAnalyser.fftSize = 512;
				this.sharedAnalyser.smoothingTimeConstant = 0.8;
				this.monitorTap.connect(this.sharedAnalyser);
				this.freqBuffer = new Uint8Array(this.sharedAnalyser.frequencyBinCount);
			} catch {
				return { bass: 0, mid: 0, treble: 0, energy: 0 };
			}
		}
		if (!this.freqBuffer || !this.sharedAnalyser) return { bass: 0, mid: 0, treble: 0, energy: 0 };
		this.sharedAnalyser.getByteFrequencyData(this.freqBuffer as unknown as Uint8Array<ArrayBuffer>);

		const len = this.freqBuffer.length;
		let bassSum = 0, bassCount = 0;
		let midSum = 0, midCount = 0;
		let trebleSum = 0, trebleCount = 0;
		let totalSum = 0;

		for (let i = 0; i < len; i++) {
			const v = this.freqBuffer[i] / 255;
			totalSum += v;
			if (i < len * 0.15) {
				bassSum += v;
				bassCount++;
			} else if (i < len * 0.6) {
				midSum += v;
				midCount++;
			} else {
				trebleSum += v;
				trebleCount++;
			}
		}

		return {
			bass: bassCount > 0 ? bassSum / bassCount : 0,
			mid: midCount > 0 ? midSum / midCount : 0,
			treble: trebleCount > 0 ? trebleSum / trebleCount : 0,
			energy: totalSum / len,
		};
	}

	getTrackPlayCount() { return this.trackCount; }
}
