#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

function stat(target) {
  const value = fs.lstatSync(target);
  return { mode: value.mode, size: value.size, mtimeMs: value.mtimeMs, isFile: value.isFile(), isDirectory: value.isDirectory(), isSymbolicLink: value.isSymbolicLink() };
}
function fail(error) {
  return { ok: false, code: error?.code ?? "helper_error", message: String(error?.message ?? error).slice(0, 4096) };
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; if (Buffer.byteLength(input) > 12 * 1024 * 1024) process.stdin.destroy(new Error("request too large")); });
process.stdin.on("end", () => {
  try {
    const { operation, params } = JSON.parse(input);
    let result;
    switch (operation) {
      case "access": fs.accessSync(params.path, params.mode); result = true; break;
      case "mkdir": fs.mkdirSync(params.path, { recursive: params.recursive, mode: params.mode }); result = true; break;
      case "listDir": result = fs.readdirSync(params.path); break;
      case "stat": result = stat(params.path); break;
      case "rename": fs.renameSync(params.oldPath, params.newPath); result = true; break;
      case "deleteFile": fs.rmSync(params.path, { force: params.force, recursive: params.recursive }); result = true; break;
      case "readFile": { const source = fs.readFileSync(params.path); const data = source.subarray(params.offset, params.offset + params.limit); result = { data: data.toString("base64"), truncated: params.offset + data.length < source.length }; break; }
      case "writeFile": fs.mkdirSync(path.dirname(params.path), { recursive: true }); fs.writeFileSync(params.path, Buffer.from(params.data, "base64")); result = true; break;
      default: throw new Error("unsupported fixed helper operation");
    }
    process.stdout.write(JSON.stringify({ ok: true, result }));
  } catch (error) { process.stdout.write(JSON.stringify(fail(error))); process.exitCode = 1; }
});
