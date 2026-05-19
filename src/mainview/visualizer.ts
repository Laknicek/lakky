export type VizMode = "bars" | "strip";
export type VizStyle = "bars" | "wave" | "radial" | "mirror";

export class Visualizer {
	private canvas: HTMLCanvasElement;
	private ctx2d: CanvasRenderingContext2D;
	private analyser: AnalyserNode;
	private data: Uint8Array;
	private timeData: Uint8Array;
	private style: VizStyle = "bars";
	private peaks: Float32Array | null = null;
	private smoothed: Float32Array | null = null;
	private running = false;
	private raf: number | null = null;
	private dpr = window.devicePixelRatio || 1;
	private accent: [number, number, number] = [167, 139, 250];
	private mode: VizMode;
	private resizeHandler: () => void;
	private resizeObserver: ResizeObserver;
	private barCount = 0;
	private cssW = 0;
	private cssH = 0;
	// Frame-rate governor. We cap the rAF callback rate so the visualizer
	// doesn't pin the GPU at the full display refresh rate (often 120/144 Hz)
	// when 30 fps already looks perfectly smooth for a music spectrum.
	private maxFps = 30;
	private minFrameMs = 1000 / 30;
	private lastFrameTime = 0;
	private idleEnabled = true;

	constructor(canvas: HTMLCanvasElement, analyser: AnalyserNode, mode: VizMode = "bars", style: VizStyle = "bars") {
		this.style = style;
		this.canvas = canvas;
		this.ctx2d = canvas.getContext("2d", { alpha: true })!;
		this.analyser = analyser;
		// The analyser is owned externally now (one shared node across all
		// engines). We don't mutate fftSize/decibel/smoothing here — that's
		// the audio layer's responsibility. We only read it.
		this.mode = mode;
		this.data = new Uint8Array(this.analyser.frequencyBinCount);
		this.timeData = new Uint8Array(this.analyser.fftSize);
		this.resize();

		this.resizeHandler = () => this.resize();
		window.addEventListener("resize", this.resizeHandler);

		// The canvas often has zero size at construction time (the splash is up,
		// or fonts are still loading). A ResizeObserver catches the very moment
		// it gets a real box and we rebuild the bitmap then.
		this.resizeObserver = new ResizeObserver(() => this.resize());
		this.resizeObserver.observe(this.canvas);

		// If we still don't have a size (e.g. canvas is in a display:none parent),
		// poll briefly until layout settles. Cheap and self-terminating.
		let attempts = 0;
		const poll = () => {
			if (this.cssW > 0 && this.cssH > 0) return;
			if (attempts++ > 40) return;
			this.resize();
			setTimeout(poll, 80);
		};
		poll();

		// Render once so the canvas isn't empty before playback starts.
		this.tickIdle();
	}

	destroy() {
		this.stop();
		window.removeEventListener("resize", this.resizeHandler);
		this.resizeObserver.disconnect();
	}

	setAccent(rgb: [number, number, number]) {
		this.accent = rgb;
	}

	setStyle(style: VizStyle) {
		this.style = style;
	}

	// Hard cap on rAF callbacks per second. 15–60 range. Even 30 fps looks
	// fluid for a spectrum bar; 24 cuts GPU usage roughly in half vs 60.
	setMaxFps(fps: number) {
		this.maxFps = Math.max(15, Math.min(120, fps));
		this.minFrameMs = 1000 / this.maxFps;
	}

	// When false, the gentle paused-state wave doesn't run at all — the
	// visualizer just stops dead while paused. Saves a few % CPU/GPU.
	setIdleEnabled(on: boolean) {
		this.idleEnabled = on;
		if (!on && !this.running) {
			// Cancel any queued idle frame and clear the canvas to a flat state.
			if (this.raf !== null) {
				cancelAnimationFrame(this.raf);
				this.raf = null;
			}
			if (this.cssW > 0 && this.cssH > 0) {
				this.ctx2d.clearRect(0, 0, this.cssW, this.cssH);
			}
		} else if (on && !this.running) {
			this.scheduleNext(this.tickIdle);
		}
	}

	private resize() {
		this.dpr = window.devicePixelRatio || 1;
		const rect = this.canvas.getBoundingClientRect();
		if (rect.width === 0 || rect.height === 0) {
			this.cssW = 0;
			this.cssH = 0;
			return;
		}
		this.cssW = rect.width;
		this.cssH = rect.height;
		const newW = Math.max(1, Math.floor(rect.width * this.dpr));
		const newH = Math.max(1, Math.floor(rect.height * this.dpr));
		if (this.canvas.width !== newW) this.canvas.width = newW;
		if (this.canvas.height !== newH) this.canvas.height = newH;
		this.ctx2d.setTransform(1, 0, 0, 1, 0, 0);
		this.ctx2d.scale(this.dpr, this.dpr);
		// Make sure exactly one loop is active. scheduleNext cancels any
		// stale rAF first so rapid resizes don't pile up parallel chains.
		if (this.running) this.scheduleNext(this.tick);
		else this.scheduleNext(this.tickIdle);
	}

	private ensureBuffers(bars: number) {
		if (this.barCount !== bars) {
			this.barCount = bars;
			this.peaks = new Float32Array(bars);
			this.smoothed = new Float32Array(bars);
		}
	}

	// Invariant: at most one rAF is queued at a time. Every code path that
	// wants to schedule another frame must go through this so we never end
	// up with parallel pulse loops (which was making the idle wave speed up
	// after each fullscreen toggle).
	private scheduleNext(fn: FrameRequestCallback) {
		if (this.raf !== null) cancelAnimationFrame(this.raf);
		this.raf = requestAnimationFrame(fn);
	}

	start() {
		if (this.running) return;
		this.running = true;
		this.scheduleNext(this.tick);
	}

	stop() {
		if (!this.running) return;
		this.running = false;
		// Hand off to the idle animator. scheduleNext cancels the running
		// tick's frame before queueing the idle one.
		this.scheduleNext(this.tickIdle);
	}

	// Bucketing of the FFT bins. Pure log spacing gives every octave the same
	// number of bars, which leaves bass looking thin. We bias the curve with
	// a power so the first ~half of bars cover the bottom 2–3 octaves where
	// kick, bass, and low-mids live.
	private fillBuckets(bars: number, out: Float32Array) {
		const bins = this.data.length;
		const minHz = 22;       // captures sub-bass on most music
		const maxHz = 10000;    // skip the near-silent top octave
		const bassBias = 1.7;   // >1 = more bars at low frequencies
		const nyquist = (this.analyser.context.sampleRate || 44100) / 2;
		for (let i = 0; i < bars; i++) {
			const t0 = Math.pow(i / bars, bassBias);
			const t1 = Math.pow((i + 1) / bars, bassBias);
			const fLo = minHz * Math.pow(maxHz / minHz, t0);
			const fHi = minHz * Math.pow(maxHz / minHz, t1);
			const iLo = Math.max(0, Math.floor((fLo / nyquist) * bins));
			const iHi = Math.min(bins - 1, Math.ceil((fHi / nyquist) * bins));
			// Pick the loudest bin in the range rather than averaging — keeps
			// kick-drum transients visible instead of smearing them down.
			let peak = 0;
			let sum = 0;
			let n = 0;
			for (let k = iLo; k <= iHi; k++) {
				const v = this.data[k];
				if (v > peak) peak = v;
				sum += v;
				n++;
			}
			const avg = n > 0 ? sum / n : 0;
			out[i] = (peak * 0.65 + avg * 0.35) / 255;
		}
	}

	private tick = (now?: number) => {
		this.raf = null;
		if (!this.running) return;
		const t = now ?? performance.now();
		const elapsed = t - this.lastFrameTime;
		if (elapsed < this.minFrameMs - 0.5) {
			// Not enough time has passed — schedule another callback and
			// bail without sampling the analyser or drawing.
			this.scheduleNext(this.tick);
			return;
		}
		// Real elapsed seconds since the last *drawn* frame. Smoothing,
		// peak fall, and idle phase are all driven off this so the visible
		// motion stays the same whether we're drawing at 15 fps or 60 fps —
		// lowering maxFps reduces frame count, not animation speed.
		const dtSec = this.lastFrameTime === 0 ? 1 / this.maxFps : Math.min(0.2, elapsed / 1000);
		this.lastFrameTime = t;
		const w = this.cssW;
		const h = this.cssH;
		if (w === 0 || h === 0) {
			this.scheduleNext(this.tick);
			return;
		}
		this.analyser.getByteFrequencyData(this.data as unknown as Uint8Array<ArrayBuffer>);
		const needsTime = this.mode !== "strip" && (this.style === "wave" || this.style === "radial");
		if (needsTime) {
			this.analyser.getByteTimeDomainData(this.timeData as unknown as Uint8Array<ArrayBuffer>);
		}
		const ctx = this.ctx2d;
		ctx.clearRect(0, 0, w, h);

		const isStrip = this.mode === "strip";
		const bars = isStrip
			? Math.max(48, Math.min(220, Math.floor(w / 5)))
			: Math.max(48, Math.min(96, Math.floor(w / 9)));
		this.ensureBuffers(bars);
		const peaks = this.peaks!;
		const smoothed = this.smoothed!;

		const raw = new Float32Array(bars);
		this.fillBuckets(bars, raw);

		// Per-bar gain: heavy bass boost on the first ~30% of bars (rolling
		// off into the mids), gentle treble lift on the top end so cymbals
		// still sparkle without overwhelming the kicks.
		const bassEnd = bars * 0.30;
		// Time-constant smoothing. Attack/release tau in seconds — the bigger
		// tau means slower change. 1 - exp(-dt/tau) gives the per-frame blend
		// factor for any dt, so frame-rate doesn't bend the feel.
		const ATTACK_TAU = 0.035;
		const RELEASE_TAU = 0.18;
		const PEAK_FALL_PER_SEC = 0.72;
		const alphaAttack = 1 - Math.exp(-dtSec / ATTACK_TAU);
		const alphaRelease = 1 - Math.exp(-dtSec / RELEASE_TAU);
		for (let i = 0; i < bars; i++) {
			const bassT = Math.max(0, 1 - i / bassEnd);
			const bassGain = 1 + 0.55 * bassT * bassT;          // up to +55% on the lowest bar
			const trebleGain = 1 + 0.18 * (i / bars);
			let v = Math.pow(raw[i], 1.28) * bassGain * trebleGain;
			v = Math.min(1, v);
			const prev = smoothed[i];
			const a = v > prev ? alphaAttack : alphaRelease;
			smoothed[i] = prev + (v - prev) * a;
			peaks[i] = peaks[i] > smoothed[i]
				? Math.max(smoothed[i], peaks[i] - PEAK_FALL_PER_SEC * dtSec)
				: smoothed[i];
		}

		this.draw(ctx, w, h, bars, smoothed, peaks, isStrip);
		this.scheduleNext(this.tick);
	};

	private tickIdle = (now?: number) => {
		this.raf = null;
		// If we've been upgraded to active playback, let tick take over.
		if (this.running) {
			this.scheduleNext(this.tick);
			return;
		}
		// Honor the battery-saver toggle: stop dead instead of pulsing.
		if (!this.idleEnabled) return;
		// Same fps cap, but at most 24 — idle doesn't need to be smooth.
		const idleMs = Math.max(this.minFrameMs, 1000 / 24);
		const t = now ?? performance.now();
		const elapsed = t - this.lastFrameTime;
		if (elapsed < idleMs - 0.5) {
			this.scheduleNext(this.tickIdle);
			return;
		}
		this.lastFrameTime = t;
		const w = this.cssW;
		const h = this.cssH;
		if (w === 0 || h === 0) {
			this.scheduleNext(this.tickIdle);
			return;
		}
		const ctx = this.ctx2d;
		ctx.clearRect(0, 0, w, h);
		const isStrip = this.mode === "strip";
		const bars = isStrip
			? Math.max(48, Math.min(220, Math.floor(w / 5)))
			: Math.max(48, Math.min(96, Math.floor(w / 9)));
		this.ensureBuffers(bars);
		const smoothed = this.smoothed!;
		const peaks = this.peaks!;
		// Idle phase is driven off wall-clock time, not a frame counter —
		// the pulse keeps the same cadence no matter what fps cap is set.
		const phase = (t / 1000) * 2.4;
		for (let i = 0; i < bars; i++) {
			const t = i / bars;
			const wave =
				0.5 +
				0.34 * Math.sin(phase + t * 5.2) +
				0.18 * Math.sin(phase * 0.7 + t * 11);
			const v = Math.max(0.06, Math.min(0.42, wave * 0.18 + 0.12));
			smoothed[i] = smoothed[i] * 0.85 + v * 0.15;
			peaks[i] = smoothed[i];
		}
		this.draw(ctx, w, h, bars, smoothed, peaks, isStrip, true);
		if (!this.running) this.scheduleNext(this.tickIdle);
	};

	private draw(
		ctx: CanvasRenderingContext2D,
		w: number,
		h: number,
		bars: number,
		smoothed: Float32Array,
		peaks: Float32Array,
		isStrip: boolean,
		idle = false,
	) {
		const [r, g, b] = this.accent;
		const hR = Math.min(255, r + 50);
		const hG = Math.min(255, g + 70);
		const hB = Math.min(255, b + 90);
		const barW = w / bars;

		if (!isStrip) {
			if (this.style === "wave")   { this.drawWave(ctx, w, h, idle); return; }
			if (this.style === "radial") { this.drawRadial(ctx, w, h, bars, smoothed, idle); return; }
			if (this.style === "mirror") { this.drawMirror(ctx, w, h, bars, smoothed, peaks, idle); return; }
			// fallthrough → classic grounded "bars"
		}

		if (isStrip) {
			// Mirrored bars centered vertically.
			for (let i = 0; i < bars; i++) {
				const v = smoothed[i];
				if (v <= 0) continue;
				const barH = Math.max(1.5, v * h * 0.94);
				const x = i * barW + barW * 0.22;
				const bw = barW * 0.56;
				const y = (h - barH) / 2;
				const grad = ctx.createLinearGradient(0, y, 0, y + barH);
				grad.addColorStop(0, `rgba(${hR}, ${hG}, ${hB}, 0.95)`);
				grad.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, 0.95)`);
				grad.addColorStop(1, `rgba(${hR}, ${hG}, ${hB}, 0.95)`);
				ctx.fillStyle = grad;
				ctx.shadowColor = `rgba(${r}, ${g}, ${b}, ${idle ? 0.18 : 0.55})`;
				ctx.shadowBlur = idle ? 6 : 10;
				roundRect(ctx, x, y, bw, barH, Math.min(bw / 2, 2));
				ctx.fill();
			}
			ctx.shadowBlur = 0;
			return;
		}

		// "bars" mode — grounded, with reflection and peak caps.
		const groundY = h * 0.92;
		for (let i = 0; i < bars; i++) {
			const v = smoothed[i];
			const barH = Math.max(2, v * groundY * 0.95);
			const x = i * barW + barW * 0.18;
			const bw = barW * 0.64;
			const radius = Math.min(bw / 2, 5);
			const y = groundY - barH;

			// Reflection (under the ground line)
			const reflectionH = barH * 0.4;
			if (!idle) {
				const grad2 = ctx.createLinearGradient(0, groundY, 0, groundY + reflectionH);
				grad2.addColorStop(0, `rgba(${r}, ${g}, ${b}, 0.28)`);
				grad2.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
				ctx.fillStyle = grad2;
				ctx.beginPath();
				roundRect(ctx, x, groundY, bw, reflectionH, radius);
				ctx.fill();
			}

			// Main bar gradient
			const grad = ctx.createLinearGradient(0, y, 0, groundY);
			grad.addColorStop(0, `rgba(${hR}, ${hG}, ${hB}, 0.98)`);
			grad.addColorStop(0.4, `rgba(${r}, ${g}, ${b}, 0.95)`);
			grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0.55)`);
			ctx.fillStyle = grad;
			ctx.shadowColor = `rgba(${r}, ${g}, ${b}, ${idle ? 0.18 : 0.6})`;
			ctx.shadowBlur = idle ? 6 : 14;
			roundRect(ctx, x, y, bw, barH, radius);
			ctx.fill();

			// Peak cap
			const pv = peaks[i];
			if (pv > 0.04 && !idle) {
				const py = groundY - Math.max(2, pv * groundY * 0.95);
				ctx.shadowBlur = 6;
				ctx.fillStyle = `rgba(255, 255, 255, ${0.55 + pv * 0.3})`;
				roundRect(ctx, x, py - 2, bw, 2, 1);
				ctx.fill();
			}
		}
		ctx.shadowBlur = 0;
	}

	// --- Waveform: oscilloscope-style time-domain line ---
	private drawWave(ctx: CanvasRenderingContext2D, w: number, h: number, idle: boolean) {
		const [r, g, b] = this.accent;
		const hR = Math.min(255, r + 50);
		const hG = Math.min(255, g + 70);
		const hB = Math.min(255, b + 90);
		const td = this.timeData;
		const N = td.length;
		const mid = h / 2;
		const amp = h * 0.42;

		// Soft fill under the curve for depth.
		ctx.beginPath();
		ctx.moveTo(0, mid);
		for (let i = 0; i < N; i++) {
			const x = (i / (N - 1)) * w;
			const v = (td[i] - 128) / 128;
			ctx.lineTo(x, mid + v * amp);
		}
		ctx.lineTo(w, mid);
		ctx.lineTo(0, mid);
		const fillGrad = ctx.createLinearGradient(0, 0, 0, h);
		fillGrad.addColorStop(0, `rgba(${hR}, ${hG}, ${hB}, ${idle ? 0.06 : 0.14})`);
		fillGrad.addColorStop(1, `rgba(${r}, ${g}, ${b}, 0)`);
		ctx.fillStyle = fillGrad;
		ctx.fill();

		// Glowing stroke.
		ctx.beginPath();
		for (let i = 0; i < N; i++) {
			const x = (i / (N - 1)) * w;
			const v = (td[i] - 128) / 128;
			const y = mid + v * amp;
			if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
		}
		ctx.lineWidth = 2;
		ctx.strokeStyle = `rgba(${hR}, ${hG}, ${hB}, ${idle ? 0.55 : 0.95})`;
		ctx.shadowColor = `rgba(${r}, ${g}, ${b}, ${idle ? 0.25 : 0.7})`;
		ctx.shadowBlur = idle ? 6 : 14;
		ctx.stroke();
		ctx.shadowBlur = 0;
	}

	// --- Radial: bars sweeping out of a central ring ---
	private drawRadial(
		ctx: CanvasRenderingContext2D,
		w: number, h: number,
		bars: number,
		smoothed: Float32Array,
		idle: boolean,
	) {
		const [r, g, b] = this.accent;
		const hR = Math.min(255, r + 50);
		const hG = Math.min(255, g + 70);
		const hB = Math.min(255, b + 90);
		const cx = w / 2;
		const cy = h / 2;
		const baseR = Math.min(w, h) * 0.18;
		const maxLen = Math.min(w, h) * 0.36;

		// Center ring
		ctx.beginPath();
		ctx.arc(cx, cy, baseR, 0, Math.PI * 2);
		ctx.strokeStyle = `rgba(${hR}, ${hG}, ${hB}, ${idle ? 0.18 : 0.42})`;
		ctx.lineWidth = 1.5;
		ctx.stroke();

		ctx.lineCap = "round";
		for (let i = 0; i < bars; i++) {
			const a = (i / bars) * Math.PI * 2 - Math.PI / 2;
			const v = smoothed[i];
			const len = baseR + Math.max(2, v * maxLen);
			const x1 = cx + Math.cos(a) * baseR;
			const y1 = cy + Math.sin(a) * baseR;
			const x2 = cx + Math.cos(a) * len;
			const y2 = cy + Math.sin(a) * len;
			const grad = ctx.createLinearGradient(x1, y1, x2, y2);
			grad.addColorStop(0, `rgba(${hR}, ${hG}, ${hB}, ${idle ? 0.55 : 0.95})`);
			grad.addColorStop(1, `rgba(${r}, ${g}, ${b}, ${idle ? 0.2 : 0.55})`);
			ctx.strokeStyle = grad;
			ctx.lineWidth = Math.max(1.5, (Math.PI * 2 * baseR) / bars * 0.55);
			ctx.shadowColor = `rgba(${r}, ${g}, ${b}, ${idle ? 0.18 : 0.55})`;
			ctx.shadowBlur = idle ? 4 : 10;
			ctx.beginPath();
			ctx.moveTo(x1, y1);
			ctx.lineTo(x2, y2);
			ctx.stroke();
		}
		ctx.shadowBlur = 0;
		ctx.lineCap = "butt";
	}

	// --- Mirror: bars growing up and down from the horizontal centerline ---
	private drawMirror(
		ctx: CanvasRenderingContext2D,
		w: number, h: number,
		bars: number,
		smoothed: Float32Array,
		peaks: Float32Array,
		idle: boolean,
	) {
		const [r, g, b] = this.accent;
		const hR = Math.min(255, r + 50);
		const hG = Math.min(255, g + 70);
		const hB = Math.min(255, b + 90);
		const barW = w / bars;
		const mid = h / 2;
		const halfMax = h * 0.46;

		for (let i = 0; i < bars; i++) {
			const v = smoothed[i];
			if (v <= 0) continue;
			const half = Math.max(1.5, v * halfMax);
			const x = i * barW + barW * 0.20;
			const bw = barW * 0.60;
			const y = mid - half;
			const grad = ctx.createLinearGradient(0, y, 0, y + half * 2);
			grad.addColorStop(0, `rgba(${hR}, ${hG}, ${hB}, 0.95)`);
			grad.addColorStop(0.5, `rgba(${r}, ${g}, ${b}, 0.95)`);
			grad.addColorStop(1, `rgba(${hR}, ${hG}, ${hB}, 0.95)`);
			ctx.fillStyle = grad;
			ctx.shadowColor = `rgba(${r}, ${g}, ${b}, ${idle ? 0.18 : 0.55})`;
			ctx.shadowBlur = idle ? 6 : 12;
			roundRect(ctx, x, y, bw, half * 2, Math.min(bw / 2, 3));
			ctx.fill();

			// Peak caps top + bottom
			const pv = peaks[i];
			if (pv > 0.04 && !idle) {
				const ph = Math.max(2, pv * halfMax);
				ctx.shadowBlur = 6;
				ctx.fillStyle = `rgba(255, 255, 255, ${0.55 + pv * 0.3})`;
				roundRect(ctx, x, mid - ph - 1, bw, 2, 1);
				ctx.fill();
				roundRect(ctx, x, mid + ph - 1, bw, 2, 1);
				ctx.fill();
			}
		}
		ctx.shadowBlur = 0;
	}
}

function roundRect(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	w: number,
	h: number,
	r: number,
) {
	const rr = Math.min(r, w / 2, h / 2);
	ctx.beginPath();
	ctx.moveTo(x + rr, y);
	ctx.lineTo(x + w - rr, y);
	ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
	ctx.lineTo(x + w, y + h - rr);
	ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
	ctx.lineTo(x + rr, y + h);
	ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
	ctx.lineTo(x, y + rr);
	ctx.quadraticCurveTo(x, y, x + rr, y);
	ctx.closePath();
}
