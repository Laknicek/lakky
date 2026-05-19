import "./style.css";
import Electrobun, { Electroview } from "electrobun/view";
import type { PlayerRPC, ExternalCommand } from "../shared/rpcSchema";
import { installTooltips } from "./tooltip";

const rpc = Electroview.defineRPC<PlayerRPC>({
	maxRequestTime: 5000,
	handlers: {
		requests: {},
		messages: {
			scanProgress: () => {},
			copyProgress: () => {},
			discordStatusChanged: () => {},
			windowStateChanged: () => {},
			externalCommand: () => {},
			requestStatePush: () => {},
		},
	},
});
const eb = new Electrobun.Electroview({ rpc });
const bun = () => eb.rpc!.request;

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
	document.getElementById(id) as T;

const playIcon = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>`;
const pauseIcon = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>`;
const repeatIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"/></svg>`;
const repeatOneIcon = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"/><text x="9" y="16" font-size="9" font-weight="bold" fill="currentColor" stroke="none">1</text></svg>`;

function fmt(s: number): string {
	if (!Number.isFinite(s)) return "0:00";
	const m = Math.floor(s / 60);
	const sec = Math.floor(s % 60);
	return `${m}:${sec.toString().padStart(2, "0")}`;
}

async function refresh() {
	try {
		const r = await bun().getSharedPlayerState({});
		const s = r.state;
		if (!s) {
			$("mini-title").textContent = "Nothing playing";
			$("mini-sub").textContent = "—";
			$("mini-art").innerHTML = "";
			$("mini-cur").textContent = "0:00";
			$("mini-dur").textContent = "0:00";
			$("mini-fill").style.width = "0";
			$("mini-play").innerHTML = playIcon;
			return;
		}
		const t = s.track;
		if (t) {
			$("mini-title").textContent = t.title;
			$("mini-sub").textContent = `${t.artist}${t.album ? " — " + t.album : ""}`;
			$("mini-art").innerHTML = t.artUrl ? `<img src="${t.artUrl}">` : "";
			$("mini-dur").textContent = fmt(t.duration);
			$("mini-fill").style.width = t.duration > 0
				? `${Math.min(100, (s.currentTime / t.duration) * 100)}%`
				: "0";
		} else {
			$("mini-title").textContent = "Nothing playing";
			$("mini-sub").textContent = "—";
			$("mini-art").innerHTML = "";
			$("mini-dur").textContent = "0:00";
			$("mini-fill").style.width = "0";
		}
		$("mini-cur").textContent = fmt(s.currentTime);
		$("mini-play").innerHTML = s.paused ? playIcon : pauseIcon;
		$("mini-art").classList.toggle("playing", !s.paused && !!t);
		// Keep the volume slider in sync, but don't fight the user while
		// they're actively dragging.
		if (document.activeElement !== miniVol) {
			const target = Math.round((s.volume ?? 1) * 100);
			if (parseInt(miniVol.value, 10) !== target) {
				miniVol.value = String(target);
				syncMiniVolFill(miniVol);
			}
		}
		$("mini-shuffle").classList.toggle("active", !!s.shuffle);
		// SharedPlayerState doesn't carry smartShuffle today; the mini
		// inherits the same boolean via the click handler if you toggle
		// shuffle here while smart is enabled in Settings. For now we
		// just style it like the main window's shuffle button.
		$("mini-repeat").classList.toggle("active", s.repeat !== "off");
		$("mini-shuffle").setAttribute("title", s.shuffle ? "Shuffle on" : "Shuffle off");
		$("mini-repeat").setAttribute("title", s.repeat === "one" ? "Repeat one track" : s.repeat === "all" ? "Repeat queue" : "Repeat off");
		$("mini-repeat").innerHTML = s.repeat === "one" ? repeatOneIcon : repeatIcon;
	} catch {
		// renderer hasn't published yet — try again next tick
	}
}

function dispatch(action: ExternalCommand, value?: number | string) {
	bun().dispatchCommand({ action, value }).catch(() => {});
}

$("mini-prev").addEventListener("click", () => dispatch("previous"));
$("mini-next").addEventListener("click", () => dispatch("next"));
$("mini-play").addEventListener("click", () => dispatch("toggle"));
$("mini-shuffle").addEventListener("click", () => dispatch("shuffle"));
$("mini-repeat").addEventListener("click", () => dispatch("repeat"));
$("mini-restore").addEventListener("click", () => bun().closeMiniPlayer({}));

// Volume slider: dispatch fractional volume (0..1) to the player while the
// user drags. The main window owns the canonical volume; we just update
// the visual fill until the next poll arrives.
const miniVol = $<HTMLInputElement>("mini-volume");
function syncMiniVolFill(el: HTMLInputElement) {
	const min = parseFloat(el.min || "0");
	const max = parseFloat(el.max || "100");
	const v = parseFloat(el.value);
	const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
	el.style.setProperty("--fill", `${pct}%`);
}
syncMiniVolFill(miniVol);
miniVol.addEventListener("input", () => {
	const v = parseInt(miniVol.value, 10) / 100;
	syncMiniVolFill(miniVol);
	dispatch("volume", v);
});

// Equalizer shortcut: there's no RPC today that restores the main window
// AND navigates to a specific view, so we just bring the main window back
// and close the mini. The user lands on whatever view the main was last
// showing; they can click Equalizer in the sidebar from there.
// NOTE: a future `openMainOnView({ view: "equalizer" })` RPC would let us
// jump straight to the equalizer.
$("mini-eq").addEventListener("click", async () => {
	try { await bun().closeMiniPlayer({}); } catch {}
});

// Send-to-tray: close mini first so the main window doesn't pop back up,
// then hide everything to the system tray.
$("mini-tray").addEventListener("click", async () => {
	try { await bun().closeMiniPlayer({}); } catch {}
	try { await bun().sendToTray({}); } catch {}
});

// Manual window-drag for the frameless titlebar. WebView2 doesn't honor
// -webkit-app-region, so we shuttle screen-cursor deltas into the mini
// window's setPosition over RPC, throttled to one update per animation
// frame.
{
	const titlebar = document.querySelector(".mini-titlebar") as HTMLElement;
	let dragging = false;
	let startScreenX = 0;
	let startScreenY = 0;
	let startWinX = 0;
	let startWinY = 0;
	let queuedX: number | null = null;
	let queuedY: number | null = null;
	let rafScheduled = false;

	const flush = () => {
		rafScheduled = false;
		if (queuedX === null || queuedY === null) return;
		const x = queuedX;
		const y = queuedY;
		queuedX = null;
		queuedY = null;
		bun().windowSetPosition({ x, y, which: "mini" }).catch(() => {});
	};

	titlebar.addEventListener("mousedown", async (e) => {
		if (e.button !== 0) return;
		if ((e.target as HTMLElement).closest(".mini-restore, button")) return;
		dragging = true;
		startScreenX = e.screenX;
		startScreenY = e.screenY;
		try {
			const p = await bun().windowGetPosition({ which: "mini" });
			startWinX = p.x;
			startWinY = p.y;
		} catch {
			dragging = false;
		}
	});

	window.addEventListener("mousemove", (e) => {
		if (!dragging) return;
		const dx = e.screenX - startScreenX;
		const dy = e.screenY - startScreenY;
		queuedX = startWinX + dx;
		queuedY = startWinY + dy;
		if (!rafScheduled) {
			rafScheduled = true;
			requestAnimationFrame(flush);
		}
	});

	window.addEventListener("mouseup", () => {
		dragging = false;
	});
}

$("mini-scrub").addEventListener("click", async (e) => {
	const rect = $("mini-scrub").getBoundingClientRect();
	const ratio = (e.clientX - rect.left) / rect.width;
	const s = (await bun().getSharedPlayerState({})).state;
	if (s?.track?.duration) {
		dispatch("seek", s.track.duration * Math.max(0, Math.min(1, ratio)));
	}
});

setInterval(refresh, 250);
refresh();
installTooltips();
