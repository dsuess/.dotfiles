import assert from "node:assert/strict";
import test from "node:test";
import extension, { asksForFeedback, latestSettledAssistantText } from "./index.ts";
import { PLAN_MODE_WORKFLOW_STATE_EVENT } from "../plan-mode/events.ts";

function createHarness(branch = []) {
	const lifecycle = new Map();
	const bus = new Map();
	const reports = [];
	const events = {
		on(name, handler) {
			if (!bus.has(name)) bus.set(name, []);
			bus.get(name).push(handler);
		},
		emit(name, payload) {
			if (name === "herdr:blocked") reports.push(payload);
			for (const handler of bus.get(name) ?? []) handler(payload);
		},
	};
	const pi = {
		events,
		on(name, handler) {
			if (!lifecycle.has(name)) lifecycle.set(name, []);
			lifecycle.get(name).push(handler);
		},
	};
	extension(pi);

	return {
		reports,
		emitBus: (name, payload) => events.emit(name, payload),
		async emitLifecycle(name, event = {}, { hasUI = true } = {}) {
			const ctx = {
				hasUI,
				sessionManager: { getBranch: () => branch },
			};
			for (const handler of lifecycle.get(name) ?? []) await handler(event, ctx);
		},
	};
}

function assistant(text, extraContent = []) {
	return {
		role: "assistant",
		stopReason: "stop",
		content: [{ type: "text", text }, ...extraContent],
	};
}

test("recognizes final free-form questions conservatively", () => {
	assert.equal(asksForFeedback("Which approach should I use?"), true);
	assert.equal(asksForFeedback("**Which approach should I use?**"), true);
	assert.equal(asksForFeedback("Which approach should I use?\n\n- Cache locally\n- Use Redis"), true);
	assert.equal(asksForFeedback("Implemented the requested cache."), false);
	assert.equal(asksForFeedback("Why this works:\n\nThe cache is scoped per request."), false);
});

test("only restores blocked state when the latest message is an assistant question", () => {
	const question = { type: "message", message: assistant("Continue with deployment?") };
	assert.equal(latestSettledAssistantText([question]), "Continue with deployment?");
	assert.equal(latestSettledAssistantText([question, { type: "custom", data: {} }]), "Continue with deployment?");
	assert.equal(latestSettledAssistantText([question, { type: "message", message: { role: "user", content: "Yes" } }]), "");
});

test("bridges structured-question waits without duplicate reports", async () => {
	const harness = createHarness();
	await harness.emitLifecycle("session_start");
	harness.emitBus("rpiv:ask-user:blocked", { active: true });
	harness.emitBus("rpiv:ask-user:blocked", { active: true });
	harness.emitBus("rpiv:ask-user:blocked", { active: false });

	assert.deepEqual(harness.reports, [
		{ active: true, label: "waiting for feedback" },
		{ active: false },
	]);
});

test("bridges pending plan approval without duplicate reports and clears when revised", async () => {
	const harness = createHarness();
	await harness.emitLifecycle("session_start");
	harness.emitBus(PLAN_MODE_WORKFLOW_STATE_EVENT, { mode: "approval" });
	harness.emitBus(PLAN_MODE_WORKFLOW_STATE_EVENT, { mode: "approval" });
	harness.emitBus(PLAN_MODE_WORKFLOW_STATE_EVENT, { mode: "planning" });

	assert.deepEqual(harness.reports, [
		{ active: true, label: "waiting for feedback" },
		{ active: false },
	]);
});

test("keeps waiting while another feedback source overlaps a consumed approval", async () => {
	const harness = createHarness();
	await harness.emitLifecycle("session_start");
	harness.emitBus(PLAN_MODE_WORKFLOW_STATE_EVENT, { mode: "approval" });
	harness.emitBus("rpiv:ask-user:blocked", { active: true });
	harness.emitBus(PLAN_MODE_WORKFLOW_STATE_EVENT, { mode: "executing_all" });
	harness.emitBus("rpiv:ask-user:blocked", { active: false });

	assert.deepEqual(harness.reports, [
		{ active: true, label: "waiting for feedback" },
		{ active: false },
	]);
});

test("reports settled plain questions as blocked until the next run", async () => {
	const harness = createHarness();
	await harness.emitLifecycle("session_start");
	await harness.emitLifecycle("message_end", { message: assistant("Should I apply this migration?") });
	await harness.emitLifecycle("agent_settled");
	await harness.emitLifecycle("agent_settled");
	await harness.emitLifecycle("agent_start");

	assert.deepEqual(harness.reports, [
		{ active: true, label: "waiting for feedback" },
		{ active: false },
	]);
});

test("does not classify incomplete or tool-calling messages as free-form waits", async () => {
	const harness = createHarness();
	await harness.emitLifecycle("session_start");
	await harness.emitLifecycle("message_end", {
		message: assistant("Which option do you prefer?", [{ type: "toolCall", name: "ask_user_question" }]),
	});
	await harness.emitLifecycle("agent_settled");
	await harness.emitLifecycle("message_end", {
		message: { ...assistant("Should I continue?"), stopReason: "length" },
	});
	await harness.emitLifecycle("agent_settled");
	assert.deepEqual(harness.reports, []);
});

test("restores an unanswered question as blocked on session start", async () => {
	const harness = createHarness([
		{ type: "message", message: assistant("Do you want me to continue?") },
	]);
	await harness.emitLifecycle("session_start");
	assert.deepEqual(harness.reports, [{ active: true, label: "waiting for feedback" }]);
});

test("does not report from non-interactive nested sessions", async () => {
	const harness = createHarness([
		{ type: "message", message: assistant("Do you want me to continue?") },
	]);
	await harness.emitLifecycle("session_start", {}, { hasUI: false });
	await harness.emitLifecycle("agent_settled");
	assert.deepEqual(harness.reports, []);
});
