#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

function command(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

function gitWorktree(cwd, run = command) {
  const root = run('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
  if (!root) return null;

  const checkoutRoot = root.trim();
  const gitDir = run('git', ['-C', checkoutRoot, 'rev-parse', '--git-dir']);
  const commonDir = run('git', ['-C', checkoutRoot, 'rev-parse', '--git-common-dir']);
  if (!gitDir || !commonDir) return null;

  const resolvedGitDir = path.resolve(checkoutRoot, gitDir.trim());
  const resolvedCommonDir = path.resolve(checkoutRoot, commonDir.trim());
  if (resolvedGitDir === resolvedCommonDir) return null;

  const checkout = path.basename(checkoutRoot);
  const commonBase = path.basename(resolvedCommonDir);
  const repository = commonBase === '.bare' || commonBase === '.git'
    ? path.basename(path.dirname(resolvedCommonDir))
    : commonBase;
  if (!repository || !checkout) return null;

  return { checkoutRoot, label: `${repository} / ${checkout}` };
}

function shouldRename(currentLabel, checkoutRoot, label) {
  return currentLabel === path.basename(checkoutRoot) || currentLabel === label;
}

function parseResponse(output) {
  try {
    return JSON.parse(output);
  } catch {
    return null;
  }
}

function herdrCommand(args, run = command, env = process.env) {
  return run(env.HERDR_BIN_PATH || 'herdr', args, { env });
}

function statePath(env) {
  return env.HERDR_PLUGIN_STATE_DIR && path.join(env.HERDR_PLUGIN_STATE_DIR, 'workspaces.json');
}

function readState(env) {
  const file = statePath(env);
  if (!file) return {};
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return {};
  }
}

function writeState(state, env) {
  const file = statePath(env);
  if (!file) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(state));
}

function rememberAutomaticLabel(workspace, run = command, env = process.env) {
  if (!workspace?.workspaceId || !workspace?.workspaceCwd || !workspace?.workspaceLabel) return;
  if (workspace.workspaceLabel !== path.basename(workspace.workspaceCwd) || gitWorktree(workspace.workspaceCwd, run)) {
    return;
  }
  const state = readState(env);
  if (!state[workspace.workspaceId]) {
    state[workspace.workspaceId] = { label: null, originalLabel: workspace.workspaceLabel };
    writeState(state, env);
  }
}

function renameWorkspace(workspace, run = command, env = process.env) {
  if (!workspace?.workspaceId || !workspace?.workspaceCwd || !workspace?.workspaceLabel) {
    return false;
  }

  const state = readState(env);
  const managed = state[workspace.workspaceId];
  const worktree = gitWorktree(workspace.workspaceCwd, run);
  if (!worktree) {
    if (!managed || workspace.workspaceLabel !== managed.label) return false;
    if (herdrCommand(['workspace', 'rename', workspace.workspaceId, managed.originalLabel], run, env) === null) {
      return false;
    }
    delete state[workspace.workspaceId];
    writeState(state, env);
    return true;
  }

  const automatic = shouldRename(workspace.workspaceLabel, worktree.checkoutRoot, worktree.label);
  const originalAutomatic = managed?.label === null && managed.originalLabel === workspace.workspaceLabel;
  if (!automatic && managed?.label !== workspace.workspaceLabel && !originalAutomatic) return false;
  if (workspace.workspaceLabel === worktree.label) {
    if (!managed) {
      state[workspace.workspaceId] = { label: worktree.label, originalLabel: path.basename(worktree.checkoutRoot) };
      writeState(state, env);
    }
    return false;
  }
  if (herdrCommand(['workspace', 'rename', workspace.workspaceId, worktree.label], run, env) === null) {
    return false;
  }
  state[workspace.workspaceId] = {
    label: worktree.label,
    originalLabel: managed?.originalLabel || workspace.workspaceLabel,
  };
  writeState(state, env);
  return true;
}

function eventWorkspace(env = process.env) {
  const context = parseResponse(env.HERDR_PLUGIN_CONTEXT_JSON || '{}');
  return {
    workspaceId: context?.workspace_id,
    workspaceLabel: context?.workspace_label,
    workspaceCwd: context?.workspace_cwd,
  };
}

function startupWorkspaces(run = command, env = process.env) {
  const response = parseResponse(herdrCommand(['workspace', 'list'], run, env));
  const workspaces = response?.result?.workspaces;
  if (!Array.isArray(workspaces)) return [];

  return workspaces.map((workspace) => {
    const panes = parseResponse(herdrCommand(['pane', 'list', '--workspace', workspace.workspace_id], run, env))
      ?.result?.panes;
    const activePane = Array.isArray(panes) && (panes.find((pane) => pane.focused) || panes[0]);
    return {
      workspaceId: workspace.workspace_id,
      workspaceLabel: workspace.label,
      workspaceCwd: activePane?.cwd || activePane?.foreground_cwd,
    };
  });
}

function main(env = process.env, run = command) {
  if (env.HERDR_PLUGIN_EVENT === 'startup') {
    for (const workspace of startupWorkspaces(run, env)) renameWorkspace(workspace, run, env);
    return;
  }
  const workspace = eventWorkspace(env);
  if (env.HERDR_PLUGIN_EVENT === 'workspace.created') rememberAutomaticLabel(workspace, run, env);
  renameWorkspace(workspace, run, env);
}

if (require.main === module) main();

module.exports = {
  eventWorkspace,
  gitWorktree,
  main,
  rememberAutomaticLabel,
  renameWorkspace,
  shouldRename,
  startupWorkspaces,
};
