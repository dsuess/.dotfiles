import assert from "node:assert/strict";
import test from "node:test";
import extension from "./index.ts";
import { ASK_USER_BLOCKED_EVENT } from "../../packages/ask-user-question/events.ts";
import { PLAN_MODE_WORKFLOW_STATE_EVENT } from "../plan-mode/events.ts";

const BLOCKING_UI_METHODS = ["select", "confirm", "input", "editor", "custom"];
const WAITING = { active: true, label: "waiting for feedback" };

function deferred() {
	let resolve;
	let reject;
	const promise = new Promise((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function nextTurn() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

function createUI() {
	return Object.fromEntries(BLOCKING_UI_METHODS.map((method) => [method, async () => method === "confirm" ? false : undefined]));
}

function createHarness(ui = createUI()) {
	const lifecycle = new Map();
	const bus = new Map();
	const reports = [];
	const events = {
		on(name, handler) {
			const handlers = bus.get(name) ?? [];
			handlers.push(handler);
			bus.set(name, handlers);
			return () => {
				const index = handlers.indexOf(handler);
				if (index >= 0) handlers.splice(index, 1);
			};
		},
		emit(name, payload) {
			if (name === "herdr:blocked") reports.push(payload);
			for (const handler of [...(bus.get(name) ?? [])]) handler(payload);
		},
	};
	const pi = {
		events,
		on(name, handler) {
			const handlers = lifecycle.get(name) ?? [];
			handlers.push(handler);
			lifecycle.set(name, handlers);
		},
	};
	extension(pi);
	return {
		ui,
		reports,
		emitEvent: (name, payload) => events.emit(name, payload),
		listenerCount: (name) => (bus.get(name) ?? []).length,
		async lifecycle(name, { mode = "tui", lifecycleUI = ui } = {}) {
			const ctx = { mode, hasUI: mode === "tui", ui: lifecycleUI };
			for (const handler of lifecycle.get(name) ?? []) await handler({}, ctx);
		},
	};
}

test("reduces duplicate and malformed producer events to effective boolean edges", async () => {
	const harness = createHarness();
	await harness.lifecycle("session_start");
	harness.emitEvent(ASK_USER_BLOCKED_EVENT, { active: true });
	harness.emitEvent(ASK_USER_BLOCKED_EVENT, { active: true });
	harness.emitEvent(ASK_USER_BLOCKED_EVENT, { active: "true" });
	harness.emitEvent(ASK_USER_BLOCKED_EVENT, null);
	assert.deepEqual(harness.reports, [WAITING, { active: false }]);
});

test("keeps the aggregate blocked for every overlap and clear order", async () => {
	for (const clearQuestionnaireFirst of [true, false]) {
		const ui = createUI();
		const custom = deferred();
		ui.custom = () => custom.promise;
		const harness = createHarness(ui);
		await harness.lifecycle("session_start");
		harness.emitEvent(PLAN_MODE_WORKFLOW_STATE_EVENT, { mode: "approval", feedbackPending: true });
		harness.emitEvent(ASK_USER_BLOCKED_EVENT, { active: true });
		const uiWait = ui.custom(() => undefined);

		if (clearQuestionnaireFirst) {
			harness.emitEvent(ASK_USER_BLOCKED_EVENT, { active: false });
			harness.emitEvent(PLAN_MODE_WORKFLOW_STATE_EVENT, { mode: "executing_all", feedbackPending: false });
		} else {
			harness.emitEvent(PLAN_MODE_WORKFLOW_STATE_EVENT, { mode: "executing_all", feedbackPending: false });
			harness.emitEvent(ASK_USER_BLOCKED_EVENT, { active: false });
		}
		assert.deepEqual(harness.reports, [WAITING]);
		custom.resolve(undefined);
		await uiWait;
		await nextTurn();
		assert.deepEqual(harness.reports, [WAITING, { active: false }]);
	}
});

test("wraps every standard blocking UI method without changing its contract", async () => {
	for (const method of BLOCKING_UI_METHODS) {
		const ui = createUI();
		const calls = [];
		const expected = method === "confirm" ? false : `${method}-result`;
		ui[method] = function (...args) {
			calls.push({ receiver: this, args });
			return Promise.resolve(expected);
		};
		const harness = createHarness(ui);
		await harness.lifecycle("session_start");
		const args = ["title", ["option"], { overlay: true }];
		assert.equal(await ui[method](...args), expected);
		await nextTurn();
		assert.deepEqual(calls, [{ receiver: ui, args }]);
		assert.deepEqual(harness.reports, [WAITING, { active: false }]);
	}
});

test("does not clear between immediate UI handoffs", async () => {
	const ui = createUI();
	const selected = deferred();
	const edited = deferred();
	ui.select = () => selected.promise;
	ui.editor = () => edited.promise;
	const harness = createHarness(ui);
	await harness.lifecycle("session_start");
	const handoff = (async () => {
		await ui.select("Plan ready", ["Change"]);
		return ui.editor("Change plan", "");
	})();
	selected.resolve("Change");
	await Promise.resolve();
	await Promise.resolve();
	assert.deepEqual(harness.reports, [WAITING]);
	edited.resolve("revised");
	assert.equal(await handoff, "revised");
	await nextTurn();
	assert.deepEqual(harness.reports, [WAITING, { active: false }]);
});

test("clears fallback waits after rejection and synchronous throw", async () => {
	for (const synchronous of [false, true]) {
		const ui = createUI();
		const failure = new Error(synchronous ? "sync" : "async");
		ui.input = synchronous ? (() => { throw failure; }) : (() => Promise.reject(failure));
		const harness = createHarness(ui);
		await harness.lifecycle("session_start");
		if (synchronous) assert.throws(() => ui.input("title"), failure);
		else await assert.rejects(ui.input("title"), failure);
		await nextTurn();
		assert.deepEqual(harness.reports, [WAITING, { active: false }]);
	}
});

test("restores durable workflow state but retires transient waits on replacement", async () => {
	const firstUI = createUI();
	const secondUI = createUI();
	const pending = deferred();
	firstUI.editor = () => pending.promise;
	const harness = createHarness(firstUI);
	harness.emitEvent(PLAN_MODE_WORKFLOW_STATE_EVENT, { mode: "approval", feedbackPending: true });
	await harness.lifecycle("session_start");
	const retired = firstUI.editor("feedback");
	harness.emitEvent(ASK_USER_BLOCKED_EVENT, { active: true });
	await harness.lifecycle("session_start", { lifecycleUI: secondUI });
	assert.equal(harness.listenerCount(ASK_USER_BLOCKED_EVENT), 1);
	assert.deepEqual(harness.reports, [WAITING, { active: false }, WAITING]);
	pending.resolve("late");
	await retired;
	await nextTurn();
	assert.deepEqual(harness.reports, [WAITING, { active: false }, WAITING]);
	harness.emitEvent(PLAN_MODE_WORKFLOW_STATE_EVENT, { mode: "executing_all", feedbackPending: false });
	assert.deepEqual(harness.reports, [WAITING, { active: false }, WAITING, { active: false }]);
});

test("shutdown restores UI, unsubscribes, clears once, and ignores retired completions", async () => {
	const ui = createUI();
	const pending = deferred();
	ui.select = () => pending.promise;
	const original = ui.select;
	const harness = createHarness(ui);
	await harness.lifecycle("session_start");
	const retired = ui.select("question", []);
	await harness.lifecycle("session_shutdown");
	assert.equal(ui.select, original);
	assert.equal(harness.listenerCount(ASK_USER_BLOCKED_EVENT), 0);
	assert.equal(harness.listenerCount(PLAN_MODE_WORKFLOW_STATE_EVENT), 0);
	assert.deepEqual(harness.reports, [WAITING, { active: false }]);
	pending.resolve(undefined);
	await retired;
	await nextTurn();
	assert.deepEqual(harness.reports, [WAITING, { active: false }]);
});

test("does not instrument or report from non-TUI sessions", async () => {
	const ui = createUI();
	const original = ui.select;
	const harness = createHarness(ui);
	await harness.lifecycle("session_start", { mode: "rpc" });
	assert.equal(ui.select, original);
	harness.emitEvent(ASK_USER_BLOCKED_EVENT, { active: true });
	await ui.select("question", []);
	assert.deepEqual(harness.reports, []);
});
