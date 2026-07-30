import assert from "node:assert/strict";
import test from "node:test";

import { textToolResult } from "./tool-result.js";

test("textToolResult returns Pi's complete custom-tool result shape", () => {
	assert.deepEqual(textToolResult("saved"), {
		content: [{ type: "text", text: "saved" }],
		details: {},
	});
});
