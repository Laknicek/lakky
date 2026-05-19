// Curated starting points for the node editor. Each template is a small
// NodeGraph laid out left-to-right so the editor can drop it in unchanged.

import type { NodeGraph, GraphNode, GraphEdge, NodeType } from "./nodes";

let _id = 0;
function tid(prefix: string): string {
	_id++;
	return `${prefix}_t${_id.toString(36)}`;
}

// Build a linear chain: input -> n0 -> n1 -> ... -> output.
// Each element either describes a typed node (with params) or is "input"/"output".
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
	{
		name: "Vocal Booth",
		description: "Adds air with a high-shelf and tightens dynamics so vocals sit clearly above the music.",
		graph: chain([
			{ type: "input" },
			{ type: "highshelf", params: { frequency: 8000, gain: 3 } },
			{ type: "compressor", params: { threshold: -18, knee: 30, ratio: 3, attack: 0.003, release: 0.25 } },
			{ type: "output" },
		]),
	},
	{
		name: "Lo-Fi",
		description: "Rolls off the highs and adds a touch of saturation for that warm cassette-tape vibe.",
		graph: chain([
			{ type: "input" },
			{ type: "filter", params: { type: "lowpass", frequency: 7500, q: 1 } },
			{ type: "distortion", params: { amount: 15, oversample: "2x" } },
			{ type: "output" },
		]),
	},
];
