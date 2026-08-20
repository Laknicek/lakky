import type { TrackInfo, RepeatMode } from "../shared/rpcSchema";
import { compileGraph, type NodeGraph } from "./nodes";

export type { RepeatMode };

export const EQ_BANDS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000] as const;

export type EQ = number[]; // 10 gains in dB

export const EQ_PRESETS: Record<string, EQ> = {
	"Anime J-Pop": [3, 2, 0, 1, 3, 4, 5, 4, 3, 2],
	"Bass Cannon": [9, 8, 5, 2, 0, -1, 0, 1, 2, 2],
	"Lo-Fi Chill": [5, 4, 2, 0, -1, -2, -3, -5, -7, -8],
	"Crystal Vocals": [-3, -2, 0, 2, 4, 5, 4, 3, 2, 1],
	"Metal Drive": [6, 4, -2, -4, -2, 2, 4, 5, 5, 4],
	"Flat Studio": [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
	Nightcore: [-1, 0, 1, 2, 3, 4, 6, 7, 8, 7],
	Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
	"Bass Boost": [6, 5, 3, 1, 0, 0, 0, 0, 0, 0],
	"Treble Boost": [0, 0, 0, 0, 0, 1, 3, 5, 6, 6],
	Vocal: [-2, -1, 0, 2, 3, 3, 2, 1, 0, -1],
	"Lo-Fi": [4, 3, 1, -1, -2, -2, -3, -4, -5, -5],
	Electronic: [4, 3, 0, -2, -1, 1, 2, 3, 4, 5],
	Classical: [3, 2, 1, 0, -1, -1, 0, 1, 2, 3],
	Loudness: [5, 3, 0, 0, -2, 0, 0, 3, 5, 6],
};

export type DspSettings = {
	eq: number[];
	eqPreset: string;
	// 8D Spatial Audio
	spatial8dEnabled: boolean;
	spatial8dSpeed: number; // seconds per rotation cycle
	spatial8dRadius: number; // soundstage radius in meters
	spatial8dDoppler: boolean; // Doppler pitch shift
	spatial8dPattern: "circle_cw" | "circle_ccw" | "figure8" | "ellipse";
	spatial8dElevation: boolean;
	spatial8dManual: boolean;
	spatial8dManualX: number;
	spatial8dManualZ: number;
	// Lo-Fi Tape & Vinyl Engine
	lofiEnabled: boolean;
	lofiWarmth: number; // 0..1 (analog saturation)
	lofiWowFlutter: number; // 0..1 (pitch wobble depth)
	lofiWowRate: number; // 0.2..4.0 Hz
	lofiTone: number; // 2000..20000 Hz lowpass
	lofiCrackle: number; // 0..1 (vinyl dust level)
	lofiAge: "clean" | "tape70s" | "shellac40s";
	// Concert Hall Reverb & Surround Widener
	widenerEnabled: boolean;
	stereoWidth: number; // 0..2.0 (1 = normal, 2 = 200% wide)
	reverbEnabled: boolean;
	reverbMix: number; // 0..1.0
	reverbDecay: number; // 0.5..8.0 s
	reverbPreset: "studio" | "warm_room" | "concert_hall" | "tokyo_arena" | "cosmic_void";
	reverbDamp: number; // damping Hz
};

export const DEFAULT_DSP_SETTINGS: DspSettings = {
	eq: [3, 2, 0, 1, 3, 4, 5, 4, 3, 2],
	eqPreset: "Anime J-Pop",
	spatial8dEnabled: false,
	spatial8dSpeed: 8,
	spatial8dRadius: 3,
	spatial8dDoppler: false,
	spatial8dPattern: "circle_cw",
	spatial8dElevation: true,
	spatial8dManual: false,
	spatial8dManualX: 0,
	spatial8dManualZ: 0,
	lofiEnabled: false,
	lofiWarmth: 0.35,
	lofiWowFlutter: 0.25,
	lofiWowRate: 0.8,
	lofiTone: 14000,
	lofiCrackle: 0.15,
	lofiAge: "tape70s",
	widenerEnabled: false,
	stereoWidth: 1.35,
	reverbEnabled: false,
	reverbMix: 0.25,
	reverbDecay: 2.5,
	reverbPreset: "concert_hall",
	reverbDamp: 8000,
};

export type AudioEngineEvents = {
	onTimeUpdate?: (current: number, duration: number) => void;
	onEnded?: () => void;
	onPlay?: () => void;
	onPause?: () => void;
	onLoaded?: () => void;
	onError?: (msg: string) => void;
};

// Procedural Reverb Impulse Response Generator & Cache
const hallIrCache = new Map<string, AudioBuffer>();

function getHallIr(
	ctx: AudioContext,
	decay: number,
	preset: string,
	damp: number,
): AudioBuffer {
	const key = `${ctx.sampleRate}|${decay.toFixed(2)}|${preset}|${damp}`;
	const cached = hallIrCache.get(key);
	if (cached) return cached;

	const duration = Math.max(0.4, Math.min(8.0, decay));
	const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
	const ir = ctx.createBuffer(2, length, ctx.sampleRate);

	let decayFactor = 4.5 / duration;
	let preDelay = 0.02;
	if (preset === "studio") { decayFactor = 7.0 / duration; preDelay = 0.006; }
	else if (preset === "warm_room") { decayFactor = 5.5 / duration; preDelay = 0.014; }
	else if (preset === "concert_hall") { decayFactor = 4.0 / duration; preDelay = 0.028; }
	else if (preset === "tokyo_arena") { decayFactor = 3.2 / duration; preDelay = 0.045; }
	else if (preset === "cosmic_void") { decayFactor = 1.8 / duration; preDelay = 0.065; }

	const preDelaySamples = Math.floor(preDelay * ctx.sampleRate);
	const dampFactor = Math.max(0.05, Math.min(1.0, damp / 16000));

	for (let ch = 0; ch < 2; ch++) {
		const data = ir.getChannelData(ch);
		const chSign = ch === 0 ? 1 : -1;

		// Early discrete reflections for spatial geometry
		const earlyTimes = [0.008 + ch * 0.003, 0.019 - ch * 0.004, 0.032 + ch * 0.005, 0.046 - ch * 0.002, 0.062 + ch * 0.006];
		for (let r = 0; r < earlyTimes.length; r++) {
			const idx = Math.floor(earlyTimes[r]! * ctx.sampleRate);
			if (idx < length) {
				data[idx] = (0.7 / (r + 1)) * (r % 2 === 0 ? 1 : -1);
			}
		}

		// Late diffuse exponential decay tail with air damping
		let filterState = 0;
		for (let i = preDelaySamples; i < length; i++) {
			const t = (i - preDelaySamples) / ctx.sampleRate;
			const env = Math.exp(-t * decayFactor);
			const noise = Math.random() * 2 - 1;
			const dynDamp = Math.max(0.04, dampFactor * (1 - (t / duration) * 0.7));
			filterState += (noise - filterState) * dynDamp;
			data[i] += (filterState * 0.75 + noise * 0.25) * env * (0.85 + 0.15 * chSign * Math.sin(t * 14));
		}
	}

	hallIrCache.set(key, ir);
	return ir;
}

// Procedural Vinyl Surface Noise & Dust Crackle Generator
function generateVinylBuffer(ctx: AudioContext): AudioBuffer {
	const sampleRate = ctx.sampleRate;
	const duration = 4.0;
	const length = Math.floor(sampleRate * duration);
	const buffer = ctx.createBuffer(2, length, sampleRate);

	for (let ch = 0; ch < 2; ch++) {
		const data = buffer.getChannelData(ch);
		let brown = 0;
		for (let i = 0; i < length; i++) {
			const white = Math.random() * 2 - 1;
			brown = (brown + 0.02 * white) / 1.02;
			let val = brown * 0.08 + white * 0.015;

			// Stochastic vinyl dust pops & clicks
			if (Math.random() < 0.00035) {
				const pop = (Math.random() * 0.45 + 0.15) * (Math.random() > 0.5 ? 1 : -1);
				val += pop;
			}
			if (Math.random() < 0.0018) {
				val += (Math.random() * 0.09 - 0.045);
			}
			data[i] = val;
		}
	}
	return buffer;
}

// Analog Tape Saturation Waveshaping Curve
function makeTapeSaturationCurve(warmth: number): Float32Array {
	const samples = 1024;
	const curve = new Float32Array(samples);
	const k = warmth * 3.5;
	for (let i = 0; i < samples; i++) {
		const x = (i / (samples - 1)) * 2 - 1;
		if (warmth <= 0.001) {
			curve[i] = x;
		} else {
			const x2 = x + 0.12 * x * x;
			curve[i] = Math.tanh(x2 * (1 + k)) / Math.tanh(1 + k);
		}
	}
	return curve;
}

export class AudioEngine {
	media: HTMLMediaElement;
	ctx: AudioContext;
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

	// DSP Studio Settings
	public dsp: DspSettings = { ...DEFAULT_DSP_SETTINGS };

	// 1. Lo-Fi Tape & Vinyl Nodes
	private lofiIn: GainNode;
	private lofiOut: GainNode;
	private lofiDry: GainNode;
	private lofiWet: GainNode;
	private lofiPreFilter: BiquadFilterNode;
	private lofiTapeShaper: WaveShaperNode;
	private lofiPostFilter: BiquadFilterNode;
	private wowDelay: DelayNode;
	private wowLfo: OscillatorNode | null = null;
	private wowLfoGain: GainNode | null = null;
	private vinylSource: AudioBufferSourceNode | null = null;
	private vinylFilter: BiquadFilterNode;
	private vinylGain: GainNode;

	// 2. Haas Stereo Widener Nodes
	private widenerIn: GainNode;
	private widenerOut: GainNode;
	private widenerDry: GainNode;
	private widenerWet: GainNode;
	private widenerSplitter: ChannelSplitterNode;
	private widenerDelayR: DelayNode;
	private widenerMerger: ChannelMergerNode;

	// 3. 8D Binaural Spatial Radar Panner Nodes
	private spatialIn: GainNode;
	private spatialOut: GainNode;
	private spatialDry: GainNode;
	private spatialWet: GainNode;
	private spatialPanner: PannerNode;
	private spatialTimer: number | null = null;
	private spatialAngle = 0;
	private basePlaybackRate = 1.0;

	// 4. Concert Hall Convolution Reverb Nodes
	private reverbIn: GainNode;
	private reverbOut: GainNode;
	private reverbDry: GainNode;
	private reverbWet: GainNode;
	private reverbConvolver: ConvolverNode;

	// Master Studio Analyser Tap
	private studioAnalyser: AnalyserNode | null = null;
	private studioFreqBuffer: Uint8Array | null = null;
	private studioTimeBuffer: Uint8Array | null = null;

	// Quick effects state
	private _bassBoost = false;
	private _vocalEnhance = false;
	private _reverbHall = false;

	constructor(media: HTMLMediaElement, sharedCtx?: AudioContext, monitorTap?: AudioNode) {
		this.media = media;
		this.media.crossOrigin = "anonymous";
		this.ctx = sharedCtx ?? new window.AudioContext();

		this.gain = this.ctx.createGain();
		this.gain.gain.value = 1;
		this.preAmp = this.ctx.createGain();
		this.preAmp.gain.value = 1;
		this.monitorTap = monitorTap ?? this.ctx.destination;

		// 10-band Graphic Equalizer filters
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

		// Initialize Lo-Fi Nodes
		this.lofiIn = this.ctx.createGain();
		this.lofiOut = this.ctx.createGain();
		this.lofiDry = this.ctx.createGain();
		this.lofiWet = this.ctx.createGain();
		this.lofiPreFilter = this.ctx.createBiquadFilter();
		this.lofiPreFilter.type = "highshelf";
		this.lofiPreFilter.frequency.value = 6000;
		this.lofiPreFilter.gain.value = 0;
		this.lofiTapeShaper = this.ctx.createWaveShaper();
		this.lofiTapeShaper.oversample = "2x";
		this.lofiTapeShaper.curve = makeTapeSaturationCurve(0.35) as Float32Array<ArrayBuffer>;
		this.lofiPostFilter = this.ctx.createBiquadFilter();
		this.lofiPostFilter.type = "lowpass";
		this.lofiPostFilter.frequency.value = 14000;
		this.lofiPostFilter.Q.value = 0.7;

		this.wowDelay = this.ctx.createDelay(0.1);
		this.wowDelay.delayTime.value = 0.015;

		this.lofiIn.connect(this.lofiDry);
		this.lofiDry.connect(this.lofiOut);

		this.lofiIn.connect(this.lofiPreFilter);
		this.lofiPreFilter.connect(this.lofiTapeShaper);
		this.lofiTapeShaper.connect(this.lofiPostFilter);
		this.lofiPostFilter.connect(this.wowDelay);
		this.wowDelay.connect(this.lofiWet);
		this.lofiWet.connect(this.lofiOut);

		// Vinyl Generator
		this.vinylFilter = this.ctx.createBiquadFilter();
		this.vinylFilter.type = "bandpass";
		this.vinylFilter.frequency.value = 2200;
		this.vinylFilter.Q.value = 1.6;
		this.vinylGain = this.ctx.createGain();
		this.vinylGain.gain.value = 0;
		this.vinylFilter.connect(this.vinylGain);
		this.vinylGain.connect(this.preAmp);

		// Initialize Haas Stereo Widener Nodes
		this.widenerIn = this.ctx.createGain();
		this.widenerOut = this.ctx.createGain();
		this.widenerDry = this.ctx.createGain();
		this.widenerWet = this.ctx.createGain();
		this.widenerSplitter = this.ctx.createChannelSplitter(2);
		this.widenerDelayR = this.ctx.createDelay(0.1);
		this.widenerDelayR.delayTime.value = 0.018;
		this.widenerMerger = this.ctx.createChannelMerger(2);

		this.widenerIn.connect(this.widenerDry);
		this.widenerDry.connect(this.widenerOut);

		this.widenerIn.connect(this.widenerSplitter);
		this.widenerSplitter.connect(this.widenerMerger, 0, 0); // L direct
		this.widenerSplitter.connect(this.widenerDelayR, 1);
		this.widenerDelayR.connect(this.widenerMerger, 0, 1); // R delayed
		this.widenerMerger.connect(this.widenerWet);
		this.widenerWet.connect(this.widenerOut);

		// Initialize 8D Binaural Spatial Panner Nodes
		this.spatialIn = this.ctx.createGain();
		this.spatialOut = this.ctx.createGain();
		this.spatialDry = this.ctx.createGain();
		this.spatialWet = this.ctx.createGain();
		this.spatialPanner = this.ctx.createPanner();
		this.spatialPanner.panningModel = "HRTF";
		this.spatialPanner.distanceModel = "inverse";
		this.spatialPanner.refDistance = 1;
		this.spatialPanner.maxDistance = 100;
		this.spatialPanner.rolloffFactor = 1;

		this.spatialIn.connect(this.spatialDry);
		this.spatialDry.connect(this.spatialOut);

		this.spatialIn.connect(this.spatialPanner);
		this.spatialPanner.connect(this.spatialWet);
		this.spatialWet.connect(this.spatialOut);

		// Initialize Concert Hall Convolution Reverb Nodes
		this.reverbIn = this.ctx.createGain();
		this.reverbOut = this.ctx.createGain();
		this.reverbDry = this.ctx.createGain();
		this.reverbWet = this.ctx.createGain();
		this.reverbConvolver = this.ctx.createConvolver();
		try {
			this.reverbConvolver.buffer = getHallIr(this.ctx, 2.5, "concert_hall", 8000);
		} catch {}

		this.reverbIn.connect(this.reverbDry);
		this.reverbDry.connect(this.reverbOut);

		this.reverbIn.connect(this.reverbConvolver);
		this.reverbConvolver.connect(this.reverbWet);
		this.reverbWet.connect(this.reverbOut);

		// Apply initial DSP gains
		this.applyDspState();

		// Media Event Listeners
		this.media.addEventListener("timeupdate", () => {
			const cur = this.media.currentTime;
			const dur = this.media.duration || 0;
			this.cb.onTimeUpdate?.(cur, dur);
			if (this.abLoop && this.abLoop.a < this.abLoop.b && dur > 0) {
				if (cur >= this.abLoop.b) {
					this.media.currentTime = this.abLoop.a;
				}
			}
		});
		this.media.addEventListener("ended", () => this.cb.onEnded?.());
		this.media.addEventListener("play", () => {
			this.ensureVinylStarted();
			this.cb.onPlay?.();
		});
		this.media.addEventListener("pause", () => this.cb.onPause?.());
		this.media.addEventListener("loadedmetadata", () => this.cb.onLoaded?.());
		this.media.addEventListener("error", () => {
			this.cb.onError?.(`Playback error (code ${this.media.error?.code ?? "?"})`);
		});
	}

	private ensureVinylStarted() {
		if (this.vinylSource) return;
		try {
			const buf = generateVinylBuffer(this.ctx);
			this.vinylSource = this.ctx.createBufferSource();
			this.vinylSource.buffer = buf;
			this.vinylSource.loop = true;
			this.vinylSource.connect(this.vinylFilter);
			this.vinylSource.start();
		} catch (err) {
			console.warn("[audio] vinyl buffer start failed:", (err as Error).message);
		}
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

		try { this.lofiOut.disconnect(); } catch {}
		try { this.widenerOut.disconnect(); } catch {}
		try { this.spatialOut.disconnect(); } catch {}
		try { this.reverbOut.disconnect(); } catch {}

		const tail = this.monoMerge ?? this.preAmp;

		if (this.nodeGraph && this.nodeEntry && this.nodeExit) {
			this.source.connect(this.nodeEntry);
			this.nodeExit.connect(tail);
			this.feedingGain = this.nodeExit;
		} else {
			// Master DSP Studio Processing Pipeline:
			// Source -> 10-Band EQ Filters -> Lo-Fi Engine -> Haas Widener -> 8D Spatial Panner -> Reverb -> PreAmp -> Gain -> MonitorTap
			let node: AudioNode = this.source;
			for (const f of this.filters) {
				node.connect(f);
				node = f;
			}

			node.connect(this.lofiIn);
			this.lofiOut.connect(this.widenerIn);
			this.widenerOut.connect(this.spatialIn);
			this.spatialOut.connect(this.reverbIn);
			this.reverbOut.connect(tail);

			this.feedingGain = this.reverbOut;
		}
	}

	on(events: AudioEngineEvents) { this.cb = { ...this.cb, ...events }; }
	clearListeners() { this.cb = {}; }

	setEq(values: number[]) {
		this.dsp.eq = [...values];
		values.forEach((v, i) => {
			if (this.filters[i]) this.filters[i].gain.value = Math.max(-24, Math.min(24, v));
		});
	}

	setDsp(settings: Partial<DspSettings>) {
		this.dsp = { ...this.dsp, ...settings };
		this.applyDspState();
	}

	private applyDspState() {
		const s = this.dsp;

		// 1. Equalizer
		if (Array.isArray(s.eq)) {
			s.eq.forEach((v, i) => {
				if (this.filters[i]) this.filters[i].gain.value = Math.max(-24, Math.min(24, v));
			});
		}

		// 2. Lo-Fi Tape & Vinyl
		if (s.lofiEnabled) {
			this.lofiDry.gain.value = 0;
			this.lofiWet.gain.value = 1;
			this.lofiTapeShaper.curve = makeTapeSaturationCurve(s.lofiWarmth) as Float32Array<ArrayBuffer>;
			this.lofiPostFilter.frequency.value = Math.max(2000, Math.min(20000, s.lofiTone));
			this.lofiPreFilter.gain.value = s.lofiWarmth > 0.5 ? -2 : 0;

			// Wow & Flutter LFO
			if (!this.wowLfo) {
				try {
					this.wowLfo = this.ctx.createOscillator();
					this.wowLfoGain = this.ctx.createGain();
					this.wowLfo.type = "sine";
					this.wowLfo.frequency.value = s.lofiWowRate;
					this.wowLfoGain.gain.value = s.lofiWowFlutter * 0.003;
					this.wowLfo.connect(this.wowLfoGain);
					this.wowLfoGain.connect(this.wowDelay.delayTime);
					this.wowLfo.start();
				} catch {}
			} else {
				this.wowLfo.frequency.value = s.lofiWowRate;
				if (this.wowLfoGain) this.wowLfoGain.gain.value = s.lofiWowFlutter * 0.003;
			}

			// Vinyl level
			this.vinylGain.gain.value = s.lofiCrackle * 0.22;
			if (s.lofiCrackle > 0.01) this.ensureVinylStarted();
		} else {
			this.lofiDry.gain.value = 1;
			this.lofiWet.gain.value = 0;
			this.vinylGain.gain.value = 0;
			if (this.wowLfoGain) this.wowLfoGain.gain.value = 0;
		}

		// 3. Haas Stereo Widener
		if (s.widenerEnabled && s.stereoWidth > 0.01) {
			this.widenerDry.gain.value = 0;
			this.widenerWet.gain.value = 1;
			const delay = Math.max(0.002, Math.min(0.035, (s.stereoWidth - 0.5) * 0.02));
			this.widenerDelayR.delayTime.value = delay;
		} else {
			this.widenerDry.gain.value = 1;
			this.widenerWet.gain.value = 0;
		}

		// 4. 8D Spatial Audio Studio
		if (s.spatial8dEnabled) {
			this.spatialDry.gain.value = 0;
			this.spatialWet.gain.value = 1;
			this.startSpatialLoop();
		} else {
			this.spatialDry.gain.value = 1;
			this.spatialWet.gain.value = 0;
			this.stopSpatialLoop();
		}

		// 5. Concert Hall Convolution Reverb
		if (s.reverbEnabled && s.reverbMix > 0.01) {
			this.reverbDry.gain.value = Math.max(0, 1 - s.reverbMix * 0.7);
			this.reverbWet.gain.value = s.reverbMix;
			try {
				this.reverbConvolver.buffer = getHallIr(this.ctx, s.reverbDecay, s.reverbPreset, s.reverbDamp);
			} catch {}
		} else {
			this.reverbDry.gain.value = 1;
			this.reverbWet.gain.value = 0;
		}
	}

	private startSpatialLoop() {
		if (this.spatialTimer !== null) return;
		this.spatialTimer = window.setInterval(() => {
			this.tickSpatial8D();
		}, 25);
	}

	private stopSpatialLoop() {
		if (this.spatialTimer !== null) {
			clearInterval(this.spatialTimer);
			this.spatialTimer = null;
		}
		try {
			if (this.spatialPanner.positionX) {
				this.spatialPanner.positionX.value = 0;
				this.spatialPanner.positionY.value = 0;
				this.spatialPanner.positionZ.value = 0;
			} else {
				(this.spatialPanner as any).setPosition(0, 0, 0);
			}
			if (this.dsp.spatial8dDoppler) {
				this.setRate(this.basePlaybackRate);
			}
		} catch {}
	}

	private tickSpatial8D() {
		const s = this.dsp;
		if (!s.spatial8dEnabled) return;

		let x = 0;
		let y = 0;
		let z = 0;
		const r = Math.max(0.5, Math.min(10, s.spatial8dRadius));

		if (s.spatial8dManual) {
			x = s.spatial8dManualX * r;
			z = s.spatial8dManualZ * r;
			y = 0;
		} else {
			const speedSec = Math.max(1, Math.min(30, s.spatial8dSpeed));
			const delta = (25 / 1000) * ((2 * Math.PI) / speedSec);
			const dir = s.spatial8dPattern === "circle_ccw" ? -1 : 1;
			this.spatialAngle = (this.spatialAngle + delta * dir) % (2 * Math.PI);

			if (s.spatial8dPattern === "figure8") {
				x = Math.sin(this.spatialAngle) * r;
				z = Math.sin(this.spatialAngle * 2) * (r * 0.75);
			} else if (s.spatial8dPattern === "ellipse") {
				x = Math.sin(this.spatialAngle) * (r * 1.35);
				z = -Math.cos(this.spatialAngle) * (r * 0.65);
			} else {
				x = Math.sin(this.spatialAngle) * r;
				z = -Math.cos(this.spatialAngle) * r;
			}

			if (s.spatial8dElevation) {
				y = Math.sin(this.spatialAngle * 2) * 0.45;
			}
		}

		try {
			if (this.spatialPanner.positionX) {
				this.spatialPanner.positionX.setTargetAtTime(x, this.ctx.currentTime, 0.02);
				this.spatialPanner.positionY.setTargetAtTime(y, this.ctx.currentTime, 0.02);
				this.spatialPanner.positionZ.setTargetAtTime(z, this.ctx.currentTime, 0.02);
			} else {
				(this.spatialPanner as any).setPosition(x, y, z);
			}
		} catch {}

		if (s.spatial8dDoppler && !s.spatial8dManual) {
			const speedSec = Math.max(1, Math.min(30, s.spatial8dSpeed));
			const orbitalSpeed = (2 * Math.PI * r) / speedSec;
			const vRadial = orbitalSpeed * Math.cos(this.spatialAngle);
			const dopplerFactor = 1 + (vRadial / 343) * 0.5;
			try {
				this.media.playbackRate = this.basePlaybackRate * dopplerFactor;
			} catch {}
		}
	}

	getSpatialCoordinates(): { x: number; y: number; z: number; angle: number } {
		const s = this.dsp;
		const r = Math.max(0.5, Math.min(10, s.spatial8dRadius));
		if (s.spatial8dManual) {
			return { x: s.spatial8dManualX * r, y: 0, z: s.spatial8dManualZ * r, angle: Math.atan2(s.spatial8dManualX, -s.spatial8dManualZ) };
		}
		let x = Math.sin(this.spatialAngle) * r;
		let z = -Math.cos(this.spatialAngle) * r;
		let y = s.spatial8dElevation ? Math.sin(this.spatialAngle * 2) * 0.45 : 0;
		if (s.spatial8dPattern === "figure8") {
			x = Math.sin(this.spatialAngle) * r;
			z = Math.sin(this.spatialAngle * 2) * (r * 0.75);
		} else if (s.spatial8dPattern === "ellipse") {
			x = Math.sin(this.spatialAngle) * (r * 1.35);
			z = -Math.cos(this.spatialAngle) * (r * 0.65);
		}
		return { x, y, z, angle: this.spatialAngle };
	}

	getBiquadFrequencyResponse(freqs: Float32Array): Float32Array {
		const totalDbs = new Float32Array(freqs.length);
		const mag = new Float32Array(freqs.length);
		const phase = new Float32Array(freqs.length);
		for (const filter of this.filters) {
			filter.getFrequencyResponse(freqs as any, mag as any, phase as any);
			for (let i = 0; i < freqs.length; i++) {
				const m = Math.max(1e-5, mag[i]!);
				totalDbs[i] = (totalDbs[i] || 0) + 20 * Math.log10(m);
			}
		}
		return totalDbs;
	}

	getRealtimeAudioData(fftSize = 1024): {
		timeDomain: Uint8Array;
		frequency: Uint8Array;
		rmsL: number;
		rmsR: number;
		peakL: number;
		peakR: number;
	} {
		if (!this.studioAnalyser) {
			try {
				this.studioAnalyser = this.ctx.createAnalyser();
				this.studioAnalyser.fftSize = fftSize;
				this.studioAnalyser.smoothingTimeConstant = 0.82;
				this.monitorTap.connect(this.studioAnalyser);
				this.studioFreqBuffer = new Uint8Array(this.studioAnalyser.frequencyBinCount);
				this.studioTimeBuffer = new Uint8Array(this.studioAnalyser.fftSize);
			} catch {
				return {
					timeDomain: new Uint8Array(512),
					frequency: new Uint8Array(256),
					rmsL: 0,
					rmsR: 0,
					peakL: 0,
					peakR: 0,
				};
			}
		}

		if (!this.studioFreqBuffer || !this.studioTimeBuffer || !this.studioAnalyser) {
			return {
				timeDomain: new Uint8Array(512),
				frequency: new Uint8Array(256),
				rmsL: 0,
				rmsR: 0,
				peakL: 0,
				peakR: 0,
			};
		}

		this.studioAnalyser.getByteFrequencyData(this.studioFreqBuffer as unknown as Uint8Array<ArrayBuffer>);
		this.studioAnalyser.getByteTimeDomainData(this.studioTimeBuffer as unknown as Uint8Array<ArrayBuffer>);

		let sumSquares = 0;
		let peak = 0;
		const len = this.studioTimeBuffer.length;
		for (let i = 0; i < len; i++) {
			const sample = (this.studioTimeBuffer[i]! - 128) / 128;
			const abs = Math.abs(sample);
			if (abs > peak) peak = abs;
			sumSquares += sample * sample;
		}
		const rms = Math.sqrt(sumSquares / len);

		return {
			timeDomain: this.studioTimeBuffer,
			frequency: this.studioFreqBuffer,
			rmsL: rms,
			rmsR: rms * 0.98,
			peakL: peak,
			peakR: peak * 0.98,
		};
	}

	setSpatial8D(on: boolean) {
		this.setDsp({ spatial8dEnabled: on });
	}

	setBassBoost(on: boolean) {
		this._bassBoost = on;
		const currentEq = [...this.dsp.eq];
		if (on) {
			currentEq[0] = Math.min(24, (currentEq[0] ?? 0) + 7);
			currentEq[1] = Math.min(24, (currentEq[1] ?? 0) + 5);
		}
		this.setEq(currentEq);
	}

	setVocalEnhance(on: boolean) {
		this._vocalEnhance = on;
		const currentEq = [...this.dsp.eq];
		if (on) {
			currentEq[4] = Math.min(24, (currentEq[4] ?? 0) + 4);
			currentEq[5] = Math.min(24, (currentEq[5] ?? 0) + 5);
		}
		this.setEq(currentEq);
	}

	setReverbHall(on: boolean) {
		this._reverbHall = on;
		this.setDsp({ reverbEnabled: on, reverbMix: on ? 0.35 : 0 });
	}

	getQuickEffects() {
		return {
			eightD: this.dsp.spatial8dEnabled,
			bassBoost: this._bassBoost,
			vocalEnhance: this._vocalEnhance,
			reverbHall: this.dsp.reverbEnabled,
		};
	}

	setQuickEffects(fx: { eightD?: boolean; bassBoost?: boolean; vocalEnhance?: boolean; reverbHall?: boolean }) {
		if (fx.eightD !== undefined) this.setSpatial8D(fx.eightD);
		if (fx.bassBoost !== undefined) this.setBassBoost(fx.bassBoost);
		if (fx.vocalEnhance !== undefined) this.setVocalEnhance(fx.vocalEnhance);
		if (fx.reverbHall !== undefined) this.setReverbHall(fx.reverbHall);
	}

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

	setRate(r: number, preservesPitch = true) {
		this.basePlaybackRate = Math.max(0.25, Math.min(4, r));
		this.media.playbackRate = this.basePlaybackRate;
		try {
			(this.media as any).preservesPitch = preservesPitch;
			(this.media as any).mozPreservesPitch = preservesPitch;
			(this.media as any).webkitPreservesPitch = preservesPitch;
		} catch {}
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
			if (this.dsp.lofiEnabled && this.dsp.lofiCrackle > 0.01) {
				this.ensureVinylStarted();
			}
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
			const v = (this.freqBuffer[i] ?? 0) / 255;
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

	destroy() {
		this.stopSpatialLoop();
		if (this.vinylSource) {
			try { this.vinylSource.stop(); } catch {}
			this.vinylSource = null;
		}
		if (this.wowLfo) {
			try { this.wowLfo.stop(); } catch {}
			this.wowLfo = null;
		}
	}
}

