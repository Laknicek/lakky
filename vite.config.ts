import { defineConfig } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

export default defineConfig({
	plugins: [tailwindcss()],
	root: "src/mainview",
	build: {
		outDir: "../../dist",
		emptyOutDir: true,
		rollupOptions: {
			input: {
				main: resolve(__dirname, "src/mainview/index.html"),
				mini: resolve(__dirname, "src/mainview/mini.html"),
			},
		},
	},
	server: {
		port: 5173,
		strictPort: true,
	},
});
