#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const TOKEN = 'cwd_label';
const SOURCE = 'worktree-label';

function command(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

function gitInfo(cwd, run = command) {
  const root = run('git', ['-C', cwd, 'rev-parse', '--show-toplevel']);
  if (!root) return null;

  const checkoutRoot = root.trim();
  const gitDir = run('git', ['-C', checkoutRoot, 'rev-parse', '--git-dir']);
  const commonDir = run('git', ['-C', checkoutRoot, 'rev-parse', '--git-common-dir']);
  if (!gitDir || !commonDir) return null;

  const resolvedGitDir = path.resolve(checkoutRoot, gitDir.trim());
  const resolvedCommonDir = path.resolve(checkoutRoot, commonDir.trim());
  return {
    checkoutRoot,
    commonDir: resolvedCommonDir,
    isLinkedWorktree: resolvedGitDir !== resolvedCommonDir,
  };
}

function repositoryName(commonDir) {
  const commonBase = path.basename(commonDir);
  return commonBase === '.bare' || commonBase === '.git'
    ? path.basename(path.dirname(commonDir))
    : commonBase;
}

function fallbackLabel(cwd, home = os.homedir()) {
  const resolved = path.resolve(cwd);
  if (resolved === path.resolve(home)) return '~';
  return path.basename(resolved) || resolved;
}

function displayLabel(cwd, run = command, home = os.homedir()) {
  const git = gitInfo(cwd, run);
  if (!git) return fallbackLabel(cwd, home);

  const checkout = path.basename(git.checkoutRoot);
  if (!git.isLinkedWorktree) return checkout;

  const repository = repositoryName(git.commonDir);
  return repository && checkout ? `${repository} / ${checkout}` : checkout;
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

function reportMetadata(resource, id, cwd, run = command, env = process.env) {
  if (!id || !cwd) return false;
  const label = displayLabel(cwd, run, env.HOME || os.homedir());
  return herdrCommand([
    resource, 'report-metadata', id,
    '--source', SOURCE,
    '--token', `${TOKEN}=${label}`,
  ], run, env) !== null;
}

function reportWorkspace(workspace, run = command, env = process.env) {
  return reportMetadata('workspace', workspace?.workspaceId, workspace?.workspaceCwd, run, env);
}

function reportPane(workspace, run = command, env = process.env) {
  return reportMetadata('pane', workspace?.paneId, workspace?.workspaceCwd, run, env);
}

function currentShellWorkspace(_run = command, env = process.env, cwd = process.cwd()) {
  if (!env.HERDR_WORKSPACE_ID || !env.HERDR_PANE_ID) return null;
  return {
    paneId: env.HERDR_PANE_ID,
    workspaceId: env.HERDR_WORKSPACE_ID,
    workspaceCwd: cwd,
  };
}

function eventWorkspace(env = process.env) {
  const context = parseResponse(env.HERDR_PLUGIN_CONTEXT_JSON || '{}');
  return {
    workspaceId: context?.workspace_id,
    workspaceCwd: context?.workspace_cwd,
  };
}

function startupWorkspaces(run = command, env = process.env) {
  const response = parseResponse(herdrCommand(['workspace', 'list'], run, env));
  const workspaces = response?.result?.workspaces;
  if (!Array.isArray(workspaces)) return [];

  return workspaces.map((workspace) => {
    const panes = parseResponse(herdrCommand([
      'pane', 'list', '--workspace', workspace.workspace_id,
    ], run, env))?.result?.panes;
    const activePane = Array.isArray(panes) && (panes.find((pane) => pane.focused) || panes[0]);
    return {
      workspaceId: workspace.workspace_id,
      workspaceCwd: activePane?.foreground_cwd || activePane?.cwd,
    };
  });
}

function main(env = process.env, run = command) {
  if (env.HERDR_PLUGIN_EVENT === 'startup') {
    return startupWorkspaces(run, env)
      .map((workspace) => reportWorkspace(workspace, run, env))
      .every(Boolean);
  }
  const workspace = env.HERDR_PLUGIN_EVENT
    ? eventWorkspace(env)
    : currentShellWorkspace(run, env);
  return env.HERDR_PLUGIN_EVENT
    ? reportWorkspace(workspace, run, env)
    : reportWorkspace(workspace, run, env) && reportPane(workspace, run, env);
}

if (require.main === module && !main()) process.exitCode = 1;

module.exports = {
  currentShellWorkspace,
  displayLabel,
  eventWorkspace,
  fallbackLabel,
  gitInfo,
  main,
  reportPane,
  reportWorkspace,
  repositoryName,
  startupWorkspaces,
};
