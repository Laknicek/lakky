import { stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { artCacheDir } from "./library";

const MIME: Record<string, string> = {
	".mp3": "audio/mpeg",
	".m4a": "audio/mp4",
	".aac": "audio/aac",
	".wav": "audio/wav",
	".flac": "audio/flac",
	".ogg": "audio/ogg",
	".oga": "audio/ogg",
	".opus": "audio/ogg",
	".webm": "video/webm",
	".mp4": "video/mp4",
	".m4v": "video/mp4",
	".mkv": "video/x-matroska",
	".mov": "video/quicktime",
	".avi": "video/x-msvideo",
	".wmv": "video/x-ms-wmv",
	".ts": "video/mp2t",
};

function mimeFor(path: string): string {
	return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export function startMediaServer(): { port: number; stop: () => void } {
	const server = Bun.serve({
		port: 0, // pick a free port
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			if (url.pathname === "/health") {
				return new Response("ok", {
					headers: { "Access-Control-Allow-Origin": "*" },
				});
			}

			if (url.pathname.startsWith("/art/")) {
				const filename = url.pathname.slice("/art/".length);
				// Only allow a flat lowercase hash + extension. No traversal.
				if (!/^[a-z0-9]+\.(jpg|jpeg|png|webp|gif|bmp)$/i.test(filename)) {
					return new Response("bad", { status: 400 });
				}
				const filePath = join(artCacheDir(), filename);
				const file = Bun.file(filePath);
				if (!(await file.exists())) {
					return new Response("not found", { status: 404 });
				}
				return new Response(file, {
					headers: {
						"Content-Type": file.type || "image/jpeg",
						"Cache-Control": "public, max-age=86400",
						"Access-Control-Allow-Origin": "*",
					},
				});
			}
			if (url.pathname === "/stream") {
				const filePath = url.searchParams.get("p");
				if (!filePath) return new Response("missing path", { status: 400 });

				let info;
				try {
					info = await stat(filePath);
					if (!info.isFile()) return new Response("not a file", { status: 404 });
				} catch {
					return new Response("not found", { status: 404 });
				}
				const size = info.size;
				const contentType = mimeFor(filePath);
				const range = req.headers.get("range");

				const baseHeaders: Record<string, string> = {
					"Content-Type": contentType,
					"Accept-Ranges": "bytes",
					"Cache-Control": "no-store",
					"Access-Control-Allow-Origin": "*",
				};

				if (!range) {
					const file = Bun.file(filePath);
					return new Response(file, {
						headers: {
							...baseHeaders,
							"Content-Length": String(size),
						},
					});
				}

				const match = /bytes=(\d*)-(\d*)/.exec(range);
				if (!match) return new Response("bad range", { status: 416 });

				let start = match[1] === "" ? 0 : parseInt(match[1], 10);
				let end = match[2] === "" ? size - 1 : parseInt(match[2], 10);
				if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= size) {
					return new Response("bad range", {
						status: 416,
						headers: { "Content-Range": `bytes */${size}` },
					});
				}

				const chunkSize = end - start + 1;
				const file = Bun.file(filePath);
				const slice = file.slice(start, end + 1);
				return new Response(slice, {
					status: 206,
					headers: {
						...baseHeaders,
						"Content-Range": `bytes ${start}-${end}/${size}`,
						"Content-Length": String(chunkSize),
					},
				});
			}
			return new Response("not found", { status: 404 });
		},
	});

	return {
		port: server.port ?? 0,
		stop: () => server.stop(true),
	};
}
