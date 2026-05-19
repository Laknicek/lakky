// Renderer-side utilities shared across views.

// Escape user-controlled text before inlining into innerHTML templates.
// Covers the five HTML/XML-sensitive characters; safe for both attribute
// and text-node contexts.
export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
