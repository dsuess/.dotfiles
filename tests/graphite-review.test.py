"""Integration boundary tests; never authenticate or create GitHub reviews."""
import copy
from contextlib import closing
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SCRIPT = Path(__file__).resolve().parents[1] / "bin/graphite-review"
loader = importlib.machinery.SourceFileLoader("graphite_review", str(SCRIPT))
spec = importlib.util.spec_from_loader(loader.name, loader)
m = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = m
loader.exec_module(m)


def git(path, *args):
    return m.run(["git", *args], path)


def session(root):
    return dict(id="session", version="1.3", repo_path=str(root), base_commit="a" * 40,
                diff_source="commit_range", commit_range=["b" * 40, "a" * 40],
                pr_session_key=None, created_at="2026-11-06T00:00:00Z",
                updated_at="2026-11-06T00:00:00Z", review_comments=[], files={}, session_notes=None)


def comment():
    return dict(id="draft", content="LGTM", comment_type="none", created_at="2026-11-06T00:00:00Z",
                line_context=None, side=None, line_range=None, author="user",
                lifecycle_state="local_draft", remote_review_id=None,
                remote_comment_id=None, commit_id="a" * 40)


class Boundaries(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()

    def init(self):
        git(self.root, "init", "-q", "-b", "main")
        git(self.root, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-qm", "base")
        return self.root

    def metadata(self):
        (self.root / ".graphite_repo_config").write_text(json.dumps({"trunk": "main"}))
        (self.root / ".graphite_pr_info").write_text(json.dumps({"prInfos": [dict(prNumber=1, headRefName="one", baseRefName="main", state="OPEN", title="One", isDraft=False)]}))
        with closing(sqlite3.connect(self.root / ".graphite_metadata.db")) as db:
            db.execute("CREATE TABLE branch_metadata (branch_name TEXT PRIMARY KEY, parent_branch_name TEXT, parent_branch_revision TEXT, last_submitted_version TEXT, state TEXT, children TEXT, branch_revision TEXT, validation_result TEXT, parent_head_revision TEXT)")
            db.execute("INSERT INTO branch_metadata (branch_name,parent_branch_name,children) VALUES ('one','main','[]')")
            db.commit()

    def test_url(self):
        self.assertEqual(m.parse_url("https://app.graphite.com/github/pr/owner/repo/12?x=1#top"), m.Target("owner", "repo", 12))
        self.assertEqual(m.parse_url("https://app.graphite.com/github/pr/Neara-AI/pc-ml/1302/Replay-free-stateful-cyclic-data-loading"), m.Target("Neara-AI", "pc-ml", 1302))
        invalid = ["http://app.graphite.com/github/pr/a/b/1", "https://evil.com/github/pr/a/b/1", "https://app.graphite.com:443/github/pr/a/b/1", "https://app.graphite.com/github/pr/a/b/0", "https://app.graphite.com/github/pr/a/b/-1", "https://app.graphite.com/github/pr/a/../1", "https://app.graphite.com/github/pr/a/%62/1", "https://app.graphite.com/github/pr/a/b/1/slug/extra"]
        for url in invalid:
            with self.subTest(url=url), patch.object(m, "run") as run:
                self.assertEqual(m.main([url]), 1)
                run.assert_not_called()

    def test_normal_and_linked(self):
        self.init()
        nested = self.root / "a/b"
        nested.mkdir(parents=True)
        repo = m.discover_repository(nested)
        self.assertEqual(repo.common, self.root / ".git")
        linked = self.root / "linked"
        git(self.root, "worktree", "add", "--detach", str(linked), "HEAD")
        other = m.discover_repository(linked)
        self.assertEqual(other.common, repo.common)
        self.assertEqual(other.context, linked)

    def test_bare_container(self):
        self.init()
        container = self.root / "container"
        container.mkdir()
        bare = container / ".bare"
        git(self.root, "clone", "--bare", str(self.root), str(bare))
        nested = container / "nested/deeper"
        nested.mkdir(parents=True)
        for cwd in (bare, nested):
            repo = m.discover_repository(cwd)
            self.assertEqual(repo.common, bare)
            self.assertTrue(repo.bare)

    def test_ambiguous_bare(self):
        self.init()
        container = self.root / "container"
        container.mkdir()
        for name in ("one.git", "two.git"):
            git(self.root, "clone", "--bare", str(self.root), str(container / name))
        with self.assertRaisesRegex(m.ReviewError, "Ambiguous"):
            m.discover_repository(container)

    def test_remotes(self):
        self.init()
        repo = m.discover_repository(self.root)
        target = m.Target("owner", "repo", 1)
        with self.assertRaises(m.ReviewError):
            m.select_remote(repo, target)
        git(self.root, "remote", "add", "upstream", "git@github.com:owner/repo.git")
        self.assertEqual(m.select_remote(repo, target), "upstream")
        git(self.root, "remote", "add", "origin", "https://github.com/owner/repo.git")
        with self.assertRaises(m.ReviewError):
            m.select_remote(repo, target)
        for url in ("git@github.com:owner/repo.git", "ssh://git@github.com/owner/repo.git", "https://github.com/owner/repo"):
            self.assertEqual(m.remote_coordinate(url), ("owner", "repo"))
        self.assertIsNone(m.remote_coordinate("https://evil.com/owner/repo"))

    def test_metadata_readonly(self):
        self.metadata()
        before = {p.name: p.read_bytes() for p in self.root.iterdir()}
        data = m.read_graphite(self.root)
        self.assertEqual(data.parents, {"one": "main"})
        self.assertEqual(data.prs["one"]["prNumber"], 1)
        self.assertEqual(before, {p.name: p.read_bytes() for p in self.root.iterdir()})

    def test_missing_metadata_no_fallback(self):
        with patch.object(m, "run") as run, self.assertRaises(m.ReviewError):
            m.read_graphite(self.root)
        run.assert_not_called()

    def test_schema_and_corruption(self):
        self.metadata()
        with closing(sqlite3.connect(self.root / ".graphite_metadata.db")) as db:
            db.execute("ALTER TABLE branch_metadata ADD COLUMN future TEXT")
            db.commit()
        with self.assertRaisesRegex(m.ReviewError, "schema"):
            m.read_graphite(self.root)
        (self.root / ".graphite_metadata.db").write_bytes(b"corrupt")
        with self.assertRaisesRegex(m.ReviewError, "metadata"):
            m.read_graphite(self.root)

    def test_duplicates_and_cycles(self):
        self.metadata()
        path = self.root / ".graphite_pr_info"
        data = json.loads(path.read_text())
        data["prInfos"].append(data["prInfos"][0])
        path.write_text(json.dumps(data))
        with self.assertRaisesRegex(m.ReviewError, "Duplicate"):
            m.read_graphite(self.root)
        data["prInfos"].pop()
        path.write_text(json.dumps(data))
        with closing(sqlite3.connect(self.root / ".graphite_metadata.db")) as db:
            db.execute("UPDATE branch_metadata SET parent_branch_name='one'")
            db.commit()
        with self.assertRaisesRegex(m.ReviewError, "Cycle"):
            m.read_graphite(self.root)

    def test_session_attribution_preserved(self):
        data = session(self.root)
        data["review_comments"] = [comment()]
        before = copy.deepcopy(data)
        self.assertIs(m.validate_session(data, self.root, "a" * 40, ["b" * 40, "a" * 40]), data)
        self.assertEqual(data, before)
        for change in ({"version": "99"}, {"pr_session_key": {}}, {"base_commit": "c" * 40}, {"repo_path": "/different"}):
            bad = dict(data, **change)
            with self.subTest(change=change), self.assertRaises(m.ReviewError):
                m.validate_session(bad, self.root, "a" * 40, ["b" * 40, "a" * 40])
        del data["review_comments"][0]["commit_id"]
        with self.assertRaises(m.ReviewError):
            m.validate_session(data, self.root, "a" * 40, ["b" * 40, "a" * 40])

    def test_listing_identity_active_and_duplicates(self):
        data = session(self.root)
        path = self.root / "session.json"
        path.write_text(json.dumps(data))
        entry = dict(kind="local", path=str(path), slug="example", active=False)
        with patch.object(m, "run", return_value=json.dumps([entry])):
            actual, _ = m.resolve_session(self.root, "a" * 40, ["b" * 40, "a" * 40])
            self.assertEqual(actual, path)
        for entries in ([dict(entry, active=True)], [entry, entry], []):
            with patch.object(m, "run", return_value=json.dumps(entries)), self.assertRaises(m.ReviewError):
                m.resolve_session(self.root, "a" * 40, ["b" * 40, "a" * 40])

    def test_version_bounds(self):
        with patch.object(m.shutil, "which", return_value="present"), patch.object(m, "run", side_effect=["tuicr 0.29.0"]):
            with self.assertRaisesRegex(m.ReviewError, "Unsupported"):
                m.check_dependencies()

    def test_help(self):
        result = subprocess.run([sys.executable, str(SCRIPT), "--help"], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0)
        self.assertIn("one tuicr range session", result.stdout)


class CommandOutput(unittest.TestCase):
    def test_fetch_streams_output(self):
        with patch.object(m.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0)) as command, patch.object(m, 'progress') as progress:
            self.assertEqual(m.run(['git', 'fetch', '--no-tags', 'origin', 'refs/heads/one'], '/repo'), '')
        command.assert_called_once_with(['git', 'fetch', '--no-tags', 'origin', 'refs/heads/one'], cwd='/repo', text=True)
        self.assertIn('git fetch', progress.call_args.args[0])

    def test_queries_keep_stdout_for_parsing(self):
        result = subprocess.CompletedProcess([], 0, stdout='abc\n', stderr='warning\n')
        with patch.object(m.subprocess, 'run', return_value=result) as command, patch.object(m.sys, 'stderr') as stderr:
            self.assertEqual(m.run(['git', 'rev-parse', 'HEAD']), 'abc')
        command.assert_called_once_with(['git', 'rev-parse', 'HEAD'], cwd=None, capture_output=True, text=True)
        stderr.write.assert_any_call('warning\n')


class StackRefs(unittest.TestCase):
    def test_ancestors_and_descendants_but_not_unrelated_branches(self):
        def pr(n, branch, parent):
            return dict(prNumber=n, headRefName=branch, baseRefName=parent, state='OPEN')
        metadata = m.Metadata('main', {'old': 'main', 'one': 'old', 'two': 'one', 'three': 'two', 'other': 'main'},
                              {'old': pr(9, 'old', 'main'), 'one': pr(1, 'one', 'old'), 'two': pr(2, 'two', 'one'),
                               'three': pr(3, 'three', 'two'), 'other': pr(5, 'other', 'main')})
        self.assertEqual(m.stack_refs(metadata, 2), {'old', 'one', 'two', 'three'})
        self.assertEqual(m.stack_refs(metadata, 42), set())


class Workspaces(Boundaries):
    def test_middle_full_stack_and_fork(self):
        def pr(n, branch, parent, state='OPEN'):
            return dict(prNumber=n, headRefName=branch, baseRefName=parent, state=state)
        metadata = m.Metadata('main', {'old':'main','one':'old','two':'one','three':'two'},
                              {'old':pr(9,'old','main','MERGED'),'one':pr(1,'one','old'),
                               'two':pr(2,'two','one'),'three':pr(3,'three','two')})
        self.assertEqual([p['prNumber'] for p in m.stack_members(metadata,2)], [1,2,3])
        metadata.parents['fork']='two';metadata.prs['fork']=pr(4,'fork','two')
        with patch.object(m,'choose',return_value=['one','two','fork']):
            self.assertEqual([p['prNumber'] for p in m.stack_members(metadata,2)], [1,2,4])
        del metadata.prs['fork']
        with self.assertRaisesRegex(m.ReviewError,'Missing'):
            m.stack_members(metadata,2)

    def test_workspace_reuse_dirty_and_lock(self):
        self.init();repo=m.discover_repository(self.root);target=m.Target('owner','repo',1)
        directory,state=m.open_workspace(repo,target)
        self.addCleanup(lambda: git(self.root,'worktree','remove','--force',state['checkout']))
        checkout=Path(state['checkout'])
        sha=git(self.root,'rev-parse','HEAD')
        snap={'base':sha,'tip':sha,'commits':[sha], 'prs':[dict(number=1,sha=sha),dict(number=2,sha=sha)]}
        m.prepare_snapshot(repo,directory,state,snap,target)
        other_directory,other=m.open_workspace(repo,m.Target('owner','repo',2))
        self.assertEqual(other_directory,directory);self.assertEqual(other['checkout'],state['checkout'])
        (checkout/'untracked').write_text('preserve')
        with self.assertRaisesRegex(m.ReviewError,'edits'):
            m.open_workspace(repo,target)
        self.assertEqual((checkout/'untracked').read_text(),'preserve')
        with m.process_lock(directory/'lock'):
            with self.assertRaisesRegex(m.ReviewError,'Another'):
                with m.process_lock(directory/'lock'):pass

    def test_same_snapshot_resume_and_archive(self):
        self.init();repo=m.discover_repository(self.root);target=m.Target('owner','repo',1)
        directory,state=m.open_workspace(repo,target)
        self.addCleanup(lambda: git(self.root,'worktree','remove','--force',state['checkout']))
        sha=git(self.root,'rev-parse','HEAD')
        snap={'base':sha,'tip':sha,'commits':[sha],'prs':[dict(number=1,sha=sha)]}
        m.prepare_snapshot(repo,directory,state,snap,target)
        path=directory/'draft.json';path.write_text('{"LGTM":"old"}')
        state['session']=str(path);state['assignments']={'draft':1}
        m.prepare_snapshot(repo,directory,state,snap,target)
        self.assertEqual(state['session'],str(path));self.assertEqual(state['assignments'],{'draft':1})
        git(self.root,'-c','user.name=test','-c','user.email=test@example.com','commit','--allow-empty','-qm','next')
        new=git(self.root,'rev-parse','HEAD');new_snap={'base':sha,'tip':new,'commits':[new],'prs':[dict(number=1,sha=new)]}
        m.prepare_snapshot(repo,directory,state,new_snap,target)
        self.assertIsNone(state['session']);self.assertEqual(state['assignments'],{})
        archives=list((directory/'archives').iterdir());self.assertEqual(len(archives),1)
        self.assertEqual((archives[0]/'session.json').read_text(),path.read_text())

    def test_range_bottom_parent_and_ancestry(self):
        self.init();repo=m.discover_repository(self.root)
        base=git(self.root,'rev-parse','HEAD');prs={};parents={};previous=base
        for n in (1,2):
            git(self.root,'-c','user.name=test','-c','user.email=test@example.com','commit','--allow-empty','-qm',str(n))
            sha=git(self.root,'rev-parse','HEAD');branch=f'pr{n}';parent='main' if n==1 else 'pr1'
            git(self.root,'update-ref',f'refs/heads/{branch}',sha)
            prs[n]=dict(number=n,state='open',head=dict(sha=sha,ref=branch),base=dict(sha=previous,ref=parent),commits=1,title=branch,user=dict(login='author'))
            parents[branch]=parent;previous=sha
        target=m.Target('owner','repo',1);members=[dict(prNumber=n,headRefName=f'pr{n}',baseRefName=parents[f'pr{n}']) for n in (1,2)]
        original=m.run
        def fake_run(args,cwd=None):
            if args[:2]==['git','fetch']:
                if 'refs/pull/' in args[-1]:
                    source,dest=args[-1].split(':');n=int(source.split('/')[2]);git(self.root,'update-ref',dest,prs[n]['head']['sha'])
                return ''
            return original(args,cwd)
        with patch.object(m,'pr_details',side_effect=lambda t,n:prs[n]),patch.object(m,'run',side_effect=fake_run):
            snapshot=m.checked_snapshot(repo,'origin',target,m.Metadata('main',parents,{}),members,'a'*32)
            self.assertEqual(snapshot['base'],base);self.assertEqual(snapshot['tip'],previous)
            prs[2]['commits']=2
            with self.assertRaisesRegex(m.ReviewError,'exactly one'):
                m.checked_snapshot(repo,'origin',target,m.Metadata('main',parents,{}),members,'a'*32)


class Imports(unittest.TestCase):
    def test_locked_context_and_location_and_draft_resume(self):
        with tempfile.TemporaryDirectory() as root:
            root=Path(root).resolve();data=session(root);draft=comment();data['review_comments']=[draft]
            snapshot={'prs':[dict(number=1,sha='a'*40),dict(number=2,sha='b'*40)]}
            state={'repository':'owner/repo','imports':{}}
            remote=dict(id='comment:1',comment_id='42',review_id='3',author='someone',body='LGTM',url='https://github.com/o/r/pull/1#1',resolved=False,outdated=False,path='shared',line=2,side='RIGHT')
            files={'shared':dict(path='shared',sides={'old':{},'new':{2:'line'}},hunks={'old':{},'new':{2:0}})}
            contexts={1:[remote],2:[dict(remote,id='comment:2',outdated=True)]}
            with patch.object(m,'diff_locations',return_value=files):
                m.import_context(data,snapshot,contexts,root,state)
                first=copy.deepcopy(data)
                m.import_context(data,snapshot,contexts,root,state)
            imports=[c for _,_,c in m.all_comments(data) if c['id'].startswith('import-')]
            self.assertEqual(len(imports),2);self.assertTrue(all(c['lifecycle_state']=='submitted' for c in imports))
            self.assertEqual(data['review_comments'][0],draft)
            self.assertEqual(data['files']['shared']['line_comments']['2'][0]['commit_id'],'a'*40)
            self.assertIn('outdated',data['review_comments'][1]['content'])
            self.assertEqual(len(state['imports']),2)

    def test_side_range_and_file_anchors(self):
        files={'old':dict(path='new',sides={'old':{1:'deleted',2:'context'},'new':{2:'context',3:'added'}},
                          hunks={'old':{1:0,2:0},'new':{2:0,3:0}})}
        self.assertEqual(m.inline_location(files,'old',1,'old'),dict(path='new',line=1,side='LEFT'))
        self.assertEqual(m.inline_location(files,'old',None,'new')['line'],2)
        self.assertEqual(m.inline_location(files,'old',3,'new',dict(start=2,end=3))['start_line'],2)
        self.assertIsNone(m.inline_location(files,'old',4,'new'))
        self.assertIsNone(m.inline_location(files,'old',3,'new',dict(start=1,end=3)))

    def test_remote_pagination(self):
        remote=dict(id='C',databaseId=1,body='feedback',url='url',author=dict(login='author'),pullRequestReview=dict(databaseId=2))
        thread=dict(id='T',isResolved=False,isOutdated=False,path='file',line=1,startLine=None,diffSide='RIGHT',startDiffSide=None,
                    comments=dict(pageInfo=dict(hasNextPage=True,endCursor='comments2'),nodes=[remote]))
        responses=[[],dict(data=dict(repository=dict(pullRequest=dict(reviewThreads=dict(pageInfo=dict(hasNextPage=True,endCursor='threads2'),nodes=[thread]))))),
                   dict(data=dict(node=dict(comments=dict(pageInfo=dict(hasNextPage=False,endCursor=None),nodes=[dict(remote,id='D',databaseId=3)])))),
                   dict(data=dict(repository=dict(pullRequest=dict(reviewThreads=dict(pageInfo=dict(hasNextPage=False,endCursor=None),nodes=[])))))]
        with patch.object(m,'api',side_effect=responses) as api:
            result=m.remote_context(m.Target('o','r',1),1)
        self.assertEqual(len(result),2);self.assertEqual(api.call_count,4)
        self.assertEqual(result[0]['author'],'author');self.assertEqual(result[1]['comment_id'],'3')


class Verdicts(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.root=Path(self.temp.name).resolve();git(self.root,'init','-q','-b','main')
        git(self.root,'-c','user.name=test','-c','user.email=test@example.com','commit','--allow-empty','-qm','base')
        self.base=git(self.root,'rev-parse','HEAD');(self.root/'code').write_text('first\nsecond\n')
        git(self.root,'add','code');git(self.root,'-c','user.name=test','-c','user.email=test@example.com','commit','-qm','one')
        self.sha=git(self.root,'rev-parse','HEAD')
        self.pr=dict(number=1,sha=self.sha,parent=self.base,title='One',base_branch='main',base_sha=self.base,author='author')
        self.state=dict(id='a'*32,checkout=str(self.root),snapshot=dict(base=self.base,tip=self.sha,commits=[self.sha],prs=[self.pr]),
                        assignments={},imports={},receipts=[],attempts={})
        self.data=session(self.root);self.data.update(base_commit=self.sha,commit_range=[self.sha])
        self.path='Commit Message ('+self.sha[:7]+')'
        self.data['files'][self.path]=m.file_review(self.path,'added');self.data['files']['code']=m.file_review('code','added')

    def add(self,text,path=None,line=None,**values):
        c=dict(comment(),id=str(len(list(m.all_comments(self.data)))),content=text,commit_id=self.sha,**values)
        if path is None:self.data['review_comments'].append(c)
        elif line is None:self.data['files'][path]['file_comments'].append(c)
        else:self.data['files'][path]['line_comments'].setdefault(str(line),[]).append(c)
        return c

    def actions(self):
        with patch.object(m,'type_configuration',return_value=(True,{'bug':'DEFECT'})):
            return m.build_actions(self.data,self.state)

    def test_lgtm_wins_with_objection(self):
        self.add(' \nLgTm \t',self.path);self.add('Fix this','code',2)
        actions=self.actions();self.assertEqual(actions[0]['payload']['event'],'APPROVE')
        self.assertEqual(actions[0]['payload']['comments'][0]['body'],'Fix this')
        self.assertIn('LgTm',actions[0]['payload']['body'])

    def test_code_lgtm_and_remote_and_empty(self):
        self.assertEqual(self.actions(),[])
        self.add('LGTM',self.path,lifecycle_state='submitted')
        self.assertEqual(self.actions(),[])
        self.add('LGTM','code',1)
        self.assertEqual(self.actions()[0]['payload']['event'],'REQUEST_CHANGES')

    def test_whole_marker_only(self):
        for value in ['LGTM!', 'LGTM but fix this', 'Looks good']:
            self.data['files'][self.path]['file_comments']=[];self.add(value,self.path)
            self.assertEqual(self.actions()[0]['payload']['event'],'REQUEST_CHANGES')

    def test_synthetic_without_commit_and_tracked_collision(self):
        c=self.add('LGTM',self.path);c['commit_id']=None
        self.assertEqual(self.actions()[0]['payload']['event'],'APPROVE')
        (self.root/self.path).write_text('real file')
        git(self.root,'add',self.path);git(self.root,'-c','user.name=test','-c','user.email=test@example.com','commit','-qm','collision')
        self.pr['sha']=git(self.root,'rev-parse','HEAD');self.state['snapshot']['commits']=[self.pr['sha']]
        self.assertIsNone(m.synthetic_commit(self.path,c,self.state['snapshot'],self.root))

    def test_labels_and_file_convention(self):
        c=self.add('fix','code',None);c['comment_type']='bug'
        outgoing=self.actions()[0]['payload']['comments'][0]
        self.assertEqual(outgoing['body'],'[DEFECT] File-level: fix');self.assertEqual(outgoing['line'],1)
        self.assertEqual(m.formatted_comment(c,False,{}),'fix')

    def test_unscoped_ownership_and_placement(self):
        c=self.add('fix','code',2);c['commit_id']=None
        with patch.object(m,'choose',side_effect=[self.pr,'summary']):
            actions=self.actions()
        self.assertEqual(actions[0]['payload']['comments'],[])
        self.assertIn('code:2',actions[0]['payload']['body'])
        with patch.object(m,'choose') as choose:self.actions();choose.assert_not_called()

    def test_skip_and_cancel_and_invalid_location(self):
        c=self.add('fix','code',99)
        with patch.object(m,'choose',return_value='skip'):self.assertEqual(self.actions(),[])
        self.state['assignments']={}
        with patch.object(m,'choose',return_value='cancel'),self.assertRaises(m.Cancelled):self.actions()

    def test_preview_return_cancel_no_posts(self):
        self.add('LGTM',self.path);actions=self.actions()
        for decision in ('return','cancel'):
            with patch.object(m,'choose',return_value=decision),patch.object(m,'api') as api:
                self.assertEqual(m.preview(actions,self.state['snapshot'],self.state),decision)
                api.assert_not_called()

    def test_review_loop_rebuilds_and_tui_error_stops(self):
        self.state.update(session=str(self.root/'saved'),session_id=self.data['id'])
        with patch.object(m,'run_tui'),patch.object(m,'resolve_session',return_value=(Path(self.state['session']),self.data)),patch.object(m,'build_actions',side_effect=[[],[]]) as build,patch.object(m,'preview',side_effect=['return','cancel']),patch.object(m,'api') as api:
            m.review_loop(self.root,self.state,m.Target('o','r',1));self.assertEqual(build.call_count,2);api.assert_not_called()
        with patch.object(m,'run_tui',side_effect=m.ReviewError('TUI error')),patch.object(m,'api') as api,self.assertRaises(m.ReviewError):
            m.review_loop(self.root,self.state,m.Target('o','r',1))
        api.assert_not_called()


class Submission(Verdicts):
    def setup_action(self):
        self.pr['branch']='branch'
        self.add('LGTM',self.path)
        return self.actions()[0]

    def response(self,action,identity=1):
        return dict(id=identity,commit_id=action['payload']['commit_id'],state='APPROVED',body=action['payload']['body'],user=dict(login='reviewer'))

    def test_success_once_and_lock(self):
        action=self.setup_action();remote=self.response(action)
        with patch.object(m,'submission_preflight',return_value='reviewer'),patch.object(m,'api',return_value=remote) as api,patch.object(m,'save_session'):
            m.submit_actions([action],self.root,self.state,m.Target('o','r',1),self.root/'session',self.data)
            m.submit_actions([action],self.root,self.state,m.Target('o','r',1),self.root/'session',self.data)
        self.assertEqual(api.call_count,1);self.assertEqual(len(self.state['receipts']),1)
        self.assertEqual(next(m.all_comments(self.data))[2]['lifecycle_state'],'submitted')
        self.assertEqual(self.actions(),[])

    def test_response_loss_reconciles_without_repeat(self):
        action=self.setup_action();remote=self.response(action)
        with patch.object(m,'submission_preflight',return_value='reviewer'),patch.object(m,'api',side_effect=m.ReviewError('timeout')) as api,patch.object(m,'published_reviews',return_value=[remote]),patch.object(m,'save_session'):
            m.submit_actions([action],self.root,self.state,m.Target('o','r',1),self.root/'session',self.data)
        self.assertEqual(api.call_count,1);self.assertEqual(self.state['attempts'][action['token']]['status'],'completed')

    def test_uncertain_blocks_restart(self):
        action=self.setup_action()
        with patch.object(m,'submission_preflight',return_value='reviewer'),patch.object(m,'api',side_effect=m.ReviewError('timeout')) as api,patch.object(m,'published_reviews',return_value=[]),patch.object(m,'save_session'):
            with self.assertRaisesRegex(m.ReviewError,'cannot be proved'):
                m.submit_actions([action],self.root,self.state,m.Target('o','r',1),self.root/'session',self.data)
            with self.assertRaisesRegex(m.ReviewError,'cannot be proved'):
                m.submit_actions([action],self.root,self.state,m.Target('o','r',1),self.root/'session',self.data)
        self.assertEqual(api.call_count,1);self.assertEqual(self.state['receipts'],[])

    def test_partial_batch_preserves_success(self):
        action=self.setup_action();second=copy.deepcopy(action);second.update(number=2,token='second',marker='<!-- second -->',source_ids=['other'])
        with patch.object(m,'submission_preflight',return_value='reviewer'),patch.object(m,'api',side_effect=[self.response(action),m.ReviewError('rejected')]),patch.object(m,'published_reviews',return_value=[]),patch.object(m,'save_session'):
            with self.assertRaisesRegex(m.ReviewError,'Batch stopped at #2'):
                m.submit_actions([action,second],self.root,self.state,m.Target('o','r',1),self.root/'session',self.data)
        self.assertEqual(len(self.state['receipts']),1)
        persisted=m.read_json(self.root/'state.json');self.assertEqual(persisted['attempts']['second']['status'],'uncertain')

    def test_preflight_head_closed_self_and_permission(self):
        action=self.setup_action()
        current=dict(state='open',head=dict(sha=self.sha,ref='branch'),base=dict(sha=self.base,ref='main'),commits=1)
        for bad in [dict(current,state='closed'),dict(current,head=dict(sha='f'*40,ref='branch'))]:
            with patch.object(m,'api',side_effect=[dict(login='reviewer'),dict(permissions=dict(pull=True))]),patch.object(m,'pr_details',return_value=bad),self.assertRaisesRegex(m.ReviewError,'changed or closed'):
                m.submission_preflight([action],self.state,m.Target('o','r',1))
        with patch.object(m,'api',side_effect=[dict(login='author'),dict(permissions=dict(pull=True))]),patch.object(m,'pr_details',return_value=current),self.assertRaisesRegex(m.ReviewError,'own PR'):
            m.submission_preflight([action],self.state,m.Target('o','r',1))
        with patch.object(m,'api',side_effect=[dict(login='reviewer'),dict(permissions=dict(pull=False))]),self.assertRaisesRegex(m.ReviewError,'permission'):
            m.submission_preflight([action],self.state,m.Target('o','r',1))


class RejectionRecovery(Submission):
    def test_explicit_rejection_retries_after_new_preview(self):
        action=self.setup_action()
        with patch.object(m,'submission_preflight',return_value='reviewer'),patch.object(m,'api',side_effect=m.ApiError('HTTP 422',rejected=True)),patch.object(m,'save_session'):
            with self.assertRaisesRegex(m.ReviewError,'rejected PR'):
                m.submit_actions([action],self.root,self.state,m.Target('o','r',1),self.root/'session',self.data)
        self.assertEqual(self.state['attempts'][action['token']]['status'],'rejected')
        with patch.object(m,'submission_preflight',return_value='reviewer'),patch.object(m,'api',return_value=self.response(action)) as api,patch.object(m,'save_session'):
            m.submit_actions([action],self.root,self.state,m.Target('o','r',1),self.root/'session',self.data)
        self.assertEqual(api.call_count,1)


if __name__ == '__main__':
    unittest.main()
