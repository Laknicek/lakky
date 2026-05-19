// Node-based audio effect graph. The data model lives here, plus a compiler
// that turns a graph into a chain of WebAudio nodes the AudioEngine can splice
// into its signal path in place of the default 10-band EQ.

export type NodeId = string;
export type NodeType =
	| "input" | "output"
	| "gain" | "filter" | "delay" | "reverb"
	| "compressor" | "distortion" | "panner"
	| "lowshelf" | "highshelf" | "peaking";

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

function uid(prefix = "n"): string {
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

// Procedural reverb impulse responses are not cheap to generate (a few thousand
// samples of noise per channel) and rebuilding one on every param tweak would
// audibly crackle. Cache by (decay, sampleRate) so identical reverbs share a
// single buffer across nodes and across recompiles.
const reverbIrCache = new Map<string, AudioBuffer>();

function getReverbIr(ctx: AudioContext, decay: number): AudioBuffer {
	const key = `${ctx.sampleRate}|${decay.toFixed(3)}`;
	const cached = reverbIrCache.get(key);
	if (cached) return cached;

	const length = Math.max(1, Math.floor(ctx.sampleRate * decay));
	const ir = ctx.createBuffer(2, length, ctx.sampleRate);
	for (let ch = 0; ch < 2; ch++) {
		const data = ir.getChannelData(ch);
		for (let i = 0; i < length; i++) {
			const t = i / ctx.sampleRate;
			data[i] = (Math.random() * 2 - 1) * Math.exp(-(t * 6) / decay);
		}
	}
	reverbIrCache.set(key, ir);
	return ir;
}

// ---------- distortion curve ----------

function makeDistortionCurve(amount: number): Float32Array {
	const samples = 1024;
	const curve = new Float32Array(samples);
	// Standard tanh-based shaper: as amount grows, the curve hardens toward a
	// clip. amount=0 stays linear-ish, amount=100 is harsh.
	const k = amount;
	for (let i = 0; i < samples; i++) {
		const x = (i / (samples - 1)) * 2 - 1;
		curve[i] = Math.tanh(x * (1 + k * 0.1)) / Math.tanh(1 + k * 0.1);
	}
	return curve;
}

// ---------- compile ----------

// A compiled per-graph-node holds the WebAudio "in" and "out" sides — for
// simple nodes these are the same AudioNode; for composite nodes (delay,
// reverb) "in" is a fan-in gain and "out" is a fan-out mixer gain.
type Compiled = { in: AudioNode; out: AudioNode };

function compileNode(n: GraphNode, ctx: AudioContext): Compiled {
	switch (n.type) {
		case "input":
		case "output": {
			// Pass-through gain. Lets us wire edges uniformly and gives the
			// AudioEngine a stable entry/exit handle.
			const g = ctx.createGain();
			g.gain.value = 1;
			return { in: g, out: g };
		}
		case "gain": {
			const g = ctx.createGain();
			// dB -> linear amplitude
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
			// Parallel wet/dry. inHub fans out to two paths; mixOut sums them.
			//
			//   inHub ──► dryGain ─────────────────────► mixOut
			//          └► delay ──► wetGain ────────────► mixOut
			//                  ▲      │
			//                  └─ fbGain ─┘
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
			// Feedback loop: tap delay output, attenuate, fold back to delay input.
			delay.connect(fb);
			fb.connect(delay);

			return { in: inHub, out: mixOut };
		}
		case "reverb": {
			// Parallel wet/dry around a ConvolverNode.
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
	}
}

export function compileGraph(
	graph: NodeGraph,
	ctx: AudioContext,
): { entry: AudioNode; exit: AudioNode } {
	const v = validateGraph(graph);
	if (!v.ok) {
		// Fall back to a pass-through so a broken graph never breaks audio.
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
