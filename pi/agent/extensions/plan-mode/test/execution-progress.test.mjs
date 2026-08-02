import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { splitManagedProgressReport } from "../plan-document.js";
import { persistPlan } from "../plan-store.js";
import { buildStepProgressRows, getDocumentProgressTasks } from "../progress-widget.js";
import {
	approveExecution,
	createInitialState,
	enterPlanning,
	submitPlan,
} from "../state.js";
import { SMALL_PLAN } from "./fixtures.mjs";

const root = process.env.PI_PACKAGE_ROOT || "/opt/homebrew/Cellar/pi-coding-agent/0.82.1/libexec/lib/node_modules/@earendil-works/pi-coding-agent";
const { createJiti } = await import(`${root}/node_modules/jiti/lib/jiti.mjs`);
const jiti = createJiti(import.meta.url, { alias: {
	"@earendil-works/pi-coding-agent": `${root}/dist/index.js`,
	"@earendil-works/pi-tui": `${root}/node_modules/@earendil-works/pi-tui/dist/index.js`,
	"@earendil-works/pi-ai": `${root}/node_modules/@earendil-works/pi-ai/dist/index.js`,
	"typebox": `${root}/node_modules/typebox/build/index.mjs`,
} });
const { registerExecutionTools } = await jiti.import(new URL("../execution.ts", import.meta.url).pathname);

function expectedRows(state) {
	return buildStepProgressRows(state);
}

async function fileRows(planPath) {
	return splitManagedProgressReport(await readFile(planPath, "utf8")).report.rows;
}

test("accepted progress transitions atomically synchronize widget and saved Step rows", async () => {
	const project = await mkdtemp(path.join(os.tmpdir(), "pi-plan-progress-"));
	try {
		const stored = await persistPlan({
			cwd: project,
			intent: "Clarify cache documentation",
			title: "Clarify Cache Documentation",
			markdown: SMALL_PLAN,
		});
		let state = enterPlanning(createInitialState(), ["read"]).state;
		const tasks = getDocumentProgressTasks(stored.document);
		state = submitPlan(state, {
			path: stored.path,
			slug: stored.slug,
			hash: stored.hash,
			title: stored.document.title,
			intent: "Clarify cache documentation",
			approvalNonce: "approval",
			stages: stored.document.stages.map((stage) => ({
				id: stage.id, description: stage.description, taskIds: stage.stepIds,
			})),
			tasks,
		}).state;
		state = approveExecution(state, "approval", "all").state;

		const contract = {
			version: 1,
			approvedMarkdown: stored.markdown,
			planPath: stored.path,
			planHash: stored.hash,
			executionMode: "all",
			originalActiveTools: ["read"],
			parentSessionPath: null,
		};
		const tools = new Map();
		registerExecutionTools({
			registerTool(definition) { tools.set(definition.name, definition); },
			sendUserMessage() {},
		}, {
			getState: () => state,
			getContract: () => contract,
			commit(result) { if (result.ok) state = result.state; },
			commitState(next) { state = next; },
			refreshUI() {},
		});
		const progress = tools.get("plan_progress");
		const ctx = {};

		for (const update of [
			{ taskId: "1", status: "in_progress" },
			{ taskId: "1", status: "completed", evidence: "docs test passed" },
			{ taskId: "1", status: "in_progress", reopenReason: "user requested clarification" },
			{ taskId: "1", status: "blocked", note: "waiting on policy", evidence: "owner unavailable" },
		]) {
			await progress.execute("progress", update, undefined, undefined, ctx);
			assert.deepEqual(await fileRows(stored.path), expectedRows(state));
		}

		const beforeFailedWrite = await readFile(stored.path, "utf8");
		await assert.rejects(
			progress.execute("oversized", {
				taskId: "1", status: "in_progress", note: "x".repeat(300_000),
			}, undefined, undefined, ctx),
			/exceeds the 262144-byte limit/,
		);
		assert.equal(state.ledger["1"].status, "blocked");
		assert.equal(await readFile(stored.path, "utf8"), beforeFailedWrite);

		const plansDir = path.dirname(stored.path);
		await chmod(plansDir, 0o500);
		try {
			await assert.rejects(
				progress.execute("failed-write", { taskId: "1", status: "in_progress" }, undefined, undefined, ctx),
			);
		} finally {
			await chmod(plansDir, 0o700);
		}
		assert.equal(state.ledger["1"].status, "blocked", "runtime state must not commit after a failed file write");
		assert.equal(await readFile(stored.path, "utf8"), beforeFailedWrite);

		await rm(stored.path);
		await progress.execute("recover", { taskId: "1", status: "in_progress" }, undefined, undefined, ctx);
		assert.equal(state.ledger["1"].status, "in_progress");
		assert.deepEqual(await fileRows(stored.path), expectedRows(state));

		const malformed = `${await readFile(stored.path, "utf8")}\n<!-- pi-plan-mode:progress:start -->\n`;
		await writeFile(stored.path, malformed);
		await assert.rejects(
			progress.execute("malformed", { taskId: "1", status: "completed", evidence: "would pass" }, undefined, undefined, ctx),
			/managed progress report/,
		);
		assert.equal(state.ledger["1"].status, "in_progress");
		assert.equal(await readFile(stored.path, "utf8"), malformed);
	} finally {
		await rm(project, { recursive: true, force: true });
	}
});
