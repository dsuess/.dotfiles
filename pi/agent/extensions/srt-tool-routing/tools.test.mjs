import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { createPiJiti } from "../../../test-helpers.mjs";

const jiti = await createPiJiti(import.meta.url);
const {
  createSandboxBashOperations,
  pathResolvedHostTool,
  registerSandboxTools,
  sanitizeGuestEnvironment,
} = await jiti.import(new URL("./tools.ts", import.meta.url).pathname);
const { adapterEffects } = await jiti.import(new URL("./host-adapters.ts", import.meta.url).pathname);

function fakeClient(cwd) {
  const files = new Map([
    [path.join(cwd, "read.txt"), Buffer.from("line one\nline two\n")],
    [path.join(cwd, "edit.txt"), Buffer.from("before\n")],
  ]);
  const execCalls = [];
  return {
    files,
    execCalls,
    policyGeneration: "a".repeat(64),
    async access(filePath) {
      if (!files.has(filePath) && filePath !== cwd && !filePath.endsWith("/.git")) throw new Error("ENOENT");
    },
    async mkdir() {},
    async listDir(directory) {
      return [...files.keys()].filter((file) => path.dirname(file) === directory).map((file) => path.basename(file));
    },
    async stat(filePath) {
      if (filePath === cwd) {
        return { mode: 0o40755, size: 0, mtimeMs: 1, isFile: false, isDirectory: true, isSymbolicLink: false };
      }
      const value = files.get(filePath);
      if (!value) throw new Error("ENOENT");
      return { mode: 0o100644, size: value.length, mtimeMs: 1, isFile: true, isDirectory: false, isSymbolicLink: false };
    },
    async readFile(filePath, options = {}) {
      const value = files.get(filePath);
      if (!value) throw new Error("ENOENT");
      const offset = options.offset ?? 0;
      const limit = options.limit ?? value.length;
      return { data: value.subarray(offset, offset + limit), truncated: offset + limit < value.length };
    },
    async writeFile(filePath, data) {
      files.set(filePath, Buffer.from(data));
    },
    async exec(argv, options) {
      execCalls.push({ argv, options });
      if (argv[0] === "rg") {
        const event = {
          type: "match",
          data: {
            path: { text: path.join(cwd, "read.txt") },
            lines: { text: "line one\n" },
            line_number: 1,
          },
        };
        options.onEvent?.("stdout", Buffer.from(`${JSON.stringify(event)}\n`));
      } else if (argv[0] === "fd") {
        options.onEvent?.("stdout", Buffer.from(`${path.join(cwd, "read.txt")}\n`));
      } else {
        options.onEvent?.("stdout", Buffer.from("bash-output"));
      }
      return { exitCode: 0, signal: null, outputBytes: 11, sidecarId: "fake-vm" };
    },
  };
}

function registeredTools(client, cwd) {
  const tools = new Map();
  registerSandboxTools(
    { registerTool(tool) { tools.set(tool.name, tool); } },
    { cwd, getClient: () => client },
  );
  return tools;
}

test("PATH-resolved optional host tools accept only bare executable names", () => {
  assert.deepEqual(pathResolvedHostTool("rg"), ["rg"]);
  assert.deepEqual(pathResolvedHostTool("fd-tool_2.0+local"), ["fd-tool_2.0+local"]);
  for (const name of ["", ".", "-rg", "/usr/bin/rg", "./rg", "../rg", "tools/rg", "tools\\rg", "rg --json", "rg;id", "rg\u0000fd", null]) {
    assert.throws(() => pathResolvedHostTool(name));
  }
});

test("trusted host effects are explicit source-controlled data", () => {
  const effects = adapterEffects();
  assert.match(effects.ketch_search.join(" "), /public network research/);
  assert.match(effects.ask_user_question.join(" "), /user interaction/);
  assert.match(effects.subagent.join(" "), /child Pi/);
  assert.match(effects.plan_progress.join(" "), /plan\/ledger persistence/);
  assert.deepEqual(Object.keys(effects).sort(), [
    "ask_user_question", "complete_plan", "complete_stage", "ketch_code", "ketch_crawl",
    "ketch_docs", "ketch_scrape", "ketch_search", "plan_progress", "subagent", "submit_plan",
  ].sort());
});

test("replacement names and prompt contracts match Pi built-ins", () => {
  const cwd = "/workspace";
  const tools = registeredTools(fakeClient(cwd), cwd);
  assert.deepEqual([...tools.keys()].sort(), ["bash", "edit", "find", "grep", "ls", "read", "write"]);
  assert.match(tools.get("read").description, /2000 lines or 50KB/);
  assert.match(tools.get("bash").description, /last 2000 lines or 50KB/);
});

test("read, write, edit, and ls use controller VFS paths without /workspace translation", async () => {
  const cwd = "/physical/workspace";
  const client = fakeClient(cwd);
  const tools = registeredTools(client, cwd);

  const read = await tools.get("read").execute("read-1", { path: "read.txt" });
  assert.match(read.content[0].text, /line one/);

  await tools.get("write").execute("write-1", { path: "new.txt", content: "new-content" });
  assert.equal(client.files.get(path.join(cwd, "new.txt")).toString(), "new-content");

  const edit = await tools.get("edit").execute("edit-1", {
    path: "edit.txt",
    edits: [{ oldText: "before", newText: "after" }],
  });
  assert.equal(client.files.get(path.join(cwd, "edit.txt")).toString(), "after\n");
  assert.match(edit.details.diff, /after/);

  const listed = await tools.get("ls").execute("ls-1", { path: "." });
  assert.match(listed.content[0].text, /read\.txt/);
  assert.equal(client.execCalls.length, 0);
});

test("grep and find execute PATH-resolved rg/fd as argument vectors and keep truncation details", async () => {
  const cwd = "/physical/workspace";
  const client = fakeClient(cwd);
  const tools = registeredTools(client, cwd);

  const grep = await tools.get("grep").execute("grep-1", { pattern: "line", path: ".", limit: 1 });
  assert.match(grep.content[0].text, /read\.txt:1: line one/);
  assert.equal(grep.details.matchLimitReached, 1);
  assert.deepEqual(client.execCalls[0].argv, [
    "rg", "--json", "--line-number", "--color=never", "--hidden", "--max-count", "1", "--", "line", cwd,
  ]);

  const found = await tools.get("find").execute("find-1", { pattern: "*.txt", path: ".", limit: 1 });
  assert.match(found.content[0].text, /^read\.txt/);
  assert.equal(found.details.resultLimitReached, 1);
  assert.deepEqual(client.execCalls[1].argv, [
    "fd", "--glob", "--color=never", "--hidden", "--max-results", "1", "--", "*.txt", cwd,
  ]);

  for (const call of client.execCalls) {
    assert.equal(path.isAbsolute(call.argv[0]), false, "optional host tools must be PATH-resolved basenames");
    assert.equal(call.argv.includes("-lc"), false, "adapters must not invoke a login shell");
    assert.equal(call.options.env.PATH, undefined, "adapters must not reconstruct PATH");
  }
});

test("bash and rewritten RTK commands retain tool secrets but strip control authority", async () => {
  const cwd = "/physical/workspace";
  const client = fakeClient(cwd);
  const operations = createSandboxBashOperations(() => client);
  const chunks = [];
  await operations.exec("rtk git status", cwd, {
    onData: (data) => chunks.push(data.toString()),
    timeout: 10,
    env: {
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      PATH: "/model-selected-path",
      PI_SESSION_ID: "secret-session",
      GENERIC_SECRET_TOKEN: "secret-generic",
      OPENAI_API_KEY: "secret-provider",
      NPM_TOKEN: "secret-package",
      GOOGLE_APPLICATION_CREDENTIALS: "/workspace/.gcloud/adc.json",
    },
  });
  const call = client.execCalls[0];
  assert.deepEqual(call.argv, ["/bin/bash", "-c", "rtk git status"]);
  assert.equal(call.options.env.TERM, "xterm-256color");
  assert.equal(call.options.env.PATH, "/model-selected-path");
  assert.equal(call.options.env.PI_SESSION_ID, "secret-session");
  assert.equal(call.options.env.GENERIC_SECRET_TOKEN, "secret-generic");
  assert.equal(call.options.env.OPENAI_API_KEY, "secret-provider");
  assert.equal(call.options.env.NPM_TOKEN, "secret-package");
  assert.equal(call.options.env.GOOGLE_APPLICATION_CREDENTIALS, "/workspace/.gcloud/adc.json");
  assert.equal(call.options.env.NPM_CONFIG_CACHE, "/root/.npm");
  assert.deepEqual(chunks, ["bash-output"]);

  const sanitized = sanitizeGuestEnvironment({
    GITHUB_TOKEN: "secret",
    GOOGLE_APPLICATION_CREDENTIALS: "/workspace/.gcloud/adc.json",
    LC_TIME: "C",
  });
  assert.equal(sanitizeGuestEnvironment(undefined).PATH, undefined, "the extension does not construct a guest PATH");
  assert.equal(sanitized.GITHUB_TOKEN, "secret");
  assert.equal(sanitized.GOOGLE_APPLICATION_CREDENTIALS, "/workspace/.gcloud/adc.json");
  assert.equal(sanitized.LC_TIME, "C");
  for (const name of ["SSL_CERT_FILE", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS"]) {
    assert.equal(sanitized[name], undefined, `${name} must not propagate SRT tool routing MITM trust`);
  }
});
