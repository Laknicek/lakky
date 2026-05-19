// Shim for `three` and `@babylonjs/core` which are leaked into the public
// surface of `electrobun/bun` but only used by WebGPU paths we don't touch.
declare module "three";
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
