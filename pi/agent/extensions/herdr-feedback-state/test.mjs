import assert from "node:assert/strict";
import test from "node:test";
import extension from "./index.ts";
import {
	HERDR_BLOCKED_EVENT,
	HERDR_FEEDBACK_SNAPSHOT_EVENT,
} from "./events.ts";
import { ASK_USER_BLOCKED_EVENT } from "../../packages/ask-user-question/events.ts";
import { PLAN_MODE_WORKFLOW_STATE_EVENT } from "../plan-mode/events.ts";

const BLOCKING_UI_METHODS = ["select", "confirm", "input", "editor", "custom"];

function nextTurn() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createUI() {
	const ui = {};
	for (const method of BLOCKING_UI_METHODS) ui[method] = () => Promise.resolve(undefined);
	return ui;
}

function sourceIds(snapshot) {
	return snapshot.sources.map((source) => source.id);
}

function createHarness(ui = createUI()) {
	const lifecycle = new Map();
	const bus = new Map();
	const snapshots = [];
	const legacyReports = [];
	const events = {
		on(name, handler) {
			if (!bus.has(name)) bus.set(name, []);
			const handlers = bus.get(name);
			handlers.push(handler);
			return () => {
				const index = handlers.indexOf(handler);
				if (index >= 0) handlers.splice(index, 1);
			};
		},
		emit(name, payload) {
			if (name === HERDR_FEEDBACK_SNAPSHOT_EVENT) snapshots.push(payload);
			if (name === HERDR_BLOCKED_EVENT) legacyReports.push(payload);
			for (const handler of [...(bus.get(name) ?? [])]) handler(payload);
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
		snapshots,
		legacyReports,
		ui,
		emitBus: (name, payload) => events.emit(name, payload),
		busListenerCount: (name) => (bus.get(name) ?? []).length,
		async emitLifecycle(name, event = {}, { mode = "tui", lifecycleUI = ui } = {}) {
			const ctx = { mode, hasUI: mode === "tui", ui: lifecycleUI, sessionManager: { getBranch: () => [] } };
			for (const handler of lifecycle.get(name) ?? []) await handler(event, ctx);
		},
	};
}

test("publishes a complete source snapshot and idempotently derives the legacy edge", async () => {
	const harness = createHarness();
	await harness.emitLifecycle("session_start");
	assert.deepEqual(harness.snapshots, [{ sources: [] }]);

	harness.emitBus(ASK_USER_BLOCKED_EVENT, { active: true });
	harness.emitBus(ASK_USER_BLOCKED_EVENT, { active: true });
	assert.deepEqual(harness.snapshots.map(sourceIds), [[], ["questionnaire"]]);
	assert.deepEqual(harness.legacyReports, [{ active: true, label: "waiting for feedback" }]);

	harness.emitBus(ASK_USER_BLOCKED_EVENT, { active: false });
	harness.emitBus(ASK_USER_BLOCKED_EVENT, { active: false });
	assert.deepEqual(harness.snapshots.map(sourceIds), [[], ["questionnaire"], []]);
	assert.deepEqual(harness.legacyReports, [
		{ active: true, label: "waiting for feedback" },
		{ active: false },
	]);
});

test("clearing one source cannot clear overlapping sources", async () => {
	const harness = createHarness();
	await harness.emitLifecycle("session_start");
	harness.emitBus(PLAN_MODE_WORKFLOW_STATE_EVENT, { mode: "approval", feedbackPending: true });
	harness.emitBus(ASK_USER_BLOCKED_EVENT, { active: true });
	assert.deepEqual(harness.snapshots.map(sourceIds), [[], ["plan-workflow"], ["plan-workflow", "questionnaire"]]);

	harness.emitBus(PLAN_MODE_WORKFLOW_STATE_EVENT, { mode: "executing_all", feedbackPending: false });
	assert.deepEqual(harness.snapshots.at(-1).sources, [{ id: "questionnaire", label: "waiting for feedback" }]);
	harness.emitBus(ASK_USER_BLOCKED_EVENT, { active: false });
	assert.deepEqual(harness.snapshots.at(-1), { sources: [] });
});

test("wraps every fallback UI operation with an individual source and preserves cancellation", async () => {
	for (const method of BLOCKING_UI_METHODS) {
		const ui = createUI();
		const harness = createHarness(ui);
		const calls = [];
		const cancelled = method === "confirm" ? false : undefined;
		ui[method] = function (...args) {
			calls.push({ thisValue: this, args });
			return Promise.resolve(cancelled);
		};
		await harness.emitLifecycle("session_start");

		const args = ["title", ["option"], { overlay: true }];
		assert.equal(await ui[method](...args), cancelled);
		await nextTurn();
		assert.deepEqual(calls, [{ thisValue: ui, args }], method);
		assert.deepEqual(harness.snapshots.map(sourceIds), [[], ["ui:1"], []], method);
	}
});

test("keeps an overlap blocked until every individual fallback UI source clears", async () => {
	const ui = createUI();
	const harness = createHarness(ui);
	const first = deferred();
	const second = deferred();
	ui.select = () => first.promise;
	ui.confirm = () => second.promise;
	await harness.emitLifecycle("session_start");

	const firstResult = ui.select("First", []);
	const secondResult = ui.confirm("Second", "message");
	first.resolve("first");
	assert.equal(await firstResult, "first");
	await nextTurn();
	assert.deepEqual(harness.snapshots.at(-1).sources.map((source) => source.id), ["ui:2"]);
	second.resolve(true);
	assert.equal(await secondResult, true);
	await nextTurn();
	assert.deepEqual(harness.snapshots.at(-1), { sources: [] });
});

test("does not clear between an immediate UI handoff", async () => {
	const ui = createUI();
	const harness = createHarness(ui);
	const selected = deferred();
	const edited = deferred();
	ui.select = () => selected.promise;
	ui.editor = () => edited.promise;
	await harness.emitLifecycle("session_start");

	const handoff = (async () => {
		await ui.select("Plan ready", ["Change"]);
		return ui.editor("Change plan");
	})();
	selected.resolve("Change");
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(harness.snapshots.map(sourceIds), [[], ["ui:1"], ["ui:1", "ui:2"]]);
	edited.resolve("revised");
	assert.equal(await handoff, "revised");
	await nextTurn();
	assert.deepEqual(harness.snapshots.at(-1), { sources: [] });
});

test("restores only durable workflow state on session replacement", async () => {
	const firstUI = createUI();
	const secondUI = createUI();
	const harness = createHarness(firstUI);
	harness.emitBus(PLAN_MODE_WORKFLOW_STATE_EVENT, { mode: "approval", feedbackPending: true });
	await harness.emitLifecycle("session_start");
	harness.emitBus(ASK_USER_BLOCKED_EVENT, { active: true });
	await harness.emitLifecycle("session_start", {}, { lifecycleUI: secondUI });

	assert.equal(harness.busListenerCount(ASK_USER_BLOCKED_EVENT), 1);
	assert.deepEqual(harness.snapshots.map(sourceIds), [
		["plan-workflow"],
		["plan-workflow", "questionnaire"],
		["plan-workflow"],
	]);
});

test("restores durable workflow state published before session_start", async () => {
	const harness = createHarness();
	harness.emitBus(PLAN_MODE_WORKFLOW_STATE_EVENT, { mode: "approval", feedbackPending: true });
	await harness.emitLifecycle("session_start");
	assert.deepEqual(harness.snapshots, [{ sources: [{ id: "plan-workflow", label: "waiting for feedback" }] }]);
});

test("treats malformed producer payloads as source clears", async () => {
	const harness = createHarness();
	await harness.emitLifecycle("session_start");
	harness.emitBus(ASK_USER_BLOCKED_EVENT, { active: true });
	for (const payload of [{ active: "true" }, {}, null, undefined]) harness.emitBus(ASK_USER_BLOCKED_EVENT, payload);
	assert.deepEqual(harness.snapshots.map(sourceIds), [[], ["questionnaire"], []]);
});

test("never infers authoritative feedback waits from settled assistant prose", async () => {
	const harness = createHarness();
	await harness.emitLifecycle("session_start");
	await harness.emitLifecycle("message_end", {
		message: { role: "assistant", stopReason: "stop", content: "Should I apply this migration?" },
	});
	await harness.emitLifecycle("agent_settled");
	assert.deepEqual(harness.snapshots, [{ sources: [] }]);
	assert.deepEqual(harness.legacyReports, []);
});

test("restores UI and unsubscribes producer listeners on shutdown", async () => {
	const ui = createUI();
	const pending = deferred();
	ui.custom = () => pending.promise;
	const original = ui.custom;
	const harness = createHarness(ui);
	await harness.emitLifecycle("session_start");
	const waiting = ui.custom(() => undefined);
	await harness.emitLifecycle("session_shutdown");
	assert.equal(ui.custom, original);
	assert.equal(harness.busListenerCount(ASK_USER_BLOCKED_EVENT), 0);
	assert.equal(harness.busListenerCount(PLAN_MODE_WORKFLOW_STATE_EVENT), 0);
	harness.emitBus(ASK_USER_BLOCKED_EVENT, { active: true });
	pending.resolve(undefined);
	await waiting;
	await nextTurn();
	assert.deepEqual(harness.snapshots.map(sourceIds), [[], ["ui:1"]]);
});

test("does not instrument or report from non-TUI sessions", async () => {
	const ui = createUI();
	const original = ui.select;
	const harness = createHarness(ui);
	await harness.emitLifecycle("session_start", {}, { mode: "rpc" });
	assert.equal(ui.select, original);
	await ui.select("Question", []);
	assert.deepEqual(harness.snapshots, []);
});
