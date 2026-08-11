import { mkdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ModelProfile } from "./model-routing.ts";

const THINKING_PROVIDER = "defaultThinkingProvider";
const THINKING_MODEL = "defaultThinkingModel";

type SettingsObject = Record<string, unknown>;

export interface DefaultModelProfiles {
	planning: ModelProfile;
	inference: ModelProfile;
}

export interface ModelDefaultsBoundary {
	load(thinkingLevel: ModelProfile["thinkingLevel"]): { profiles: DefaultModelProfiles | null; warning?: string };
	persist(profiles: DefaultModelProfiles): Promise<void>;
}

function readPair(settings: SettingsObject, providerKey: string, modelKey: string, thinkingLevel: ModelProfile["thinkingLevel"]): ModelProfile | null {
	const provider = settings[providerKey];
	const modelId = settings[modelKey];
	if (typeof provider !== "string" || !provider.trim() || typeof modelId !== "string" || !modelId.trim()) return null;
	return { provider, modelId, thinkingLevel };
}

function parseProfiles(settings: SettingsObject, thinkingLevel: ModelProfile["thinkingLevel"]): { profiles: DefaultModelProfiles | null; warning?: string } {
	const planning = readPair(settings, THINKING_PROVIDER, THINKING_MODEL, thinkingLevel);
	const inference = readPair(settings, "defaultProvider", "defaultModel", thinkingLevel);
	const planningPresent = THINKING_PROVIDER in settings || THINKING_MODEL in settings;
	const inferencePresent = "defaultProvider" in settings || "defaultModel" in settings;
	if (!planning || !inference) {
		return {
			profiles: null,
			warning: planningPresent || inferencePresent
				? "Configured planning or implementation default is incomplete; keeping the current model."
				: "No configured planning or implementation default is available; keeping the current model.",
		};
	}
	return { profiles: { planning, inference } };
}

/**
 * Owns Pi's custom planning-default fields while sharing Pi's proper-lockfile
 * lock path. Replacement targets the resolved file so a Stow symlink remains
 * intact.
 */
export class SettingsModelDefaults implements ModelDefaultsBoundary {
	private readonly settingsPath: string;
	private writeQueue = Promise.resolve();

	constructor(settingsPath = join(getAgentDir(), "settings.json")) {
		this.settingsPath = settingsPath;
	}

	private withPiSettingsLock<T>(operation: () => T): T {
		const lockPath = `${this.settingsPath}.lock`;
		let lastError: unknown;
		for (let attempt = 1; attempt <= 10; attempt += 1) {
			try {
				// proper-lockfile, used by Pi, acquires this directory. Matching its
				// lock path lets this extension serialize with Pi's queued saves.
				mkdirSync(lockPath);
				try { return operation(); } finally { rmdirSync(lockPath); }
			} catch (error) {
				lastError = error;
				if (attempt === 10 || (error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
				const until = Date.now() + 20;
				while (Date.now() < until) { /* match Pi's synchronous lock retry */ }
			}
		}
		throw lastError ?? new Error("Pi settings lock could not be acquired");
	}

	load(thinkingLevel: ModelProfile["thinkingLevel"]): { profiles: DefaultModelProfiles | null; warning?: string } {
		try {
			const raw = this.withPiSettingsLock(() => readFileSync(this.settingsPath, "utf8"));
			if (!raw) return { profiles: null, warning: "Pi settings are unavailable; keeping the current model." };
			const parsed = JSON.parse(raw) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				return { profiles: null, warning: "Pi settings are malformed; keeping the current model." };
			}
			return parseProfiles(parsed as SettingsObject, thinkingLevel);
		} catch (error) {
			return { profiles: null, warning: `Pi settings could not be read: ${error instanceof Error ? error.message : String(error)}` };
		}
	}

	persist(profiles: DefaultModelProfiles): Promise<void> {
		this.writeQueue = this.writeQueue.then(async () => {
			// Pi queues setDefaultModelAndProvider(). Let that queued save settle
			// before taking its lock and reconciling both independent pairs.
			await new Promise<void>((resolve) => setImmediate(resolve));
			this.withPiSettingsLock(() => {
				const current = readFileSync(this.settingsPath, "utf8");
				let settings: unknown;
				try { settings = JSON.parse(current); } catch { throw new Error("Pi settings are malformed"); }
				if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("Pi settings are malformed");
				const next: SettingsObject = {
					...(settings as SettingsObject),
					[THINKING_PROVIDER]: profiles.planning.provider,
					[THINKING_MODEL]: profiles.planning.modelId,
					defaultProvider: profiles.inference.provider,
					defaultModel: profiles.inference.modelId,
				};
				const target = realpathSync(this.settingsPath);
				const stat = statSync(target);
				const temporary = join(dirname(target), `.${Date.now()}.${process.pid}.plan-mode-settings.tmp`);
				const serialized = `${JSON.stringify(next, null, 2)}\n`;
				try {
					writeFileSync(temporary, serialized, { mode: stat.mode });
					renameSync(temporary, target);
				} catch (error) {
					try { rmSync(temporary, { force: true }); } catch { /* best-effort cleanup */ }
					const code = (error as NodeJS.ErrnoException)?.code;
					if (code === "EACCES" || code === "EPERM") {
						// The whole-process sandbox allows ~/.pi/agent but correctly
						// rejects new siblings under this Stow target. Writing through
						// the allowed symlink retains it and Pi's own write semantics.
						writeFileSync(this.settingsPath, serialized, { mode: stat.mode });
						return;
					}
					throw error;
				}
			});
		});
		return this.writeQueue;
	}
}

export function createSettingsModelDefaults(): SettingsModelDefaults {
	return new SettingsModelDefaults();
}
