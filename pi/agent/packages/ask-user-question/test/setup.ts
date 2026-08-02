import { mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempRoot = join(packageRoot, ".test-tmp");
const testHome = join(tempRoot, `home-${process.pid}`);

mkdirSync(testHome, { recursive: true });
process.env.HOME = testHome;
process.env.USERPROFILE = testHome;
process.env.TMPDIR = tempRoot;
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.XDG_CONFIG_HOME;

beforeEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
  delete process.env.XDG_CONFIG_HOME;
  rmSync(join(testHome, ".config", "rpiv-ask-user-question"), { recursive: true, force: true });
});

afterAll(() => rmSync(testHome, { recursive: true, force: true }));
