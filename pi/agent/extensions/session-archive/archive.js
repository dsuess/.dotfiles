import fs from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";

export const SCHEMA = 1;
export const ARCHIVE_KIND = "pi-session-archive";
export const OUTPUT_CAP = 16000;
const ID = /^[a-f0-9]{32}$/;
export const fingerprint = (entry) => createHash("sha256").update(JSON.stringify(entry)).digest("hex");

export function archiveReference(entry) {
  const d = entry?.details;
  return entry?.type === "compaction" && d?.kind === ARCHIVE_KIND && d.schema === SCHEMA &&
    typeof d.archiveId === "string" && ID.test(d.archiveId) &&
    d.firstKeptEntryId === entry.firstKeptEntryId ? d : null;
}

export function authorizedReferences(branch) {
  return branch.map(archiveReference).filter(Boolean);
}

// Binary data and provider signatures stay in raw.jsonl, never in the transcript.
function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    if (block.type === "text") return block.text ?? "";
    if (block.type === "thinking") return `[thinking]\n${block.thinking ?? ""}`;
    if (block.type === "toolCall") return `[toolCall ${block.name}]\n${JSON.stringify(block.arguments)}`;
    return `[attachment type=${String(block.type).slice(0, 80)} mime=${String(block.mimeType ?? "unknown").slice(0, 100)}]`;
  }).join("\n");
}

export function buildArtifacts(header, entries, firstKeptEntryId) {
  let transcript = "";
  let spanId = null;
  const edits = new Map();
  for (const entry of entries) if (entry.type === "context_edit") edits.set(entry.targetId, entry);
  const index = entries.map((entry) => {
    const m = entry.message;
    if (m?.role === "user") spanId = entry.id;
    const edit = edits.get(entry.id);
    const annotation = edit ? `\n[context edit ${edit.id}: ${edit.replacement === null ? "omitted from current context" : "content replaced in current context"}]` : "";
    let body = m ? contentText(m.content) : contentText(entry.content);
    if (m?.role === "bashExecution") body = `[bash ${m.command}]\n${m.output ?? ""}`;
    if (entry.type === "compaction" || entry.type === "branch_summary") body = entry.summary;
    if (entry.type === "context_edit") body = `[context edit target=${entry.targetId}: ${entry.replacement === null ? "omission" : "replacement"}]\n${contentText(entry.replacement?.content)}`;
    if (entry.type === "custom") body = `[custom ${entry.customType}]\n${JSON.stringify(entry.data, (key, value) => /signature|data|base64/i.test(key) && typeof value === "string" ? "[opaque payload retained in raw archive]" : value)}`;
    const start = transcript.length;
    transcript += `=== ${entry.id} ${m?.role ?? entry.type} ${entry.timestamp} ===${annotation}\n${body ?? ""}\n`;
    const calls = (Array.isArray(m?.content) ? m.content : []).filter((c) => c.type === "toolCall");
    const tools = [...new Set([m?.toolName, ...calls.map((c) => c.name)].filter(Boolean))].slice(0, 10).map((s) => s.slice(0, 100));
    const files = calls.flatMap((c) => [c.arguments?.path, c.arguments?.file_path]).filter((s) => typeof s === "string").slice(0, 10).map((s) => s.slice(0, 300));
    return { entryId: entry.id, type: entry.type, role: m?.role, timestamp: entry.timestamp, spanId, tools, files, start, end: transcript.length, fingerprint: fingerprint(entry), ...(edit ? { contextEdit: edit.replacement === null ? "omitted" : "replaced" } : {}) };
  });
  return { transcript, index, raw: [header, ...entries].map((e) => JSON.stringify(e)).join("\n") + "\n", firstKeptEntryId };
}

// Resolve only the configured store parent (which may be Stow-managed). The
// private store and every artifact below it must be real, non-symlink objects.
function checkedDirectory(dir, create = false) {
  if (create) {
    try { fs.mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const stat = fs.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error("Unsafe archive directory");
  if ((stat.mode & 0o077) !== 0) throw new Error("Archive directory must have private permissions (0700)");
  return dir;
}

export class ArchiveStore {
  constructor(agentDir) {
    this.root = path.join(fs.realpathSync(agentDir), "session-archives");
  }
  publish({ header, entries, firstKeptEntryId, labels = [] }) {
    checkedDirectory(this.root, true);
    const archiveId = randomUUID().replaceAll("-", "");
    const staging = path.join(this.root, `.pending-${archiveId}`);
    const destination = path.join(this.root, archiveId);
    fs.mkdirSync(staging, { mode: 0o700 });
    try {
      const artifacts = buildArtifacts(header, entries, firstKeptEntryId);
      const metadata = { kind: ARCHIVE_KIND, schema: SCHEMA, archiveId, sourceSession: header?.id, branchLeaf: entries.at(-1)?.id ?? null, firstKeptEntryId, created: new Date().toISOString() };
      for (const [name, data] of Object.entries({ "raw.jsonl": artifacts.raw, "transcript.txt": artifacts.transcript, "index.json": JSON.stringify({ ...metadata, entries: artifacts.index, labels }) })) {
        fs.writeFileSync(path.join(staging, name), data, { mode: 0o600, flag: "wx" });
      }
      if (fs.existsSync(destination)) throw new Error("Archive collision");
      fs.renameSync(staging, destination);
      return { metadata, index: artifacts.index, labels };
    } catch (error) {
      fs.rmSync(staging, { recursive: true, force: true });
      throw error;
    }
  }
  artifact(archiveId, name) {
    if (!ID.test(archiveId)) throw new Error("Invalid archive ID");
    checkedDirectory(this.root);
    const dir = checkedDirectory(path.join(this.root, archiveId));
    const file = path.join(dir, name);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new Error("Unsafe archive artifact");
      return fs.readFileSync(fd, "utf8");
    } finally { fs.closeSync(fd); }
  }
  index(id) {
    const index = JSON.parse(this.artifact(id, "index.json"));
    if (index.archiveId !== id || index.schema !== SCHEMA || index.kind !== ARCHIVE_KIND) throw new Error("Invalid archive schema");
    return index;
  }
  retrieve(params, branch) {
    const reference = authorizedReferences(branch).find((d) => d.archiveId === params.archiveId);
    if (!reference) throw new Error("Archive is not referenced on the current branch");
    let index;
    try { index = this.index(params.archiveId); } catch (error) { throw new Error(`Archive unavailable: ${error.message}`); }
    if (index.firstKeptEntryId !== reference.firstKeptEntryId || index.branchLeaf !== reference.branchLeaf) throw new Error("Archive reference mismatch");
    const integer = (name, fallback, max) => {
      const value = params[name] ?? fallback;
      if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`Invalid ${name}`);
      return value;
    };
    const offset = integer("offset", 0, Number.MAX_SAFE_INTEGER);
    const limit = integer("limit", 5, 10);
    if (limit === 0) throw new Error("limit must be positive");
    let result;
    if (params.operation === "index") {
      const entries = index.entries.slice(offset, offset + limit);
      const ids = new Set(entries.map((e) => e.entryId));
      result = { entries, labels: (index.labels ?? []).filter((l) => ids.has(l.entryId)).slice(0, 10), next: offset + entries.length < index.entries.length ? { ...params, offset: offset + entries.length, limit } : null };
    } else if (params.operation === "read") {
      const start = integer("start", 0, Number.MAX_SAFE_INTEGER);
      const length = integer("length", 4000, 6000);
      if (!length) throw new Error("length must be positive");
      const text = this.artifact(params.archiveId, "transcript.txt");
      if (start > text.length) throw new Error("Range starts beyond transcript");
      const end = Math.min(start + length, text.length);
      result = { start, end, text: text.slice(start, end), entries: index.entries.filter((e) => e.start < end && e.end > start).slice(0, 10).map((e) => ({ entryId: e.entryId, start: e.start, end: e.end, contextEdit: e.contextEdit })), next: end < text.length ? { ...params, start: end, length } : null };
    } else if (params.operation === "search") {
      if (typeof params.query !== "string" || !params.query.length || params.query.length > 200) throw new Error("query must contain 1–200 characters");
      const text = this.artifact(params.archiveId, "transcript.txt");
      const matches = [];
      let cursor = offset;
      while (matches.length < limit) {
        const start = text.indexOf(params.query, cursor);
        if (start < 0) break;
        const end = start + params.query.length;
        const entry = index.entries.find((e) => e.start <= start && e.end > start);
        matches.push({ entryId: entry?.entryId, contextEdit: entry?.contextEdit, start, end, text: text.slice(start, end) });
        cursor = start + 1;
      }
      result = { matches, next: matches.length === limit && text.indexOf(params.query, cursor) >= 0 ? { ...params, offset: cursor, limit } : null };
    } else throw new Error("Unknown operation");
    result = { archiveId: params.archiveId, schema: SCHEMA, rangeUnit: "UTF-16 code units; end exclusive", ...result, truncated: result.next !== null };
    if (JSON.stringify(result).length > OUTPUT_CAP) {
      // JSON escaping can multiply text size. Reduce the actual page and keep
      // exact continuation offsets rather than truncating the serialized result.
      if (params.operation === "read" && result.end - result.start > 1) return this.retrieve({ ...params, length: Math.floor((result.end - result.start) / 2) }, branch);
      if (limit > 1) return this.retrieve({ ...params, limit: Math.floor(limit / 2) }, branch);
      throw new Error("Archive entry metadata exceeds output cap");
    }
    return result;
  }
}
