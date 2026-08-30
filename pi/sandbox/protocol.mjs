export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 12 * 1024 * 1024;
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
export const MAX_ARGV_BYTES = 64 * 1024;
export const MAX_ENV_BYTES = 128 * 1024;
export const MAX_PATH_BYTES = 4096;

export const PROTOCOL_METHODS = Object.freeze([
  "lease.acquire",
  "lease.renew",
  "lease.heartbeat",
  "lease.release",
  "status",
  "fs.access",
  "fs.mkdir",
  "fs.listDir",
  "fs.stat",
  "fs.rename",
  "fs.readFile",
  "fs.writeFile",
  "fs.deleteFile",
  "exec",
  "cancel",
  "reload",
  "restart",
  "docker.reset",
]);

const METHOD_SET = new Set(PROTOCOL_METHODS);
const REQUEST_KEYS = new Set(["v", "type", "id", "method", "auth", "params"]);
const RESPONSE_KEYS = new Set(["v", "type", "id", "ok", "result", "error"]);

function protocolError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function plainObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw protocolError("invalid_request", `${label} must be an object`);
  }
  return value;
}

function exactKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw protocolError("invalid_request", `${label} has unknown key: ${key}`);
    }
  }
}

function string(value, label, maxBytes, { empty = false } = {}) {
  if (
    typeof value !== "string" ||
    (!empty && value.length === 0) ||
    value.includes("\0") ||
    Buffer.byteLength(value) > maxBytes
  ) {
    throw protocolError("invalid_request", `${label} is invalid`);
  }
  return value;
}

function absolutePath(value, label) {
  const candidate = string(value, label, MAX_PATH_BYTES);
  if (!candidate.startsWith("/")) {
    throw protocolError("invalid_request", `${label} must be absolute`);
  }
  return candidate;
}

function integer(value, label, minimum, maximum) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw protocolError("invalid_request", `${label} is out of range`);
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== "boolean") {
    throw protocolError("invalid_request", `${label} must be boolean`);
  }
  return value;
}

function generation(value, label = "policyGeneration") {
  const result = string(value, label, 64);
  if (!/^[0-9a-f]{64}$/.test(result)) {
    throw protocolError("invalid_request", `${label} is invalid`);
  }
  return result;
}

function authToken(value) {
  const result = string(value, "auth", 128);
  if (!/^[0-9a-f]{64}$/.test(result)) {
    throw protocolError("unauthorized", "invalid authentication token");
  }
  return result;
}

function paramsObject(value) {
  return plainObject(value ?? {}, "params");
}

function validatePathParams(params, keys = []) {
  exactKeys(params, new Set(["path", "policyGeneration", ...keys]), "params");
  absolutePath(params.path, "params.path");
  generation(params.policyGeneration);
}

function validateExec(params) {
  exactKeys(
    params,
    new Set(["argv", "cwd", "env", "timeoutMs", "maxOutputBytes", "policyGeneration"]),
    "params",
  );
  generation(params.policyGeneration);
  if (!Array.isArray(params.argv) || params.argv.length < 1 || params.argv.length > 256) {
    throw protocolError("invalid_request", "params.argv is invalid");
  }
  let argvBytes = 0;
  for (const [index, entry] of params.argv.entries()) {
    argvBytes += Buffer.byteLength(string(entry, `params.argv[${index}]`, 16 * 1024, { empty: true }));
  }
  if (argvBytes > MAX_ARGV_BYTES || !params.argv[0].startsWith("/")) {
    throw protocolError("invalid_request", "params.argv is too large or argv[0] is not absolute");
  }
  absolutePath(params.cwd, "params.cwd");
  integer(params.timeoutMs, "params.timeoutMs", 1, 60 * 60 * 1000);
  integer(params.maxOutputBytes, "params.maxOutputBytes", 1, MAX_OUTPUT_BYTES);

  const env = plainObject(params.env, "params.env");
  if (Object.keys(env).length > 128) throw protocolError("invalid_request", "params.env has too many entries");
  let envBytes = 0;
  for (const [name, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name)) {
      throw protocolError("invalid_request", `invalid environment name: ${name}`);
    }
    envBytes += Buffer.byteLength(name) + Buffer.byteLength(string(value, `params.env.${name}`, 32 * 1024, { empty: true }));
  }
  if (envBytes > MAX_ENV_BYTES) throw protocolError("invalid_request", "params.env is too large");
}

function decodeCanonicalBase64(value) {
  if (value.length % 4 !== 0) {
    throw protocolError("invalid_request", "params.data is not canonical base64");
  }
  const padding = value.indexOf("=");
  const contentEnd = padding < 0 ? value.length : padding;
  if (padding >= 0 && (value.length - padding > 2 || !/^=+$/.test(value.slice(padding)))) {
    throw protocolError("invalid_request", "params.data is not canonical base64");
  }
  for (let index = 0; index < contentEnd; index += 1) {
    const code = value.charCodeAt(index);
    const valid =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!valid) throw protocolError("invalid_request", "params.data is not canonical base64");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw protocolError("invalid_request", "params.data is not canonical base64");
  }
  return decoded;
}

function validateMethod(method, params) {
  switch (method) {
    case "lease.acquire":
      exactKeys(params, new Set(["workspaceKey", "clientId"]), "params");
      generation(params.workspaceKey, "params.workspaceKey");
      string(params.clientId, "params.clientId", 256);
      break;
    case "lease.renew":
      exactKeys(params, new Set(["workspaceKey", "leaseToken"]), "params");
      generation(params.workspaceKey, "params.workspaceKey");
      authToken(params.leaseToken);
      break;
    case "lease.heartbeat":
    case "lease.release":
      exactKeys(params, new Set(), "params");
      break;
    case "status":
      exactKeys(params, new Set(["policyGeneration"]), "params");
      if (params.policyGeneration !== undefined) generation(params.policyGeneration);
      break;
    case "fs.access":
      validatePathParams(params, ["mode"]);
      integer(params.mode, "params.mode", 0, 7);
      break;
    case "fs.mkdir":
      validatePathParams(params, ["recursive", "mode"]);
      boolean(params.recursive, "params.recursive");
      integer(params.mode, "params.mode", 0, 0o777);
      break;
    case "fs.listDir":
    case "fs.stat":
      validatePathParams(params);
      break;
    case "fs.rename":
      exactKeys(params, new Set(["oldPath", "newPath", "policyGeneration"]), "params");
      absolutePath(params.oldPath, "params.oldPath");
      absolutePath(params.newPath, "params.newPath");
      generation(params.policyGeneration);
      break;
    case "fs.readFile":
      validatePathParams(params, ["offset", "limit"]);
      integer(params.offset, "params.offset", 0, Number.MAX_SAFE_INTEGER);
      integer(params.limit, "params.limit", 1, MAX_FILE_BYTES);
      break;
    case "fs.writeFile": {
      validatePathParams(params, ["data"]);
      const data = string(params.data, "params.data", Math.ceil(MAX_FILE_BYTES / 3) * 4, {
        empty: true,
      });
      if (decodeCanonicalBase64(data).length > MAX_FILE_BYTES) {
        throw protocolError("invalid_request", "params.data exceeds the file limit");
      }
      break;
    }
    case "fs.deleteFile":
      validatePathParams(params, ["force", "recursive"]);
      boolean(params.force, "params.force");
      boolean(params.recursive, "params.recursive");
      break;
    case "exec":
      validateExec(params);
      break;
    case "cancel":
      exactKeys(params, new Set(["requestId"]), "params");
      integer(params.requestId, "params.requestId", 1, 0x7fffffff);
      break;
    case "reload":
      exactKeys(params, new Set(["expectedPolicyGeneration"]), "params");
      if (params.expectedPolicyGeneration !== undefined) {
        generation(params.expectedPolicyGeneration, "params.expectedPolicyGeneration");
      }
      break;
    case "restart":
      exactKeys(params, new Set(["policyGeneration"]), "params");
      generation(params.policyGeneration);
      break;
    case "docker.reset":
      exactKeys(params, new Set(["policyGeneration"]), "params");
      generation(params.policyGeneration);
      break;
    default:
      throw protocolError("unknown_method", `unknown protocol method: ${method}`);
  }
}

export function validateRequest(value) {
  const request = plainObject(value, "request");
  exactKeys(request, REQUEST_KEYS, "request");
  if (request.v !== PROTOCOL_VERSION || request.type !== "request") {
    throw protocolError("protocol_version", "unsupported protocol frame");
  }
  integer(request.id, "request.id", 1, 0x7fffffff);
  if (typeof request.method !== "string" || !METHOD_SET.has(request.method)) {
    throw protocolError("unknown_method", "request.method is not allowed");
  }
  authToken(request.auth);
  const params = paramsObject(request.params);
  validateMethod(request.method, params);
  return request;
}

export function validateResponse(value) {
  const response = plainObject(value, "response");
  if (response.type === "event") {
    exactKeys(response, new Set(["v", "type", "id", "event", "data"]), "event");
    if (response.v !== PROTOCOL_VERSION) throw protocolError("protocol_version", "unsupported event");
    integer(response.id, "event.id", 1, 0x7fffffff);
    if (!new Set(["stdout", "stderr"]).has(response.event)) {
      throw protocolError("invalid_response", "invalid stream event");
    }
    string(response.data, "event.data", MAX_FRAME_BYTES, { empty: true });
    return response;
  }
  exactKeys(response, RESPONSE_KEYS, "response");
  if (response.v !== PROTOCOL_VERSION || response.type !== "response") {
    throw protocolError("protocol_version", "unsupported response frame");
  }
  integer(response.id, "response.id", 1, 0x7fffffff);
  if (typeof response.ok !== "boolean") throw protocolError("invalid_response", "response.ok is invalid");
  if (response.ok && "error" in response) throw protocolError("invalid_response", "successful response has an error");
  if (!response.ok) {
    const error = plainObject(response.error, "response.error");
    exactKeys(error, new Set(["code", "message"]), "response.error");
    string(error.code, "response.error.code", 128);
    string(error.message, "response.error.message", 4096);
  }
  return response;
}

export function encodeFrame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  if (payload.length === 0 || payload.length > MAX_FRAME_BYTES) {
    throw protocolError("frame_too_large", "protocol frame exceeds the size limit");
  }
  const frame = Buffer.allocUnsafe(payload.length + 4);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  return frame;
}

export class FrameDecoder {
  constructor(onFrame, options = {}) {
    this.onFrame = onFrame;
    this.maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
    this.buffer = Buffer.alloc(0);
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    if (this.buffer.length + chunk.length > this.maxFrameBytes + 4) {
      throw protocolError("frame_too_large", "buffered protocol data exceeds the size limit");
    }
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const length = this.buffer.readUInt32BE(0);
      if (length < 1 || length > this.maxFrameBytes) {
        throw protocolError("frame_too_large", "declared protocol frame is invalid");
      }
      if (this.buffer.length < length + 4) return;
      const payload = this.buffer.subarray(4, length + 4);
      this.buffer = this.buffer.subarray(length + 4);
      let value;
      try {
        value = JSON.parse(payload.toString("utf8"));
      } catch {
        throw protocolError("invalid_json", "protocol frame is not valid JSON");
      }
      this.onFrame(value);
    }
  }
}

export function makeRequest(id, method, auth, params = {}) {
  return { v: PROTOCOL_VERSION, type: "request", id, method, auth, params };
}

export function makeResponse(id, result) {
  return { v: PROTOCOL_VERSION, type: "response", id, ok: true, result };
}

export function makeErrorResponse(id, error) {
  return {
    v: PROTOCOL_VERSION,
    type: "response",
    id,
    ok: false,
    error: {
      code: typeof error?.code === "string" ? error.code : "controller_error",
      message: error instanceof Error ? error.message.slice(0, 4096) : "controller request failed",
    },
  };
}

export function makeStreamEvent(id, stream, data) {
  return {
    v: PROTOCOL_VERSION,
    type: "event",
    id,
    event: stream,
    data: Buffer.from(data).toString("base64"),
  };
}

export const protocolInternals = Object.freeze({ protocolError });
