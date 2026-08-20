// Shim for `@babylonjs/core` which is referenced in electrobun types but unused.
declare module "@babylonjs/core";

// Vite turns raster imports into URL strings at build time.
declare module "*.png" {
	const url: string;
	export default url;
}
declare module "*.jpg" {
	const url: string;
	export default url;
}
declare module "*.jpeg" {
	const url: string;
	export default url;
}

// Cross-module shims hung off the Window object. nodeEditor.ts reads these
// at call time so we don't have to import main.ts (which would cycle).
// Imports are inline-`import()` so this stays an ambient (non-module) .d.ts.
interface Window {
	applyNodeGraph?: (g: import("./mainview/nodes").NodeGraph | null) => Promise<void>;
	__lakkyToast?: (msg: string, opts?: { ttl?: number; key?: string }) => void;
	webkitAudioContext?: typeof AudioContext;
}
