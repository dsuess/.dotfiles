import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const launcher = fileURLToPath(new URL("../../bin/buzz-bot", import.meta.url));
const python = "/opt/homebrew/bin/python3.14";

test("Stow launcher uses host installation and forwards arguments with generated HOME", { skip: !fs.existsSync(python) }, (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-buzz-launcher-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "host with spaces"), bin = path.join(home, "bin");
  const script = path.join(home, "src/slack-bridge/buzz/skills/buzz-bot/scripts/buzz-bot");
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(path.dirname(script), { recursive: true });
  // Match Stow: execute the deployed spelling, not the source path.
  fs.symlinkSync(launcher, path.join(bin, "buzz-bot"));
  fs.writeFileSync(script, "import json, os, sys\nprint(json.dumps({'args': sys.argv[1:], 'key_dir': os.environ['BUZZ_BOT_KEY_DIR'], 'home': os.environ['HOME']}))\n");
  const result = spawnSync(path.join(bin, "buzz-bot"), ["as", "daniel-suess-local", "messages", "get", "a b", "--flag"], {
    env: { ...process.env, HOME: path.join(root, "generated"), BUZZ_BOT_KEY_DIR: "/not-the-host-keys" }, encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    args: ["as", "daniel-suess-local", "messages", "get", "a b", "--flag"],
    key_dir: path.join(home, ".config/buzz-bot/keys"), home: path.join(root, "generated"),
  });
});
