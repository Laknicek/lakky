// Lakky Echoes — year-in-review experience.
//
// Fullscreen cinematic takeover with custom cursor, ambient synth pads,
// background music info bar, live particle field, and rich animated slides.
// Pauses playback on entry, restores on exit. Deterministic per-year.

import type { TrackInfo } from "../shared/rpcSchema";
import { escapeHtml } from "./util";

// ----- Types -----

export type EchoesData = {
	year: number;
	seed: number;
	totalSeconds: number;
	totalPlays: number;
	uniqueTracks: number;
	uniqueArtists: number;
	uniqueAlbums: number;
	uniqueGenres: number;
	librarySize: number;
	oldestYear: number | null;
	newestYear: number | null;
	topTrack: { title: string; artist: string; plays: number; artUrl?: string; streamUrl?: string } | null;
	topTracks: { title: string; artist: string; plays: number; artUrl?: string }[];
	topArtists: { name: string; plays: number; trackCount: number }[];
	topAlbums: { name: string; artist: string; plays: number }[];
	topGenres: { name: string; plays: number }[];
	vibe: { name: string; description: string };
	palette: Palette;
	particleStyle: ParticleStyle;
};

type EchoesHooks = {
	onPause: () => void;
	onClose: () => void;
};

type Palette = { id: string; bg: string; a: string; b: string; c: string };
type ParticleStyle = "orbs" | "triangles" | "hexagons" | "ribbons" | "stars";

// ----- Theming -----

const PALETTES: Palette[] = [
	{ id: "aurora",   bg: "#08041c", a: "167, 139, 250", b: "56, 189, 248",  c: "236, 72, 153" },
	{ id: "solar",    bg: "#1c0a06", a: "251, 146, 60",  b: "248, 113, 113", c: "252, 211, 77" },
	{ id: "forest",   bg: "#041410", a: "52, 211, 153",  b: "94, 234, 212",  c: "163, 230, 53" },
	{ id: "rose",     bg: "#180518", a: "244, 114, 182", b: "192, 132, 252", c: "248, 113, 113" },
	{ id: "midnight", bg: "#050a1e", a: "96, 165, 250",  b: "129, 140, 248", c: "165, 180, 252" },
	{ id: "sunset",   bg: "#1a0816", a: "251, 113, 133", b: "251, 146, 60",  c: "192, 132, 252" },
];
const PARTICLE_STYLES: ParticleStyle[] = ["orbs", "triangles", "hexagons", "ribbons", "stars"];

// ----- RNG (mulberry32, deterministic per seed) -----

function makeRng(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
const pick = <T>(rng: () => number, arr: readonly T[]) => arr[Math.floor(rng() * arr.length)];

// ----- Ambient synth (Web Audio API) -----

type SynthNote = { freq: number; gain: GainNode; osc: OscillatorNode; age: number; duration: number };

class AmbientSynth {
	private ctx: AudioContext;
	private master: GainNode;
	private notes: SynthNote[] = [];
	private raf: number | null = null;
	private lastT = 0;
	private palette: Palette;
	private baseFreqs: number[];

	constructor(palette: Palette) {
		this.ctx = new AudioContext();
		this.master = this.ctx.createGain();
		this.master.gain.value = 0.06;
		this.master.connect(this.ctx.destination);
		this.palette = palette;

		const seed = this.ctx.currentTime * 1000;
		const rng = makeRng(seed);
		this.baseFreqs = [
			55 + rng() * 27.5,    // A1-ish
			110 + rng() * 55,     // A2-ish
			146.83 + rng() * 20,  // D3-ish
			220 + rng() * 40,     // A3-ish
		];
		this.lastT = performance.now();
		const tick = (t: number) => {
			const dt = (t - this.lastT) / 1000;
			this.lastT = t;
			this.step(dt);
			this.raf = requestAnimationFrame(tick);
		};
		this.raf = requestAnimationFrame(tick);

		// Spawn a few notes immediately so it doesn't start silent.
		this.spawnNote();
		this.spawnNote();
	}

	private spawnNote() {
		if (this.notes.length > 6) return;
		const freq = this.baseFreqs[Math.floor(Math.random() * this.baseFreqs.length)] * (0.5 + Math.random());
		const osc = this.ctx.createOscillator();
		const gain = this.ctx.createGain();
		osc.type = (["sine", "triangle", "sine"] as OscillatorType[])[Math.floor(Math.random() * 3)];
		osc.frequency.value = freq;
		gain.gain.value = 0;
		gain.gain.linearRampToValueAtTime(0.35 + Math.random() * 0.4, this.ctx.currentTime + 0.8);
		osc.connect(gain);
		gain.connect(this.master);
		osc.start();
		this.notes.push({ freq, gain, osc, age: 0, duration: 4 + Math.random() * 8 });
	}

	private step(dt: number) {
		for (const n of this.notes) {
			n.age += dt;
			const t = n.age / n.duration;
			if (t > 1) {
				n.gain.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 1.5);
				n.osc.stop(this.ctx.currentTime + 1.5);
			}
		}
		this.notes = this.notes.filter((n) => n.age < n.duration + 1.5);
		if (this.notes.length < 4 && Math.random() < 0.3) this.spawnNote();
	}

	destroy() {
		if (this.raf) cancelAnimationFrame(this.raf);
		this.master.gain.linearRampToValueAtTime(0, this.ctx.currentTime + 1);
		setTimeout(() => { this.ctx.close(); this.notes = []; }, 1200);
	}
}

// ----- Vibe system -----

const VIBE_TEMPLATES: Array<{
	match: (genres: string[]) => boolean;
	names: readonly string[];
	descriptions: readonly string[];
}> = [
	{
		match: (g) => g.some((x) => /metal|rock|punk|grunge/.test(x)),
		names: ["The Riff Lord", "Distortion Disciple", "Stage Diver", "Amp Worshipper"],
		descriptions: [
			"Your eardrums made the case for hearing protection — and lost.",
			"You spent the year leaning into the loudest, fastest minutes of music humanity has produced.",
			"Quiet songs need not apply.",
		],
	},
	{
		match: (g) => g.some((x) => /electronic|edm|techno|house|trance|dnb|drum/.test(x)),
		names: ["The Pulse", "Synth Architect", "Beat Driver", "Frequency Hunter"],
		descriptions: [
			"Your headphones think you live inside a kick drum.",
			"You found beauty in machines that pretend to be drums.",
			"Tempo is a language and you're fluent.",
		],
	},
	{
		match: (g) => g.some((x) => /hip|rap|trap/.test(x)),
		names: ["The Wordsmith", "Bassline Believer", "Rhyme Receiver", "808 Devotee"],
		descriptions: [
			"You don't just listen — you mouth every other syllable in the chorus.",
			"You measured the year in bars.",
			"Lyrics matter and your queue knows it.",
		],
	},
	{
		match: (g) => g.some((x) => /jazz|blues|soul|funk/.test(x)),
		names: ["The Late-Night Listener", "Saxophone Stowaway", "Smoke-Room Romantic"],
		descriptions: [
			"You played music that doesn't need permission to take its time.",
			"Your year had a horn section.",
			"You found rooms inside the songs.",
		],
	},
	{
		match: (g) => g.some((x) => /classical|orchestral|score|soundtrack|piano/.test(x)),
		names: ["The Composer's Companion", "Score Reader", "Cathedral Wanderer"],
		descriptions: [
			"You let strings explain things that words couldn't.",
			"Your year had movements.",
			"Quiet wasn't quiet — it was being held.",
		],
	},
	{
		match: (g) => g.some((x) => /indie|alternative|folk|acoustic/.test(x)),
		names: ["The Headphone Wanderer", "Coffee-Shop Cartographer", "Backseat Lyricist"],
		descriptions: [
			"You found whole worlds inside reverb tails.",
			"Your queue was a long handwritten letter.",
			"You played the songs people made for themselves first.",
		],
	},
	{
		match: (g) => g.some((x) => /pop|r&b|rnb|dance/.test(x)),
		names: ["The Chorus-First Consumer", "Hook Magnet", "Top-Line Tourist"],
		descriptions: [
			"You weren't there for the verses.",
			"If a song was a candy, you read the wrapper.",
			"You voted with the repeat button.",
		],
	},
];

const NEUTRAL_VIBE = {
	names: ["The Wide-Ear", "The Eclectic", "Genre Tourist", "The Curator"],
	descriptions: [
		"You don't have a taste — you have a buffet.",
		"Your queue has no idea what it's doing and that's the point.",
		"Every shuffle was a surprise.",
	],
};

function pickVibe(rng: () => number, genres: string[]): { name: string; description: string } {
	const lower = genres.map((g) => g.toLowerCase());
	const match = VIBE_TEMPLATES.find((v) => v.match(lower));
	if (match) return { name: pick(rng, match.names), description: pick(rng, match.descriptions) };
	return { name: pick(rng, NEUTRAL_VIBE.names), description: pick(rng, NEUTRAL_VIBE.descriptions) };
}

// ----- Stat computation -----

export function computeEchoes(
	library: TrackInfo[],
	playStats: Record<string, number>,
	year: number,
): EchoesData {
	const rng = makeRng(year * 2654435761);
	let totalSeconds = 0, totalPlays = 0;
	const trackPlays: { t: TrackInfo; plays: number }[] = [];
	const artistAgg = new Map<string, { plays: number; tracks: Set<string> }>();
	const albumAgg = new Map<string, { artist: string; plays: number }>();
	const genreAgg = new Map<string, number>();
	let oldestYear: number | null = null, newestYear: number | null = null;

	for (const t of library) {
		if (t.year != null) {
			oldestYear = oldestYear == null ? t.year : Math.min(oldestYear, t.year);
			newestYear = newestYear == null ? t.year : Math.max(newestYear, t.year);
		}
		const plays = playStats[t.id] ?? 0;
		if (plays === 0) continue;
		totalPlays += plays;
		totalSeconds += plays * (t.duration || 0);
		trackPlays.push({ t, plays });

		const artist = t.artist?.trim() || "Unknown Artist";
		const aBucket = artistAgg.get(artist) ?? { plays: 0, tracks: new Set<string>() };
		aBucket.plays += plays;
		aBucket.tracks.add(t.id);
		artistAgg.set(artist, aBucket);

		const album = t.album?.trim() || "Unknown Album";
		const albKey = `${album}\0${artist}`;
		const albBucket = albumAgg.get(albKey) ?? { artist, plays: 0 };
		albBucket.plays += plays;
		albumAgg.set(albKey, albBucket);

		if (t.genre) {
			const g = t.genre.trim();
			if (g) genreAgg.set(g, (genreAgg.get(g) ?? 0) + plays);
		}
	}

	trackPlays.sort((a, b) => b.plays - a.plays);
	const topTracks = trackPlays.slice(0, 5).map((x) => ({
		title: x.t.title, artist: x.t.artist, plays: x.plays,
		artUrl: x.t.artDataUrl, streamUrl: x.t.streamUrl,
	}));
	const topTrack = topTracks[0] ?? null;
	const topArtists = [...artistAgg.entries()]
		.sort((a, b) => b[1].plays - a[1].plays).slice(0, 5)
		.map(([name, v]) => ({ name, plays: v.plays, trackCount: v.tracks.size }));
	const topAlbums = [...albumAgg.entries()]
		.sort((a, b) => b[1].plays - a[1].plays).slice(0, 5)
		.map(([key, v]) => ({ name: key.split("\0")[0], artist: v.artist, plays: v.plays }));
	const topGenres = [...genreAgg.entries()]
		.sort((a, b) => b[1] - a[1]).slice(0, 5)
		.map(([name, plays]) => ({ name, plays }));
	const vibe = pickVibe(rng, topGenres.map((g) => g.name));

	return {
		year, seed: year * 2654435761, totalSeconds, totalPlays,
		uniqueTracks: trackPlays.length, uniqueArtists: artistAgg.size,
		uniqueAlbums: albumAgg.size, uniqueGenres: genreAgg.size,
		librarySize: library.length, oldestYear, newestYear,
		topTrack, topTracks, topArtists, topAlbums, topGenres,
		vibe, palette: pick(rng, PALETTES), particleStyle: pick(rng, PARTICLE_STYLES),
	};
}

// ===== Custom cursor =====

class SparkleCursor {
	private el: HTMLDivElement;
	private trail: HTMLDivElement[] = [];
	private trailSize = 6;
	private mouse = { x: -100, y: -100 };
	private trailPositions: { x: number; y: number }[] = [];

	constructor() {
		this.el = document.createElement("div");
		this.el.className = "ec-cursor";
		document.body.appendChild(this.el);

		for (let i = 0; i < this.trailSize; i++) {
			const d = document.createElement("div");
			d.className = "ec-cursor-trail";
			Object.assign(d.style, { width: `${10 - i}px`, height: `${10 - i}px`, opacity: `${0.5 - i * 0.07}` });
			document.body.appendChild(d);
			this.trail.push(d);
			this.trailPositions.push({ x: -100, y: -100 });
		}
		document.addEventListener("mousemove", (e) => {
			this.mouse.x = e.clientX;
			this.mouse.y = e.clientY;
		});
	}

	update() {
		this.el.style.transform = `translate(${this.mouse.x - 4}px, ${this.mouse.y - 4}px)`;
		this.trailPositions.unshift({ x: this.mouse.x, y: this.mouse.y });
		this.trailPositions.pop();
		for (let i = 0; i < this.trail.length; i++) {
			const p = this.trailPositions[i];
			this.trail[i].style.transform = `translate(${p.x - 5}px, ${p.y - 5}px)`;
		}
	}

	destroy() {
		this.el.remove();
		for (const d of this.trail) d.remove();
	}
}

// ===== Decorative floating notes =====

class FloatingNotes {
	private el: HTMLElement;
	private notes: { el: HTMLElement; x: number; y: number; vy: number; vx: number; rot: number; vrot: number; life: number }[] = [];
	private raf: number | null = null;

	constructor(parent: HTMLElement) {
		this.el = document.createElement("div");
		this.el.className = "ec-notes-layer";
		parent.appendChild(this.el);

		const symbols = ["♪", "♫", "♬", "✦", "♩", "·"];
		for (let i = 0; i < 30; i++) {
			const d = document.createElement("div");
			d.className = "ec-note";
			d.textContent = symbols[Math.floor(Math.random() * symbols.length)];
			this.el.appendChild(d);
			this.notes.push({ el: d, x: Math.random() * 100, y: Math.random() * 100, vy: -0.02 - Math.random() * 0.06, vx: (Math.random() - 0.5) * 0.04, rot: 0, vrot: (Math.random() - 0.5) * 0.3, life: Math.random() });
			Object.assign(d.style, { left: `${this.notes[i].x}%`, top: `${this.notes[i].y}%` });
		}

		const tick = () => {
			for (const n of this.notes) {
				n.y += n.vy;
				n.x += n.vx;
				n.rot += n.vrot;
				n.life += 0.002;
				if (n.y < -5 || n.y > 105 || n.life > 1.2) {
					n.y = 100 + Math.random() * 5;
					n.x = Math.random() * 100;
					n.life = 0;
					n.vy = -0.02 - Math.random() * 0.06;
					n.vx = (Math.random() - 0.5) * 0.04;
				}
				n.el.style.transform = `translate(calc(${n.x}vw - 50%), calc(${n.y}vh - 50%)) rotate(${n.rot}rad)`;
				n.el.style.opacity = String(0.08 + Math.sin(n.life * Math.PI) * 0.12);
			}
			this.raf = requestAnimationFrame(tick);
		};
		this.raf = requestAnimationFrame(tick);
	}

	destroy() {
		if (this.raf) cancelAnimationFrame(this.raf);
		this.el.remove();
	}
}

// ===== Now-playing info bar =====

class NowPlayingBar {
	private el: HTMLElement;
	private interval: ReturnType<typeof setInterval> | null = null;

	constructor(parent: HTMLElement, topTrack: EchoesData["topTrack"], palette: Palette) {
		const el = document.createElement("div");
		el.className = "ec-np-bar";
		el.innerHTML = topTrack
			? `
				<div class="ec-np-inner">
					<div class="ec-np-label">Your anthem of the year</div>
					<div class="ec-np-title">${escapeHtml(topTrack.title)}</div>
					<div class="ec-np-artist">${escapeHtml(topTrack.artist)} · ${topTrack.plays.toLocaleString()} plays</div>
				</div>
				<div class="ec-np-ring">
					<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="17" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="2"/><circle id="ec-np-ring-fill" cx="20" cy="20" r="17" fill="none" stroke="rgba(${palette.a}, 0.8)" stroke-width="2" stroke-linecap="round" stroke-dasharray="106.8" stroke-dashoffset="106.8" transform="rotate(-90 20 20)"/></svg>
				</div>
			`
			: `<div class="ec-np-inner"><div class="ec-np-label">No anthems yet — play some music</div></div>`;
		parent.appendChild(el);
		this.el = el;
		if (topTrack) {
			let p = 0;
			this.interval = setInterval(() => {
				p = (p + 0.3) % 100;
				(el.querySelector("#ec-np-ring-fill") as SVGElement)?.setAttribute("stroke-dashoffset", String(106.8 * (1 - p / 100)));
			}, 50);
		}
	}

	destroy() {
		if (this.interval) clearInterval(this.interval);
		this.el.remove();
	}
}

// ===== Particle field =====

type Particle = {
	x: number; y: number; vx: number; vy: number; size: number;
	rot: number; vrot: number; hue: number; life: number;
	kind: "drift" | "confetti" | "spark";
};

class ParticleField {
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private raf: number | null = null;
	private particles: Particle[] = [];
	private style: ParticleStyle;
	private palette: Palette;
	private rng: () => number;
	private lastT = 0;
	private intensity = 1;
	private dpr = 1;
	private cssW = 0;
	private cssH = 0;
	private resizeHandler: () => void;

	constructor(canvas: HTMLCanvasElement, style: ParticleStyle, palette: Palette, seed: number) {
		this.canvas = canvas;
		this.ctx = canvas.getContext("2d", { alpha: true })!;
		this.style = style;
		this.palette = palette;
		this.rng = makeRng(seed);
		this.resize();
		this.resizeHandler = () => this.resize();
		window.addEventListener("resize", this.resizeHandler);
		for (let i = 0; i < 60; i++) this.spawn(true);
	}

	private resize() {
		this.dpr = Math.min(window.devicePixelRatio || 1, 2);
		const rect = this.canvas.getBoundingClientRect();
		this.cssW = rect.width;
		this.cssH = rect.height;
		this.canvas.width = Math.floor(rect.width * this.dpr);
		this.canvas.height = Math.floor(rect.height * this.dpr);
		this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
	}

	setIntensity(n: number) { this.intensity = n; }

	burst() {
		const cx = this.cssW / 2, cy = this.cssH / 2;
		for (let i = 0; i < 80; i++) {
			const angle = (i / 80) * Math.PI * 2 + this.rng() * 0.4;
			const speed = 100 + this.rng() * 350;
			this.particles.push({
				x: cx + (this.rng() - 0.5) * 100,
				y: cy + (this.rng() - 0.5) * 100,
				vx: Math.cos(angle) * speed,
				vy: Math.sin(angle) * speed - 60,
				size: 6 + this.rng() * 22,
				rot: this.rng() * Math.PI * 2,
				vrot: (this.rng() - 0.5) * 8,
				hue: this.rng(),
				life: 0,
				kind: this.rng() < 0.3 ? "spark" : "confetti",
			});
		}
	}

	private spawn(prefill = false) {
		const rng = this.rng;
		const x = rng() * this.cssW;
		const y = prefill ? rng() * this.cssH : this.cssH + 30;
		this.particles.push({
			x, y, vx: (rng() - 0.5) * 24, vy: -(20 + rng() * 75),
			size: 3 + rng() * 30, rot: rng() * Math.PI * 2,
			vrot: (rng() - 0.5) * 0.9, hue: rng(),
			life: prefill ? rng() : 0, kind: "drift",
		});
	}

	start() {
		if (this.raf !== null) return;
		this.lastT = performance.now();
		const tick = (t: number) => {
			this.raf = requestAnimationFrame(tick);
			const dt = Math.min(0.05, (t - this.lastT) / 1000);
			this.lastT = t;
			this.step(dt);
			this.draw();
		};
		this.raf = requestAnimationFrame(tick);
	}

	stop() { if (this.raf !== null) { cancelAnimationFrame(this.raf); this.raf = null; } }
	destroy() { this.stop(); window.removeEventListener("resize", this.resizeHandler); }

	private step(dt: number) {
		const rate = 18 * this.intensity;
		const spawns = Math.floor(rate * dt) + (this.rng() < (rate * dt) % 1 ? 1 : 0);
		for (let i = 0; i < spawns; i++) this.spawn();
		for (const p of this.particles) {
			p.x += p.vx * dt;
			p.y += p.vy * dt;
			p.rot += p.vrot * dt;
			if (p.kind === "drift") {
				p.life += dt * 0.09;
				p.vx += Math.sin((p.y + p.hue * 800) * 0.004) * 5 * dt;
				p.vy -= 6 * dt;
			} else if (p.kind === "spark") {
				p.life += dt * 0.7;
				p.size *= 1 - dt * 0.5;
				p.vy += 150 * dt;
				p.vx *= 0.98;
				p.vrot *= 0.95;
			} else {
				p.life += dt * 0.5;
				p.vy += 180 * dt;
				p.vx *= 0.995;
				p.vrot *= 0.97;
			}
		}
		this.particles = this.particles.filter((p) =>
			p.kind === "drift" ? (p.y > -80 && p.life < 1.6) : (p.life < 1.25));
	}

	private draw() {
		const ctx = this.ctx, w = this.cssW, h = this.cssH;
		ctx.clearRect(0, 0, w, h);
		ctx.globalCompositeOperation = "lighter";
		for (const p of this.particles) {
			const fade = p.kind === "drift"
				? (p.life < 0.12 ? p.life / 0.12 : 1 - Math.max(0, p.life - 0.88) / 0.52)
				: Math.sin(p.life * Math.PI);
			if (fade <= 0.01) continue;
			const rgb = p.hue < 0.4 ? this.palette.a : (p.hue < 0.72 ? this.palette.b : this.palette.c);
			const alpha = p.kind === "drift" ? fade * 0.5 : (p.kind === "spark" ? fade * 0.95 : fade * 0.8);
			ctx.fillStyle = `rgba(${rgb}, ${alpha})`;
			ctx.strokeStyle = `rgba(${rgb}, ${alpha * 0.7})`;
			ctx.lineWidth = p.kind === "spark" ? 1.5 : (p.kind === "confetti" ? 2.2 : 1.6);
			ctx.save();
			ctx.translate(p.x, p.y); ctx.rotate(p.rot);
			ctx.shadowBlur = p.kind === "spark" ? 28 : (p.kind === "confetti" ? 18 : 8);
			ctx.shadowColor = `rgba(${rgb}, ${alpha})`;
			this.drawShape(p);
			ctx.shadowBlur = 0;
			ctx.restore();
		}
		ctx.globalCompositeOperation = "source-over";
	}

	private drawShape(p: Particle) {
		const ctx = this.ctx, s = p.size;
		switch (this.style) {
			case "orbs": ctx.beginPath(); ctx.arc(0, 0, s * 0.5, 0, Math.PI * 2); ctx.fill(); break;
			case "triangles": { ctx.beginPath(); const r = s * 0.55; ctx.moveTo(0, -r); ctx.lineTo(r * 0.866, r * 0.5); ctx.lineTo(-r * 0.866, r * 0.5); ctx.closePath(); ctx.fill(); break; }
			case "hexagons": { ctx.beginPath(); const r2 = s * 0.55; for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2, px = Math.cos(a) * r2, py = Math.sin(a) * r2; i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); } ctx.closePath(); ctx.stroke(); break; }
			case "stars": { ctx.beginPath(); const o = s * 0.55, inn = o * 0.42; for (let i = 0; i < 10; i++) { const a = (i / 10) * Math.PI * 2 - Math.PI / 2; const r3 = i % 2 === 0 ? o : inn; const px = Math.cos(a) * r3, py = Math.sin(a) * r3; i === 0 ? ctx.moveTo(px, py) : ctx.lineTo(px, py); } ctx.closePath(); ctx.fill(); break; }
			case "ribbons": { const len = s * 2.6; ctx.lineWidth = Math.max(1.5, s * 0.18); ctx.lineCap = "round"; ctx.beginPath(); ctx.moveTo(-len / 2, 0); ctx.quadraticCurveTo(0, -len * 0.35, len / 2, 0); ctx.stroke(); break; }
		}
	}
}

// ===== Helpers =====

function fmtMinutes(secs: number): string {
	const m = Math.round(secs / 60);
	if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
	const h = Math.round(m / 6) / 10;
	return `${h} hour${h === 1 ? "" : "s"}`;
}

// ===== The Player =====

export class Echoes {
	private root: HTMLElement;
	private field: ParticleField;
	private synth: AmbientSynth;
	private cursor: SparkleCursor;
	private notes: FloatingNotes;
	private npBar: NowPlayingBar;
	private data: EchoesData;
	private hooks: EchoesHooks;
	private slideIndex = -1;
	private wheelLock = 0;
	private keyHandler: (e: KeyboardEvent) => void;
	private slideWrap: HTMLElement;
	private progressBar: HTMLElement;
	private hintEl: HTMLElement;
	private countUpRaf: number | null = null;
	private cursorRaf: number | null = null;

	constructor(data: EchoesData, hooks: EchoesHooks) {
		this.data = data;
		this.hooks = hooks;

		const root = document.createElement("div");
		root.id = "echoes-root";
		root.className = "ec-root";
		root.style.setProperty("--ec-bg", data.palette.bg);
		root.style.setProperty("--ec-grad-a", `rgb(${data.palette.a})`);
		root.style.setProperty("--ec-grad-b", `rgb(${data.palette.b})`);
		root.style.setProperty("--ec-grad-c", `rgb(${data.palette.c})`);
		root.innerHTML = `
			<canvas id="ec-canvas" class="ec-canvas"></canvas>
			<div class="ec-vignette"></div>
			<div class="ec-scanline"></div>
			<button class="ec-close" aria-label="Close">×</button>
			<div class="ec-progress-bar" id="ec-progress-bar"></div>
			<div class="ec-hint" id="ec-hint">Click or scroll to continue</div>
			<div class="ec-slide-stage"><div class="ec-slide-wrap" id="ec-slide-wrap"></div></div>
		`;
		document.body.appendChild(root);
		this.root = root;
		this.slideWrap = root.querySelector("#ec-slide-wrap")!;
		this.progressBar = root.querySelector("#ec-progress-bar")!;
		this.hintEl = root.querySelector("#ec-hint")!;

		const canvas = root.querySelector("#ec-canvas") as HTMLCanvasElement;
		this.field = new ParticleField(canvas, data.particleStyle, data.palette, data.seed);
		this.field.start();

		this.synth = new AmbientSynth(data.palette);
		this.cursor = new SparkleCursor();
		this.notes = new FloatingNotes(root);
		this.npBar = new NowPlayingBar(root, data.topTrack, data.palette);

		// Cursor update loop
		const cursorTick = () => { this.cursor.update(); this.cursorRaf = requestAnimationFrame(cursorTick); };
		this.cursorRaf = requestAnimationFrame(cursorTick);

		// Events
		root.querySelector(".ec-close")?.addEventListener("click", () => this.close());
		root.addEventListener("click", (e) => {
			if ((e.target as HTMLElement).closest(".ec-close")) return;
			this.next();
		});
		root.addEventListener("wheel", (e) => {
			const now = performance.now();
			if (now - this.wheelLock < 600) return;
			this.wheelLock = now;
			e.deltaY > 0 ? this.next() : this.prev();
		}, { passive: true });
		this.keyHandler = (e) => {
			if (e.key === "Escape") this.close();
			else if (e.key === "ArrowRight" || e.key === " " || e.key === "Enter") this.next();
			else if (e.key === "ArrowLeft") this.prev();
		};
		window.addEventListener("keydown", this.keyHandler);

		requestAnimationFrame(() => {
			root.classList.add("ec-in");
			this.next();
		});
		hooks.onPause();
	}

	private get totalSlides() { return SLIDES.length; }

	private render() {
		const slide = SLIDES[this.slideIndex];
		this.field.setIntensity(slide.intensity ?? 1);

		// Progress dots
		this.progressBar.innerHTML = SLIDES.map((_, i) =>
			`<span class="ec-prog-dot ${i < this.slideIndex ? "done" : i === this.slideIndex ? "active" : ""}"></span>`,
		).join("");

		// Hint text
		this.hintEl.textContent = this.slideIndex >= this.totalSlides - 1
			? "Click to close  ✦  Thanks for the year"
			: "Click or scroll to continue";

		// Slide content
		const incoming = document.createElement("div");
		incoming.className = "ec-slide ec-slide-enter";
		incoming.innerHTML = slide.render(this.data);
		this.slideWrap.appendChild(incoming);

		const prev = this.slideWrap.querySelector(".ec-slide-active");
		if (prev) {
			prev.classList.remove("ec-slide-active");
			prev.classList.add("ec-slide-exit");
			setTimeout(() => prev.remove(), 500);
		}
		requestAnimationFrame(() => {
			incoming.classList.remove("ec-slide-enter");
			incoming.classList.add("ec-slide-active");
		});

		if (slide.animateCounters) this.animateCounters(incoming);
		if (this.slideIndex === this.totalSlides - 1) {
			setTimeout(() => this.field.burst(), 400);
			setTimeout(() => this.field.burst(), 1100);
			setTimeout(() => this.field.burst(), 2000);
		}
	}

	private animateCounters(el: HTMLElement) {
		if (this.countUpRaf) cancelAnimationFrame(this.countUpRaf);
		const numbers = el.querySelectorAll<HTMLElement>("[data-count]");
		const start = performance.now();
		const tick = (t: number) => {
			const p = Math.min(1, (t - start) / 1800);
			const eased = 1 - Math.pow(1 - p, 3);
			for (const n of numbers) {
				const target = parseInt(n.dataset.count!, 10);
				n.textContent = Math.round(target * eased).toLocaleString();
			}
			if (p < 1) this.countUpRaf = requestAnimationFrame(tick);
		};
		this.countUpRaf = requestAnimationFrame(tick);
	}

	private next() {
		if (this.slideIndex >= this.totalSlides - 1) { this.close(); return; }
		this.slideIndex++;
		this.render();
	}
	private prev() {
		if (this.slideIndex <= 0) return;
		this.slideIndex--;
		this.render();
	}

	close() {
		window.removeEventListener("keydown", this.keyHandler);
		if (this.countUpRaf) cancelAnimationFrame(this.countUpRaf);
		if (this.cursorRaf) cancelAnimationFrame(this.cursorRaf);
		this.field.setIntensity(2.5);
		this.field.burst();
		this.root.classList.add("ec-out");
		setTimeout(() => {
			this.field.destroy();
			this.synth.destroy();
			this.cursor.destroy();
			this.notes.destroy();
			this.npBar.destroy();
			this.root.remove();
			this.hooks.onClose();
		}, 500);
	}
}

// ===== Slide definitions =====

type Slide = { render: (d: EchoesData) => string; intensity?: number; animateCounters?: boolean };

const SLIDES: Slide[] = [
	{
		render: (d) => `
			<div class="ec-center">
				<div class="ec-logo">✦ LAKKY · ECHOES ✦</div>
				<div class="ec-year-reveal"><span>${d.year}</span></div>
				<div class="ec-tagline ec-tagline-glow">Your year in sound</div>
				<div class="ec-sub-hint">Click anywhere to begin</div>
			</div>
		`,
		intensity: 1.8,
	},
	{
		render: (d) => {
			const hrs = Math.max(0, Math.round(d.totalSeconds / 36) / 100);
			const val = d.totalSeconds >= 3600 ? hrs : Math.round(d.totalSeconds / 60);
			const unit = d.totalSeconds >= 3600 ? (hrs < 1 ? "hour" : "hours") : (val < 1 ? "minute" : "minutes");
			return `
				<div class="ec-center">
					<div class="ec-eyebrow">YOU SPENT</div>
					<div class="ec-mega" data-count="${val}">0</div>
					<div class="ec-tagline">${escapeHtml(unit)} listening</div>
					<div class="ec-small">${fmtMinutes(d.totalSeconds)} — ${d.totalPlays.toLocaleString()} plays total</div>
				</div>
			`;
		},
		intensity: 2.6,
		animateCounters: true,
	},
	{
		render: (d) => {
			if (!d.topTrack) return blankSlide("No track stood out", "Play something to seed next year's Echoes.");
			return `
				<div class="ec-center">
					<div class="ec-eyebrow">YOUR ANTHEM</div>
					<div class="ec-hero-card">
						<div class="ec-hero-art">
							${d.topTrack.artUrl ? `<img src="${escapeHtml(d.topTrack.artUrl)}" alt="">` : '<div class="ec-hero-art-empty">♪</div>'}
						</div>
						<div class="ec-hero-info">
							<div class="ec-hero-title">${escapeHtml(d.topTrack.title)}</div>
							<div class="ec-hero-artist">${escapeHtml(d.topTrack.artist)}</div>
							<div class="ec-hero-plays">${d.topTrack.plays.toLocaleString()} plays</div>
						</div>
					</div>
				</div>
			`;
		},
		intensity: 1.3,
	},
	{
		render: (d) => {
			if (d.topArtists.length === 0) return blankSlide("No top artists", "Listen to more music to populate this slide next year.");
			return `
				<div class="ec-side">
					<div class="ec-eyebrow">TOP ARTISTS</div>
					<div class="ec-tagline ec-tagline-lg">${escapeHtml(d.topArtists[0].name)}</div>
					<div class="ec-small">${d.topArtists[0].plays.toLocaleString()} plays across ${d.topArtists[0].trackCount} tracks</div>
					<ol class="ec-list">${d.topArtists.map((a, i) => `
						<li class="ec-list-row" style="--i:${i}">
							<span class="ec-list-rank">${i + 1}</span>
							<span class="ec-list-name">${escapeHtml(a.name)}</span>
							<span class="ec-list-meta">${a.plays.toLocaleString()} plays</span>
						</li>
					`).join("")}</ol>
				</div>
			`;
		},
		intensity: 1.1,
	},
	{
		render: (d) => {
			if (d.topAlbums.length === 0) return blankSlide("No top albums", "Tag your library and spin full albums.");
			return `
				<div class="ec-side">
					<div class="ec-eyebrow">ALBUMS ON REPEAT</div>
					<div class="ec-tagline ec-tagline-lg">${escapeHtml(d.topAlbums[0].name)}</div>
					<div class="ec-small">by ${escapeHtml(d.topAlbums[0].artist)}</div>
					<ol class="ec-list">${d.topAlbums.map((a, i) => `
						<li class="ec-list-row" style="--i:${i}">
							<span class="ec-list-rank">${i + 1}</span>
							<span class="ec-list-name">${escapeHtml(a.name)}<span class="ec-list-sub">${escapeHtml(a.artist)}</span></span>
							<span class="ec-list-meta">${a.plays.toLocaleString()}</span>
						</li>
					`).join("")}</ol>
				</div>
			`;
		},
		intensity: 1.1,
	},
	{
		render: (d) => {
			if (d.topTracks.length === 0) return blankSlide("No tracks", "");
			return `
				<div class="ec-side">
					<div class="ec-eyebrow">YOUR TOP FIVE</div>
					<div class="ec-tagline">The tracks that defined ${d.year}</div>
					<ol class="ec-list">${d.topTracks.map((t, i) => `
						<li class="ec-list-row" style="--i:${i}">
							<span class="ec-list-rank">${i + 1}</span>
							<span class="ec-list-name">${escapeHtml(t.title)}<span class="ec-list-sub">${escapeHtml(t.artist)}</span></span>
							<span class="ec-list-meta">${t.plays.toLocaleString()}</span>
						</li>
					`).join("")}</ol>
				</div>
			`;
		},
	},
	{
		render: (d) => `
			<div class="ec-center">
				<div class="ec-eyebrow">BY THE NUMBERS</div>
				<div class="ec-grid">
					<div class="ec-grid-cell"><div class="ec-grid-n" data-count="${d.uniqueTracks}">0</div><div class="ec-grid-l">tracks played</div></div>
					<div class="ec-grid-cell"><div class="ec-grid-n" data-count="${d.uniqueArtists}">0</div><div class="ec-grid-l">unique artists</div></div>
					<div class="ec-grid-cell"><div class="ec-grid-n" data-count="${d.uniqueAlbums}">0</div><div class="ec-grid-l">albums</div></div>
					<div class="ec-grid-cell"><div class="ec-grid-n" data-count="${d.uniqueGenres}">0</div><div class="ec-grid-l">genres</div></div>
					<div class="ec-grid-cell"><div class="ec-grid-n" data-count="${d.totalPlays}">0</div><div class="ec-grid-l">total plays</div></div>
					<div class="ec-grid-cell"><div class="ec-grid-n" data-count="${d.librarySize}">0</div><div class="ec-grid-l">in library</div></div>
				</div>
			</div>
		`,
		intensity: 1.8,
		animateCounters: true,
	},
	{
		render: (d) => `
			<div class="ec-center">
				<div class="ec-eyebrow">YOUR SOUND PERSONALITY</div>
				<div class="ec-vibe-name">${escapeHtml(d.vibe.name)}</div>
				<div class="ec-vibe-desc">${escapeHtml(d.vibe.description)}</div>
				<div class="ec-outro">Thanks for spending ${d.year} with Lakky.<br>Here's to ${d.year + 1}.</div>
			</div>
		`,
		intensity: 2.2,
	},
];

function blankSlide(title: string, body: string): string {
	return `
		<div class="ec-center">
			<div class="ec-eyebrow">${escapeHtml(title)}</div>
			<div class="ec-small">${escapeHtml(body)}</div>
		</div>
	`;
}
