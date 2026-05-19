// Tiny LAN web remote. Spins up a Bun.serve HTTP server with two endpoints
// plus an in-page WebSocket so a phone on the same network can drive
// playback. HTTP-only (LAN) to avoid the self-signed-cert UX disaster.

import { networkInterfaces } from "node:os";
import type { ExternalCommand, SharedPlayerState } from "../shared/rpcSchema";

type Hooks = {
	getState: () => SharedPlayerState | null;
	dispatch: (action: ExternalCommand, value?: number | string) => void;
};

let server: ReturnType<typeof Bun.serve> | null = null;

export function lanIPv4(): string | null {
	const nets = networkInterfaces();
	for (const ifaces of Object.values(nets)) {
		for (const i of ifaces ?? []) {
			if (i.family === "IPv4" && !i.internal) return i.address;
		}
	}
	return null;
}

const REMOTE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover" />
<meta name="theme-color" content="#0a0a14" />
<title>Lakky Remote</title>
<style>
*{box-sizing:border-box;-webkit-tap-highlight-color:transparent;user-select:none}
html,body{margin:0;height:100%;background:#07060d;color:#e8e8f5;font:500 16px/1.4 system-ui,-apple-system,Segoe UI,sans-serif;overflow:hidden}
body{display:flex;flex-direction:column;padding:env(safe-area-inset-top,16px) 18px env(safe-area-inset-bottom,18px)}
.title{font-size:13px;letter-spacing:.14em;text-transform:uppercase;color:rgba(232,232,245,.45);margin:6px 0 18px}
.art{position:relative;width:100%;max-width:340px;aspect-ratio:1/1;border-radius:50%;margin:6px auto 24px;background:linear-gradient(135deg,#1e1a2e,#221033);overflow:hidden;box-shadow:0 30px 80px rgba(0,0,0,.6),inset 0 0 0 8px rgba(0,0,0,.25)}
.art img{width:100%;height:100%;object-fit:cover}
.art::after{content:"";position:absolute;left:50%;top:50%;width:22px;height:22px;border-radius:50%;background:rgba(10,10,20,.85);box-shadow:0 0 0 2px rgba(255,255,255,.15);transform:translate(-50%,-50%)}
.meta{text-align:center;margin-bottom:18px}
.tt{font-size:1.15rem;font-weight:700;letter-spacing:-.02em;margin:0 0 4px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ta{font-size:.92rem;color:rgba(232,232,245,.65);margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.scrub{position:relative;height:6px;background:rgba(255,255,255,.08);border-radius:6px;margin:14px 0 6px}
.fill{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,#a78bfa,#22d3ee);border-radius:6px;width:0}
.times{display:flex;justify-content:space-between;font-size:.78rem;font-variant-numeric:tabular-nums;color:rgba(232,232,245,.55);margin-bottom:14px}
.row{display:flex;justify-content:center;align-items:center;gap:18px;margin:10px 0}
button{font:inherit;color:inherit;background:transparent;border:0;cursor:pointer}
.btn{display:flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;background:rgba(255,255,255,.06);transition:transform .15s ease,background .15s ease}
.btn:active{transform:scale(.92);background:rgba(255,255,255,.12)}
.btn.play{width:72px;height:72px;background:linear-gradient(135deg,#a78bfa,#22d3ee);color:#0a0a14;box-shadow:0 8px 28px rgba(167,139,250,.4)}
.btn svg{width:24px;height:24px}
.btn.play svg{width:30px;height:30px}
.toggles{display:flex;gap:14px;justify-content:center;margin-top:14px}
.tg{padding:.6rem 1.1rem;border-radius:999px;background:rgba(255,255,255,.05);font-size:.78rem;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:rgba(232,232,245,.7)}
.tg.on{background:linear-gradient(135deg,#a78bfa,#22d3ee);color:#0a0a14}
.vol{margin-top:18px;display:flex;align-items:center;gap:10px}
.vol input{flex:1;-webkit-appearance:none;appearance:none;height:6px;background:rgba(255,255,255,.08);border-radius:6px;outline:none}
.vol input::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 0 0 2px #a78bfa}
.foot{margin-top:auto;font-size:.7rem;letter-spacing:.06em;text-transform:uppercase;color:rgba(232,232,245,.35);text-align:center}
</style>
</head>
<body>
<div class="title">Lakky Remote</div>
<div class="art" id="art"></div>
<div class="meta">
  <div class="tt" id="tt">Nothing playing</div>
  <div class="ta" id="ta">—</div>
</div>
<div class="scrub"><div class="fill" id="fill"></div></div>
<div class="times"><span id="cur">0:00</span><span id="dur">0:00</span></div>
<div class="row">
  <button class="btn" data-act="previous"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 6h2v12H6zM9 12l10-7v14z"/></svg></button>
  <button class="btn play" id="play"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></button>
  <button class="btn" data-act="next"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M16 6h2v12h-2zM5 5v14l10-7z"/></svg></button>
</div>
<div class="toggles">
  <button class="tg" id="shf">Shuffle</button>
  <button class="tg" id="rep">Repeat</button>
</div>
<div class="vol">
  <span style="opacity:.6">VOL</span>
  <input type="range" id="vol" min="0" max="100" value="80" />
</div>
<div class="foot">Connected · refreshes 4×/sec</div>
<script>
const fmt = s => { if (!isFinite(s)) return "0:00"; const m = Math.floor(s/60); return m + ":" + String(Math.floor(s%60)).padStart(2,"0"); };
const $ = id => document.getElementById(id);
const playIco = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';
const pauseIco = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>';

async function refresh() {
  try {
    const r = await fetch("/state");
    if (!r.ok) return;
    const s = await r.json();
    if (!s) return;
    const t = s.track;
    if (t) {
      $("tt").textContent = t.title;
      $("ta").textContent = t.artist + " — " + t.album;
      $("art").innerHTML = t.artUrl ? '<img src="' + t.artUrl + '">' : '';
      $("dur").textContent = fmt(t.duration);
    } else {
      $("tt").textContent = "Nothing playing";
      $("ta").textContent = "—";
      $("art").innerHTML = "";
      $("dur").textContent = "0:00";
    }
    $("cur").textContent = fmt(s.currentTime);
    if (t && t.duration > 0) $("fill").style.width = (s.currentTime / t.duration * 100) + "%";
    else $("fill").style.width = "0";
    $("play").querySelector("svg").outerHTML = s.paused ? playIco : pauseIco;
    $("shf").classList.toggle("on", !!s.shuffle);
    $("rep").classList.toggle("on", s.repeat !== "off");
    $("rep").textContent = "Repeat" + (s.repeat === "one" ? " 1" : "");
    $("vol").value = Math.round(s.volume * 100);
  } catch (e) {}
}
function cmd(action, value) {
  fetch("/cmd", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, value }) }).catch(()=>{});
}
$("play").onclick = () => cmd("toggle");
document.querySelectorAll("[data-act]").forEach(b => b.onclick = () => cmd(b.dataset.act));
$("shf").onclick = () => cmd("shuffle");
$("rep").onclick = () => cmd("repeat");
$("vol").addEventListener("input", () => cmd("volume", parseInt($("vol").value, 10) / 100));
setInterval(refresh, 250);
refresh();
</script>
</body>
</html>`;

export function startWebRemote(port: number, hooks: Hooks): { url: string } | null {
	if (server) return { url: serverUrl(port) };
	try {
		server = Bun.serve({
			port,
			hostname: "0.0.0.0",
			async fetch(req) {
				const url = new URL(req.url);
				if (url.pathname === "/" || url.pathname === "/index.html") {
					return new Response(REMOTE_HTML, {
						headers: { "Content-Type": "text/html; charset=utf-8" },
					});
				}
				if (url.pathname === "/state") {
					const s = hooks.getState();
					return Response.json(s, {
						headers: { "Access-Control-Allow-Origin": "*" },
					});
				}
				if (url.pathname === "/cmd" && req.method === "POST") {
					try {
						const body = (await req.json()) as { action: ExternalCommand; value?: number | string };
						hooks.dispatch(body.action, body.value);
						return new Response("ok", {
							headers: { "Access-Control-Allow-Origin": "*" },
						});
					} catch {
						return new Response("bad", { status: 400 });
					}
				}
				return new Response("not found", { status: 404 });
			},
		});
		return { url: serverUrl(port) };
	} catch (err) {
		console.warn("[web-remote] failed to start:", (err as Error).message);
		return null;
	}
}

export function stopWebRemote(): boolean {
	if (!server) return false;
	server.stop(true);
	server = null;
	return true;
}

function serverUrl(port: number): string {
	const ip = lanIPv4() ?? "localhost";
	return `http://${ip}:${port}`;
}
