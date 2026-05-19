import type { ElectrobunConfig } from "electrobun";

export default {
	app: {
		name: "Lakky",
		identifier: "player.lak.app",
		version: "1.0.0",
		description: "A stunning modern media player.",
	},
	build: {
		copy: {
			"dist/index.html": "views/mainview/index.html",
			"dist/mini.html": "views/mainview/mini.html",
			"dist/assets": "views/mainview/assets",
			"assets/tray-32.png": "views/tray.png",
			"assets/icon.ico": "views/tray.ico",
		},
		watchIgnore: ["dist/**"],
		mac: {
			bundleCEF: false,
		},
		linux: {
			bundleCEF: false,
			icon: "assets/icon-256.png",
		},
		win: {
			bundleCEF: false,
			icon: "assets/icon.ico",
		},
	},
	scripts: {
		postBuild: "scripts/embed-icon.ts",
	},
} satisfies ElectrobunConfig;
