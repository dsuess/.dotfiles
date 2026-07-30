/**
 * Build the complete result shape required by Pi custom tools.
 *
 * @param {string} text
 * @returns {{content: Array<{type: "text", text: string}>, details: Record<string, never>}}
 */
export function textToolResult(text) {
	return {
		content: [{ type: "text", text }],
		details: {},
	};
}
