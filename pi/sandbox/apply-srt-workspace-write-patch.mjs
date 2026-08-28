#!/usr/bin/env node
/**
 * Apply the one reviewed SRT 0.0.74 macOS patch required by Pi's accepted
 * full-workspace-write exception. The lockfile still verifies upstream bytes;
 * this script verifies the exact installed preimage before making the narrow
 * controller-only change and verifies its exact postimage afterwards.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const SRT_PACKAGE_ROOT = path.join(SCRIPT_DIR, "node_modules", "@anthropic-ai", "sandbox-runtime");

const PATCHES = Object.freeze([
  {
    relativePath: "dist/sandbox/sandbox-config.js",
    preimage: "2ce6b3d66f17b7015a0fa4b3409398cfb4949e9be7219d612c73407731cb6c60",
    postimage: "3fe159068dc0225fb49c669f40bd704bc31bf05791dac24645050b7927c1a228",
    find: `    allowGitConfig: z\n        .boolean()\n        .optional()\n        .describe('Allow writes to .git/config files (default: false). Enables git remote URL updates while keeping .git/hooks protected.'),\n`,
    replace: `    allowGitConfig: z\n        .boolean()\n        .optional()\n        .describe('Allow writes to .git/config files (default: false). Enables git remote URL updates while keeping .git/hooks protected.'),\n    // Pi-only controller input. It is intentionally an explicit list of canonical\n    // roots; it changes macOS mandatory *write* denies but never read access.\n    allowCompleteWorkspaceWrites: z\n        .array(filesystemPathSchema)\n        .optional()\n        .describe('Controller-only canonical roots that retain complete workspace writes on macOS.'),\n`,
  },
  {
    relativePath: "dist/sandbox/sandbox-manager.js",
    preimage: "e8a34f0c014784d9c5af1b610a9d310f80117998a1d9357e8b9624e0da5957f6",
    postimage: "0b2ab909fb06609c043c70d690bc5d5f9cf9da1b74aca66bbb01969486ec2608",
    find: `function getAllowGitConfig() {\n    return config?.filesystem?.allowGitConfig ?? false;\n}\n`,
    replace: `function getAllowGitConfig() {\n    return config?.filesystem?.allowGitConfig ?? false;\n}\nfunction getAllowCompleteWorkspaceWrites() {\n    return config?.filesystem?.allowCompleteWorkspaceWrites ?? [];\n}\n`,
    secondFind: `                allowPty,\n                allowGitConfig: getAllowGitConfig(),\n                gitSafeDirectories,\n`,
    secondReplace: `                allowGitConfig: getAllowGitConfig(),\n                // The patched macOS generator uses this only to omit its\n                // default dangerous-path write guards below canonical roots.\n                allowCompleteWorkspaceWrites: getAllowCompleteWorkspaceWrites(),\n                gitSafeDirectories,\n`,
  },
  {
    relativePath: "dist/sandbox/macos-sandbox-utils.js",
    preimage: "040bd404987514a32027e68e12a40d4d0abe4fa48987e0c0ffb98f775e14f008",
    postimage: "cc9aa73cb213874a4ded112e5311cd2a8f7405f89c42401595e765a2ef594844",
    find: `export function macGetMandatoryDenyPatterns(allowGitConfig = false) {\n    const cwd = process.cwd();\n    const denyPaths = [];\n`,
    replace: `export function macGetMandatoryDenyPatterns(allowGitConfig = false, allowCompleteWorkspaceWrites = []) {\n    const cwd = process.cwd();\n    const completeRoots = allowCompleteWorkspaceWrites.filter(root => typeof root === 'string' && path.isAbsolute(root));\n    const cwdHasCompleteWrites = completeRoots.some(root => cwd === root || cwd.startsWith(root + path.sep));\n    const denyPaths = [];\n`,
    secondFind: `        denyPaths.push(path.resolve(cwd, fileName));\n        denyPaths.push(\`**/\${fileName}\`);\n`,
    secondReplace: `        if (!cwdHasCompleteWrites) denyPaths.push(path.resolve(cwd, fileName));\n        // A glob applies inside every allowWrite root. When the controller has\n        // explicitly accepted complete workspace writes, omitting it is safe:\n        // only those canonical roots are write-allowed.\n        if (!cwdHasCompleteWrites) denyPaths.push(\`**/\${fileName}\`);\n`,
    thirdFind: `        denyPaths.push(path.resolve(cwd, dirName));\n        denyPaths.push(\`**/\${dirName}/**\`);\n`,
    thirdReplace: `        if (!cwdHasCompleteWrites) denyPaths.push(path.resolve(cwd, dirName));\n        if (!cwdHasCompleteWrites) denyPaths.push(\`**/\${dirName}/**\`);\n`,
    fourthFind: `    denyPaths.push(path.resolve(cwd, '.git/hooks'));\n    denyPaths.push('**/.git/hooks/**');\n`,
    fourthReplace: `    if (!cwdHasCompleteWrites) {\n        denyPaths.push(path.resolve(cwd, '.git/hooks'));\n        denyPaths.push('**/.git/hooks/**');\n    }\n`,
    fifthFind: `        denyPaths.push(path.resolve(cwd, '.git/config'));\n        denyPaths.push('**/.git/config');\n`,
    fifthReplace: `        if (!cwdHasCompleteWrites) {\n            denyPaths.push(path.resolve(cwd, '.git/config'));\n            denyPaths.push('**/.git/config');\n        }\n`,
    sixthFind: `function generateWriteRules(config, logTag, allowGitConfig = false) {\n`,
    sixthReplace: `function generateWriteRules(config, logTag, allowGitConfig = false, allowCompleteWorkspaceWrites = []) {\n`,
    seventhFind: `        ...macGetMandatoryDenyPatterns(allowGitConfig),\n`,
    seventhReplace: `        ...macGetMandatoryDenyPatterns(allowGitConfig, allowCompleteWorkspaceWrites),\n`,
    eighthFind: `function generateSandboxProfile({ readConfig, writeConfig, httpProxyPort, socksProxyPort, needsNetworkRestriction, allowUnixSockets, allowAllUnixSockets, allowLocalBinding, allowMachLookup, allowPty, allowGitConfig = false, enableWeakerNetworkIsolation = false, allowAppleEvents = false, logTag, }) {\n`,
    eighthReplace: `function generateSandboxProfile({ readConfig, writeConfig, httpProxyPort, socksProxyPort, needsNetworkRestriction, allowUnixSockets, allowAllUnixSockets, allowLocalBinding, allowMachLookup, allowPty, allowGitConfig = false, allowCompleteWorkspaceWrites = [], enableWeakerNetworkIsolation = false, allowAppleEvents = false, logTag, }) {\n`,
    ninthFind: `    profile.push(...generateWriteRules(writeConfig, logTag, allowGitConfig));\n`,
    ninthReplace: `    profile.push(...generateWriteRules(writeConfig, logTag, allowGitConfig, allowCompleteWorkspaceWrites));\n`,
    tenthFind: `    const { command, commandId, needsNetworkRestriction, httpProxyPort, socksProxyPort, proxyAuthToken, caCertPath, javaAgentJarPath, allowUnixSockets, allowAllUnixSockets, allowLocalBinding, allowMachLookup, readConfig: readConfigIn, writeConfig, unsetEnvVars, setEnvVars, maskedFileBinds, allowPty, allowGitConfig = false, gitSafeDirectories, enableWeakerNetworkIsolation = false, allowAppleEvents = false, binShell, } = params;\n`,
    tenthReplace: `    const { command, commandId, needsNetworkRestriction, httpProxyPort, socksProxyPort, proxyAuthToken, caCertPath, javaAgentJarPath, allowUnixSockets, allowAllUnixSockets, allowLocalBinding, allowMachLookup, readConfig: readConfigIn, writeConfig, unsetEnvVars, setEnvVars, maskedFileBinds, allowPty, allowGitConfig = false, allowCompleteWorkspaceWrites = [], gitSafeDirectories, enableWeakerNetworkIsolation = false, allowAppleEvents = false, binShell, } = params;\n`,
    eleventhFind: `        allowGitConfig,\n        enableWeakerNetworkIsolation,\n`,
    eleventhReplace: `        allowGitConfig,\n        allowCompleteWorkspaceWrites,\n        enableWeakerNetworkIsolation,\n`,
  },
]);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function replaceOnce(source, find, replacement, label) {
  const first = source.indexOf(find);
  if (first < 0 || source.indexOf(find, first + find.length) >= 0) {
    throw new Error(`SRT patch drift in ${label}`);
  }
  return `${source.slice(0, first)}${replacement}${source.slice(first + find.length)}`;
}

function applyDirectIpSupplement(packageRoot) {
  const supplements = [
    ["dist/sandbox/sandbox-config.js", "3fe159068dc0225fb49c669f40bd704bc31bf05791dac24645050b7927c1a228", "fd4e6eeb60980a9de9b1446a27de94155247e93e83d92918d8038076e568fcc3", [
      [`    allowUnixSockets: z\n        .array(z.string())\n        .optional()\n        .describe('macOS only: Unix socket paths to allow. Ignored on Linux (seccomp cannot filter by path).'),\n`, `    allowUnixSockets: z\n        .array(z.string())\n        .optional()\n        .describe('macOS only: Unix socket paths to allow. Ignored on Linux (seccomp cannot filter by path).'),\n    allowUnrestrictedIp: z\n        .boolean()\n        .optional()\n        .describe('macOS only: allow direct IP network operations without granting Unix sockets or proxy environment variables.'),\n`],
    ]],
    ["dist/sandbox/sandbox-manager.js", "0b2ab909fb06609c043c70d690bc5d5f9cf9da1b74aca66bbb01969486ec2608", "e0dfdb56711acac31ad37ab2d3fd328eaafba5bdcbb3d92f33c66ccf4acfcbb5", [
      [`function getAllowCompleteWorkspaceWrites() {\n    return config?.filesystem?.allowCompleteWorkspaceWrites ?? [];\n}\n`, `function getAllowCompleteWorkspaceWrites() {\n    return config?.filesystem?.allowCompleteWorkspaceWrites ?? [];\n}\nfunction getAllowUnrestrictedIp() {\n    return config?.network?.allowUnrestrictedIp ?? false;\n}\n`],
      [`    const needsNetworkProxy = hasNetworkConfig;\n`, `    const needsNetworkProxy = hasNetworkConfig && !getAllowUnrestrictedIp();\n`],
      [`                allowLocalBinding: getAllowLocalBinding(),\n                allowMachLookup: getAllowMachLookup(),\n                ignoreViolations: getIgnoreViolations(),\n                allowGitConfig: getAllowGitConfig(),\n`, `                allowLocalBinding: getAllowLocalBinding(),\n                allowUnrestrictedIp: getAllowUnrestrictedIp(),\n                allowMachLookup: getAllowMachLookup(),\n                ignoreViolations: getIgnoreViolations(),\n                allowPty,\n                allowGitConfig: getAllowGitConfig(),\n`],
    ]],
    ["dist/sandbox/macos-sandbox-utils.js", "cc9aa73cb213874a4ded112e5311cd2a8f7405f89c42401595e765a2ef594844", "1fbf73889cc5c5415bc1cc8d049ede5be2ff24fba96232538f617d98164e74fa", [
      [`function generateSandboxProfile({ readConfig, writeConfig, httpProxyPort, socksProxyPort, needsNetworkRestriction, allowUnixSockets, allowAllUnixSockets, allowLocalBinding, allowMachLookup, allowPty, allowGitConfig = false, allowCompleteWorkspaceWrites = [], enableWeakerNetworkIsolation = false, allowAppleEvents = false, logTag, }) {`, `function generateSandboxProfile({ readConfig, writeConfig, httpProxyPort, socksProxyPort, needsNetworkRestriction, allowUnixSockets, allowAllUnixSockets, allowLocalBinding, allowUnrestrictedIp = false, allowMachLookup, allowPty, allowGitConfig = false, allowCompleteWorkspaceWrites = [], enableWeakerNetworkIsolation = false, allowAppleEvents = false, logTag, }) {`],
      [`    else {\n        // Allow local binding if requested.\n`, `    else {\n        // Direct-IP mode grants AF_INET/AF_INET6 only; AF_UNIX stays exact.\n        if (allowUnrestrictedIp) {\n            profile.push('(allow network-bind (local ip "*:*"))');\n            profile.push('(allow network-inbound (local ip "*:*"))');\n            profile.push('(allow network-outbound (remote ip "*:*"))');\n        }\n        // Allow local binding if requested.\n`],
      [`export function wrapCommandWithSandboxMacOS(params) {\n    const { command, commandId, needsNetworkRestriction, httpProxyPort, socksProxyPort, proxyAuthToken, caCertPath, javaAgentJarPath, allowUnixSockets, allowAllUnixSockets, allowLocalBinding, allowMachLookup, readConfig: readConfigIn, writeConfig, unsetEnvVars, setEnvVars, maskedFileBinds, allowPty, allowGitConfig = false, allowCompleteWorkspaceWrites = [], gitSafeDirectories, enableWeakerNetworkIsolation = false, allowAppleEvents = false, binShell, } = params;`, `export function wrapCommandWithSandboxMacOS(params) {\n    const { command, commandId, needsNetworkRestriction, httpProxyPort, socksProxyPort, proxyAuthToken, caCertPath, javaAgentJarPath, allowUnixSockets, allowAllUnixSockets, allowLocalBinding, allowUnrestrictedIp = false, allowMachLookup, readConfig: readConfigIn, writeConfig, unsetEnvVars, setEnvVars, maskedFileBinds, allowPty, allowGitConfig = false, allowCompleteWorkspaceWrites = [], gitSafeDirectories, enableWeakerNetworkIsolation = false, allowAppleEvents = false, binShell, } = params;`],
      [`        allowLocalBinding,\n        allowMachLookup,\n        allowPty,\n`, `        allowLocalBinding,\n        allowUnrestrictedIp,\n        allowMachLookup,\n        allowPty,\n`],
      [`    const proxyEnvArgs = generateProxyEnvVars(httpProxyPort, socksProxyPort, caCertPath, proxyAuthToken, writeConfig === undefined, encodeSandboxedCommand(attributionCommand));\n`, `    const proxyEnvArgs = allowUnrestrictedIp ? [] : generateProxyEnvVars(httpProxyPort, socksProxyPort, caCertPath, proxyAuthToken, writeConfig === undefined, encodeSandboxedCommand(attributionCommand));\n`],
    ]],
  ];
  for (const [relativePath, preimage, postimage, replacements] of supplements) {
    const target = path.join(packageRoot, relativePath);
    const source = fs.readFileSync(target);
    if (sha256(source) === postimage) continue;
    if (sha256(source) !== preimage) throw new Error(`SRT pre-patch hash drift: ${relativePath}`);
    let text = source.toString("utf8");
    for (const [find, replacement] of replacements) text = replaceOnce(text, find, replacement, relativePath);
    fs.writeFileSync(target, text, { mode: fs.statSync(target).mode });
    if (sha256(fs.readFileSync(target)) !== postimage) throw new Error(`SRT post-patch hash mismatch: ${relativePath}`);
  }
}

const SUPPLEMENTED_POSTIMAGES = new Map([
  ["dist/sandbox/sandbox-config.js", "fd4e6eeb60980a9de9b1446a27de94155247e93e83d92918d8038076e568fcc3"],
  ["dist/sandbox/sandbox-manager.js", "e0dfdb56711acac31ad37ab2d3fd328eaafba5bdcbb3d92f33c66ccf4acfcbb5"],
  ["dist/sandbox/macos-sandbox-utils.js", "1fbf73889cc5c5415bc1cc8d049ede5be2ff24fba96232538f617d98164e74fa"],
]);

export function applySrtWorkspaceWritePatch(packageRoot = SRT_PACKAGE_ROOT) {
  for (const patch of PATCHES) {
    const target = path.join(packageRoot, patch.relativePath);
    let source = fs.readFileSync(target);
    const originalHash = sha256(source);
    if (originalHash === patch.postimage || originalHash === SUPPLEMENTED_POSTIMAGES.get(patch.relativePath)) continue;
    if (originalHash !== patch.preimage) throw new Error(`SRT pre-patch hash drift: ${patch.relativePath}`);
    let text = source.toString("utf8");
    text = replaceOnce(text, patch.find, patch.replace, patch.relativePath);
    for (const [find, replacement] of [
      [patch.secondFind, patch.secondReplace], [patch.thirdFind, patch.thirdReplace], [patch.fourthFind, patch.fourthReplace],
      [patch.fifthFind, patch.fifthReplace], [patch.sixthFind, patch.sixthReplace], [patch.seventhFind, patch.seventhReplace],
      [patch.eighthFind, patch.eighthReplace], [patch.ninthFind, patch.ninthReplace], [patch.tenthFind, patch.tenthReplace],
      [patch.eleventhFind, patch.eleventhReplace],
    ]) {
      if (find !== undefined) text = replaceOnce(text, find, replacement, patch.relativePath);
    }
    fs.writeFileSync(target, text, { mode: fs.statSync(target).mode });
    const changedHash = sha256(fs.readFileSync(target));
    if (changedHash !== patch.postimage) {
      throw new Error(`SRT post-patch hash mismatch: ${patch.relativePath} (${changedHash})`);
    }
  }
  applyDirectIpSupplement(packageRoot);
}

export const SRT_WORKSPACE_WRITE_PATCHES = PATCHES;

if (import.meta.main) {
  try {
    applySrtWorkspaceWritePatch();
    process.stdout.write("Applied verified SRT workspace-write patch.\n");
  } catch (error) {
    process.stderr.write(`pi-srt-patch: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
