#!/usr/bin/env node
import { beginControllerStartup } from "./client.mjs";
const [command, ...args] = process.argv.slice(2);
if (command !== "preflight") throw new Error("only preflight is supported");
let launchDirectory;
for (let i = 0; i < args.length; i += 2) { if (args[i] === "--launch-dir") launchDirectory = args[i + 1]; }
if (!launchDirectory) throw new Error("--launch-dir is required");
const descriptor = beginControllerStartup({ launchDirectory });
process.stdout.write(Buffer.from(JSON.stringify(descriptor)).toString("base64"));
