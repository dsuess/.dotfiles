'use strict';

const assert = require('node:assert/strict');
const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const plugin = require('../index.js');

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeFixture(name = 'visonic') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worktree label '));
  const seed = path.join(root, 'seed');
  const repository = path.join(root, name);
  fs.mkdirSync(seed);
  git(['init'], seed);
  git(['config', 'user.email', 'test@example.com'], seed);
  git(['config', 'user.name', 'Test User'], seed);
  fs.writeFileSync(path.join(seed, 'README.md'), 'fixture\n');
  git(['add', '.'], seed);
  git(['commit', '-m', 'initial'], seed);
  fs.mkdirSync(repository);
  git(['clone', '--bare', seed, '.bare'], repository);
  return { root, repository };
}

function addWorktree(fixture, name) {
  const checkout = path.join(fixture.repository, name);
  const branch = `worktree-${name.replaceAll(/[^A-Za-z0-9._-]/g, '-')}`;
  git(['--git-dir', path.join(fixture.repository, '.bare'), 'worktree', 'add', checkout, '-b', branch]);
  return checkout;
}

function response(result) {
  return JSON.stringify({ id: 'test', result });
}

function fakeHerdr(root, workspaces, panes) {
  const calls = path.join(root, 'herdr-calls.jsonl');
  const executable = path.join(root, 'fake-herdr.js');
  fs.writeFileSync(executable, `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const workspaces = JSON.parse(process.env.FAKE_WORKSPACES);
const panes = JSON.parse(process.env.FAKE_PANES);
if (args[0] === 'workspace' && args[1] === 'list') {
  console.log(JSON.stringify({ id: 'fake', result: { workspaces } }));
} else if (args[0] === 'pane' && args[1] === 'list') {
  console.log(JSON.stringify({ id: 'fake', result: { panes: panes[args[3]] || [] } }));
} else if (args[0] === 'pane' && args[1] === 'get') {
  console.log(JSON.stringify({ id: 'fake', result: { pane: { pane_id: args[2], focused: process.env.FAKE_PANE_FOCUSED !== 'false' } } }));
} else if ((args[0] === 'workspace' || args[0] === 'pane') && args[1] === 'report-metadata') {
  fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(args) + '\\n');
  console.log(JSON.stringify({ id: 'fake', result: { type: 'ok' } }));
} else {
  process.exit(1);
}
`);
  fs.chmodSync(executable, 0o755);
  return {
    calls,
    executable,
    env: {
      FAKE_CALLS: calls,
      FAKE_PANES: JSON.stringify(panes),
      FAKE_WORKSPACES: JSON.stringify(workspaces),
      HERDR_PLUGIN_STATE_DIR: path.join(root, 'state'),
    },
  };
}

function pluginProcess(env) {
  const result = spawnSync(process.execPath, [path.join(__dirname, '..', 'index.js')], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  assert.equal(result.status, 0, result.stderr);
}

function calls(file) {
  return fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
    : [];
}

test('derives dynamic labels for linked worktrees and nested paths', (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const dev = addWorktree(fixture, 'dev');
  const polishing = addWorktree(fixture, 'ad20-polishing');
  fs.mkdirSync(path.join(polishing, 'nested'));

  assert.equal(plugin.displayLabel(dev), 'visonic / dev');
  assert.equal(plugin.displayLabel(path.join(polishing, 'nested')), 'visonic / ad20-polishing');
});

test('uses the Git root for ordinary repositories and the CWD outside Git', (t) => {
  const fixture = makeFixture('space repo');
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const checkout = addWorktree(fixture, 'feature space');
  assert.equal(plugin.displayLabel(checkout), 'space repo / feature space');

  const ordinary = path.join(fixture.root, 'ordinary');
  const nested = path.join(ordinary, 'nested');
  fs.mkdirSync(nested, { recursive: true });
  git(['init'], ordinary);
  assert.equal(plugin.displayLabel(nested), 'ordinary');
  assert.equal(plugin.displayLabel(fixture.root), path.basename(fixture.root));
  assert.equal(plugin.fallbackLabel('/tmp/home', '/tmp/home'), '~');
});

test('reports a display-only metadata token without renaming the workspace', () => {
  const root = '/tmp/visonic/dev';
  const commands = [];
  const run = (command, args) => {
    if (command === 'git') {
      if (args.includes('--show-toplevel')) return `${root}\n`;
      if (args.includes('--git-dir')) return '/tmp/visonic/.bare/worktrees/dev\n';
      return '/tmp/visonic/.bare\n';
    }
    commands.push([command, args]);
    return response({ type: 'ok' });
  };

  assert.equal(plugin.reportWorkspace(
    { workspaceId: 'w1', workspaceCwd: root },
    run,
    { HERDR_BIN_PATH: 'fake-herdr' },
  ), true);
  assert.deepEqual(commands, [[
    'fake-herdr',
    ['workspace', 'report-metadata', 'w1', '--source', 'worktree-label', '--token', 'cwd_label=visonic / dev'],
  ]]);
});

test('shell reports its inherited CWD label to both workspace and pane', () => {
  const commands = [];
  const run = (command, args) => {
    commands.push([command, args]);
    if (command === 'git') return null;
    return response({ type: 'ok' });
  };
  const env = {
    HERDR_BIN_PATH: 'fake-herdr',
    HERDR_PANE_ID: 'w1:p1',
    HERDR_WORKSPACE_ID: 'w1',
    HOME: '/tmp/home',
  };

  const shell = plugin.currentShellWorkspace(run, env, '/tmp/project');
  assert.deepEqual(shell, {
    paneId: 'w1:p1',
    workspaceId: 'w1',
    workspaceCwd: '/tmp/project',
  });
  assert.equal(plugin.reportWorkspace(shell, run, env), true);
  assert.equal(plugin.reportPane(shell, run, env), true);
  assert.deepEqual(commands.map(([, args]) => args), [
    ['-C', '/tmp/project', 'rev-parse', '--show-toplevel'],
    ['workspace', 'report-metadata', 'w1', '--source', 'worktree-label', '--token', 'cwd_label=project'],
    ['-C', '/tmp/project', 'rev-parse', '--show-toplevel'],
    ['pane', 'report-metadata', 'w1:p1', '--source', 'worktree-label', '--token', 'cwd_label=project'],
  ]);
});

test('the production Zsh hook reports every directory transition', (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const checkout = addWorktree(fixture, 'dev');
  const nested = path.join(checkout, 'nested');
  const outside = path.join(fixture.root, 'outside');
  fs.mkdirSync(nested);
  fs.mkdirSync(outside);
  const fake = fakeHerdr(fixture.root, [], {});
  const hook = path.join(__dirname, '..', 'shell.zsh');
  const script = `source \"$HOOK\"; _dotfiles_herdr_report_cwd; cd -- \"$CHECKOUT\"; cd -- \"$NESTED\"; cd -- \"$OUTSIDE\"`;

  const result = spawnSync('zsh', ['-f', '-c', script], {
    cwd: outside,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...fake.env,
      CHECKOUT: checkout,
      HERDR_BIN_PATH: fake.executable,
      HERDR_ENV: '1',
      HERDR_PANE_ID: 'w1:p1',
      HERDR_WORKSPACE_ID: 'w1',
      HOOK: hook,
      NESTED: nested,
      OUTSIDE: outside,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(calls(fake.calls), [
    ['workspace', 'report-metadata', 'w1', '--source', 'worktree-label', '--token', `cwd_label=${path.basename(outside)}`],
    ['pane', 'report-metadata', 'w1:p1', '--source', 'worktree-label', '--token', `cwd_label=${path.basename(outside)}`],
    ['workspace', 'report-metadata', 'w1', '--source', 'worktree-label', '--token', 'cwd_label=visonic / dev'],
    ['pane', 'report-metadata', 'w1:p1', '--source', 'worktree-label', '--token', 'cwd_label=visonic / dev'],
    ['workspace', 'report-metadata', 'w1', '--source', 'worktree-label', '--token', 'cwd_label=visonic / dev'],
    ['pane', 'report-metadata', 'w1:p1', '--source', 'worktree-label', '--token', 'cwd_label=visonic / dev'],
    ['workspace', 'report-metadata', 'w1', '--source', 'worktree-label', '--token', `cwd_label=${path.basename(outside)}`],
    ['pane', 'report-metadata', 'w1:p1', '--source', 'worktree-label', '--token', `cwd_label=${path.basename(outside)}`],
  ]);
});

test('startup and workspace events refresh labels from the current CWD', (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const dev = addWorktree(fixture, 'dev');
  fs.mkdirSync(path.join(dev, 'nested'));
  const fake = fakeHerdr(fixture.root,
    [{ workspace_id: 'w-dev', label: 'stale custom name' }],
    { 'w-dev': [{ pane_id: 'p-dev', focused: true, foreground_cwd: path.join(dev, 'nested') }] });

  pluginProcess({
    ...fake.env,
    HERDR_BIN_PATH: fake.executable,
    HERDR_PLUGIN_EVENT: 'startup',
  });
  pluginProcess({
    ...fake.env,
    HERDR_BIN_PATH: fake.executable,
    HERDR_PLUGIN_EVENT: 'workspace.updated',
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      workspace_id: 'w-dev',
      workspace_label: 'stale custom name',
      workspace_cwd: fixture.root,
    }),
  });

  assert.deepEqual(calls(fake.calls), [
    ['workspace', 'report-metadata', 'w-dev', '--source', 'worktree-label', '--token', 'cwd_label=visonic / dev'],
    ['workspace', 'report-metadata', 'w-dev', '--source', 'worktree-label', '--token', `cwd_label=${path.basename(fixture.root)}`],
  ]);
});
