// Visual block-diagram editor for the audio node graph. Owns the canvas, the
// SVG cable overlay, the inspector, and the toolbar. Calls back on every
// committed change via `onChange(graph)` so the rest of the app can persist
// the graph and apply it to the live audio engine.

import {
	NODE_DEFS,
	newGraph,
	validateGraph,
	uid,
	type NodeGraph,
	type GraphNode,
	type GraphEdge,
	type NodeId,
	type NodeType,
} from "./nodes";
import { NODE_TEMPLATES } from "./nodeTemplates";
import { escapeHtml } from "./util";

type ToastFn = (msg: string, opts?: { ttl?: number; key?: string }) => void;

let _toast: ToastFn = (m) => console.log("[node-editor]", m);

// Lazy import the real toast so we don't create a circular dep with main.ts at
// load time. If main.ts exposes window.__lakkyToast we use it; otherwise we
// fall back to console.
function getToast(): ToastFn {
	const fn = window.__lakkyToast;
	if (typeof fn === "function") return fn;
	return _toast;
}

function makeUid(prefix = "n"): string {
	return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function clone(g: NodeGraph): NodeGraph {
	return {
		nodes: g.nodes.map((n) => ({ ...n, params: { ...n.params } })),
		edges: g.edges.map((e) => ({ ...e })),
	};
}

const NODE_W = 200;
// Approximate header height + ports row. Used for cable anchor math; the real
// element is measured at draw time so this is just a fallback when a node
// hasn't laid out yet.
const NODE_H_APPROX = 96;

// Anchor offsets within a .ne-node. Ports sit on the vertical center; input
// hugs the left edge, output hugs the right edge.
function portOffset(side: "in" | "out", nodeWidth = NODE_W, nodeHeight = NODE_H_APPROX): { x: number; y: number } {
	return { x: side === "in" ? 0 : nodeWidth, y: nodeHeight / 2 };
}

function bezierPath(x1: number, y1: number, x2: number, y2: number): string {
	const dx = Math.max(40, Math.abs(x2 - x1) * 0.5);
	return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

export function renderNodeEditor(
	root: HTMLElement,
	currentGraph: NodeGraph,
	onChange: (g: NodeGraph) => void,
): void {
	const toast = getToast();

	// Live working copy. Every interaction mutates this then calls commit().
	let graph: NodeGraph = currentGraph && currentGraph.nodes?.length ? clone(currentGraph) : newGraph();
	let selectedNodeId: NodeId | null = null;
	let hoveredEdgeId: string | null = null;

	const commit = () => {
		onChange(clone(graph));
	};

	root.innerHTML = `
		<div class="ne-wrap">
			<div class="ne-toolbar">
				<h2>Nodes</h2>
				<div class="ne-toolbar-actions">
					<div class="ne-menu" data-menu="add">
						<button class="btn" id="ne-btn-add" data-tip="Add an audio node to the graph" title="Add a node">
							<span>Add node</span>
							<span class="ne-caret">▾</span>
						</button>
						<div class="ne-menu-pop" id="ne-menu-add"></div>
					</div>
					<div class="ne-menu" data-menu="tpl">
						<button class="btn" id="ne-btn-tpl" data-tip="Load a curated preset graph" title="Load a template">
							<span>Templates</span>
							<span class="ne-caret">▾</span>
						</button>
						<div class="ne-menu-pop" id="ne-menu-tpl"></div>
					</div>
					<button class="btn" id="ne-btn-reset" data-tip="Reset to a fresh input → output graph" title="Reset graph">
						<span>Reset</span>
					</button>
					<button class="btn" id="ne-btn-validate" data-tip="Check the graph for missing nodes, cycles, and orphans" title="Validate graph">
						<span>Validate</span>
					</button>
				</div>
			</div>
			<div class="ne-stage" id="ne-stage" tabindex="0">
				<svg class="ne-edges" id="ne-edges" xmlns="http://www.w3.org/2000/svg"></svg>
				<div class="ne-nodes" id="ne-nodes"></div>
			</div>
			<aside class="ne-inspector" id="ne-inspector"></aside>
		</div>
	`;

	const stage = root.querySelector<HTMLDivElement>("#ne-stage")!;
	const nodesLayer = root.querySelector<HTMLDivElement>("#ne-nodes")!;
	const edgesLayer = root.querySelector<SVGSVGElement>("#ne-edges")!;
	const inspector = root.querySelector<HTMLElement>("#ne-inspector")!;
	const addMenu = root.querySelector<HTMLDivElement>("#ne-menu-add")!;
	const tplMenu = root.querySelector<HTMLDivElement>("#ne-menu-tpl")!;

	// ---------- dropdowns ----------
	const populateAddMenu = () => {
		addMenu.innerHTML = Object.values(NODE_DEFS)
			.map(
				(d) => `
				<button class="ne-menu-item" data-type="${d.type}" title="${escapeHtml(d.description)}">
					<strong>${escapeHtml(d.type)}</strong>
					<span>${escapeHtml(d.description.slice(0, 60))}${d.description.length > 60 ? "…" : ""}</span>
				</button>`,
			)
			.join("");
	};
	const populateTplMenu = () => {
		tplMenu.innerHTML = NODE_TEMPLATES
			.map(
				(t, i) => `
				<button class="ne-menu-item" data-tpl="${i}" title="${escapeHtml(t.description)}">
					<strong>${escapeHtml(t.name)}</strong>
					<span>${escapeHtml(t.description.slice(0, 60))}${t.description.length > 60 ? "…" : ""}</span>
				</button>`,
			)
			.join("");
	};
	populateAddMenu();
	populateTplMenu();

	const closeMenus = () => {
		root.querySelector(".ne-menu.open")?.classList.remove("open");
	};
	root.querySelectorAll<HTMLDivElement>(".ne-menu").forEach((wrap) => {
		const btn = wrap.querySelector("button")!;
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			const wasOpen = wrap.classList.contains("open");
			closeMenus();
			if (!wasOpen) wrap.classList.add("open");
		});
	});
	document.addEventListener("click", closeMenus);

	addMenu.addEventListener("click", (e) => {
		const t = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-type]");
		if (!t) return;
		closeMenus();
		addNode(t.dataset.type as NodeType);
	});
	tplMenu.addEventListener("click", (e) => {
		const t = (e.target as HTMLElement).closest<HTMLButtonElement>("[data-tpl]");
		if (!t) return;
		closeMenus();
		const idx = Number(t.dataset.tpl);
		const tpl = NODE_TEMPLATES[idx];
		if (!tpl) return;
		// Templates ship with shared template IDs ("input_t1" etc). To avoid
		// collisions if the user loads the same template twice or has nodes with
		// the same prefix already, re-stamp every id.
		const idMap = new Map<NodeId, NodeId>();
		const fresh: NodeGraph = {
			nodes: tpl.graph.nodes.map((n) => {
				const nid = uid(n.type);
				idMap.set(n.id, nid);
				return { ...n, id: nid, params: { ...n.params } };
			}),
			edges: tpl.graph.edges.map((e2) => ({
				id: uid("e"),
				from: idMap.get(e2.from)!,
				to: idMap.get(e2.to)!,
			})),
		};
		graph = fresh;
		selectedNodeId = null;
		commit();
		renderAll();
		toast(`Loaded template: ${tpl.name}`);
	});

	// ---------- buttons ----------
	root.querySelector("#ne-btn-reset")!.addEventListener("click", () => {
		graph = newGraph();
		selectedNodeId = null;
		commit();
		renderAll();
		toast("Graph reset");
	});
	root.querySelector("#ne-btn-validate")!.addEventListener("click", () => {
		const v = validateGraph(graph);
		if (v.ok) toast("Graph is valid", { ttl: 1600 });
		else toast(`Invalid: ${v.error ?? "unknown error"}`, { ttl: 2800 });
	});

	// ---------- add node ----------
	const addNode = (type: NodeType) => {
		const def = NODE_DEFS[type];
		// Drop the new node near the visible center of the stage.
		const rect = stage.getBoundingClientRect();
		const cx = stage.scrollLeft + rect.width / 2 - NODE_W / 2;
		const cy = stage.scrollTop + rect.height / 2 - NODE_H_APPROX / 2;
		const n: GraphNode = {
			id: uid(type),
			type,
			x: Math.max(8, cx + (Math.random() - 0.5) * 60),
			y: Math.max(8, cy + (Math.random() - 0.5) * 60),
			params: { ...def.defaults },
		};
		graph.nodes.push(n);
		selectedNodeId = n.id;
		commit();
		renderAll();
	};

	// ---------- delete node ----------
	const deleteNode = (id: NodeId) => {
		graph.nodes = graph.nodes.filter((n) => n.id !== id);
		graph.edges = graph.edges.filter((e) => e.from !== id && e.to !== id);
		if (selectedNodeId === id) selectedNodeId = null;
		commit();
		renderAll();
	};

	// ---------- delete edge ----------
	const deleteEdge = (id: string) => {
		graph.edges = graph.edges.filter((e) => e.id !== id);
		commit();
		renderAll();
	};

	// ---------- drag / connect state ----------
	type DragNodeState = { kind: "node"; id: NodeId; startX: number; startY: number; startMx: number; startMy: number };
	type DragCableState = { kind: "cable"; from: NodeId; px: number; py: number };
	let drag: DragNodeState | DragCableState | null = null;
	let rafPending = false;
	let pendingDragXY: { x: number; y: number } | null = null;

	const stagePoint = (e: MouseEvent): { x: number; y: number } => {
		const r = stage.getBoundingClientRect();
		return { x: e.clientX - r.left + stage.scrollLeft, y: e.clientY - r.top + stage.scrollTop };
	};

	const flushDrag = () => {
		rafPending = false;
		if (!drag || drag.kind !== "node" || !pendingDragXY) return;
		const node = graph.nodes.find((nn) => nn.id === (drag as DragNodeState).id);
		if (!node) return;
		node.x = pendingDragXY.x;
		node.y = pendingDragXY.y;
		positionNodeEl(node);
		redrawEdges();
	};

	const positionNodeEl = (n: GraphNode) => {
		const el = nodesLayer.querySelector<HTMLDivElement>(`.ne-node[data-id="${n.id}"]`);
		if (!el) return;
		el.style.left = `${n.x}px`;
		el.style.top = `${n.y}px`;
	};

	// ---------- render ----------
	function nodeCardHTML(n: GraphNode): string {
		const def = NODE_DEFS[n.type];
		const isFixed = n.type === "input" || n.type === "output";
		const paramSummary = def.params
			.slice(0, 2)
			.map((p) => {
				const v = n.params[p.key];
				const display = typeof v === "number" ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)) : String(v ?? "");
				return `<span>${escapeHtml(p.label)}: ${escapeHtml(display)}${p.unit ? escapeHtml(p.unit) : ""}</span>`;
			})
			.join("");
		const selected = selectedNodeId === n.id ? " is-selected" : "";
		return `
			<div class="ne-node ne-node-${n.type}${selected}" data-id="${n.id}" style="left:${n.x}px; top:${n.y}px;">
				<header class="ne-node-head">
					<span class="ne-node-title">${escapeHtml(n.type)}</span>
					${isFixed ? "" : `<button class="ne-node-x" data-act="delete" title="Delete node">×</button>`}
				</header>
				<div class="ne-ports">
					${n.type !== "input" ? `<span class="ne-port ne-port-in" data-port="in"></span>` : `<span class="ne-port ne-port-spacer"></span>`}
					${n.type !== "output" ? `<span class="ne-port ne-port-out" data-port="out"></span>` : `<span class="ne-port ne-port-spacer"></span>`}
				</div>
				${paramSummary ? `<p class="ne-params">${paramSummary}</p>` : `<p class="ne-params ne-params-empty">${escapeHtml(def.description.slice(0, 64))}${def.description.length > 64 ? "…" : ""}</p>`}
			</div>
		`;
	}

	function renderNodes() {
		nodesLayer.innerHTML = graph.nodes.map(nodeCardHTML).join("");
		// Grow stage so far-away nodes are reachable via scroll.
		const maxX = graph.nodes.reduce((m, n) => Math.max(m, n.x + NODE_W + 80), 800);
		const maxY = graph.nodes.reduce((m, n) => Math.max(m, n.y + NODE_H_APPROX + 80), 480);
		nodesLayer.style.width = `${maxX}px`;
		nodesLayer.style.height = `${maxY}px`;
		edgesLayer.setAttribute("width", String(maxX));
		edgesLayer.setAttribute("height", String(maxY));
		edgesLayer.style.width = `${maxX}px`;
		edgesLayer.style.height = `${maxY}px`;
	}

	function redrawEdges() {
		const liveCable = drag && drag.kind === "cable"
			? (() => {
				const from = graph.nodes.find((n) => n.id === (drag as DragCableState).from);
				if (!from) return "";
				const a = portOffset("out");
				const x1 = from.x + a.x;
				const y1 = from.y + a.y;
				const x2 = (drag as DragCableState).px;
				const y2 = (drag as DragCableState).py;
				return `<path class="ne-edge ne-edge-ghost" d="${bezierPath(x1, y1, x2, y2)}" />`;
			})()
			: "";

		const edgePaths = graph.edges
			.map((e) => {
				const a = graph.nodes.find((n) => n.id === e.from);
				const b = graph.nodes.find((n) => n.id === e.to);
				if (!a || !b) return "";
				const oa = portOffset("out");
				const ob = portOffset("in");
				const x1 = a.x + oa.x;
				const y1 = a.y + oa.y;
				const x2 = b.x + ob.x;
				const y2 = b.y + ob.y;
				const cls = hoveredEdgeId === e.id ? "ne-edge ne-edge-hover" : "ne-edge";
				// Two paths: a fat invisible one for easier hit-testing and the visible one.
				return `
					<path class="ne-edge-hit" data-edge="${e.id}" d="${bezierPath(x1, y1, x2, y2)}" />
					<path class="${cls}" data-edge="${e.id}" d="${bezierPath(x1, y1, x2, y2)}" />
				`;
			})
			.join("");

		edgesLayer.innerHTML = edgePaths + liveCable;
	}

	function renderInspector() {
		if (!selectedNodeId) {
			inspector.innerHTML = `
				<h3>Inspector</h3>
				<p class="ne-desc">Click a node to inspect and tune its parameters. Drag from the right port of one node to the left port of another to wire them up.</p>
			`;
			return;
		}
		const node = graph.nodes.find((n) => n.id === selectedNodeId);
		if (!node) {
			selectedNodeId = null;
			renderInspector();
			return;
		}
		const def = NODE_DEFS[node.type];
		const rows = def.params
			.map((p) => {
				const v = node.params[p.key];
				if (p.options) {
					const opts = p.options.map(
						(o) => `<option value="${escapeHtml(o)}"${o === String(v) ? " selected" : ""}>${escapeHtml(o)}</option>`,
					).join("");
					return `
						<label class="ne-param">
							<span class="ne-param-label">${escapeHtml(p.label)}</span>
							<select class="ne-input" data-key="${escapeHtml(p.key)}" data-kind="select">${opts}</select>
						</label>
					`;
				}
				const num = typeof v === "number" ? v : Number(v ?? 0);
				const step = p.step ?? 0.01;
				const min = p.min ?? 0;
				const max = p.max ?? 1;
				const display = Number.isFinite(num) ? (Math.abs(num) >= 100 ? num.toFixed(0) : num.toFixed(2)) : "0";
				return `
					<label class="ne-param">
						<span class="ne-param-label">${escapeHtml(p.label)}<span class="ne-param-value" data-for="${escapeHtml(p.key)}">${escapeHtml(display)}${p.unit ? escapeHtml(p.unit) : ""}</span></span>
						<input class="range" type="range" data-key="${escapeHtml(p.key)}" data-kind="range" data-unit="${escapeHtml(p.unit ?? "")}" min="${min}" max="${max}" step="${step}" value="${num}" />
					</label>
				`;
			})
			.join("");
		inspector.innerHTML = `
			<h3>${escapeHtml(def.type)}</h3>
			<p class="ne-desc">${escapeHtml(def.description)}</p>
			<div class="ne-params-edit">
				${rows || `<p class="ne-desc ne-desc-muted">This node has no parameters to tune.</p>`}
			</div>
		`;

		inspector.querySelectorAll<HTMLInputElement>('[data-kind="range"]').forEach((input) => {
			const key = input.dataset.key!;
			const unit = input.dataset.unit ?? "";
			const valueEl = inspector.querySelector<HTMLElement>(`[data-for="${key}"]`);
			input.addEventListener("input", () => {
				const v = Number(input.value);
				node.params[key] = v;
				if (valueEl) valueEl.textContent = `${Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)}${unit}`;
				// Live param summary on the card too.
				updateNodeCardSummary(node);
			});
			input.addEventListener("change", () => {
				commit();
			});
		});
		inspector.querySelectorAll<HTMLSelectElement>('[data-kind="select"]').forEach((sel) => {
			const key = sel.dataset.key!;
			sel.addEventListener("change", () => {
				node.params[key] = sel.value;
				updateNodeCardSummary(node);
				commit();
			});
		});
	}

	function updateNodeCardSummary(node: GraphNode) {
		const el = nodesLayer.querySelector<HTMLElement>(`.ne-node[data-id="${node.id}"] .ne-params`);
		if (!el) return;
		const def = NODE_DEFS[node.type];
		const summary = def.params
			.slice(0, 2)
			.map((p) => {
				const v = node.params[p.key];
				const display = typeof v === "number" ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)) : String(v ?? "");
				return `<span>${escapeHtml(p.label)}: ${escapeHtml(display)}${p.unit ? escapeHtml(p.unit) : ""}</span>`;
			})
			.join("");
		if (summary) {
			el.classList.remove("ne-params-empty");
			el.innerHTML = summary;
		}
	}

	function renderAll() {
		renderNodes();
		redrawEdges();
		renderInspector();
	}

	renderAll();

	// ---------- mouse handlers ----------

	// Pointerdown on a node: select + maybe start drag (header) or start a cable
	// (output port).
	nodesLayer.addEventListener("mousedown", (e) => {
		const target = e.target as HTMLElement;

		// Delete button
		if (target.matches('[data-act="delete"]')) {
			const card = target.closest<HTMLElement>(".ne-node");
			if (!card) return;
			e.stopPropagation();
			deleteNode(card.dataset.id!);
			return;
		}

		const card = target.closest<HTMLElement>(".ne-node");
		if (!card) return;
		const id = card.dataset.id!;
		const node = graph.nodes.find((n) => n.id === id);
		if (!node) return;

		// Select on any mousedown
		if (selectedNodeId !== id) {
			selectedNodeId = id;
			nodesLayer.querySelectorAll(".ne-node.is-selected").forEach((el) => el.classList.remove("is-selected"));
			card.classList.add("is-selected");
			renderInspector();
		}

		// Output port → start a cable
		if (target.classList.contains("ne-port-out")) {
			e.preventDefault();
			const pt = stagePoint(e);
			drag = { kind: "cable", from: id, px: pt.x, py: pt.y };
			redrawEdges();
			return;
		}
		// Input port → no-op on mousedown (drop target only)
		if (target.classList.contains("ne-port-in")) return;

		// Header → drag the node
		if (target.closest(".ne-node-head")) {
			e.preventDefault();
			const pt = stagePoint(e);
			drag = {
				kind: "node",
				id,
				startX: node.x,
				startY: node.y,
				startMx: pt.x,
				startMy: pt.y,
			};
		}
	});

	window.addEventListener("mousemove", (e) => {
		if (!drag) return;
		const pt = stagePoint(e);
		if (drag.kind === "node") {
			pendingDragXY = {
				x: Math.max(0, drag.startX + (pt.x - drag.startMx)),
				y: Math.max(0, drag.startY + (pt.y - drag.startMy)),
			};
			if (!rafPending) {
				rafPending = true;
				requestAnimationFrame(flushDrag);
			}
		} else if (drag.kind === "cable") {
			drag.px = pt.x;
			drag.py = pt.y;
			redrawEdges();
		}
	});

	window.addEventListener("mouseup", (e) => {
		if (!drag) return;
		if (drag.kind === "node") {
			drag = null;
			pendingDragXY = null;
			commit();
		} else {
			// cable drop — look for input port under cursor
			const target = e.target as HTMLElement;
			const port = target?.closest?.(".ne-port-in") as HTMLElement | null;
			const card = port?.closest<HTMLElement>(".ne-node");
			const toId = card?.dataset.id;
			const fromId = drag.from;
			drag = null;
			if (toId && toId !== fromId) {
				// Don't allow duplicate edges between the same two nodes in the same direction.
				const exists = graph.edges.some((ed) => ed.from === fromId && ed.to === toId);
				if (!exists) {
					graph.edges.push({ id: uid("e"), from: fromId, to: toId });
					commit();
				}
			}
			renderAll();
		}
	});

	// ---------- edge hover / click ----------
	edgesLayer.addEventListener("mousemove", (e) => {
		const target = e.target as SVGElement;
		const id = target?.getAttribute?.("data-edge");
		if (id !== hoveredEdgeId) {
			hoveredEdgeId = id ?? null;
			redrawEdges();
		}
	});
	edgesLayer.addEventListener("mouseleave", () => {
		if (hoveredEdgeId) {
			hoveredEdgeId = null;
			redrawEdges();
		}
	});
	edgesLayer.addEventListener("click", (e) => {
		const target = e.target as SVGElement;
		const id = target?.getAttribute?.("data-edge");
		if (id) deleteEdge(id);
	});

	// Click empty stage = deselect
	stage.addEventListener("mousedown", (e) => {
		if (e.target === stage || (e.target as HTMLElement).id === "ne-nodes" || (e.target as Element).tagName === "svg") {
			if (selectedNodeId) {
				selectedNodeId = null;
				nodesLayer.querySelectorAll(".ne-node.is-selected").forEach((el) => el.classList.remove("is-selected"));
				renderInspector();
			}
		}
	});

	// ---------- keyboard ----------
	const onKey = (e: KeyboardEvent) => {
		// Only act when our stage (or its descendants) has focus, or no input is focused elsewhere.
		const activeIsField =
			document.activeElement &&
			["INPUT", "SELECT", "TEXTAREA"].includes((document.activeElement as HTMLElement).tagName);
		if (activeIsField) return;

		if (e.key === "Escape") {
			if (drag && drag.kind === "cable") {
				drag = null;
				redrawEdges();
				e.preventDefault();
			} else if (selectedNodeId) {
				selectedNodeId = null;
				nodesLayer.querySelectorAll(".ne-node.is-selected").forEach((el) => el.classList.remove("is-selected"));
				renderInspector();
			}
		} else if ((e.key === "Delete" || e.key === "Backspace") && selectedNodeId) {
			const n = graph.nodes.find((nn) => nn.id === selectedNodeId);
			if (n && n.type !== "input" && n.type !== "output") {
				deleteNode(selectedNodeId);
				e.preventDefault();
			}
		}
	};
	stage.addEventListener("keydown", onKey);
	// Also listen on the document so the user doesn't strictly need to click the stage first.
	document.addEventListener("keydown", onKey);
	// Park a cleanup hook on the root so re-renders detach the document listener.
	(root as any).__neCleanup?.();
	(root as any).__neCleanup = () => {
		document.removeEventListener("keydown", onKey);
		document.removeEventListener("click", closeMenus);
	};
}
