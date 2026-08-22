import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REQUIRED_DISCUSSION_KEYS = [
  "sentinel.discuss",
  "discussion.launching",
  "discussion.outcome",
  "discussion.context_only",
  "discussion.confirm",
  "discussion.error",
  "rpc.multi_choose",
] as const;
const REMOVED_PANEL_KEYS = [
  "discussion.heading",
  "discussion.empty",
  "discussion.you",
  "discussion.agent",
  "discussion.running_cancel",
  "discussion.input_label",
  "discussion.send",
  "discussion.back",
  "discussion.continue",
  "discussion.hint",
] as const;

describe("discussion localization", () => {
  it("ships the compact returned-outcome keys in every locale and no panel chrome", () => {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    const localeDir = join(packageRoot, "locales");
    const files = readdirSync(localeDir).filter((name) => name.endsWith(".json"));
    expect(files).toHaveLength(9);
    for (const file of files) {
      const locale = JSON.parse(readFileSync(join(localeDir, file), "utf8")) as Record<string, unknown>;
      for (const key of REQUIRED_DISCUSSION_KEYS) {
        expect(locale[key], `${file}:${key}`).toEqual(expect.any(String));
        expect((locale[key] as string).trim().length, `${file}:${key}`).toBeGreaterThan(0);
      }
      for (const key of REMOVED_PANEL_KEYS) expect(locale, `${file}:${key}`).not.toHaveProperty(key);
    }
  });
});
