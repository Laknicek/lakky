// Curated starting points for the node editor. Each template is a small
// NodeGraph laid out left-to-right so the editor can drop it in unchanged.

import type { NodeGraph, GraphNode, GraphEdge, NodeType } from "./nodes";

let _id = 0;
function tid(prefix: string): string {
	_id++;
	return `${prefix}_t${_id.toString(36)}`;
}

// Build a linear chain: input -> n0 -> n1 -> ... -> output.
function chain(
	steps: Array<{ type: NodeType; params?: Record<string, number | string> }>,
): NodeGraph {
	const nodes: GraphNode[] = [];
	const edges: GraphEdge[] = [];
	const y = 200;
	let x = 80;
	for (const s of steps) {
		nodes.push({ id: tid(s.type), type: s.type, x, y, params: { ...(s.params ?? {}) } });
		x += 220;
	}
	for (let i = 0; i < nodes.length - 1; i++) {
		edges.push({ id: tid("e"), from: nodes[i]!.id, to: nodes[i + 1]!.id });
	}
	return { nodes, edges };
}

export const NODE_TEMPLATES: Array<{
	name: string;
	description: string;
	graph: NodeGraph;
}> = [
	{
		name: "8D Spatial Voyage",
		description: "Immersive 3D binaural rotation through a lush concert hall with crystal presence.",
		graph: chain([
			{ type: "input" },
			{ type: "equalizer10", params: { b0: 3, b1: 2, b2: 0, b3: 1, b4: 3, b5: 4, b6: 5, b7: 4, b8: 3, b9: 2 } },
			{ type: "spatial8d", params: { speed: 8, radius: 3.5, elevation: 1 } },
			{ type: "lush_reverb", params: { preset: "concert_hall", decay: 2.8, mix: 0.3 } },
			{ type: "limiter", params: { threshold: -0.5, release: 0.08 } },
			{ type: "output" },
		]),
	},
	{
		name: "Anime J-Pop Sparkle",
		description: "Crisp airy vocals, sparkling upper harmonics, and an expanded vibrant stereo soundstage.",
		graph: chain([
			{ type: "input" },
			{ type: "highshelf", params: { frequency: 7000, gain: 4.5 } },
			{ type: "peaking", params: { frequency: 3200, gain: 3.0, q: 1.2 } },
			{ type: "stereo_widener", params: { width: 145, delay: 16 } },
			{ type: "compressor", params: { threshold: -20, knee: 25, ratio: 3.5, attack: 0.005, release: 0.2 } },
			{ type: "output" },
		]),
	},
	{
		name: "Lo-Fi Midnight Vinyl",
		description: "Warm analog tape saturation, authentic pitch wobble, and dusty vinyl crackle.",
		graph: chain([
			{ type: "input" },
			{ type: "lofi_tape", params: { warmth: 55, wow: 35, tone: 11000 } },
			{ type: "vinyl_crackle", params: { level: 30 } },
			{ type: "filter", params: { type: "lowpass", frequency: 8500, q: 0.9 } },
			{ type: "output" },
		]),
	},
	{
		name: "Bass Cannon Impact",
		description: "Colossal sub-bass boost with analog tape punch and brickwall peak limiting.",
		graph: chain([
			{ type: "input" },
			{ type: "lowshelf", params: { frequency: 80, gain: 8.5 } },
			{ type: "lofi_tape", params: { warmth: 30, wow: 0, tone: 16000 } },
			{ type: "compressor", params: { threshold: -22, knee: 20, ratio: 5, attack: 0.008, release: 0.15 } },
			{ type: "limiter", params: { threshold: -0.2, release: 0.05 } },
			{ type: "output" },
		]),
	},
	{
		name: "Concert Hall Immersion",
		description: "Expansive Haas stereo widening combined with a lush convolution hall impulse.",
		graph: chain([
			{ type: "input" },
			{ type: "stereo_widener", params: { width: 160, delay: 22 } },
			{ type: "lush_reverb", params: { preset: "concert_hall", decay: 3.4, mix: 0.38 } },
			{ type: "limiter", params: { threshold: -0.5, release: 0.08 } },
			{ type: "output" },
		]),
	},
	{
		name: "Crystal Vocals",
		description: "High-pass cleanup, pristine mid-range presence, and intimate studio air.",
		graph: chain([
			{ type: "input" },
			{ type: "lowshelf", params: { frequency: 120, gain: -3.5 } },
			{ type: "highshelf", params: { frequency: 8000, gain: 4.0 } },
			{ type: "peaking", params: { frequency: 2800, gain: 3.5, q: 1.1 } },
			{ type: "compressor", params: { threshold: -18, knee: 30, ratio: 3.2, attack: 0.003, release: 0.25 } },
			{ type: "lush_reverb", params: { preset: "warm_room", decay: 1.5, mix: 0.2 } },
			{ type: "output" },
		]),
	},
	{
		name: "Nightcore Dream",
		description: "Hyper-energetic highs, punchy upper mids, and wide euphoric stereo presence.",
		graph: chain([
			{ type: "input" },
			{ type: "highshelf", params: { frequency: 9000, gain: 6.0 } },
			{ type: "peaking", params: { frequency: 4500, gain: 4.0, q: 1.0 } },
			{ type: "stereo_widener", params: { width: 155, delay: 18 } },
			{ type: "limiter", params: { threshold: -0.5, release: 0.06 } },
			{ type: "output" },
		]),
	},
	{
		name: "Metal Drive Shred",
		description: "Aggressive distortion drive, scooped mid EQ, and hard punchy compression.",
		graph: chain([
			{ type: "input" },
			{ type: "distortion", params: { amount: 35, oversample: "2x" } },
			{ type: "peaking", params: { frequency: 1000, gain: -5.0, q: 1.5 } },
			{ type: "lowshelf", params: { frequency: 100, gain: 5.0 } },
			{ type: "compressor", params: { threshold: -24, knee: 15, ratio: 6, attack: 0.002, release: 0.1 } },
			{ type: "output" },
		]),
	},
	{
		name: "Bypass",
		description: "Passes audio through untouched. A clean slate for building your own chain.",
		graph: chain([{ type: "input" }, { type: "output" }]),
	},
	{
		name: "Boom",
		description: "Adds weight and warmth with a low-shelf bass boost and a small overall gain bump.",
		graph: chain([
			{ type: "input" },
			{ type: "lowshelf", params: { frequency: 80, gain: 6 } },
			{ type: "gain", params: { gain: 2 } },
			{ type: "output" },
		]),
	},
	{
		name: "Cinema",
		description: "Glues the mix with a compressor and adds a big hall reverb for that movie-theater feel.",
		graph: chain([
			{ type: "input" },
			{ type: "compressor", params: { threshold: -24, knee: 30, ratio: 4, attack: 0.003, release: 0.25 } },
			{ type: "reverb", params: { decay: 3, mix: 0.35 } },
			{ type: "output" },
		]),
	},
];

