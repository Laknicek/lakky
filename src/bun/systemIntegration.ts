import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export const SUPPORTED_AUDIO_EXTENSIONS = [
	".mp3", ".wav", ".flac", ".ogg", ".oga", ".opus", ".m4a", ".aac",
	".wma", ".aiff", ".aif", ".alac", ".ape", ".wv", ".mka", ".mp2",
	".mp1", ".amr", ".ac3", ".dts", ".eac3", ".dsd", ".dsf", ".dff",
	".au", ".snd", ".ra", ".mid", ".midi", ".mod", ".xm", ".s3m",
	".it", ".spx", ".tak", ".tta", ".caf",
];

export const SUPPORTED_VIDEO_EXTENSIONS = [
	".mp4", ".m4v", ".mkv", ".webm", ".mov", ".avi", ".wmv", ".flv",
	".f4v", ".mpg", ".mpeg", ".m2v", ".3gp", ".3g2", ".ts", ".mts",
	".m2ts", ".ogv", ".vob", ".rm", ".rmvb", ".asf", ".divx", ".wtv",
	".dvr-ms",
];

export const ALL_SUPPORTED_EXTENSIONS = [
	...SUPPORTED_AUDIO_EXTENSIONS,
	...SUPPORTED_VIDEO_EXTENSIONS,
];

/**
 * Generates and applies a Windows Registry (.reg) registration to associate Lakky Player
 * with all supported audio and video file types and register the lakky:// URL protocol.
 */
export async function registerDefaultPlayerAssociations(): Promise<{ ok: boolean; message: string }> {
	if (process.platform !== "win32") {
		return { ok: false, message: "File association registry generator is currently designed for Windows." };
	}

	try {
		const exePath = process.execPath.replace(/\\/g, "\\\\");
		const progId = "Lakky.MediaFile";
		const progDescription = "Lakky Media Player File";

		let regContent = `Windows Registry Editor Version 5.00\r\n\r\n`;

		// 1. Register ProgID under HKCU\Software\Classes
		regContent += `[HKEY_CURRENT_USER\\Software\\Classes\\${progId}]\r\n`;
		regContent += `@="${progDescription}"\r\n`;
		regContent += `"FriendlyTypeName"="${progDescription}"\r\n\r\n`;

		regContent += `[HKEY_CURRENT_USER\\Software\\Classes\\${progId}\\DefaultIcon]\r\n`;
		regContent += `@="\\"${exePath}\\",0"\r\n\r\n`;

		regContent += `[HKEY_CURRENT_USER\\Software\\Classes\\${progId}\\shell]\r\n`;
		regContent += `@="open"\r\n\r\n`;

		regContent += `[HKEY_CURRENT_USER\\Software\\Classes\\${progId}\\shell\\open]\r\n`;
		regContent += `@="Play in Lakky"\r\n\r\n`;

		regContent += `[HKEY_CURRENT_USER\\Software\\Classes\\${progId}\\shell\\open\\command]\r\n`;
		regContent += `@="\\"${exePath}\\" \\"%1\\""\r\n\r\n`;

		// 2. Register lakky:// URL protocol
		regContent += `[HKEY_CURRENT_USER\\Software\\Classes\\lakky]\r\n`;
		regContent += `@="URL:Lakky Protocol"\r\n`;
		regContent += `"URL Protocol"=""\r\n\r\n`;

		regContent += `[HKEY_CURRENT_USER\\Software\\Classes\\lakky\\DefaultIcon]\r\n`;
		regContent += `@="\\"${exePath}\\",0"\r\n\r\n`;

		regContent += `[HKEY_CURRENT_USER\\Software\\Classes\\lakky\\shell\\open\\command]\r\n`;
		regContent += `@="\\"${exePath}\\" \\"%1\\""\r\n\r\n`;

		// 3. Register Application Capabilities under HKCU\Software\Lakky\Capabilities
		regContent += `[HKEY_CURRENT_USER\\Software\\Lakky\\Capabilities]\r\n`;
		regContent += `"ApplicationDescription"="Lakky — Stylized 2026 Cel-Shaded Anime Media Player"\r\n`;
		regContent += `"ApplicationName"="Lakky"\r\n\r\n`;

		regContent += `[HKEY_CURRENT_USER\\Software\\Lakky\\Capabilities\\FileAssociations]\r\n`;
		for (const ext of ALL_SUPPORTED_EXTENSIONS) {
			regContent += `"${ext}"="${progId}"\r\n`;
		}
		regContent += `\r\n`;

		// 4. Register in RegisteredApplications
		regContent += `[HKEY_CURRENT_USER\\Software\\RegisteredApplications]\r\n`;
		regContent += `"Lakky"="Software\\\\Lakky\\\\Capabilities"\r\n\r\n`;

		// 5. Register each extension OpenWithProgids under HKCU\Software\Classes
		for (const ext of ALL_SUPPORTED_EXTENSIONS) {
			regContent += `[HKEY_CURRENT_USER\\Software\\Classes\\${ext}\\OpenWithProgids]\r\n`;
			regContent += `"${progId}"=""\r\n\r\n`;
		}

		// Write to temporary .reg file
		const tempDir = join(tmpdir(), "lakky-setup");
		if (!existsSync(tempDir)) mkdirSync(tempDir, { recursive: true });
		const regFile = join(tempDir, "lakky-associations.reg");
		writeFileSync(regFile, regContent, "utf16le");

		// Execute reg.exe import
		await execAsync(`reg import "${regFile}"`);

		return {
			ok: true,
			message: `Successfully registered Lakky as media handler for ${ALL_SUPPORTED_EXTENSIONS.length} audio and video formats.`,
		};
	} catch (err) {
		console.error("[systemIntegration] Registration failed:", err);
		return {
			ok: false,
			message: `Registry configuration error: ${(err as Error).message}`,
		};
	}
}
