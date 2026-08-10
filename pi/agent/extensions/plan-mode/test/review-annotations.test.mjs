import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewAnnotations } from "../review-annotations.js";
import { PART_MINIMAL_PLAN } from "./fixtures.mjs";

const ORIGINAL = `# Plan

## Stage

#### 1.1 [pending] Task

Do the thing.

- **Targets:** file.ts
- **Tools / APIs:** edit
`;

test("parses directives, questions, continuations, and section context", () => {
	const edited = ORIGINAL.replace(
		"Do the thing.",
		"Do the thing.\n! reuse the existing helper\n? should this remain synchronous?\n  Consider callers in api/.\n",
	);
	const result = parseReviewAnnotations(ORIGINAL, edited);
	assert.equal(result.directives[0].text, "reuse the existing helper");
	assert.equal(result.questions[0].text, "should this remain synchronous?\nConsider callers in api/.");
	assert.equal(result.questions[0].context, "1.1 [pending] Task");
	assert.equal(result.hasAnnotations, true);
	assert.doesNotMatch(result.cleanedMarkdown, /^[ \t]*[!?]/m);
});

test("retains Part identity as review context and strips annotations cleanly", () => {
	const edited = PART_MINIMAL_PLAN.replace(
		"Describe writes, expiry, and ownership",
		"! retain the repository's expiry term\n? does the public guide define ownership?\nDescribe writes, expiry, and ownership",
	);
	const result = parseReviewAnnotations(PART_MINIMAL_PLAN, edited);
	assert.equal(result.directives[0].context, "Part A — Clarify the cache lifecycle");
	assert.equal(result.questions[0].context, "Part A — Clarify the cache lifecycle");
	assert.doesNotMatch(result.cleanedMarkdown, /^[ \t]*[!?]/m);
});

test("ignores fenced code and inline-code marker examples", () => {
	const edited = ORIGINAL.replace(
		"Do the thing.",
		"Do the thing.\n\n```sh\n! history expansion\n? shell glob\n```\n\n`?` is documented inline.",
	);
	const result = parseReviewAnnotations(ORIGINAL, edited);
	assert.equal(result.hasAnnotations, false);
	assert.equal(result.hasDirectEdits, true);
});

test("treats empty ambiguous markers as blocking questions", () => {
	const result = parseReviewAnnotations(ORIGINAL, ORIGINAL.replace("Do the thing.", "Do the thing.\n!"));
	assert.equal(result.directives.length, 0);
	assert.equal(result.questions.length, 1);
	assert.equal(result.questions[0].ambiguous, true);
	assert.equal(result.questions[0].originalKind, "!");
});

test("detects direct edits separately from annotations and potential conflicts", () => {
	const annotationsOnly = parseReviewAnnotations(ORIGINAL, ORIGINAL.replace("Do the thing.", "Do the thing.\n! use helper"));
	assert.equal(annotationsOnly.hasDirectEdits, false);
	const mixed = parseReviewAnnotations(
		ORIGINAL,
		ORIGINAL.replace("Do the thing.", "Do the safer thing.\n! use helper\n? is helper concurrency-safe?"),
	);
	assert.equal(mixed.hasDirectEdits, true);
	assert.equal(mixed.conflicts.length, 1);
});
