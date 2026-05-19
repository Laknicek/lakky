// OS-conventional per-app data directory. Pass the app name (e.g. "Lakky"
// for the current version, or a legacy name when migrating state).
//   Windows: %APPDATA%\<name>
//   macOS:   ~/Library/Application Support/<name>
//   Linux:   $XDG_DATA_HOME/<name> (default ~/.local/share/<name>)

import { join } from "node:path";
import { homedir } from "node:os";

export function appDataDir(name: string): string {
	if (process.platform === "win32") {
		return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), name);
	}
	if (process.platform === "darwin") {
		return join(homedir(), "Library", "Application Support", name);
	}
	return join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), name);
}

export const LAKKY_APP_DATA = "Lakky";
