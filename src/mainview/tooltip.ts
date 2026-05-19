// Instant-appearing tooltip system for Lakky.
//
// Replaces the browser's native `title=""` tooltips (which have a ~700ms
// delay and look like a tiny yellow OS tag) with a single shared, themed,
// pill-shaped floating element driven by `data-tip="..."` attributes.
//
// Usage:
//   <button data-tip="Play / Pause">…</button>
//   <button data-tip="Open below" data-tip-side="bottom">…</button>
//
// Call installTooltips() once after the DOM is ready.

let installed = false;

export function installTooltips(): void {
	if (installed) return;
	installed = true;

	const tip = document.createElement("div");
	tip.className = "tip";
	tip.setAttribute("role", "tooltip");
	tip.setAttribute("aria-hidden", "true");
	tip.style.opacity = "0";
	tip.style.pointerEvents = "none";
	document.body.appendChild(tip);

	let currentTrigger: HTMLElement | null = null;
	// Stash the original `title` attribute on the element so we can restore
	// it on mouseleave — otherwise the native OS tooltip stacks on top of
	// ours, defeating the whole point.
	const TITLE_STASH = "__lakkyOriginalTitle";

	const findTrigger = (el: EventTarget | null): HTMLElement | null => {
		if (!(el instanceof Element)) return null;
		const hit = el.closest<HTMLElement>("[data-tip]");
		return hit ?? null;
	};

	const stashTitle = (el: HTMLElement) => {
		if (el.hasAttribute("title")) {
			const t = el.getAttribute("title") ?? "";
			(el as unknown as Record<string, string>)[TITLE_STASH] = t;
			el.removeAttribute("title");
		}
	};

	const restoreTitle = (el: HTMLElement) => {
		const rec = el as unknown as Record<string, string | undefined>;
		const saved = rec[TITLE_STASH];
		if (typeof saved === "string") {
			el.setAttribute("title", saved);
			delete rec[TITLE_STASH];
		}
	};

	const position = () => {
		const trg = currentTrigger;
		if (!trg) return;
		const rect = trg.getBoundingClientRect();
		const tipRect = tip.getBoundingClientRect();
		const margin = 8;
		const gap = 10;

		const preferBelow = trg.getAttribute("data-tip-side") === "bottom";
		const fitsAbove = rect.top - gap - tipRect.height >= margin;
		const placeBelow = preferBelow || !fitsAbove;

		let top = placeBelow
			? rect.bottom + gap
			: rect.top - gap - tipRect.height;

		let left = rect.left + rect.width / 2 - tipRect.width / 2;
		const maxLeft = window.innerWidth - tipRect.width - margin;
		if (left < margin) left = margin;
		if (left > maxLeft) left = Math.max(margin, maxLeft);

		// Clamp vertically as a last resort.
		if (top < margin) top = margin;
		const maxTop = window.innerHeight - tipRect.height - margin;
		if (top > maxTop) top = Math.max(margin, maxTop);

		tip.style.left = `${Math.round(left)}px`;
		tip.style.top = `${Math.round(top)}px`;
		tip.classList.toggle("tip--below", placeBelow);
		tip.classList.toggle("tip--above", !placeBelow);

		// Place the caret horizontally over the trigger center, relative to
		// the tooltip's own left edge.
		const caretX = rect.left + rect.width / 2 - left;
		const clampedCaret = Math.max(
			12,
			Math.min(tipRect.width - 12, caretX),
		);
		tip.style.setProperty("--tip-caret-x", `${Math.round(clampedCaret)}px`);
	};

	const show = (trg: HTMLElement) => {
		const text = trg.getAttribute("data-tip");
		if (!text) return;
		currentTrigger = trg;
		stashTitle(trg);

		tip.textContent = text;
		// Instant on: no transition while appearing.
		tip.style.transition = "none";
		tip.style.opacity = "0";
		tip.classList.add("tip--visible");
		// Force reflow so we can measure, then position and reveal.
		// eslint-disable-next-line @typescript-eslint/no-unused-expressions
		tip.offsetWidth;
		position();
		tip.style.opacity = "1";
		tip.setAttribute("aria-hidden", "false");
	};

	const hide = () => {
		const trg = currentTrigger;
		currentTrigger = null;
		if (trg) restoreTitle(trg);
		// Fade out only.
		tip.style.transition = "opacity 120ms ease-out";
		tip.style.opacity = "0";
		tip.setAttribute("aria-hidden", "true");
		tip.classList.remove("tip--visible");
	};

	document.body.addEventListener("mouseover", (e) => {
		const trg = findTrigger(e.target);
		if (!trg) return;
		if (trg === currentTrigger) return;
		if (currentTrigger) {
			restoreTitle(currentTrigger);
		}
		show(trg);
	});

	document.body.addEventListener("mouseout", (e) => {
		const trg = findTrigger(e.target);
		if (!trg) return;
		// If we moved into a child of the same trigger, ignore.
		const next = e.relatedTarget;
		if (next instanceof Element && trg.contains(next)) return;
		if (currentTrigger === trg) hide();
	});

	document.body.addEventListener(
		"focusin",
		(e) => {
			const trg = findTrigger(e.target);
			if (!trg) return;
			if (trg === currentTrigger) return;
			if (currentTrigger) restoreTitle(currentTrigger);
			show(trg);
		},
		true,
	);

	document.body.addEventListener(
		"focusout",
		(e) => {
			const trg = findTrigger(e.target);
			if (trg && currentTrigger === trg) hide();
		},
		true,
	);

	// Hide on click — the action speaks for itself.
	document.body.addEventListener(
		"click",
		() => {
			if (currentTrigger) hide();
		},
		true,
	);

	// Escape dismisses.
	window.addEventListener("keydown", (e) => {
		if (e.key === "Escape" && currentTrigger) hide();
	});

	// Keep the tip glued to the trigger while it's showing.
	const reposition = () => {
		if (!currentTrigger) return;
		// If the trigger is no longer in the DOM, drop it.
		if (!currentTrigger.isConnected) {
			hide();
			return;
		}
		position();
	};
	window.addEventListener("scroll", reposition, true);
	window.addEventListener("resize", reposition);
}
