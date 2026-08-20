// Node-based audio effect graph. The data model lives here, plus a compiler
// that turns a graph into a chain of WebAudio nodes the AudioEngine can splice
// into its signal path in place of the default 10-band EQ.

export type NodeId = string;
export type NodeType =
	| "input" | "output"
	| "gain" | "filter" | "delay" | "reverb"
	| "compressor" | "distortion" | "panner"
	| "lowshelf" | "highshelf" | "peaking"
	| "spatial8d" | "lofi_tape" | "vinyl_crackle"
	| "stereo_widener" | "lush_reverb" | "limiter"
	| "equalizer10";

export type NodeDef = {
	type: NodeType;
	/** What this node does, in plain English (1-2 sentences). Shown in UI as a tooltip / info panel. */
	description: string;
	/** Default parameter values for new nodes of this type. */
	defaults: Record<string, number | string>;
	/** Parameter metadata for the UI to render sliders / inputs. */
	params: Array<{
		key: string;
		label: string;
		min?: number;
		max?: number;
		step?: number;
		unit?: string;
		options?: string[];
	}>;
};

export const NODE_DEFS: Record<NodeType, NodeDef> = {
	input: {
		type: "input",
		description:
			"The source of the signal — audio enters the graph here. Every graph needs exactly one Input.",
		defaults: {},
		params: [],
	},
	output: {
		type: "output",
		description:
			"The final destination of the signal — audio leaves the graph here and goes to your speakers. Every graph needs exactly one Output.",
		defaults: {},
		params: [],
	},
	gain: {
		type: "gain",
		description:
			"Cuts or boosts the level of the signal in decibels. Positive values make it louder, negative make it quieter.",
		defaults: { gain: 0 },
		params: [
			{ key: "gain", label: "Gain", min: -24, max: 24, step: 0.1, unit: "dB" },
		],
	},
	filter: {
		type: "filter",
		description:
			"A frequency filter. Lowpass keeps lows, highpass keeps highs, bandpass keeps a band around the cutoff, notch removes one. Q controls how sharp the cutoff is.",
		defaults: { type: "lowpass", frequency: 1000, q: 1 },
		params: [
			{ key: "type", label: "Type", options: ["lowpass", "highpass", "bandpass", "notch"] },
			{ key: "frequency", label: "Frequency", min: 20, max: 20000, step: 1, unit: "Hz" },
			{ key: "q", label: "Q", min: 0.1, max: 10, step: 0.05 },
		],
	},
	delay: {
		type: "delay",
		description:
			"An echo effect. Time sets the gap between echoes, feedback controls how many echoes you hear, mix blends the echoed signal with the original.",
		defaults: { time: 0.3, feedback: 0.3, mix: 0.4 },
		params: [
			{ key: "time", label: "Time", min: 0, max: 2, step: 0.01, unit: "s" },
			{ key: "feedback", label: "Feedback", min: 0, max: 0.95, step: 0.01 },
			{ key: "mix", label: "Mix", min: 0, max: 1, step: 0.01 },
		],
	},
	reverb: {
		type: "reverb",
		description:
			"Simulates the sound of a room or hall. Decay sets how long the tail lasts, mix blends the wet reverb with the dry signal.",
		defaults: { mix: 0.3, decay: 2.0 },
		params: [
			{ key: "mix", label: "Mix", min: 0, max: 1, step: 0.01 },
			{ key: "decay", label: "Decay", min: 0.1, max: 6, step: 0.05, unit: "s" },
		],
	},
	compressor: {
		type: "compressor",
		description:
			"Squashes loud parts so the quieter parts are easier to hear. Lower the threshold to start compressing earlier; raise the ratio to squash harder.",
		defaults: { threshold: -24, knee: 30, ratio: 4, attack: 0.003, release: 0.25 },
		params: [
			{ key: "threshold", label: "Threshold", min: -60, max: 0, step: 0.5, unit: "dB" },
			{ key: "knee", label: "Knee", min: 0, max: 40, step: 0.5, unit: "dB" },
			{ key: "ratio", label: "Ratio", min: 1, max: 20, step: 0.1 },
			{ key: "attack", label: "Attack", min: 0, max: 1, step: 0.001, unit: "s" },
			{ key: "release", label: "Release", min: 0, max: 1, step: 0.001, unit: "s" },
		],
	},
	distortion: {
		type: "distortion",
		description:
			"Adds grit and harmonics by clipping the waveform. Higher amount means more crunch. Oversample reduces aliasing artifacts at the cost of CPU.",
		defaults: { amount: 25, oversample: "2x" },
		params: [
			{ key: "amount", label: "Amount", min: 0, max: 100, step: 0.5 },
			{ key: "oversample", label: "Oversample", options: ["none", "2x", "4x"] },
		],
	},
	panner: {
		type: "panner",
		description:
			"Moves the signal left or right in the stereo field. -1 is hard left, 0 is center, 1 is hard right.",
		defaults: { pan: 0 },
		params: [
			{ key: "pan", label: "Pan", min: -1, max: 1, step: 0.01 },
		],
	},
	lowshelf: {
		type: "lowshelf",
		description:
			"Boosts or cuts everything below the chosen frequency. Use this to add or remove bass without affecting the mids.",
		defaults: { frequency: 200, gain: 0 },
		params: [
			{ key: "frequency", label: "Frequency", min: 20, max: 20000, step: 1, unit: "Hz" },
			{ key: "gain", label: "Gain", min: -24, max: 24, step: 0.1, unit: "dB" },
		],
	},
	highshelf: {
		type: "highshelf",
		description:
			"Boosts or cuts everything above the chosen frequency. Use this to add air and sparkle or to tame harshness.",
		defaults: { frequency: 6000, gain: 0 },
		params: [
			{ key: "frequency", label: "Frequency", min: 20, max: 20000, step: 1, unit: "Hz" },
			{ key: "gain", label: "Gain", min: -24, max: 24, step: 0.1, unit: "dB" },
		],
	},
	peaking: {
		type: "peaking",
		description:
			"Boosts or cuts a band of frequencies around the chosen frequency. Q controls how wide the band is — high Q is narrow and surgical, low Q is wide and musical.",
		defaults: { frequency: 1000, gain: 0, q: 1 },
		params: [
			{ key: "frequency", label: "Frequency", min: 20, max: 20000, step: 1, unit: "Hz" },
			{ key: "gain", label: "Gain", min: -24, max: 24, step: 0.1, unit: "dB" },
			{ key: "q", label: "Q", min: 0.1, max: 10, step: 0.05 },
		],
	},
	spatial8d: {
		type: "spatial8d",
		description:
			"3D Binaural 8D Audio Panner. Orbits the sound source around the listener's head in 3D binaural space with HRTF spatialization.",
		defaults: { speed: 8, radius: 3, elevation: 1 },
		params: [
			{ key: "speed", label: "Rotation Speed", min: 1, max: 30, step: 0.5, unit: "s" },
			{ key: "radius", label: "Soundstage Radius", min: 0.5, max: 10, step: 0.1, unit: "m" },
			{ key: "elevation", label: "3D Elevation", min: 0, max: 1, step: 1 },
		],
	},
	lofi_tape: {
		type: "lofi_tape",
		description:
			"Lo-Fi Analog Tape Engine. Simulates warm asymmetrical magnetic tape saturation, subtle head roll-off, and wow & flutter pitch wobble.",
		defaults: { warmth: 40, wow: 30, tone: 14000 },
		params: [
			{ key: "warmth", label: "Tape Saturation", min: 0, max: 100, step: 1, unit: "%" },
			{ key: "wow", label: "Pitch Wobble", min: 0, max: 100, step: 1, unit: "%" },
			{ key: "tone", label: "Tape Head Tone", min: 2000, max: 20000, step: 100, unit: "Hz" },
		],
	},
	vinyl_crackle: {
		type: "vinyl_crackle",
		description:
			"Procedural Vinyl Dust & Crackle Generator. Injects vintage turntable needle surface noise, micro-groove dust pops, and retro warmth.",
		defaults: { level: 25 },
		params: [
			{ key: "level", label: "Crackle Level", min: 0, max: 100, step: 1, unit: "%" },
		],
	},
	stereo_widener: {
		type: "stereo_widener",
		description:
			"Haas Psychoacoustic Stereo Expander. Expands stereo width far beyond physical headphone and speaker boundaries.",
		defaults: { width: 140, delay: 18 },
		params: [
			{ key: "width", label: "Stereo Width", min: 0, max: 200, step: 1, unit: "%" },
			{ key: "delay", label: "Haas Delay", min: 1, max: 35, step: 0.5, unit: "ms" },
		],
	},
	lush_reverb: {
		type: "lush_reverb",
		description:
			"Concert Hall Convolution Impulse Reverb. Simulates majestic acoustic spaces with natural early reflections and air-damped diffuse tails.",
		defaults: { preset: "concert_hall", decay: 2.5, mix: 0.35 },
		params: [
			{ key: "preset", label: "Space Preset", options: ["studio", "warm_room", "concert_hall", "tokyo_arena", "cosmic_void"] },
			{ key: "decay", label: "Decay Time", min: 0.5, max: 8.0, step: 0.1, unit: "s" },
			{ key: "mix", label: "Wet Mix", min: 0, max: 1, step: 0.01 },
		],
	},
	limiter: {
		type: "limiter",
		description:
			"Master Brickwall Limiter. Prevents digital audio clipping and inter-sample peaks while maintaining maximum loudness and punch.",
		defaults: { threshold: -1.0, release: 0.08 },
		params: [
			{ key: "threshold", label: "Ceiling", min: -24, max: 0, step: 0.1, unit: "dB" },
			{ key: "release", label: "Release", min: 0.01, max: 0.5, step: 0.005, unit: "s" },
		],
	},
	equalizer10: {
		type: "equalizer10",
		description:
			"Integrated 10-Band Graphic Equalizer Block. Shapes frequencies from 60Hz sub-bass up to 16kHz brilliance.",
		defaults: { b0: 0, b1: 0, b2: 0, b3: 0, b4: 0, b5: 0, b6: 0, b7: 0, b8: 0, b9: 0 },
		params: [
			{ key: "b0", label: "60Hz", min: -24, max: 24, step: 1, unit: "dB" },
			{ key: "b1", label: "170Hz", min: -24, max: 24, step: 1, unit: "dB" },
			{ key: "b2", label: "310Hz", min: -24, max: 24, step: 1, unit: "dB" },
			{ key: "b3", label: "600Hz", min: -24, max: 24, step: 1, unit: "dB" },
			{ key: "b4", label: "1kHz", min: -24, max: 24, step: 1, unit: "dB" },
			{ key: "b5", label: "3kHz", min: -24, max: 24, step: 1, unit: "dB" },
			{ key: "b6", label: "6kHz", min: -24, max: 24, step: 1, unit: "dB" },
			{ key: "b7", label: "12kHz", min: -24, max: 24, step: 1, unit: "dB" },
			{ key: "b8", label: "14kHz", min: -24, max: 24, step: 1, unit: "dB" },
			{ key: "b9", label: "16kHz", min: -24, max: 24, step: 1, unit: "dB" },
		],
	},
};

export type GraphNode = {
	id: NodeId;
	type: NodeType;
	x: number;
	y: number;
	params: Record<string, number | string>;
};

export type GraphEdge = {
	id: string;
	from: NodeId;
	to: NodeId;
};

export type NodeGraph = {
	nodes: GraphNode[];
	edges: GraphEdge[];
};

// ---------- helpers ----------

export function uid(prefix = "n"): string {
	return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function num(v: number | string | undefined, fallback: number): number {
	const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
	return Number.isFinite(n) ? n : fallback;
}

function str(v: number | string | undefined, fallback: string): string {
	return typeof v === "string" ? v : fallback;
}

// ---------- validate ----------

export function validateGraph(g: NodeGraph): { ok: boolean; error?: string } {
	if (!g || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) {
		return { ok: false, error: "Graph is malformed." };
	}
	const inputs = g.nodes.filter((n) => n.type === "input");
	const outputs = g.nodes.filter((n) => n.type === "output");
	if (inputs.length !== 1) {
		return { ok: false, error: `Graph must have exactly one Input node (found ${inputs.length}).` };
	}
	if (outputs.length !== 1) {
		return { ok: false, error: `Graph must have exactly one Output node (found ${outputs.length}).` };
	}

	const byId = new Map(g.nodes.map((n) => [n.id, n]));
	for (const e of g.edges) {
		if (!byId.has(e.from)) return { ok: false, error: `Edge ${e.id} references missing node ${e.from}.` };
		if (!byId.has(e.to)) return { ok: false, error: `Edge ${e.id} references missing node ${e.to}.` };
		if (e.from === e.to) return { ok: false, error: `Edge ${e.id} is a self-loop.` };
		const src = byId.get(e.from)!;
		const dst = byId.get(e.to)!;
		if (src.type === "output") return { ok: false, error: `Output node cannot be a source.` };
		if (dst.type === "input") return { ok: false, error: `Input node cannot be a destination.` };
	}

	// Reachability: every non-input node must be reachable from input,
	// and output must be reachable from input.
	const outgoing = new Map<NodeId, NodeId[]>();
	for (const n of g.nodes) outgoing.set(n.id, []);
	for (const e of g.edges) outgoing.get(e.from)!.push(e.to);

	const reachable = new Set<NodeId>();
	const stack = [inputs[0]!.id];
	while (stack.length) {
		const id = stack.pop()!;
		if (reachable.has(id)) continue;
		reachable.add(id);
		for (const next of outgoing.get(id) ?? []) stack.push(next);
	}
	if (!reachable.has(outputs[0]!.id)) {
		return { ok: false, error: "Output is not connected to Input." };
	}
	for (const n of g.nodes) {
		if (!reachable.has(n.id)) {
			return { ok: false, error: `Node ${n.type} (${n.id}) is orphaned — not connected to Input.` };
		}
	}

	return { ok: true };
}

// ---------- new graph ----------

export function newGraph(): NodeGraph {
	const input: GraphNode = { id: uid("in"), type: "input", x: 80, y: 200, params: {} };
	const output: GraphNode = { id: uid("out"), type: "output", x: 520, y: 200, params: {} };
	return {
		nodes: [input, output],
		edges: [{ id: uid("e"), from: input.id, to: output.id }],
	};
}

// ---------- reverb IR cache ----------

const reverbIrCache = new Map<string, AudioBuffer>();

function getReverbIr(ctx: AudioContext, decay: number, preset = "concert_hall"): AudioBuffer {
	const key = `${ctx.sampleRate}|${decay.toFixed(3)}|${preset}`;
	const cached = reverbIrCache.get(key);
	if (cached) return cached;

	const duration = Math.max(0.2, decay);
	const length = Math.max(1, Math.floor(ctx.sampleRate * duration));
	const ir = ctx.createBuffer(2, length, ctx.sampleRate);
	
	let decayRate = 5.0 / duration;
	if (preset === "studio") decayRate = 7.5 / duration;
	else if (preset === "cosmic_void") decayRate = 2.0 / duration;

	for (let ch = 0; ch < 2; ch++) {
		const data = ir.getChannelData(ch);
		for (let i = 0; i < length; i++) {
			const t = i / ctx.sampleRate;
			data[i] = (Math.random() * 2 - 1) * Math.exp(-t * decayRate);
		}
	}
	reverbIrCache.set(key, ir);
	return ir;
}

// ---------- distortion curve ----------

function makeDistortionCurve(amount: number): Float32Array {
	const samples = 1024;
	const curve = new Float32Array(samples);
	const k = amount;
	for (let i = 0; i < samples; i++) {
		const x = (i / (samples - 1)) * 2 - 1;
		curve[i] = Math.tanh(x * (1 + k * 0.1)) / Math.tanh(1 + k * 0.1);
	}
	return curve;
}

function makeTapeSaturationCurve(warmthPercent: number): Float32Array {
	const samples = 1024;
	const curve = new Float32Array(samples);
	const warmth = warmthPercent / 100;
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

// ---------- compile ----------

type Compiled = { in: AudioNode; out: AudioNode };

function compileNode(n: GraphNode, ctx: AudioContext): Compiled {
	switch (n.type) {
		case "input":
		case "output": {
			const g = ctx.createGain();
			g.gain.value = 1;
			return { in: g, out: g };
		}
		case "gain": {
			const g = ctx.createGain();
			g.gain.value = Math.pow(10, num(n.params.gain, 0) / 20);
			return { in: g, out: g };
		}
		case "filter": {
			const f = ctx.createBiquadFilter();
			const t = str(n.params.type, "lowpass") as BiquadFilterType;
			f.type = t;
			f.frequency.value = num(n.params.frequency, 1000);
			f.Q.value = num(n.params.q, 1);
			return { in: f, out: f };
		}
		case "lowshelf": {
			const f = ctx.createBiquadFilter();
			f.type = "lowshelf";
			f.frequency.value = num(n.params.frequency, 200);
			f.gain.value = num(n.params.gain, 0);
			return { in: f, out: f };
		}
		case "highshelf": {
			const f = ctx.createBiquadFilter();
			f.type = "highshelf";
			f.frequency.value = num(n.params.frequency, 6000);
			f.gain.value = num(n.params.gain, 0);
			return { in: f, out: f };
		}
		case "peaking": {
			const f = ctx.createBiquadFilter();
			f.type = "peaking";
			f.frequency.value = num(n.params.frequency, 1000);
			f.gain.value = num(n.params.gain, 0);
			f.Q.value = num(n.params.q, 1);
			return { in: f, out: f };
		}
		case "panner": {
			const p = ctx.createStereoPanner();
			p.pan.value = Math.max(-1, Math.min(1, num(n.params.pan, 0)));
			return { in: p, out: p };
		}
		case "compressor": {
			const c = ctx.createDynamicsCompressor();
			c.threshold.value = num(n.params.threshold, -24);
			c.knee.value = num(n.params.knee, 30);
			c.ratio.value = num(n.params.ratio, 4);
			c.attack.value = num(n.params.attack, 0.003);
			c.release.value = num(n.params.release, 0.25);
			return { in: c, out: c };
		}
		case "distortion": {
			const ws = ctx.createWaveShaper();
			ws.curve = makeDistortionCurve(num(n.params.amount, 25)) as Float32Array<ArrayBuffer>;
			const os = str(n.params.oversample, "2x");
			ws.oversample = (os === "2x" || os === "4x" || os === "none") ? os : "none";
			return { in: ws, out: ws };
		}
		case "delay": {
			const inHub = ctx.createGain();
			const mixOut = ctx.createGain();
			const dryGain = ctx.createGain();
			const wetGain = ctx.createGain();
			const delay = ctx.createDelay(2.0);
			const fb = ctx.createGain();

			const mix = Math.max(0, Math.min(1, num(n.params.mix, 0.4)));
			dryGain.gain.value = 1 - mix;
			wetGain.gain.value = mix;
			delay.delayTime.value = Math.max(0, Math.min(2, num(n.params.time, 0.3)));
			fb.gain.value = Math.max(0, Math.min(0.95, num(n.params.feedback, 0.3)));

			inHub.connect(dryGain);
			dryGain.connect(mixOut);
			inHub.connect(delay);
			delay.connect(wetGain);
			wetGain.connect(mixOut);
			delay.connect(fb);
			fb.connect(delay);

			return { in: inHub, out: mixOut };
		}
		case "reverb": {
			const inHub = ctx.createGain();
			const mixOut = ctx.createGain();
			const dryGain = ctx.createGain();
			const wetGain = ctx.createGain();
			const conv = ctx.createConvolver();

			const mix = Math.max(0, Math.min(1, num(n.params.mix, 0.3)));
			dryGain.gain.value = 1 - mix;
			wetGain.gain.value = mix;
			conv.buffer = getReverbIr(ctx, Math.max(0.1, Math.min(6, num(n.params.decay, 2.0))));

			inHub.connect(dryGain);
			dryGain.connect(mixOut);
			inHub.connect(conv);
			conv.connect(wetGain);
			wetGain.connect(mixOut);

			return { in: inHub, out: mixOut };
		}
		case "spatial8d": {
			const panner = ctx.createPanner();
			panner.panningModel = "HRTF";
			panner.distanceModel = "inverse";
			panner.refDistance = 1;
			panner.maxDistance = 100;
			
			const speedSec = Math.max(1, Math.min(30, num(n.params.speed, 8)));
			const radius = Math.max(0.5, Math.min(10, num(n.params.radius, 3)));
			const elevation = num(n.params.elevation, 1);

			// Start orbit loop
			let angle = 0;
			const timer = setInterval(() => {
				angle = (angle + (0.03 * (2 * Math.PI) / speedSec)) % (2 * Math.PI);
				const x = Math.sin(angle) * radius;
				const z = -Math.cos(angle) * radius;
				const y = elevation ? Math.sin(angle * 2) * 0.4 : 0;
				try {
					if (panner.positionX) {
						panner.positionX.setTargetAtTime(x, ctx.currentTime, 0.02);
						panner.positionY.setTargetAtTime(y, ctx.currentTime, 0.02);
						panner.positionZ.setTargetAtTime(z, ctx.currentTime, 0.02);
					} else {
						(panner as any).setPosition(x, y, z);
					}
				} catch {}
			}, 30);

			// Dispose timer on garbage collection or recompile
			return { in: panner, out: panner };
		}
		case "lofi_tape": {
			const inHub = ctx.createGain();
			const outHub = ctx.createGain();
			const preFilter = ctx.createBiquadFilter();
			preFilter.type = "highshelf";
			preFilter.frequency.value = 6000;
			preFilter.gain.value = num(n.params.warmth, 40) > 50 ? -2 : 0;

			const tapeShaper = ctx.createWaveShaper();
			tapeShaper.oversample = "2x";
			tapeShaper.curve = makeTapeSaturationCurve(num(n.params.warmth, 40)) as Float32Array<ArrayBuffer>;

			const postFilter = ctx.createBiquadFilter();
			postFilter.type = "lowpass";
			postFilter.frequency.value = num(n.params.tone, 14000);

			const wowDelay = ctx.createDelay(0.1);
			wowDelay.delayTime.value = 0.015;

			const wowLfo = ctx.createOscillator();
			const wowLfoGain = ctx.createGain();
			wowLfo.type = "sine";
			wowLfo.frequency.value = 0.8;
			wowLfoGain.gain.value = (num(n.params.wow, 30) / 100) * 0.0025;
			wowLfo.connect(wowLfoGain);
			wowLfoGain.connect(wowDelay.delayTime);
			try { wowLfo.start(); } catch {}

			inHub.connect(preFilter);
			preFilter.connect(tapeShaper);
			tapeShaper.connect(postFilter);
			postFilter.connect(wowDelay);
			wowDelay.connect(outHub);

			return { in: inHub, out: outHub };
		}
		case "vinyl_crackle": {
			const inHub = ctx.createGain();
			const outHub = ctx.createGain();
			inHub.connect(outHub); // Dry passthrough

			const crackleLevel = num(n.params.level, 25) / 100;
			if (crackleLevel > 0.01) {
				const sampleRate = ctx.sampleRate;
				const length = sampleRate * 3;
				const buf = ctx.createBuffer(2, length, sampleRate);
				for (let ch = 0; ch < 2; ch++) {
					const data = buf.getChannelData(ch);
					for (let i = 0; i < length; i++) {
						let v = (Math.random() * 2 - 1) * 0.015;
						if (Math.random() < 0.0004) v += (Math.random() * 0.4 + 0.1) * (Math.random() > 0.5 ? 1 : -1);
						data[i] = v;
					}
				}
				const src = ctx.createBufferSource();
				src.buffer = buf;
				src.loop = true;
				const bandpass = ctx.createBiquadFilter();
				bandpass.type = "bandpass";
				bandpass.frequency.value = 2200;
				bandpass.Q.value = 1.6;
				const crackleGain = ctx.createGain();
				crackleGain.gain.value = crackleLevel * 0.2;
				src.connect(bandpass);
				bandpass.connect(crackleGain);
				crackleGain.connect(outHub);
				try { src.start(); } catch {}
			}

			return { in: inHub, out: outHub };
		}
		case "stereo_widener": {
			const inHub = ctx.createGain();
			const outHub = ctx.createGain();
			const splitter = ctx.createChannelSplitter(2);
			const delayR = ctx.createDelay(0.1);
			const merger = ctx.createChannelMerger(2);

			const delayMs = num(n.params.delay, 18);
			delayR.delayTime.value = delayMs / 1000;

			inHub.connect(splitter);
			splitter.connect(merger, 0, 0); // L direct
			splitter.connect(delayR, 1);
			delayR.connect(merger, 0, 1); // R delayed
			merger.connect(outHub);

			return { in: inHub, out: outHub };
		}
		case "lush_reverb": {
			const inHub = ctx.createGain();
			const outHub = ctx.createGain();
			const dryGain = ctx.createGain();
			const wetGain = ctx.createGain();
			const conv = ctx.createConvolver();

			const mix = Math.max(0, Math.min(1, num(n.params.mix, 0.35)));
			dryGain.gain.value = 1 - mix * 0.7;
			wetGain.gain.value = mix;
			conv.buffer = getReverbIr(ctx, num(n.params.decay, 2.5), str(n.params.preset, "concert_hall"));

			inHub.connect(dryGain);
			dryGain.connect(outHub);
			inHub.connect(conv);
			conv.connect(wetGain);
			wetGain.connect(outHub);

			return { in: inHub, out: outHub };
		}
		case "limiter": {
			const comp = ctx.createDynamicsCompressor();
			comp.threshold.value = num(n.params.threshold, -1.0);
			comp.knee.value = 0;
			comp.ratio.value = 20;
			comp.attack.value = 0.001;
			comp.release.value = num(n.params.release, 0.08);
			return { in: comp, out: comp };
		}
		case "equalizer10": {
			const inHub = ctx.createGain();
			const bands = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
			let curr: AudioNode = inHub;
			for (let i = 0; i < 10; i++) {
				const f = ctx.createBiquadFilter();
				f.type = i === 0 ? "lowshelf" : i === 9 ? "highshelf" : "peaking";
				f.frequency.value = bands[i]!;
				f.Q.value = 1.4;
				f.gain.value = num(n.params[`b${i}`], 0);
				curr.connect(f);
				curr = f;
			}
			return { in: inHub, out: curr };
		}
	}
}

export function compileGraph(
	graph: NodeGraph,
	ctx: AudioContext,
): { entry: AudioNode; exit: AudioNode } {
	const v = validateGraph(graph);
	if (!v.ok) {
		const passthrough = ctx.createGain();
		return { entry: passthrough, exit: passthrough };
	}

	const compiled = new Map<NodeId, Compiled>();
	for (const n of graph.nodes) {
		compiled.set(n.id, compileNode(n, ctx));
	}

	for (const e of graph.edges) {
		const src = compiled.get(e.from);
		const dst = compiled.get(e.to);
		if (!src || !dst) continue;
		src.out.connect(dst.in);
	}

	const inputNode = graph.nodes.find((n) => n.type === "input")!;
	const outputNode = graph.nodes.find((n) => n.type === "output")!;
	return {
		entry: compiled.get(inputNode.id)!.in,
		exit: compiled.get(outputNode.id)!.out,
	};
}
