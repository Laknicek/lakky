// The actual icon used by the titlebar / sidebar etc. is the raster art the
// user supplied — Vite bundles `./icon.png` and gives us a final URL to use
// inside <img src>. We keep the old SVG below as a fallback for any code
// path that still wants vector content.
import iconUrl from "./icon.png";
export { iconUrl };

// Inline SVG logo. Kept in TS so it can be embedded directly without a fetch.
// Dark rounded square + single gradient ring + white play triangle. Nothing else.
export const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
	<defs>
		<linearGradient id="lakG" x1="0%" y1="0%" x2="100%" y2="100%">
			<stop offset="0%" stop-color="#a78bfa" />
			<stop offset="100%" stop-color="#22d3ee" />
		</linearGradient>
	</defs>
	<rect x="8" y="8" width="240" height="240" rx="56" ry="56" fill="#0a0a14" />
	<circle cx="128" cy="128" r="84" fill="none" stroke="url(#lakG)" stroke-width="9" />
	<path d="M112 92 L112 164 L172 128 Z" fill="white" />
</svg>`;

// Even barer variant — just the ring + triangle, no backdrop. Use when the
// surrounding context already provides a card / pill background.
export const LOGO_MARK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256">
	<defs>
		<linearGradient id="lakMk" x1="0%" y1="0%" x2="100%" y2="100%">
			<stop offset="0%" stop-color="#a78bfa" />
			<stop offset="100%" stop-color="#22d3ee" />
		</linearGradient>
	</defs>
	<circle cx="128" cy="128" r="84" fill="none" stroke="url(#lakMk)" stroke-width="10" />
	<path d="M112 92 L112 164 L172 128 Z" fill="currentColor" />
</svg>`;
