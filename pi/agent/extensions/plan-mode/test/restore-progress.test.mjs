import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { splitManagedProgressReport } from "../plan-document.js";
import {
	approveExecution,
	createInitialState,
	enterPlanning,
	submitPlan,
} from "../state.js";
import { PART_PLAN } from "./fixtures.mjs";

const root = process.env.PI_PACKAGE_ROOT || "/opt/homebrew/Cellar/pi-coding-agent/0.82.1/libexec/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${root}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { alias: {
	"@earendil-works/pi-coding-agent": `${root}/dist/index.js`,
	"@earendil-works/pi-tui": `${root}/node_modules/@earendil-works/pi-tui/dist/index.js`,
	"@earendil-works/pi-ai": `${root}/node_modules/@earendil-works/pi-ai/dist/index.js`,
	"typebox": `${root}/node_modules/typebox/build/index.mjs`,
} });
const extension = await jiti.import(new URL("../index.ts", import.meta.url).pathname);

test("restored current execution reconstructs Part titles and backfills its missing report", async () => {
	const project = await mkdtemp(path.join(os.tmpdir(), "pi-plan-restore-"));
	try {
		const plansDir = path.join(project, ".pi", "plans");
		await mkdir(plansDir, { recursive: true });
		const planPath = path.join(plansDir, "current.md");
		await writeFile(planPath, PART_PLAN);
		const hash = createHash("sha256").update(PART_PLAN, "utf8").digest("hex");

		let state = enterPlanning(createInitialState(), ["read", "bash"]).state;
		state = submitPlan(state, {
			path: planPath,
			slug: "older",
			hash,
			title: "Add Reliable Cache Invalidation",
			intent: "older execution",
			approvalNonce: "approval",
			stages: [
				{ id: "A", description: "Define cache consistency", taskIds: ["A"] },
				{ id: "B", description: "Implement reliable invalidation", taskIds: ["B"] },
				{ id: "C", description: "Cover boundary behavior", taskIds: ["C"] },
			],
			tasks: [
				{ id: "A", title: "Define cache consistency", status: "pending" },
				{ id: "B", title: "Implement reliable invalidation", status: "in_progress" },
				{ id: "C", title: "Cover boundary behavior", status: "blocked" },
			],
		}).state;
		state = approveExecution(state, "approval", "all").state;
		delete state.plan.tasks;

		const branch = [
			{
				type: "custom",
				customType: "plan-mode-execution",
				data: {
					handoff: "in_place",
					runId: "run",
					approvedMarkdown: PART_PLAN,
					planPath,
					planHash: hash,
					executionMode: "all",
					originalActiveTools: ["read", "bash"],
					sessionPath: null,
					boundaryHash: "boundary",
				},
			},
			{ type: "custom", customType: "plan-mode-state", data: state },
		];
		const handlers = new Map();
		let activeTools = ["read", "bash"];
		const allTools = new Set(activeTools);
		let widget;
		const pi = {
			events: { on() { return () => {}; }, emit() {} },
			registerFlag() {}, getFlag() { return false; }, registerShortcut() {}, registerEntryRenderer() {}, registerCommand() {},
			registerTool(definition) { allTools.add(definition.name); },
			on(name, handler) { if (!handlers.has(name)) handlers.set(name, []); handlers.get(name).push(handler); },
			appendEntry(customType, data) { branch.push({ type: "custom", customType, data }); },
			getActiveTools() { return [...activeTools]; },
			getAllTools() { return [...allTools].map((name) => ({ name })); },
			setActiveTools(names) { activeTools = [...names]; },
			sendMessage() {}, sendUserMessage() {},
		};
		extension.default(pi);
		const ctx = {
			cwd: project,
			mode: "tui",
			hasUI: true,
			isProjectTrusted: () => true,
			hasPendingMessages: () => false,
			sessionManager: { getBranch: () => branch, getSessionFile: () => "/sessions/older.jsonl" },
			ui: {
				theme: { fg: (_color, text) => text },
				notify() {}, setStatus() {},
				setWidget(name, value) { if (name === "plan-mode-ledger") widget = value; },
			},
		};
		for (const handler of handlers.get("session_start")) await handler({ reason: "resume" }, ctx);

		assert.deepEqual(widget, [
			"☐ Define cache consistency",
			"▶ Implement reliable invalidation",
			"⛔ Cover boundary behavior",
		]);
		assert.deepEqual(branch.filter((entry) => entry.customType === "plan-mode-state").at(-1).data.plan.tasks, [
			{ id: "A", title: "Define cache consistency" },
			{ id: "B", title: "Implement reliable invalidation" },
			{ id: "C", title: "Cover boundary behavior" },
		]);
		assert.deepEqual(splitManagedProgressReport(await readFile(planPath, "utf8")).report.rows, widget);
	} finally {
		await rm(project, { recursive: true, force: true });
	}
});
