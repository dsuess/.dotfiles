import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { splitManagedProgressReport } from "../plan-document.js";
import { persistPlan } from "../plan-store.js";
import { buildProgressRows, getDocumentProgressTasks } from "../progress-widget.js";
import {
	approveExecution,
	createInitialState,
	enterPlanning,
	submitPlan,
} from "../state.js";
import { PART_MINIMAL_PLAN } from "./fixtures.mjs";
import { createPiJiti } from "../../../../test-helpers.mjs";

const jiti = await createPiJiti(import.meta.url);
const { registerExecutionTools } = await jiti.import(new URL("../execution.ts", import.meta.url).pathname);

function expectedRows(state) {
	return buildProgressRows(state);
}

async function fileRows(planPath) {
	return splitManagedProgressReport(await readFile(planPath, "utf8")).report.rows;
}

test("Part IDs drive plan_progress while status remains managed metadata", async () => {
	const project = await mkdtemp(path.join(os.tmpdir(), "pi-part-progress-"));
	try {
		const stored = await persistPlan({
			cwd: project,
			intent: "Clarify cache documentation",
			title: "Clarify Cache Documentation",
			markdown: PART_MINIMAL_PLAN,
		});
		let state = enterPlanning(createInitialState(), ["read"]).state;
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
			tasks: getDocumentProgressTasks(stored.document),
		}).state;
		state = approveExecution(state, "approval", "all").state;
		const contract = {
			handoff: "in_place",
			runId: "run",
			approvedMarkdown: stored.markdown,
			planPath: stored.path,
			planHash: stored.hash,
			executionMode: "all",
			originalActiveTools: ["read"],
			sessionPath: null,
			boundaryHash: "boundary",
		};
		const tools = new Map();
		registerExecutionTools({ registerTool(definition) { tools.set(definition.name, definition); } }, {
			getState: () => state,
			getContract: () => contract,
			commit() {},
			commitState(next) { state = next; },
			refreshUI() {},
		});
		const progress = tools.get("plan_progress");
		assert.deepEqual(progress.prepareArguments({ taskId: "A", status: "in_progress" }), {
			taskId: "A", status: "in_progress", itemId: "A",
		});
		await progress.execute("start", { itemId: "A", status: "in_progress" }, undefined, undefined, {});
		await rm(stored.path);
		await progress.execute("finish", { itemId: "A", status: "completed", evidence: "documentation reviewed" }, undefined, undefined, {});
		const markdown = await readFile(stored.path, "utf8");
		assert.match(markdown, /### Part A — Clarify the cache lifecycle\n- \*\*Ledger:\*\* \{"status":"completed"/);
		assert.doesNotMatch(markdown, /Part A \[completed\]/);
		assert.deepEqual(await fileRows(stored.path), ["☑ Clarify the cache lifecycle"]);
	} finally {
		await rm(project, { recursive: true, force: true });
	}
});

test("accepted progress transitions atomically synchronize widget and saved Part rows", async () => {
	const project = await mkdtemp(path.join(os.tmpdir(), "pi-plan-progress-"));
	try {
		const stored = await persistPlan({
			cwd: project,
			intent: "Clarify cache documentation",
			title: "Clarify Cache Documentation",
			markdown: PART_MINIMAL_PLAN,
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
			handoff: "in_place",
			runId: "run",
			approvedMarkdown: stored.markdown,
			planPath: stored.path,
			planHash: stored.hash,
			executionMode: "all",
			originalActiveTools: ["read"],
			sessionPath: null,
			boundaryHash: "boundary",
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
			{ itemId: "A", status: "in_progress" },
			{ itemId: "A", status: "completed", evidence: "docs test passed" },
			{ itemId: "A", status: "in_progress", reopenReason: "user requested clarification" },
			{ itemId: "A", status: "blocked", note: "waiting on policy", evidence: "owner unavailable" },
		]) {
			await progress.execute("progress", update, undefined, undefined, ctx);
			assert.deepEqual(await fileRows(stored.path), expectedRows(state));
		}

		const beforeFailedWrite = await readFile(stored.path, "utf8");
		await assert.rejects(
			progress.execute("oversized", {
				itemId: "A", status: "in_progress", note: "x".repeat(300_000),
			}, undefined, undefined, ctx),
			/exceeds the 262144-byte limit/,
		);
		assert.equal(state.ledger.A.status, "blocked");
		assert.equal(await readFile(stored.path, "utf8"), beforeFailedWrite);

		const plansDir = path.dirname(stored.path);
		await chmod(plansDir, 0o500);
		try {
			await assert.rejects(
				progress.execute("failed-write", { itemId: "A", status: "in_progress" }, undefined, undefined, ctx),
			);
		} finally {
			await chmod(plansDir, 0o700);
		}
		assert.equal(state.ledger.A.status, "blocked", "runtime state must not commit after a failed file write");
		assert.equal(await readFile(stored.path, "utf8"), beforeFailedWrite);

		await rm(stored.path);
		await progress.execute("recover", { itemId: "A", status: "in_progress" }, undefined, undefined, ctx);
		assert.equal(state.ledger.A.status, "in_progress");
		assert.deepEqual(await fileRows(stored.path), expectedRows(state));

		const malformed = `${await readFile(stored.path, "utf8")}\n<!-- pi-plan-mode:progress:start -->\n`;
		await writeFile(stored.path, malformed);
		await assert.rejects(
			progress.execute("malformed", { itemId: "A", status: "completed", evidence: "would pass" }, undefined, undefined, ctx),
			/managed progress report/,
		);
		assert.equal(state.ledger.A.status, "in_progress");
		assert.equal(await readFile(stored.path, "utf8"), malformed);
	} finally {
		await rm(project, { recursive: true, force: true });
	}
});
