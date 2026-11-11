import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const installer = path.resolve('install.sh');
const ignoreFile = path.resolve('obsidian/.stow-local-ignore');
const selected = ['ink', 'open-in-terminal', 'slash-commander'];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian stow '));
  const pkg = path.join(root, 'obsidian');
  const docs = path.join(root, 'vaults with spaces');
  const put = (file, contents) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  };
  const vault = (name) => path.join(docs, name, '.obsidian');
  const run = () => spawnSync('bash', ['-c',
    'source "$1"; SCRIPT_DIR="$2"; deploy_obsidian "$3"', '_', installer, root, docs],
  { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: root } });
  fs.mkdirSync(pkg, { recursive: true });
  fs.copyFileSync(ignoreFile, path.join(pkg, '.stow-local-ignore'));
  put(path.join(pkg, 'app.json'), 'committed settings');
  put(path.join(pkg, 'snippets', 'example.css'), 'css');
  put(path.join(pkg, 'plugins', '.gitignore'), 'ignore metadata');
  for (const plugin of selected) {
    put(path.join(pkg, 'plugins', plugin, 'data.json'), `${plugin} settings`);
    put(path.join(pkg, 'plugins', plugin, 'main.js'), 'source plugin code');
    put(path.join(pkg, 'plugins', plugin, 'extra.json'), 'unselected file');
  }
  put(path.join(pkg, 'plugins', 'other', 'data.json'), 'unselected settings');
  put(path.join(pkg, 'plugins', 'other', 'main.js'), 'other plugin code');
  return { root, pkg, docs, put, vault, run };
}

function isRealDirectory(file) {
  assert.ok(fs.lstatSync(file).isDirectory(), `${file} must be a real directory`);
}

function assertLink(target, source) {
  assert.ok(fs.lstatSync(target).isSymbolicLink(), `${target} must be a link`);
  assert.equal(fs.realpathSync(target), fs.realpathSync(source));
}

test('Stow links dirty settings into each existing vault without managing plugin code', (t) => {
  const { root, pkg, docs, put, vault, run } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '-q');
  git('add', 'obsidian');
  fs.writeFileSync(path.join(pkg, 'app.json'), 'dirty settings');
  for (const name of ['notes', 'other vault']) {
    fs.mkdirSync(vault(name), { recursive: true });
    put(path.join(vault(name), 'plugins', 'ink', 'main.js'), `${name} plugin code`);
    put(path.join(vault(name), 'plugins', 'other', 'data.json'), `${name} local settings`);
    put(path.join(vault(name), 'plugins', 'other', 'main.js'), `${name} other plugin code`);
  }
  fs.mkdirSync(path.join(docs, 'no config'), { recursive: true });

  let result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Stow failed/);
  for (const name of ['notes', 'other vault']) {
    const target = vault(name);
    for (const dir of ['plugins', 'plugins/ink', 'snippets']) isRealDirectory(path.join(target, dir));
    for (const file of ['app.json', 'snippets/example.css', ...selected.map((p) => `plugins/${p}/data.json`)]) {
      assertLink(path.join(target, file), path.join(pkg, file));
    }
    assert.equal(fs.readFileSync(path.join(target, 'plugins/ink/main.js'), 'utf8'), `${name} plugin code`);
    assert.equal(fs.readFileSync(path.join(target, 'plugins/other/data.json'), 'utf8'), `${name} local settings`);
    assert.equal(fs.readFileSync(path.join(target, 'plugins/other/main.js'), 'utf8'), `${name} other plugin code`);
    for (const file of ['.stow-local-ignore', 'plugins/.gitignore', 'plugins/ink/extra.json',
      'plugins/open-in-terminal/main.js']) {
      assert.equal(fs.existsSync(path.join(target, file)), false, file);
    }
  }
  assert.equal(fs.existsSync(vault('no config')), false);
  fs.writeFileSync(path.join(vault('notes'), 'app.json'), 'edited through vault');
  assert.equal(fs.readFileSync(path.join(pkg, 'app.json'), 'utf8'), 'edited through vault');
  assert.equal(fs.readFileSync(path.join(vault('other vault'), 'app.json'), 'utf8'), 'edited through vault');
  const originalLink = fs.readlinkSync(path.join(vault('notes'), 'app.json'));
  result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stderr, /Stow failed/);
  assert.equal(fs.readlinkSync(path.join(vault('notes'), 'app.json')), originalLink);
  assert.equal(fs.readFileSync(path.join(vault('notes'), 'plugins/ink/main.js'), 'utf8'), 'notes plugin code');
  assert.equal(fs.readFileSync(path.join(pkg, 'plugins/ink/main.js'), 'utf8'), 'source plugin code');
  assert.equal(fs.readFileSync(path.join(pkg, 'plugins/other/data.json'), 'utf8'), 'unselected settings');
  assert.equal(fs.readFileSync(path.join(vault('notes'), 'plugins/other/main.js'), 'utf8'), 'notes other plugin code');
});

test('conflicts remain untouched and do not prevent deployment to other vaults', (t) => {
  const { root, pkg, put, vault, run } = fixture();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  put(path.join(vault('a conflict'), 'app.json'), 'existing configuration');
  fs.mkdirSync(vault('z clean'), { recursive: true });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /conflict/i);
  assert.match(result.stderr, /Stow failed/);
  assert.equal(fs.readFileSync(path.join(vault('a conflict'), 'app.json'), 'utf8'), 'existing configuration');
  assert.ok(fs.lstatSync(path.join(vault('a conflict'), 'app.json')).isFile());
  assert.equal(fs.existsSync(path.join(vault('a conflict'), 'snippets/example.css')), false);
  assertLink(path.join(vault('z clean'), 'app.json'), path.join(pkg, 'app.json'));
});
