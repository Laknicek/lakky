// Shared frameless-window drag logic for main and mini windows.
// WebView2 doesn't honor -webkit-app-region, so we capture cursor + window
// position on mousedown and push setPosition() updates on mousemove,
// throttled to one update per animation frame.

export function installWindowDrag(
	bun: () => any,
	el: HTMLElement,
	which: string | undefined,
	excludeSelector?: string,
	onDblClick?: () => void,
) {
	let dragging = false;
	let startScreenX = 0;
	let startScreenY = 0;
	let startWinX = 0;
	let startWinY = 0;
	let queuedX: number | null = null;
	let queuedY: number | null = null;
	let rafScheduled = false;

	const flush = () => {
		rafScheduled = false;
		if (queuedX === null || queuedY === null) return;
		const x = queuedX;
		const y = queuedY;
		queuedX = null;
		queuedY = null;
		bun().windowSetPosition({ x, y, which }).catch(() => {});
	};

	el.addEventListener("mousedown", async (e) => {
		if (e.button !== 0) return;
		if (excludeSelector && (e.target as HTMLElement).closest(excludeSelector)) return;
		dragging = true;
		startScreenX = e.screenX;
		startScreenY = e.screenY;
		try {
			const p = await bun().windowGetPosition({ which });
			startWinX = p.x;
			startWinY = p.y;
		} catch {
			dragging = false;
		}
	});

	window.addEventListener("mousemove", (e) => {
		if (!dragging) return;
		const dx = e.screenX - startScreenX;
		const dy = e.screenY - startScreenY;
		queuedX = startWinX + dx;
		queuedY = startWinY + dy;
		if (!rafScheduled) {
			rafScheduled = true;
			requestAnimationFrame(flush);
		}
	});

	window.addEventListener("mouseup", () => {
		dragging = false;
	});

	if (onDblClick) {
		el.addEventListener("dblclick", (e) => {
			if (excludeSelector && (e.target as HTMLElement).closest(excludeSelector)) return;
			onDblClick();
		});
	}
}
