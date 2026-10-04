const STORE_KEY = Symbol.for("dotfiles.pi.srt-tool-routing.client-policy.v1");
const reloadSnapshots = globalThis[STORE_KEY] ??= new WeakMap();

/** Process-only reload retention; never reconstruct authority from history/env. */
export function takeReloadPolicy(sessionManager, reason) {
  const retained = sessionManager && reason === "reload" ? reloadSnapshots.get(sessionManager) : undefined;
  if (sessionManager) reloadSnapshots.delete(sessionManager);
  return retained;
}
export function retainReloadPolicy(sessionManager, reason, state) {
  if (!sessionManager) return;
  if (reason === "reload" && state) reloadSnapshots.set(sessionManager, state);
  else reloadSnapshots.delete(sessionManager);
}

/** Explicit trusted command actions only. This service is never a model tool. */
export function createClientPolicyService({ client, configuration, control, publish = () => {} }) {
  let effective = client.effectiveSnapshot;
  let blockedReason = null;
  function block(reason) {
    blockedReason = reason;
    control.blockSandbox(reason);
  }
  async function activate(saved, prepared) {
    await client.activatePolicy(prepared, saved);
    effective = saved;
  }
  async function verify() {
    if (blockedReason) throw new Error(blockedReason);
    const status = await client.status();
    if (!effective || status.effectiveRevision !== effective.revision || status.policyGeneration !== client.policyGeneration) {
      throw new Error("Sandbox effective policy does not match this client; reload saved grants");
    }
  }
  async function restore(retained) {
    if (!retained) return;
    try {
      if (client.effectiveSnapshot?.revision !== retained.effective?.revision) {
        const prepared = await client.preparePolicy(retained.effective);
        await activate(retained.effective, prepared);
      } else effective = retained.effective;
      if (retained.blockedReason) block(retained.blockedReason);
    } catch (failure) {
      effective = retained.effective;
      block(`Sandbox execution blocked: retained policy could not be restored; reload saved grants. ${failure.message}`);
    }
  }
  async function status() {
    const controller = await client.status();
    let saved = null, savedError = null;
    try { saved = configuration.read(); } catch (failure) { savedError = failure.message; }
    return { ...controller, savedRevision: saved?.revision ?? null, effectiveRevision: effective?.revision ?? null,
      refreshNeeded: Boolean(blockedReason || savedError || saved?.revision !== effective?.revision),
      savedError, blockedReason, configPath: saved?.configPath ?? effective?.configPath ?? controller.configPath,
      configuredGrants: saved?.grants.map(({ canonicalPath, access }) => ({ path: canonicalPath, access })) ?? [],
      filesystemGrants: effective?.grants.map(({ canonicalPath, access }) => ({ path: canonicalPath, access })) ?? [] };
  }
  async function change(change, ctx) {
    return control.atIdle(ctx, async () => {
      if (blockedReason) throw new Error(blockedReason);
      const saved = configuration.read();
      const candidate = configuration.prepare(change, saved);
      // Controller composition and alias validation must succeed before saving.
      const prepared = await client.preparePolicy(candidate);
      const committed = await configuration.commit(candidate);
      try { await activate(committed, prepared); }
      catch (failure) {
        block(`Saved sandbox grants (${committed.revision}) but current-client activation failed; effective grants remain unconfirmed. Sandbox operations are blocked until /sandbox reload succeeds. ${failure.message}`);
        const error = Object.assign(new Error(blockedReason), { code: "SAVED_POLICY_NOT_ACTIVE", savedRevision: committed.revision, effectiveRevision: effective?.revision ?? null });
        // Publication failure must not conceal the saved/effective mismatch.
        try { await publish(await status()); } catch {}
        throw error;
      }
      const next = await status();
      await publish(next);
      return next;
    });
  }
  async function reloadGrants(ctx) {
    return control.atIdle(ctx, async () => {
      try {
        const saved = configuration.read();
        const prepared = await client.preparePolicy(saved);
        await activate(saved, prepared);
        blockedReason = null;
        // Existing control gate accepts an empty reason to remove its block.
        control.blockSandbox("");
        const next = await status();
        await publish(next);
        return next;
      } catch (failure) {
        block(`Sandbox execution blocked: saved grants could not be refreshed; retry /sandbox reload. ${failure.message}`);
        throw new Error(blockedReason);
      }
    });
  }
  return Object.freeze({ status, listGrants: status, verify, restore, reloadGrants,
    addGrant: (access, pathname, ctx) => change({ type: "add", access, path: pathname }, ctx),
    removeGrant: (pathname, ctx) => change({ type: "remove", path: pathname }, ctx),
    retention: () => ({ effective, blockedReason }),
  });
}
