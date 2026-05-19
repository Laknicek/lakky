// Synthesized UI SFX via Web Audio API — no asset files needed.

let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let enabled = true;

function ensureCtx(): AudioContext {
	if (!ctx) {
		ctx = new (window.AudioContext || window.webkitAudioContext!)();
		masterGain = ctx.createGain();
		masterGain.gain.value = 0.18;
		masterGain.connect(ctx.destination);
	}
	if (ctx.state === "suspended") ctx.resume().catch(() => {});
	return ctx;
}

export function setSfxEnabled(on: boolean) {
	enabled = on;
}

type ToneOpts = {
	freq: number;
	type?: OscillatorType;
	duration?: number;
	gain?: number;
	attack?: number;
	decay?: number;
	freqEnd?: number;
};

function tone(opts: ToneOpts) {
	if (!enabled) return;
	const ac = ensureCtx();
	const {
		freq,
		type = "sine",
		duration = 0.08,
		gain = 1,
		attack = 0.002,
		decay,
		freqEnd,
	} = opts;
	const now = ac.currentTime;
	const osc = ac.createOscillator();
	const g = ac.createGain();
	osc.type = type;
	osc.frequency.setValueAtTime(freq, now);
	if (freqEnd !== undefined) {
		osc.frequency.exponentialRampToValueAtTime(
			Math.max(20, freqEnd),
			now + duration,
		);
	}
	g.gain.setValueAtTime(0, now);
	g.gain.linearRampToValueAtTime(gain, now + attack);
	g.gain.exponentialRampToValueAtTime(0.0001, now + (decay ?? duration));
	osc.connect(g);
	g.connect(masterGain!);
	osc.start(now);
	osc.stop(now + (decay ?? duration) + 0.02);
}

export const sfx = {
	hover() {
		tone({ freq: 1100, type: "sine", duration: 0.04, gain: 0.25 });
	},
	click() {
		tone({ freq: 740, type: "triangle", duration: 0.06, gain: 0.55, freqEnd: 520 });
	},
	toggle() {
		tone({ freq: 880, type: "square", duration: 0.05, gain: 0.3 });
	},
	play() {
		tone({ freq: 520, type: "sine", duration: 0.08, gain: 0.5, freqEnd: 740 });
		setTimeout(() => tone({ freq: 740, type: "sine", duration: 0.1, gain: 0.4, freqEnd: 880 }), 60);
	},
	pause() {
		tone({ freq: 620, type: "sine", duration: 0.08, gain: 0.4, freqEnd: 420 });
	},
	skip() {
		tone({ freq: 880, type: "triangle", duration: 0.07, gain: 0.45, freqEnd: 1320 });
	},
	error() {
		tone({ freq: 220, type: "sawtooth", duration: 0.12, gain: 0.35, freqEnd: 160 });
	},
	success() {
		tone({ freq: 660, type: "sine", duration: 0.09, gain: 0.4 });
		setTimeout(() => tone({ freq: 990, type: "sine", duration: 0.12, gain: 0.4 }), 80);
	},
	open() {
		tone({ freq: 420, type: "sine", duration: 0.18, gain: 0.4, freqEnd: 880 });
	},
};

export function primeAudio() {
	ensureCtx();
}
