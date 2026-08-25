import path from "node:path";
import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  DEFAULT_MAX_BYTES,
  formatSize,
  truncateHead,
  truncateLine,
  type BashOperations,
  type EditOperations,
  type ExtensionAPI,
  type FindToolDetails,
  type FindToolInput,
  type GrepToolDetails,
  type GrepToolInput,
  type LsOperations,
  type ReadOperations,
  type WriteOperations,
} from "@earendil-works/pi-coding-agent";

export const GONDOLIN_BUILTIN_NAMES = Object.freeze([
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
] as const);

const DEFAULT_GREP_LIMIT = 100;
const DEFAULT_FIND_LIMIT = 1000;
const FILE_CHUNK_BYTES = 512 * 1024;
const MAX_READ_BYTES = 64 * 1024 * 1024;
const MAX_SEARCH_OUTPUT_BYTES = 8 * 1024 * 1024;

export interface SandboxClient {
  policyGeneration: string;
  access(path: string, mode?: number): Promise<unknown>;
  mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>;
  listDir(path: string): Promise<string[]>;
  stat(path: string): Promise<{
    mode: number;
    size: number;
    mtimeMs: number;
    isFile: boolean;
    isDirectory: boolean;
    isSymbolicLink: boolean;
  }>;
  readFile(path: string, options?: { offset?: number; limit?: number }): Promise<{
    data: Buffer;
    truncated: boolean;
  }>;
  writeFile(path: string, data: string | Buffer): Promise<unknown>;
  exec(
    argv: string[],
    options: {
      cwd: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      maxOutputBytes?: number;
      signal?: AbortSignal;
      onEvent?: (stream: "stdout" | "stderr", data: Buffer) => void;
    },
  ): Promise<{ exitCode: number; signal: number | null; outputBytes: number; vmId: string }>;
}

export type GetSandboxClient = () => SandboxClient;

function stripAtPrefix(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

export function resolveGuestPath(cwd: string, input: string | undefined): string {
  const normalized = stripAtPrefix((input ?? ".").trim() || ".");
  return path.isAbsolute(normalized) ? path.resolve(normalized) : path.resolve(cwd, normalized);
}

async function readFileAll(client: SandboxClient, filePath: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const result = await client.readFile(filePath, { offset, limit: FILE_CHUNK_BYTES });
    chunks.push(result.data);
    offset += result.data.length;
    if (!result.truncated || result.data.length === 0) return Buffer.concat(chunks);
    if (offset >= MAX_READ_BYTES) {
      throw new Error(`File exceeds the sandbox read limit (${formatSize(MAX_READ_BYTES)}): ${filePath}`);
    }
  }
}

function createReadOps(client: SandboxClient): ReadOperations {
  return {
    readFile: (filePath) => readFileAll(client, filePath),
    access: async (filePath) => {
      await client.access(filePath, 4);
    },
    detectImageMimeType: async (filePath) => {
      const extension = path.extname(filePath).toLowerCase();
      if (extension === ".png") return "image/png";
      if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
      if (extension === ".gif") return "image/gif";
      if (extension === ".webp") return "image/webp";
      return null;
    },
  };
}

function createWriteOps(client: SandboxClient): WriteOperations {
  return {
    writeFile: async (filePath, content) => {
      await client.writeFile(filePath, content);
    },
    mkdir: async (directory) => {
      await client.mkdir(directory, { recursive: true, mode: 0o755 });
    },
  };
}

function createEditOps(client: SandboxClient): EditOperations {
  const read = createReadOps(client);
  const write = createWriteOps(client);
  return {
    readFile: read.readFile,
    writeFile: write.writeFile,
    access: async (filePath) => {
      await client.access(filePath, 6);
    },
  };
}

function createLsOps(client: SandboxClient): LsOperations {
  return {
    exists: async (filePath) => {
      try {
        await client.access(filePath, 0);
        return true;
      } catch {
        return false;
      }
    },
    stat: async (filePath) => {
      const stat = await client.stat(filePath);
      return { isDirectory: () => stat.isDirectory };
    },
    readdir: (directory) => client.listDir(directory),
  };
}

const SAFE_TERMINAL_ENV = new Set([
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TZ",
  "NO_COLOR",
  "FORCE_COLOR",
  "GOOGLE_APPLICATION_CREDENTIALS",
]);

const FIXED_GUEST_ENV = Object.freeze({
  HOME: "/root",
  PATH: "/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin",
  TMPDIR: "/tmp",
  XDG_CACHE_HOME: "/root/.cache",
  NPM_CONFIG_CACHE: "/root/.npm",
  PIP_CACHE_DIR: "/root/.cache/pip",
  UV_CACHE_DIR: "/root/.cache/uv",
  HF_HOME: "/root/.cache/huggingface",
  CARGO_HOME: "/root/.cargo",
});

export function sanitizeGuestEnvironment(input: NodeJS.ProcessEnv | undefined): Record<string, string> {
  const output: Record<string, string> = { ...FIXED_GUEST_ENV };
  for (const [name, value] of Object.entries(input ?? {})) {
    if (typeof value !== "string") continue;
    if (SAFE_TERMINAL_ENV.has(name) || /^LC_[A-Z_]+$/.test(name)) output[name] = value;
  }
  return output;
}

export function createSandboxBashOperations(getClient: GetSandboxClient): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      if (timeout !== undefined && (!Number.isFinite(timeout) || timeout <= 0 || timeout > 3600)) {
        throw new Error("Sandbox Bash timeout must be between 1 and 3600 seconds");
      }
      const result = await getClient().exec(["/bin/bash", "-lc", command], {
        cwd,
        env: sanitizeGuestEnvironment(env),
        timeoutMs: timeout ? Math.ceil(timeout * 1000) : 60 * 60 * 1000,
        maxOutputBytes: 16 * 1024 * 1024,
        signal,
        onEvent: (_stream, data) => onData(data),
      });
      return { exitCode: result.exitCode };
    },
  };
}

async function execCollected(
  client: SandboxClient,
  argv: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const result = await client.exec(argv, {
    cwd,
    env: sanitizeGuestEnvironment(undefined),
    timeoutMs: 120_000,
    maxOutputBytes: MAX_SEARCH_OUTPUT_BYTES,
    signal,
    onEvent: (stream, data) => (stream === "stdout" ? stdout : stderr).push(data),
  });
  return {
    exitCode: result.exitCode,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

function displaySearchPath(searchRoot: string, resultPath: string, isDirectory: boolean): string {
  if (!isDirectory) return path.basename(resultPath);
  const relative = path.relative(searchRoot, resultPath);
  return relative && !relative.startsWith("..") ? relative.split(path.sep).join("/") : resultPath;
}

export async function executeSandboxGrep(
  client: SandboxClient,
  cwd: string,
  params: GrepToolInput,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: GrepToolDetails | undefined }> {
  const searchRoot = resolveGuestPath(cwd, params.path);
  let rootStat;
  try {
    rootStat = await client.stat(searchRoot);
  } catch {
    throw new Error(`Path not found: ${searchRoot}`);
  }
  const context = params.context && params.context > 0 ? Math.floor(params.context) : 0;
  const effectiveLimit = Math.max(1, Math.floor(params.limit ?? DEFAULT_GREP_LIMIT));
  const argv = ["/usr/bin/rg", "--json", "--line-number", "--color=never", "--hidden"];
  if (params.ignoreCase) argv.push("--ignore-case");
  if (params.literal) argv.push("--fixed-strings");
  if (params.glob) argv.push("--glob", params.glob);
  if (context > 0) argv.push("--context", String(context));
  argv.push("--max-count", String(effectiveLimit), "--", params.pattern, searchRoot);

  const result = await execCollected(client, argv, cwd, signal);
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.exitCode}`);
  }

  const outputLines: string[] = [];
  let matchCount = 0;
  let linesTruncated = false;
  for (const raw of result.stdout.split("\n")) {
    if (!raw) continue;
    let event: any;
    try {
      event = JSON.parse(raw);
    } catch {
      continue;
    }
    if (event.type !== "match" && event.type !== "context") continue;
    const filePath = event.data?.path?.text;
    const lineNumber = event.data?.line_number;
    if (typeof filePath !== "string" || typeof lineNumber !== "number") continue;
    const isMatch = event.type === "match";
    if (isMatch) {
      if (matchCount >= effectiveLimit) continue;
      matchCount += 1;
    } else if (matchCount >= effectiveLimit) {
      continue;
    }
    const text = String(event.data?.lines?.text ?? "")
      .replace(/\r\n/g, "\n")
      .replace(/\r/g, "")
      .replace(/\n$/, "");
    const truncatedLine = truncateLine(text);
    if (truncatedLine.wasTruncated) linesTruncated = true;
    const shown = displaySearchPath(searchRoot, filePath, rootStat.isDirectory);
    outputLines.push(`${shown}${isMatch ? ":" : "-"}${lineNumber}${isMatch ? ":" : "-"} ${truncatedLine.text}`);
  }

  if (matchCount === 0) {
    return { content: [{ type: "text", text: "No matches found" }], details: undefined };
  }
  const truncation = truncateHead(outputLines.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  const details: GrepToolDetails = {};
  const notices: string[] = [];
  if (matchCount >= effectiveLimit) {
    details.matchLimitReached = effectiveLimit;
    notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
  }
  if (truncation.truncated) {
    details.truncation = truncation;
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  }
  if (linesTruncated) {
    details.linesTruncated = true;
    notices.push("Some lines truncated. Use read to see full lines");
  }
  let output = truncation.content;
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
  return {
    content: [{ type: "text", text: output }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}

async function isInsideGitRepository(client: SandboxClient, searchRoot: string): Promise<boolean> {
  let current = searchRoot;
  try {
    if (!(await client.stat(current)).isDirectory) current = path.dirname(current);
  } catch {
    return false;
  }
  for (;;) {
    try {
      await client.access(path.join(current, ".git"), 0);
      return true;
    } catch {
      // Continue toward the mounted root.
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

export async function executeSandboxFind(
  client: SandboxClient,
  cwd: string,
  params: FindToolInput,
  signal?: AbortSignal,
): Promise<{ content: Array<{ type: "text"; text: string }>; details: FindToolDetails | undefined }> {
  const searchRoot = resolveGuestPath(cwd, params.path);
  try {
    await client.access(searchRoot, 0);
  } catch {
    throw new Error(`Path not found: ${searchRoot}`);
  }
  const effectiveLimit = Math.max(1, Math.floor(params.limit ?? DEFAULT_FIND_LIMIT));
  const argv = ["/usr/bin/fd", "--glob", "--color=never", "--hidden"];
  if (!(await isInsideGitRepository(client, searchRoot))) argv.push("--no-require-git");
  argv.push("--max-results", String(effectiveLimit));
  let pattern = params.pattern;
  if (pattern.includes("/")) {
    argv.push("--full-path");
    if (!pattern.startsWith("/") && !pattern.startsWith("**/") && pattern !== "**") {
      pattern = `**/${pattern}`;
    }
  }
  argv.push("--", pattern, searchRoot);
  const result = await execCollected(client, argv, cwd, signal);
  if (result.exitCode !== 0 && !result.stdout.trim()) {
    throw new Error(result.stderr.trim() || `fd exited with code ${result.exitCode}`);
  }
  const entries = result.stdout
    .split("\n")
    .map((entry) => entry.replace(/\r$/, "").trim())
    .filter(Boolean)
    .map((entry) => {
      const trailingSlash = entry.endsWith("/");
      const relative = path.isAbsolute(entry) ? path.relative(searchRoot, entry) : entry;
      const normalized = relative.split(path.sep).join("/");
      return trailingSlash && !normalized.endsWith("/") ? `${normalized}/` : normalized;
    });
  if (entries.length === 0) {
    return {
      content: [{ type: "text", text: "No files found matching pattern" }],
      details: undefined,
    };
  }
  const truncation = truncateHead(entries.join("\n"), { maxLines: Number.MAX_SAFE_INTEGER });
  const details: FindToolDetails = {};
  const notices: string[] = [];
  if (entries.length >= effectiveLimit) {
    details.resultLimitReached = effectiveLimit;
    notices.push(`${effectiveLimit} results limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
  }
  if (truncation.truncated) {
    details.truncation = truncation;
    notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
  }
  let output = truncation.content;
  if (notices.length > 0) output += `\n\n[${notices.join(". ")}]`;
  return {
    content: [{ type: "text", text: output }],
    details: Object.keys(details).length > 0 ? details : undefined,
  };
}

export function registerSandboxTools(
  pi: ExtensionAPI,
  options: { cwd: string; getClient: GetSandboxClient },
): void {
  const baseRead = createReadTool(options.cwd);
  const baseWrite = createWriteTool(options.cwd);
  const baseEdit = createEditTool(options.cwd);
  const baseBash = createBashTool(options.cwd);
  const baseGrep = createGrepTool(options.cwd);
  const baseFind = createFindTool(options.cwd);
  const baseLs = createLsTool(options.cwd);

  pi.registerTool({
    ...baseRead,
    async execute(id, params, signal, onUpdate) {
      const tool = createReadTool(options.cwd, { operations: createReadOps(options.getClient()) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...baseWrite,
    async execute(id, params, signal, onUpdate) {
      const tool = createWriteTool(options.cwd, { operations: createWriteOps(options.getClient()) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...baseEdit,
    async execute(id, params, signal, onUpdate) {
      const tool = createEditTool(options.cwd, { operations: createEditOps(options.getClient()) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...baseBash,
    async execute(id, params, signal, onUpdate) {
      const tool = createBashTool(options.cwd, {
        operations: createSandboxBashOperations(options.getClient),
        exposeSessionEnvironment: false,
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });
  pi.registerTool({
    ...baseGrep,
    async execute(_id, params, signal) {
      return executeSandboxGrep(options.getClient(), options.cwd, params, signal);
    },
  });
  pi.registerTool({
    ...baseFind,
    async execute(_id, params, signal) {
      return executeSandboxFind(options.getClient(), options.cwd, params, signal);
    },
  });
  pi.registerTool({
    ...baseLs,
    async execute(id, params, signal, onUpdate) {
      const tool = createLsTool(options.cwd, { operations: createLsOps(options.getClient()) });
      return tool.execute(id, params, signal, onUpdate);
    },
  });
}
