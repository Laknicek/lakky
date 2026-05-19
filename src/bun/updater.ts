// GitHub Releases poller. Given an "owner/repo" string, hits the public
// /releases/latest endpoint and returns a normalized record the renderer can
// show in an "Update available" card. Pure network call — no downloads, no
// installer side effects. The renderer compares versions and decides what to
// show; we just transport.

export type LatestRelease = {
	tag: string;            // raw tag, e.g. "v1.2.0"
	version: string;        // normalized, leading 'v' stripped: "1.2.0"
	name: string;           // human-readable release title
	notes: string;          // release body (markdown — we render plain text)
	htmlUrl: string;        // URL of the GitHub release page (open in browser)
	publishedAt: string;    // ISO timestamp
	// First .exe asset in the release, if any. Useful when we extend the
	// updater to download the installer directly instead of just opening
	// the browser.
	installerUrl: string | null;
	installerName: string | null;
};

function parseRepo(input: string): { owner: string; repo: string } | null {
	const trimmed = input.trim().replace(/^https?:\/\/github\.com\//i, "").replace(/\.git$/i, "");
	const parts = trimmed.split("/").filter(Boolean);
	if (parts.length < 2) return null;
	return { owner: parts[0], repo: parts[1] };
}

// Strict-enough semver compare. Returns 1 if `a` is newer than `b`,
// -1 if older, 0 if equal. Treats any non-numeric suffix (pre-release,
// build metadata) as smaller than the same version without one, so
// "1.2.0" > "1.2.0-beta.1".
export function compareVersions(a: string, b: string): number {
	const norm = (v: string) => v.replace(/^v/i, "").trim();
	const splitCore = (v: string): { core: number[]; pre: string } => {
		const [core, pre = ""] = norm(v).split(/[-+]/, 2);
		return { core: core.split(".").map((n) => parseInt(n, 10) || 0), pre };
	};
	const A = splitCore(a);
	const B = splitCore(b);
	const len = Math.max(A.core.length, B.core.length);
	for (let i = 0; i < len; i++) {
		const ai = A.core[i] ?? 0;
		const bi = B.core[i] ?? 0;
		if (ai !== bi) return ai > bi ? 1 : -1;
	}
	if (A.pre === B.pre) return 0;
	if (!A.pre) return 1;
	if (!B.pre) return -1;
	return A.pre > B.pre ? 1 : -1;
}

type RawAsset = { name?: string; browser_download_url?: string };
type RawRelease = {
	tag_name?: string;
	name?: string;
	body?: string;
	html_url?: string;
	published_at?: string;
	assets?: RawAsset[];
	draft?: boolean;
	prerelease?: boolean;
};

export async function fetchLatestRelease(repo: string): Promise<LatestRelease | null> {
	const parsed = parseRepo(repo);
	if (!parsed) {
		throw new Error(`Invalid repo "${repo}". Expected "owner/repo".`);
	}
	const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/releases/latest`;
	const res = await fetch(url, {
		headers: {
			// GitHub requires a User-Agent header. Anonymous calls are rate
			// limited to 60/hour per IP — plenty for an in-app updater that
			// polls every few hours.
			"User-Agent": "Lakky-Updater",
			Accept: "application/vnd.github+json",
		},
	});
	if (res.status === 404) return null; // no releases yet
	if (!res.ok) throw new Error(`GitHub ${res.status} ${res.statusText}`);
	const data = (await res.json()) as RawRelease;
	if (!data.tag_name || data.draft) return null;

	const exeAsset = data.assets?.find((a) => a.name?.toLowerCase().endsWith(".exe"));
	return {
		tag: data.tag_name,
		version: data.tag_name.replace(/^v/i, ""),
		name: data.name || data.tag_name,
		notes: data.body || "",
		htmlUrl: data.html_url || `https://github.com/${parsed.owner}/${parsed.repo}/releases/latest`,
		publishedAt: data.published_at || "",
		installerUrl: exeAsset?.browser_download_url ?? null,
		installerName: exeAsset?.name ?? null,
	};
}
