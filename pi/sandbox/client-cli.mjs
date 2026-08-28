#!/usr/bin/env node
import { acquireControllerLease, beginControllerStartup } from "./client.mjs";
const [command, ...args] = process.argv.slice(2);
if (command === "preflight") {
  let launchDirectory;
  for (let i = 0; i < args.length; i += 2) { if (args[i] === "--launch-dir") launchDirectory = args[i + 1]; }
  if (!launchDirectory) throw new Error("--launch-dir is required");
  const descriptor = beginControllerStartup({ launchDirectory });
  process.stdout.write(Buffer.from(JSON.stringify(descriptor)).toString("base64"));
} else if (command === "bash") {
  const [encoded, cwd, commandText] = args;
  if (!encoded || !cwd || commandText === undefined) throw new Error("bash requires descriptor, cwd, and command");
  const startup = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  const { client } = await acquireControllerLease({ startup, clientId: `pi-print-${process.pid}` });
  try {
    const result = await client.exec(["/bin/bash", "-lc", commandText], {
      cwd, env: {}, timeoutMs: 60 * 60 * 1000, maxOutputBytes: 16 * 1024 * 1024,
      onEvent: (_stream, data) => process.stdout.write(data),
    });
    process.exitCode = result.exitCode;
  } finally { await client.release(); }
} else throw new Error("supported commands: preflight, bash");
