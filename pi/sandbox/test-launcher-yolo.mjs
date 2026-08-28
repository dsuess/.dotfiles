import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const launcher = path.join(repositoryRoot, "bin", "pi");

test("--yolo bypasses SRT and starts Pi with native tools", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-launcher-yolo-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const home = path.join(root, "home");
  const workspace = path.join(root, "workspace");
  const fakeBin = path.join(root, "bin");
  const argsFile = path.join(root, "pi-args");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  const realPi = path.join(fakeBin, "pi");
  fs.writeFileSync(realPi, '#!/bin/sh\nprintf "%s\\n" "$@" > "$PI_TEST_ARGS"\n');
  fs.chmodSync(realPi, 0o755);

  execFileSync(launcher, ["--yolo"], {
    cwd: workspace,
    env: { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}`, PI_TEST_ARGS: argsFile },
  });

  assert.equal(fs.readFileSync(argsFile, "utf8"), "\n");
});
