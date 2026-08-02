import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MAX_PLAN_BYTES, splitManagedProgressReport } from "../plan-document.js";
import {
	MAX_SLUG_LENGTH,
	PlanStoreError,
	persistPlan,
	restorePlanFile,
	sanitizeIntentSlug,
} from "../plan-store.js";
import { VALID_PLAN } from "./fixtures.mjs";

async function withProject(run) {
	const root = await mkdtemp(path.join(os.tmpdir(), "pi-plan-store-"));
	const project = path.join(root, "project");
	await mkdir(project);
	try {
		await run(project, root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

const baseOptions = {
	intent: "Add reliable cache invalidation",
	title: "Add Reliable Cache Invalidation",
	markdown: VALID_PLAN,
};

test("normalizes intent to a bounded safe slug", () => {
	assert.equal(sanitizeIntentSlug("  Héllo, WORLD! ../ cache  "), "hello-world-cache");
	assert.equal(sanitizeIntentSlug("日本語"), "plan");
	assert.equal(sanitizeIntentSlug("x".repeat(500)).length, MAX_SLUG_LENGTH);
});

test("persists validated plans atomically and allocates collision suffixes", async () => {
	await withProject(async (project) => {
		const first = await persistPlan({ cwd: project, ...baseOptions });
		const second = await persistPlan({ cwd: project, ...baseOptions });
		assert.equal(first.slug, "add-reliable-cache-invalidation");
		assert.equal(second.slug, "add-reliable-cache-invalidation-2");
		assert.equal(await readFile(first.path, "utf8"), first.markdown);
		assert.match(first.markdown, /<!-- pi-plan-mode:progress:start -->[\s\S]*- ☐ Define the cache behavior[\s\S]*- ▶ Add reliable invalidation[\s\S]*- ⛔ Cover boundary conditions[\s\S]*<!-- pi-plan-mode:progress:end -->\n$/);
		assert.match(first.hash, /^[a-f0-9]{64}$/);
		assert.deepEqual(first.document.stages.map((stage) => stage.id), ["1", "2"]);

		await assert.rejects(
			persistPlan({
				cwd: project,
				...baseOptions,
				intent: "Transient failure",
				renameFile: async () => { throw new Error("simulated first-write failure"); },
			}),
			/simulated first-write failure/,
		);
		const retry = await persistPlan({ cwd: project, ...baseOptions, intent: "Transient failure" });
		assert.equal(retry.slug, "transient-failure", "failed atomic writes must release their filename reservation");
	});
});

test("replaces only the validated active revision and preserves it on I/O failure", async () => {
	await withProject(async (project) => {
		const first = await persistPlan({ cwd: project, ...baseOptions });
		const revisedMarkdown = VALID_PLAN.replace("failed writes", "rejected writes");
		await assert.rejects(
			persistPlan({
				cwd: project,
				...baseOptions,
				markdown: revisedMarkdown,
				existingPlan: { path: first.path, hash: first.hash },
				renameFile: async () => { throw new Error("simulated rename failure"); },
			}),
			/simulated rename failure/,
		);
		assert.equal(await readFile(first.path, "utf8"), first.markdown);

		const revised = await persistPlan({
			cwd: project,
			...baseOptions,
			markdown: revisedMarkdown,
			existingPlan: { path: first.path, hash: first.hash },
		});
		assert.equal(revised.path, first.path);
		assert.notEqual(revised.hash, first.hash);
	});
});

test("restores a missing validated plan from its durable transcript copy", async () => {
	await withProject(async (project) => {
		const first = await persistPlan({ cwd: project, ...baseOptions });
		await rm(first.path);
		const restored = await restorePlanFile({
			cwd: project,
			path: first.path,
			markdown: first.markdown,
			expectedHash: first.hash,
			title: baseOptions.title,
		});
		assert.equal(restored.restored, true);
		assert.equal(await readFile(first.path, "utf8"), first.markdown);

		const existing = await restorePlanFile({
			cwd: project,
			path: first.path,
			markdown: first.markdown,
			expectedHash: first.hash,
			title: baseOptions.title,
		});
		assert.equal(existing.restored, false);
	});
});

test("rejects drift, arbitrary revision paths, and symlink escapes", async () => {
	await withProject(async (project, root) => {
		const first = await persistPlan({ cwd: project, ...baseOptions });
		await writeFile(first.path, `${VALID_PLAN}\n<!-- user edit -->\n`);
		await assert.rejects(
			persistPlan({ cwd: project, ...baseOptions, existingPlan: { path: first.path, hash: first.hash } }),
			(error) => error instanceof PlanStoreError && error.code === "revision_drift",
		);
		await assert.rejects(
			persistPlan({ cwd: project, ...baseOptions, existingPlan: { path: path.join(root, "outside.md"), hash: first.hash } }),
			(error) => error instanceof PlanStoreError && error.code === "path_escape",
		);
	});

	await withProject(async (project, root) => {
		const outside = path.join(root, "outside");
		await mkdir(outside);
		await symlink(outside, path.join(project, ".pi"));
		await assert.rejects(
			persistPlan({ cwd: project, ...baseOptions }),
			(error) => error instanceof PlanStoreError && error.code === "symlink_escape",
		);
		await assert.rejects(readFile(path.join(outside, "plans", "add-reliable-cache-invalidation.md"), "utf8"));
	});
});

test("regenerates one managed report during revision without trusting stale rows", async () => {
	await withProject(async (project) => {
		const first = await persistPlan({ cwd: project, ...baseOptions });
		const edited = first.markdown.replace(
			"### Step 1 [pending] Define the cache behavior",
			"### Step 1 [pending] Define cache ownership",
		);
		const revised = await persistPlan({
			cwd: project,
			...baseOptions,
			markdown: edited,
			existingPlan: { path: first.path, hash: first.hash },
		});
		const report = splitManagedProgressReport(revised.markdown).report;
		assert.deepEqual(report.rows, [
			"☐ Define cache ownership",
			"▶ Add reliable invalidation",
			"⛔ Cover boundary conditions",
		]);
		assert.equal((revised.markdown.match(/pi-plan-mode:progress:start/g) ?? []).length, 1);
	});
});

test("rejects malformed or ambiguous managed report markers", async () => {
	await withProject(async (project) => {
		await assert.rejects(
			persistPlan({ cwd: project, ...baseOptions, markdown: `${VALID_PLAN}\n<!-- pi-plan-mode:progress:start -->\n` }),
			(error) => error instanceof PlanStoreError && error.code === "validation_failed" &&
				error.details.some((item) => item.code === "ambiguous_progress_report"),
		);
		const first = await persistPlan({ cwd: project, ...baseOptions });
		await assert.rejects(
			persistPlan({
				cwd: project,
				...baseOptions,
				markdown: `${first.markdown}\n${first.markdown.slice(first.markdown.indexOf("<!-- pi-plan-mode:progress:start -->"))}`,
				existingPlan: { path: first.path, hash: first.hash },
			}),
			(error) => error instanceof PlanStoreError && error.code === "validation_failed" &&
				error.details.some((item) => item.code === "ambiguous_progress_report"),
		);
	});
});

test("rejects plans whose generated report would exceed the size limit", async () => {
	await withProject(async (project) => {
		const padding = "x".repeat(MAX_PLAN_BYTES - Buffer.byteLength(VALID_PLAN, "utf8") - 32);
		const nearLimit = `${VALID_PLAN}${padding}`;
		assert.ok(Buffer.byteLength(nearLimit, "utf8") < MAX_PLAN_BYTES);
		await assert.rejects(
			persistPlan({ cwd: project, ...baseOptions, markdown: nearLimit }),
			(error) => error instanceof PlanStoreError && error.code === "validation_failed" &&
				error.details.some((item) => item.code === "plan_too_large"),
		);
	});
});

test("validates size and title before writing and bounds collision probing", async () => {
	await withProject(async (project) => {
		await assert.rejects(
			persistPlan({ cwd: project, ...baseOptions, title: "Different title" }),
			(error) => error instanceof PlanStoreError && error.code === "title_mismatch",
		);
		await assert.rejects(
			persistPlan({ cwd: project, ...baseOptions, configDirName: "../escape" }),
			(error) => error instanceof PlanStoreError && error.code === "invalid_config_dir",
		);
		await assert.rejects(
			persistPlan({ cwd: project, ...baseOptions, markdown: `${VALID_PLAN}${"x".repeat(MAX_PLAN_BYTES)}` }),
			(error) => error instanceof PlanStoreError && error.code === "validation_failed",
		);

		await persistPlan({ cwd: project, ...baseOptions });
		await assert.rejects(
			persistPlan({ cwd: project, ...baseOptions, maxCollisionProbes: 1 }),
			(error) => error instanceof PlanStoreError && error.code === "collision_exhausted",
		);
	});
});
