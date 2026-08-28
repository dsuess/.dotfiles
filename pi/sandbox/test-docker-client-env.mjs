import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { materializeDockerClientEnvironment, resolveDockerClientTools } from "./docker-client-env.mjs";

test("materializes an empty Docker config with only reviewed Buildx and Compose plugins", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-docker-client-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const brew = path.join(root, "brew");
  for (const file of ["bin/docker", "lib/docker/cli-plugins/docker-buildx", "lib/docker/cli-plugins/docker-compose"]) {
    const target = path.join(brew, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, "#! /bin/sh\n"); fs.chmodSync(target, 0o755);
  }
  const tools = resolveDockerClientTools({ roots: [brew] });
  const environment = materializeDockerClientEnvironment(path.join(root, "generation"), tools);
  assert.equal(fs.readFileSync(path.join(environment.config, "config.json"), "utf8"), "{}\n");
  assert.equal(fs.realpathSync(path.join(environment.pluginDirectory, "docker-buildx")), tools.plugins.buildx);
  assert.equal(fs.realpathSync(path.join(environment.pluginDirectory, "docker-compose")), tools.plugins.compose);
  assert.deepEqual(fs.readdirSync(environment.pluginDirectory).sort(), ["docker-buildx", "docker-compose"]);
});

test("rejects ambient or incomplete Docker client installations", () => {
  assert.throws(() => resolveDockerClientTools({ roots: [] }), /Docker CLI/);
});
