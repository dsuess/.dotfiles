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
} else if (args[0] === 'workspace' && args[1] === 'rename') {
  fs.appendFileSync(process.env.FAKE_CALLS, JSON.stringify(args) + '\\n');
  console.log(JSON.stringify({ id: 'fake', result: { type: 'ok' } }));
} else {
  process.exit(1);
}
`);
  fs.chmodSync(executable, 0o755);
  return { calls, executable, env: { FAKE_CALLS: calls, FAKE_PANES: JSON.stringify(panes), FAKE_WORKSPACES: JSON.stringify(workspaces) } };
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

test('derives embedded-bare labels from checkout and nested paths', (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const dev = addWorktree(fixture, 'dev');
  const polishing = addWorktree(fixture, 'ad20-polishing');
  fs.mkdirSync(path.join(polishing, 'nested'));

  assert.deepEqual(plugin.gitWorktree(dev), {
    checkoutRoot: fs.realpathSync(dev),
    label: 'visonic / dev',
  });
  assert.deepEqual(plugin.gitWorktree(path.join(polishing, 'nested')), {
    checkoutRoot: fs.realpathSync(polishing),
    label: 'visonic / ad20-polishing',
  });
});

test('handles paths with spaces and ignores ordinary or non-Git directories', (t) => {
  const fixture = makeFixture('space repo');
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const checkout = addWorktree(fixture, 'feature space');
  assert.equal(plugin.gitWorktree(checkout).label, 'space repo / feature space');

  const ordinary = path.join(fixture.root, 'ordinary');
  fs.mkdirSync(ordinary);
  git(['init'], ordinary);
  assert.equal(plugin.gitWorktree(ordinary), null);
  assert.equal(plugin.gitWorktree(path.join(fixture.root, 'not a repo')), null);
});

test('renames only automatic labels and tolerates Git failures', () => {
  const root = '/tmp/visonic/dev';
  const git = (command, args) => {
    assert.equal(command, 'git');
    if (args.includes('--show-toplevel')) return `${root}\n`;
    if (args.includes('--git-dir')) return '/tmp/visonic/.bare/worktrees/dev\n';
    return '/tmp/visonic/.bare\n';
  };
  const renamed = [];
  const herdr = (command, args) => {
    if (command === 'git') return git(command, args);
    renamed.push([command, args]);
    return response({ type: 'ok' });
  };
  const workspace = { workspaceId: 'w1', workspaceLabel: 'dev', workspaceCwd: root };
  assert.equal(plugin.renameWorkspace(workspace, herdr, { HERDR_BIN_PATH: 'fake-herdr' }), true);
  assert.deepEqual(renamed, [['fake-herdr', ['workspace', 'rename', 'w1', 'visonic / dev']]]);

  assert.equal(plugin.renameWorkspace({ ...workspace, workspaceLabel: 'manual name' }, herdr), false);
  assert.equal(plugin.renameWorkspace({ ...workspace, workspaceLabel: 'visonic / dev' }, herdr), false);
  assert.equal(plugin.gitWorktree(root, () => null), null);
});

test('startup enumerates active panes and event hooks prefer workspace context', (t) => {
  const fixture = makeFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  const dev = addWorktree(fixture, 'dev');
  const feature = addWorktree(fixture, 'feature');
  fs.mkdirSync(path.join(dev, 'nested'));
  const fake = fakeHerdr(fixture.root,
    [
      { workspace_id: 'w-dev', label: 'dev' },
      { workspace_id: 'w-manual', label: 'manual name' },
    ],
    {
      'w-dev': [{ pane_id: 'p-dev', focused: true, cwd: path.join(dev, 'nested') }],
      'w-manual': [{ pane_id: 'p-manual', focused: true, cwd: feature }],
    });

  pluginProcess({
    ...fake.env,
    HERDR_BIN_PATH: fake.executable,
    HERDR_PLUGIN_EVENT: 'startup',
  });
  assert.deepEqual(calls(fake.calls), [
    ['workspace', 'rename', 'w-dev', 'visonic / dev'],
  ]);

  pluginProcess({
    ...fake.env,
    HERDR_BIN_PATH: fake.executable,
    HERDR_PLUGIN_EVENT: 'workspace.created',
    HERDR_PLUGIN_CONTEXT_JSON: JSON.stringify({
      workspace_id: 'w-feature',
      workspace_label: 'feature',
      workspace_cwd: feature,
    }),
  });
  assert.deepEqual(calls(fake.calls), [
    ['workspace', 'rename', 'w-dev', 'visonic / dev'],
    ['workspace', 'rename', 'w-feature', 'visonic / feature'],
  ]);
});
