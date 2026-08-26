import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const PACKAGE_SUFFIX = path.join("libexec", "lib", "node_modules", "@earendil-works", "pi-coding-agent");
const HOMEBREW_PACKAGE_ROOT = path.join("/opt/homebrew/opt/pi-coding-agent", PACKAGE_SUFFIX);

export function resolvePiPackageRoot(env = process.env) {
  const candidate = env.PI_PACKAGE_ROOT || HOMEBREW_PACKAGE_ROOT;
  const root = path.resolve(candidate);
  const runtime = path.join(root, "dist", "index.js");
  const jiti = path.join(root, "node_modules", "jiti", "lib", "jiti.mjs");
  if (!fs.existsSync(runtime) || !fs.existsSync(jiti)) {
    throw new Error(
      `Pi test runtime is unavailable at ${root}. Set PI_PACKAGE_ROOT to the installed @earendil-works/pi-coding-agent package directory (required outside supported Homebrew installations).`,
    );
  }
  return root;
}

export const piPackageRoot = resolvePiPackageRoot();

export async function createPiJiti(importMetaUrl, aliases = {}) {
  const { createJiti } = await import(pathToFileURL(path.join(piPackageRoot, "node_modules", "jiti", "lib", "jiti.mjs")).href);
  return createJiti(importMetaUrl, {
    alias: {
      "@earendil-works/pi-coding-agent": path.join(piPackageRoot, "dist", "index.js"),
      "@earendil-works/pi-tui": path.join(piPackageRoot, "node_modules", "@earendil-works", "pi-tui", "dist", "index.js"),
      "@earendil-works/pi-ai": path.join(piPackageRoot, "node_modules", "@earendil-works", "pi-ai", "dist", "index.js"),
      typebox: path.join(piPackageRoot, "node_modules", "typebox", "build", "index.mjs"),
      ...aliases,
    },
  });
}
