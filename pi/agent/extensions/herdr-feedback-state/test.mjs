import assert from "node:assert/strict";
import test from "node:test";
import extension, { asksForFeedback, latestSettledAssistantText } from "./index.ts";
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

function createHarness(branch = [], ui = createUI()) {
	const lifecycle = new Map();
	const bus = new Map();
	const reports = [];
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
			if (name === "herdr:blocked") reports.push(payload);
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
		reports,
		ui,
		emitBus: (name, payload) => events.emit(name, payload),
		busListenerCount: (name) => (bus.get(name) ?? []).length,
		async emitLifecycle(name, event = {}, { hasUI = true, mode = "tui", lifecycleUI = ui } = {}) {
			const ctx = {
				hasUI,
				mode,
				ui: lifecycleUI,
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

test("wraps every blocking UI method without changing this, arguments, or cancellation", async () => {
	for (const method of BLOCKING_UI_METHODS) {
		const ui = createUI();
		const harness = createHarness([], ui);
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
		assert.deepEqual(harness.reports, [
			{ active: true, label: "waiting for feedback" },
			{ active: false },
		], method);
	}
});

test("preserves blocking UI rejection and synchronous throw cleanup", async () => {
	const rejectedUI = createUI();
	const rejectedHarness = createHarness([], rejectedUI);
	const rejection = new Error("cancelled by extension");
	rejectedUI.select = () => Promise.reject(rejection);
	await rejectedHarness.emitLifecycle("session_start");
	await assert.rejects(rejectedUI.select("Choose", []), (error) => error === rejection);
	await nextTurn();
	assert.deepEqual(rejectedHarness.reports, [
		{ active: true, label: "waiting for feedback" },
		{ active: false },
	]);

	const throwingUI = createUI();
	const throwingHarness = createHarness([], throwingUI);
	const thrown = new Error("synchronous extension failure");
	throwingUI.input = () => { throw thrown; };
	await throwingHarness.emitLifecycle("session_start");
	assert.throws(() => throwingUI.input("Input"), (error) => error === thrown);
	await nextTurn();
	assert.deepEqual(throwingHarness.reports, [
		{ active: true, label: "waiting for feedback" },
		{ active: false },
	]);
});

test("overlapping and nested blocking UI emits one active and one final inactive", async () => {
	const ui = createUI();
	const harness = createHarness([], ui);
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
	assert.deepEqual(harness.reports, [{ active: true, label: "waiting for feedback" }]);
	second.resolve(true);
	assert.equal(await secondResult, true);
	await nextTurn();
	assert.deepEqual(harness.reports, [
		{ active: true, label: "waiting for feedback" },
		{ active: false },
	]);

	const nestedUI = createUI();
	const nestedHarness = createHarness([], nestedUI);
	const nested = deferred();
	nestedUI.editor = () => nested.promise;
	nestedUI.select = function () { return this.editor("Nested editor"); };
	await nestedHarness.emitLifecycle("session_start");
	const nestedResult = nestedUI.select("Change", []);
	nested.resolve("updated");
	assert.equal(await nestedResult, "updated");
	await nextTurn();
	assert.deepEqual(nestedHarness.reports, [
		{ active: true, label: "waiting for feedback" },
		{ active: false },
	]);
});

test("an immediate selector-to-editor handoff does not clear between dialogs", async () => {
	const ui = createUI();
	const harness = createHarness([], ui);
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
	assert.deepEqual(harness.reports, [{ active: true, label: "waiting for feedback" }]);
	edited.resolve("revised");
	assert.equal(await handoff, "revised");
	await nextTurn();
	assert.deepEqual(harness.reports, [
		{ active: true, label: "waiting for feedback" },
		{ active: false },
	]);
});

test("does not instrument or report from non-TUI sessions", async () => {
	const ui = createUI();
	const original = ui.select;
	const harness = createHarness([], ui);
	await harness.emitLifecycle("session_start", {}, { mode: "rpc", hasUI: true });
	assert.equal(ui.select, original);
	await ui.select("Question", []);
	await harness.emitLifecycle("agent_settled");
	assert.deepEqual(harness.reports, []);
});

test("restores UI and unsubscribes workflow listeners on shutdown without late reports", async () => {
	const ui = createUI();
	const pending = deferred();
	ui.custom = () => pending.promise;
	const originalMethods = Object.fromEntries(BLOCKING_UI_METHODS.map((method) => [method, ui[method]]));
	const harness = createHarness([], ui);
	assert.equal(harness.busListenerCount(PLAN_MODE_WORKFLOW_STATE_EVENT), 1);
	await harness.emitLifecycle("session_start");
	const waiting = ui.custom(() => undefined);
	await harness.emitLifecycle("session_shutdown");
	for (const method of BLOCKING_UI_METHODS) assert.equal(ui[method], originalMethods[method], method);
	assert.equal(harness.busListenerCount(PLAN_MODE_WORKFLOW_STATE_EVENT), 0);
	harness.emitBus(PLAN_MODE_WORKFLOW_STATE_EVENT, { feedbackPending: true });
	pending.resolve("done");
	assert.equal(await waiting, "done");
	await nextTurn();
	assert.deepEqual(harness.reports, [{ active: true, label: "waiting for feedback" }]);
});

test("does not consume the structured-question package event", async () => {
	const harness = createHarness();
	await harness.emitLifecycle("session_start");
	harness.emitBus("rpiv:ask-user:blocked", { active: true });
	harness.emitBus("rpiv:ask-user:blocked", { active: false });
	assert.deepEqual(harness.reports, []);
});

test("restores durable feedback published before session_start", async () => {
	const harness = createHarness();
	harness.emitBus(PLAN_MODE_WORKFLOW_STATE_EVENT, { mode: "approval", feedbackPending: true });
	await harness.emitLifecycle("session_start");
	assert.deepEqual(harness.reports, [{ active: true, label: "waiting for feedback" }]);
});

test("composes durable approval and staged waits with blocking UI", async () => {
	for (const mode of ["approval", "executing_staged"]) {
		const ui = createUI();
		const pending = deferred();
		ui.editor = () => pending.promise;
		const harness = createHarness([], ui);
		await harness.emitLifecycle("session_start");
		harness.emitBus(PLAN_MODE_WORKFLOW_STATE_EVENT, { mode, feedbackPending: true });
		const editor = ui.editor("Feedback");
		harness.emitBus(PLAN_MODE_WORKFLOW_STATE_EVENT, { mode, feedbackPending: false });
		pending.resolve("feedback");
		assert.equal(await editor, "feedback");
		await nextTurn();
		assert.deepEqual(harness.reports, [
			{ active: true, label: "waiting for feedback" },
			{ active: false },
		], mode);
	}
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
