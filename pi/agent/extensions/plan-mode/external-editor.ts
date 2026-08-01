import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import {
	getAgentDir,
	SettingsManager,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { prepareEditorInvocation } from "./external-editor-command.js";
import { atomicReplaceFile } from "./plan-store.js";

export interface EditorResult {
	ok: boolean;
	changed: boolean;
	content: string;
	error?: string;
	fallback: boolean;
}

async function runConfiguredEditor(ctx: ExtensionContext, planPath: string): Promise<{ ok: boolean; error?: string }> {
	if (ctx.mode !== "tui") return { ok: false, error: "External editor requires TUI mode" };
	const manager = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
	const invocation = prepareEditorInvocation(manager.getExternalEditorCommand(), planPath);
	const status = await ctx.ui.custom<{ ok: boolean; error?: string }>((tui, _theme, _keybindings, done) => {
		tui.stop();
		let outcome: { ok: boolean; error?: string };
		try {
			const result = spawnSync(invocation.executable, invocation.args, { stdio: "inherit", env: process.env });
			outcome = result.error
				? { ok: false, error: result.error.message }
				: result.status === 0
					? { ok: true }
					: { ok: false, error: `Editor exited with status ${result.status ?? "unknown"}` };
		} catch (error) {
			outcome = { ok: false, error: error instanceof Error ? error.message : String(error) };
		} finally {
			tui.start();
			tui.requestRender(true);
		}
		done(outcome);
		return { render: () => [], invalidate: () => {} };
	});
	return status ?? { ok: false, error: "Editor was cancelled" };
}

export async function editPlanForReview(ctx: ExtensionContext, planPath: string, original: string): Promise<EditorResult> {
	const backupPath = `${planPath}.review-backup-${process.pid}-${randomBytes(6).toString("hex")}`;
	await writeFile(backupPath, original, { encoding: "utf8", flag: "wx", mode: 0o600 });
	try {
		let external: { ok: boolean; error?: string };
		try {
			external = await runConfiguredEditor(ctx, planPath);
		} catch (error) {
			external = { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		if (external.ok) {
			const content = await readFile(planPath, "utf8");
			return { ok: true, changed: content !== original, content, fallback: false };
		}
		// A failed editor may still have partially written the file. Restore the last
		// validated revision before offering the in-Pi fallback.
		await atomicReplaceFile(planPath, original);
		if (!ctx.hasUI) return { ok: false, changed: false, content: original, error: external.error, fallback: false };
		const edited = await ctx.ui.editor("Review plan (! directive, ? question)", original);
		if (edited === undefined) return { ok: false, changed: false, content: original, error: external.error, fallback: true };
		if (edited !== original) await atomicReplaceFile(planPath, edited);
		return { ok: true, changed: edited !== original, content: edited, error: external.error, fallback: true };
	} finally {
		await rm(backupPath, { force: true });
	}
}
