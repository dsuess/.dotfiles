import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const env = { ...process.env };
delete env.NODE_TEST_CONTEXT;
const child = spawn(process.execPath, ["--test", "--test-concurrency=1", "ui-performance/footer.test.mjs", "ui-performance/capture.test.mjs", "ui-performance/runtime.test.mjs", "ui-performance/sensitivity.test.mjs"], { cwd: root, stdio: "inherit", env, detached: true });
const timer = setTimeout(() => {
 console.error("UI performance suite stalled: process deadline exceeded (30s)");
 process.kill(-child.pid, "SIGKILL");
}, 30000);
child.on("error", error => { clearTimeout(timer); console.error(error); process.exitCode = 1; });
child.on("exit", (code) => { clearTimeout(timer); process.exitCode = code ?? 1; });

for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => {
 clearTimeout(timer);
 try { process.kill(-child.pid, "SIGKILL"); } catch {}
 process.exitCode = 1;
});
