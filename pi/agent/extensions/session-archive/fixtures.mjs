import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ArchiveStore } from "./archive.js";

export function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-archive-"));
  const header = { type: "session", id: "test-session" };
  const entries = [
    { type: "message", id: "early", timestamp: "now", message: { role: "user", content: "distinctive fact: cobalt otter 🌍\nsecond line" } },
    { type: "message", id: "large", timestamp: "now", message: { role: "toolResult", toolName: "read", content: [{ type: "text", text: "x".repeat(22000) + "EXACT-LATE-PASSAGE" }, { type: "image", data: "BINARY", mimeType: "image/png" }] } },
    { type: "message", id: "think", timestamp: "now", message: { role: "assistant", content: [{ type: "thinking", thinking: "consideration", thinkingSignature: "SECRET-SIGNATURE" }, { type: "toolCall", name: "read", arguments: { path: "file.ts" } }] } },
    { type: "context_edit", id: "edit", targetId: "think", replacement: null },
    { type: "custom", id: "custom", customType: "state", data: { value: "raw" } },
  ];
  const store = new ArchiveStore(dir);
  const snapshot = store.publish({ header, entries, firstKeptEntryId: "think" });
  const compaction = { type: "compaction", id: "cmp", firstKeptEntryId: "think", details: snapshot.metadata };
  return { dir, header, entries, store, snapshot, branch: [...entries, compaction], cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}
