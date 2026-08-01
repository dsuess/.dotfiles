import { createHash, randomBytes } from "node:crypto";
import {
	lstat,
	mkdir,
	open,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parsePlanDocument } from "./plan-document.js";

export const MAX_INTENT_BYTES = 16 * 1024;
export const MAX_SLUG_LENGTH = 64;
export const MAX_COLLISION_PROBES = 100;

export class PlanStoreError extends Error {
	constructor(code, message, details = undefined) {
		super(message);
		this.name = "PlanStoreError";
		this.code = code;
		this.details = details;
	}
}

function isWithin(root, candidate) {
	const path = relative(root, candidate);
	return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function sanitizeIntentSlug(intent, maxLength = MAX_SLUG_LENGTH) {
	if (typeof intent !== "string") throw new PlanStoreError("invalid_intent", "Plan intent must be a string");
	if (Buffer.byteLength(intent, "utf8") > MAX_INTENT_BYTES) {
		throw new PlanStoreError("intent_too_large", `Plan intent exceeds ${MAX_INTENT_BYTES} bytes`);
	}
	const slug = intent
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, maxLength)
		.replace(/-+$/g, "");
	return slug || "plan";
}

async function ensureSafePlansRoot(cwd, configDirName) {
	if (typeof configDirName !== "string" || !configDirName || configDirName === "." || configDirName === ".." || /[\\/]/.test(configDirName)) {
		throw new PlanStoreError("invalid_config_dir", "The project config directory name must be one safe path segment");
	}
	const cwdReal = await realpath(cwd);
	const configPath = resolve(cwd, configDirName);
	const plansPath = join(configPath, "plans");

	for (const candidate of [configPath, plansPath]) {
		try {
			const stats = await lstat(candidate);
			if (stats.isSymbolicLink()) {
				const target = await realpath(candidate);
				if (!isWithin(cwdReal, target)) {
					throw new PlanStoreError("symlink_escape", `${candidate} resolves outside the project`);
				}
				const targetStats = await lstat(target);
				if (!targetStats.isDirectory()) throw new PlanStoreError("invalid_plan_root", `${candidate} is not a directory`);
			} else if (!stats.isDirectory()) {
				throw new PlanStoreError("invalid_plan_root", `${candidate} is not a directory`);
			}
		} catch (error) {
			if (error?.code !== "ENOENT") throw error;
			await mkdir(candidate);
		}
	}

	const plansReal = await realpath(plansPath);
	if (!isWithin(cwdReal, plansReal)) {
		throw new PlanStoreError("path_escape", "The plans directory resolves outside the project");
	}
	return plansReal;
}

function hashContent(content) {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

async function verifyRevisionTarget(path, plansRoot, expectedHash) {
	if (typeof path !== "string" || !isAbsolute(path)) {
		throw new PlanStoreError("path_escape", "The existing plan path must be absolute");
	}
	const target = resolve(path);
	if (!isWithin(plansRoot, target) || dirname(target) !== plansRoot || !target.endsWith(".md")) {
		throw new PlanStoreError("path_escape", "The existing plan path is outside the project plans directory");
	}
	const stats = await lstat(target);
	if (stats.isSymbolicLink() || !stats.isFile()) {
		throw new PlanStoreError("unsafe_revision_target", "The existing plan must be a regular, non-symlink file");
	}
	const current = await readFile(target, "utf8");
	if (typeof expectedHash !== "string" || hashContent(current) !== expectedHash) {
		throw new PlanStoreError("revision_drift", "The saved plan changed since its last validated revision");
	}
	return target;
}

async function allocateTarget(plansRoot, baseSlug, maxCollisionProbes) {
	for (let probe = 1; probe <= maxCollisionProbes; probe += 1) {
		const suffix = probe === 1 ? "" : `-${probe}`;
		const stem = baseSlug.slice(0, MAX_SLUG_LENGTH - suffix.length).replace(/-+$/g, "") || "plan";
		const target = join(plansRoot, `${stem}${suffix}.md`);
		try {
			const reservation = await open(target, "wx", 0o600);
			await reservation.close();
			return { target, slug: `${stem}${suffix}`, reserved: true };
		} catch (error) {
			if (error?.code !== "EEXIST") throw error;
		}
	}
	throw new PlanStoreError(
		"collision_exhausted",
		`Could not allocate a plan filename after ${maxCollisionProbes} attempts`,
	);
}

async function atomicWrite(target, content, options = {}) {
	const renameFile = options.renameFile ?? rename;
	const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
	let reserved = options.targetReserved === true;
	try {
		await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o600 });
		await renameFile(temporary, target);
		reserved = false;
	} catch (error) {
		await rm(temporary, { force: true }).catch(() => {});
		if (reserved) await rm(target, { force: true }).catch(() => {});
		throw error;
	}
}

export async function atomicReplaceFile(target, content, options = {}) {
	await atomicWrite(target, content, { renameFile: options.renameFile, targetReserved: false });
}

export async function persistPlan(options) {
	const {
		cwd,
		intent,
		title,
		markdown,
		existingPlan = null,
		configDirName = ".pi",
		maxCollisionProbes = MAX_COLLISION_PROBES,
		renameFile,
	} = options ?? {};
	if (typeof cwd !== "string" || !cwd) throw new PlanStoreError("invalid_cwd", "A project working directory is required");
	if (typeof title !== "string" || !title.trim()) throw new PlanStoreError("invalid_title", "Plan title cannot be empty");
	if (typeof intent !== "string" || !intent.trim()) throw new PlanStoreError("invalid_intent", "Plan intent cannot be empty");

	const parsed = parsePlanDocument(markdown);
	if (!parsed.ok) {
		throw new PlanStoreError("validation_failed", "Plan Markdown does not match the canonical schema", parsed.errors);
	}
	if (parsed.document.title !== title.trim()) {
		throw new PlanStoreError("title_mismatch", "The title parameter must exactly match the plan H1 title");
	}

	const baseSlug = sanitizeIntentSlug(intent);
	const plansRoot = await ensureSafePlansRoot(cwd, configDirName);
	let target;
	let slug;
	let targetReserved = false;
	if (existingPlan) {
		target = await verifyRevisionTarget(existingPlan.path, plansRoot, existingPlan.hash);
		slug = basename(target, ".md");
	} else {
		({ target, slug, reserved: targetReserved } = await allocateTarget(plansRoot, baseSlug, maxCollisionProbes));
	}

	await atomicWrite(target, markdown, { renameFile, targetReserved });
	return {
		path: target,
		slug,
		hash: hashContent(markdown),
		document: parsed.document,
	};
}
