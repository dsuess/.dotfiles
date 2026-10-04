import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPiJiti } from "../../../test-helpers.mjs";

const jiti = await createPiJiti(import.meta.url);
const {
  createSandboxBashOperations,
  createModeBashOperations,
  createModeDispatchedTool,
  sanitizeHostEnvironment,
  pathResolvedHostTool,
  registerSandboxTools,
  sanitizeGuestEnvironment,
} = await jiti.import(new URL("./tools.ts", import.meta.url).pathname);
const { ConversationMode } = await jiti.import(new URL("./mode-state.ts", import.meta.url).pathname);
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

function registeredTools(client, cwd, execution) {
  const tools = new Map();
  registerSandboxTools(
    { registerTool(tool) { tools.set(tool.name, tool); } },
    { cwd, getClient: () => client, execution },
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
    "ketch_docs", "ketch_scrape", "ketch_search", "plan_progress", "subagent", "show_plan",
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
      NPM_CONFIG_CACHE: "/Users/dsuess/.npm",
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
  assert.equal(call.options.env.NPM_CONFIG_CACHE, "/Users/dsuess/.npm");
  assert.equal(call.options.env.GOOGLE_APPLICATION_CREDENTIALS, "/workspace/.gcloud/adc.json");
  assert.equal(sanitizeGuestEnvironment({}).NPM_CONFIG_CACHE, undefined, "the adapter must not synthesize /root/.npm");
  assert.deepEqual(chunks, ["bash-output"]);

  const sanitized = sanitizeGuestEnvironment({
    GITHUB_TOKEN: "secret",
    GOOGLE_APPLICATION_CREDENTIALS: "/workspace/.gcloud/adc.json",
    LC_TIME: "C",
    NPM_CONFIG_CACHE: "/tmp/caller-npm",
  });
  assert.equal(sanitizeGuestEnvironment(undefined).PATH, undefined, "the extension does not construct a guest PATH");
  assert.equal(sanitized.GITHUB_TOKEN, "secret");
  assert.equal(sanitized.GOOGLE_APPLICATION_CREDENTIALS, "/workspace/.gcloud/adc.json");
  assert.equal(sanitized.LC_TIME, "C");
  assert.equal(sanitized.NPM_CONFIG_CACHE, "/tmp/caller-npm");
  for (const name of ["SSL_CERT_FILE", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE", "NODE_EXTRA_CA_CERTS"]) {
    assert.equal(sanitized[name], undefined, `${name} must not propagate SRT tool routing MITM trust`);
  }
});

test("dispatch keeps native schemas, renderers, and exact execution arguments in both modes", async () => {
  const mode = new ConversationMode();
  const calls = [];
  const nativeResult = { content: [{ type: "text", text: "host" }], details: { path: "host" } };
  const sandboxResult = { content: [{ type: "text", text: "sandbox" }], details: { path: "sandbox" } };
  const native = {
    name: "bash", parameters: { type: "object" }, renderCall() {}, renderResult() {},
    outputSchema: { type: "object" }, executionMode: "sequential",
    execute: async (...args) => { calls.push(["host", ...args]); return nativeResult; },
  };
  const tool = createModeDispatchedTool(native, async (...args) => { calls.push(["sandbox", ...args]); return sandboxResult; }, mode);
  for (const key of ["parameters", "renderCall", "renderResult", "outputSchema", "executionMode"]) assert.equal(tool[key], native[key]);
  const args = ["id", { command: "pwd" }, new AbortController().signal, () => {}, { cwd: "/example" }];
  assert.equal(await tool.execute(...args), sandboxResult);
  await mode.switchMode("off", () => true, async () => {});
  assert.equal(await tool.execute(...args), nativeResult);
  assert.deepEqual(calls, [["sandbox", ...args], ["host", ...args]]);
});

test("all seven registered replacements select real host operations off and controller operations on", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "srt-native-dispatch-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace");
  const outside = path.join(root, "outside workspace");
  fs.mkdirSync(cwd);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "host.txt"), "host-needle\n");
  const client = fakeClient(cwd);
  const mode = new ConversationMode();
  const tools = registeredTools(client, cwd, mode);
  const before = new Map(client.files);
  await mode.switchMode("off", () => true, async () => {});
  assert.match((await tools.get("read").execute("host-read", { path: path.join(outside, "host.txt") })).content[0].text, /host-needle/);
  await tools.get("write").execute("host-write", { path: path.join(outside, "edit.txt"), content: "before\n" });
  await tools.get("edit").execute("host-edit", { path: path.join(outside, "edit.txt"), edits: [{ oldText: "before", newText: "after" }] });
  assert.equal(fs.readFileSync(path.join(outside, "edit.txt"), "utf8"), "after\n");
  assert.match((await tools.get("grep").execute("host-grep", { pattern: "host-needle", path: outside })).content[0].text, /host\.txt:1/);
  assert.match((await tools.get("find").execute("host-find", { pattern: "*.txt", path: outside })).content[0].text, /host\.txt/);
  assert.match((await tools.get("ls").execute("host-ls", { path: outside })).content[0].text, /host\.txt/);
  const updates = [];
  const bash = await tools.get("bash").execute("host-bash", { command: "printf native-bash" }, undefined, (result) => updates.push(result));
  assert.match(bash.content[0].text, /native-bash/);
  assert.ok(updates.length > 0, "native streaming remains enabled");
  assert.deepEqual(client.files, before);
  assert.equal(client.execCalls.length, 0, "host dispatch never consults the controller");
  await mode.switchMode("on", () => true, async () => {});
  assert.match((await tools.get("read").execute("sandbox-read", { path: "read.txt" })).content[0].text, /line one/);
  await tools.get("write").execute("sandbox-write", { path: "new.txt", content: "sandbox" });
  await tools.get("edit").execute("sandbox-edit", { path: "edit.txt", edits: [{ oldText: "before", newText: "sandbox-after" }] });
  await tools.get("grep").execute("sandbox-grep", { pattern: "line" });
  await tools.get("find").execute("sandbox-find", { pattern: "*.txt" });
  await tools.get("ls").execute("sandbox-ls", { path: "." });
  await tools.get("bash").execute("sandbox-bash", { command: "pwd" });
  assert.equal(client.files.get(path.join(cwd, "new.txt")).toString(), "sandbox");
  assert.equal(client.files.get(path.join(cwd, "edit.txt")).toString(), "sandbox-after\n");
  assert.equal(client.execCalls.length, 3);
  assert.equal(fs.existsSync(path.join(cwd, "new.txt")), false, "sandbox writes never fall back to host");
});

test("off retains host HOME, Docker, credentials and session context but hides routing authority", async () => {
  const env = {
    HOME: os.homedir(), DOCKER_HOST: "unix:///host/docker.sock", DOCKER_CONTEXT: "host-context",
    SSH_AUTH_SOCK: "/host/ssh-agent.sock", OPENAI_API_KEY: "tool-secret", PI_SESSION_ID: "host-session",
    PI_SRT_ROUTING_LEASE: "hidden", PI_SRT_ROUTING_SOCKET: "/hidden/controller.sock",
    PI_SRT_ROUTING_STARTUP_DESCRIPTOR: "hidden-descriptor", PI_SRT_ROUTING: "1",
  };
  const sanitized = sanitizeHostEnvironment(env);
  for (const key of ["HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "SSH_AUTH_SOCK", "OPENAI_API_KEY", "PI_SESSION_ID"]) assert.equal(sanitized[key], env[key]);
  for (const key of Object.keys(env).filter((key) => key.startsWith("PI_SRT_"))) assert.equal(sanitized[key], undefined);
  const sandboxEnv = sanitizeGuestEnvironment(env);
  assert.equal(sandboxEnv.HOME, "/root");
  for (const key of ["PI_SRT_ROUTING_LEASE", "PI_SRT_ROUTING_SOCKET", "DOCKER_HOST", "DOCKER_CONTEXT", "SSH_AUTH_SOCK"]) assert.equal(sandboxEnv[key], undefined);
  const mode = new ConversationMode();
  await mode.switchMode("off", () => true, async () => {});
  const operations = createModeBashOperations(() => { throw new Error("must not consult controller off"); }, mode);
  const chunks = [];
  await operations.exec('printf "%s|%s|%s|%s|%s" "$HOME" "$DOCKER_HOST" "$DOCKER_CONTEXT" "$PI_SRT_ROUTING_LEASE" "$PI_SRT_ROUTING_SOCKET"', process.cwd(), {
    env, onData: (data) => chunks.push(data.toString()),
  });
  assert.equal(chunks.join(""), `${os.homedir()}|unix:///host/docker.sock|host-context||`);
});

test("off preserves native cancellation and mutation queues; active operations hold their authority", async (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "srt-native-queue-"));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const mode = new ConversationMode();
  await mode.switchMode("off", () => true, async () => {});
  const tools = registeredTools(fakeClient(cwd), cwd, mode);
  fs.writeFileSync(path.join(cwd, "queued.txt"), "first");
  await Promise.all([
    tools.get("edit").execute("edit-first", { path: "queued.txt", edits: [{ oldText: "first", newText: "second" }] }),
    tools.get("edit").execute("edit-second", { path: "queued.txt", edits: [{ oldText: "second", newText: "third" }] }),
  ]);
  assert.equal(fs.readFileSync(path.join(cwd, "queued.txt"), "utf8"), "third");
  const abort = new AbortController();
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const running = tools.get("bash").execute("cancel-bash", { command: "printf started; sleep 20" }, abort.signal, () => started());
  await ready;
  await assert.rejects(() => mode.switchMode("on", () => true, async () => {}), /Retry after.*user Bash/);
  abort.abort();
  await assert.rejects(() => running, /aborted/);
  await mode.switchMode("on", () => true, async () => {});
});

test("native Bash retains Pi session metadata and contextual cwd while sandbox Bash suppresses it", async () => {
  const mode = new ConversationMode();
  const client = fakeClient(process.cwd());
  const tools = registeredTools(client, "/not-the-current-directory", mode);
  const context = {
    cwd: process.cwd(), thinkingLevel: "high", model: { provider: "test-provider", id: "test-model" },
    sessionManager: { getSessionId: () => "conversation-id", getSessionFile: () => "/sessions/current.jsonl" },
  };
  await mode.switchMode("off", () => true, async () => {});
  const result = await tools.get("bash").execute("native-context", {
    command: 'printf "%s|%s|%s|%s|%s" "$PI_SESSION_ID" "$PI_SESSION_FILE" "$PI_PROVIDER" "$PI_MODEL" "$PI_REASONING_LEVEL"',
  }, undefined, undefined, context);
  assert.equal(result.content[0].text, "conversation-id|/sessions/current.jsonl|test-provider|test-model|high");
  await mode.switchMode("on", () => true, async () => {});
  await tools.get("bash").execute("sandbox-context", { command: "pwd" }, undefined, undefined, context);
  assert.equal(client.execCalls[0].options.cwd, process.cwd());
  assert.equal(client.execCalls[0].options.env.PI_SESSION_ID, undefined);
});
