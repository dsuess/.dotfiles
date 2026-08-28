import fs from "node:fs";
import path from "node:path";

const DOCKER_ROOTS = ["/opt/homebrew", "/usr/local", "/Applications/Docker.app/Contents/Resources"];
const PLUGINS = Object.freeze({
  buildx: ["lib/docker/cli-plugins/docker-buildx", "libexec/docker/cli-plugins/docker-buildx", "cli-plugins/docker-buildx"],
  compose: ["lib/docker/cli-plugins/docker-compose", "libexec/docker/cli-plugins/docker-compose", "cli-plugins/docker-compose"],
});

function executable(file) {
  try { const stat = fs.statSync(file); return stat.isFile() && (stat.mode & 0o111) !== 0 ? fs.realpathSync(file) : null; } catch { return null; }
}

/** Resolve the reviewed Docker client surface without consulting PATH or ~/.docker. */
export function resolveDockerClientTools(options = {}) {
  const roots = options.roots ?? DOCKER_ROOTS;
  const docker = options.docker ?? roots.map((root) => path.join(root, "bin/docker")).map(executable).find(Boolean);
  if (!docker) throw new Error("reviewed Docker CLI is not installed in a canonical location");
  const plugins = {};
  for (const [name, candidates] of Object.entries(PLUGINS)) {
    const found = roots.flatMap((root) => candidates.map((candidate) => path.join(root, candidate))).map(executable).find(Boolean);
    if (!found) throw new Error(`reviewed Docker ${name} plugin is not installed in a canonical location`);
    plugins[name] = found;
  }
  return Object.freeze({ docker, plugins: Object.freeze(plugins) });
}

/** Create a per-generation Docker config with exactly the approved plugins. */
export function materializeDockerClientEnvironment(root, tools) {
  const config = path.join(root, "docker-config");
  const pluginDirectory = path.join(config, "cli-plugins");
  fs.mkdirSync(pluginDirectory, { recursive: true, mode: 0o700 });
  fs.chmodSync(config, 0o700); fs.chmodSync(pluginDirectory, 0o700);
  fs.writeFileSync(path.join(config, "config.json"), "{}\n", { mode: 0o600 });
  for (const [name, source] of Object.entries(tools.plugins)) {
    const target = path.join(pluginDirectory, `docker-${name}`);
    fs.rmSync(target, { force: true }); fs.symlinkSync(source, target);
  }
  return Object.freeze({
    config, pluginDirectory, path: path.dirname(tools.docker), docker: tools.docker,
    files: Object.freeze([tools.docker, ...Object.values(tools.plugins), config, pluginDirectory, path.join(config, "config.json"), ...Object.keys(tools.plugins).map((name) => path.join(pluginDirectory, `docker-${name}`))]),
  });
}
