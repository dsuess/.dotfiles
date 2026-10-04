import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { CONFIG_PATH, validateFilesystemConfiguration, validateFilesystemGrants } from "./filesystem-grants.mjs";

function immutable(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function snapshot(value) {
  // Copy before freezing: no caller may mutate operation authority afterwards.
  return immutable(JSON.parse(JSON.stringify(value)));
}
function error(code, message) { return Object.assign(new Error(message), { code }); }

/** Connection-bound authority. Lease siblings never share mutable policy state. */
export class ClientPolicies {
  constructor({ configuration, validation, buildPolicy }) {
    this.configuration = configuration;
    this.validation = validation;
    this.buildPolicy = buildPolicy;
    this.connections = new WeakMap();
  }
  context(connection, initialize = true) {
    let context = this.connections.get(connection);
    if (!context) {
      context = { effective: null, prepared: null };
      this.connections.set(connection, context);
    }
    if (initialize && !context.effective) context.effective = this.compose(this.configuration.read());
    return context;
  }
  compose(saved) {
    const grants = validateFilesystemConfiguration(saved.config, this.validation);
    if (saved.grants) {
      validateFilesystemGrants(saved.grants, this.validation);
      if (JSON.stringify(grants) !== JSON.stringify(saved.grants)) throw error("stale_grants", "Grant targets changed; reload saved grants");
    }
    return snapshot({ configuration: { config: saved.config, grants, revision: saved.revision,
      configPath: saved.configPath, targetPath: saved.targetPath }, policy: this.buildPolicy(grants) });
  }
  capture(connection, generation) {
    const effective = this.context(connection).effective;
    if (generation !== undefined && generation !== effective.policy.generation) throw error("stale_generation", "stale client policy generation");
    validateFilesystemGrants(effective.configuration.grants, this.validation);
    return effective;
  }
  prepare(connection, value) {
    const context = this.context(connection, false);
    // Reload can restore a complete trusted snapshot even if saved JSON was
    // edited into an invalid state. Never take file locations from RPC input.
    const configPath = path.resolve(this.validation.configPath ?? CONFIG_PATH);
    const effective = this.compose({ ...value, configPath, targetPath: fs.realpathSync(configPath) });
    const preparation = randomBytes(32).toString("hex");
    context.prepared = { preparation, effective };
    return { preparation, policyGeneration: effective.policy.generation };
  }
  activate(connection, preparation, revision) {
    const context = this.context(connection, false);
    if (context.prepared?.preparation !== preparation) throw error("invalid_preparation", "Policy preparation belongs to another connection or is stale");
    const candidate = context.prepared.effective;
    // Revalidate aliases at activation; a post-save failure must be reported by
    // the trusted action service rather than pretending revocation succeeded.
    validateFilesystemGrants(candidate.configuration.grants, this.validation);
    context.effective = snapshot({ ...candidate, configuration: { ...candidate.configuration, revision } });
    context.prepared = null;
    return { policyGeneration: context.effective.policy.generation, effectiveRevision: revision };
  }
  status(connection) {
    const effective = this.context(connection).effective;
    let savedRevision = null, savedError = null;
    try { savedRevision = this.configuration.read().revision; }
    catch (failure) { savedError = failure.message; }
    return { policyGeneration: effective.policy.generation, effectiveRevision: effective.configuration.revision,
      savedRevision, refreshNeeded: savedRevision !== effective.configuration.revision,
      savedError, configPath: effective.configuration.configPath,
      filesystemGrants: effective.configuration.grants.map(({ canonicalPath, access }) => ({ path: canonicalPath, access })),
      effectiveConfiguration: effective.configuration };
  }
}

export const clientPolicyInternals = Object.freeze({ immutable, snapshot });
