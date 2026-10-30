import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
const installer = path.resolve('install.sh');
test('Obsidian sync ignores plugin updates, preserves binaries, and detects settings drift', () => {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'obsidian-sync-'));
 const run=(command)=>spawnSync('bash',['-c',command],{cwd:root,encoding:'utf8'});
 try {
  run('git init -q; git config user.email test@example.com; git config user.name test');
  for(const dir of ['obsidian/plugins/p','obsidian/snippets','vaults/notes/.obsidian/plugins/p','vaults/other/.obsidian/plugins/p'])fs.mkdirSync(path.join(root,dir),{recursive:true});
  for(const f of ['app.json','plugins/p/data.json','snippets/a.css']){fs.writeFileSync(path.join(root,'obsidian',f),'settings');fs.mkdirSync(path.dirname(path.join(root,'vaults/notes/.obsidian',f)),{recursive:true});fs.writeFileSync(path.join(root,'vaults/notes/.obsidian',f),'settings');}
  fs.writeFileSync(path.join(root,'obsidian/plugins/p/main.js'),'tracked legacy code');
  run('git add obsidian; git commit -qm baseline');
  fs.unlinkSync(path.join(root,'obsidian/plugins/p/main.js'));
  for(const vault of ['notes','other'])fs.writeFileSync(path.join(root,`vaults/${vault}/.obsidian/plugins/p/main.js`),'updated by Obsidian');
  const command=`source '${installer}'; OBSIDIAN_VAULT=notes; sync_obsidian '${root}/vaults'`;
  let result=run(command);assert.equal(result.status,0,result.stderr);
  assert.equal(fs.readFileSync(path.join(root,'vaults/other/.obsidian/plugins/p/main.js'),'utf8'),'updated by Obsidian');
  assert.equal(fs.readFileSync(path.join(root,'vaults/other/.obsidian/plugins/p/data.json'),'utf8'),'settings');
  assert.ok(!fs.existsSync(path.join(root,'obsidian/plugins/p/main.js')));
  fs.writeFileSync(path.join(root,'vaults/notes/.obsidian/plugins/p/data.json'),'device change');
  result=run(command);assert.notEqual(result.status,0);assert.match(result.stderr,/managed settings changes/);
  assert.equal(fs.readFileSync(path.join(root,'vaults/other/.obsidian/plugins/p/data.json'),'utf8'),'settings');
 } finally {fs.rmSync(root,{recursive:true,force:true});}
});
