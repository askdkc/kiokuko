#!/usr/bin/env python3
"""Real CLI pseudo-terminal contract, disposable repository and DB only."""
import hashlib, json, os, pathlib, pty, select, shutil, subprocess, sys, tempfile, time
source = pathlib.Path(__file__).resolve().parents[2]
with tempfile.TemporaryDirectory(prefix='kiokuko-review-terminal-') as tmp:
    root = pathlib.Path(tmp) / 'repo'; root.mkdir()
    subprocess.run(['git', 'init', '-q', str(root)], check=True)
    trace = root / '.agenticreplay' / 'runs' / 'run_abcdef'; trace.mkdir(parents=True)
    events = [dict(seq=1, type='user.message', payload={'text': 'Check SQLite migration'}), dict(seq=2, type='tool.call', attrs={'name':'bash','attemptId':'one'}, payload={'command':'node migration.test.js'}), dict(seq=3,type='tool.result',causes=[2],attrs={'exit_code':0},payload={'stdout':'1 test passed'})]
    # Exercise an approved proposal larger than a small indexed-memory payload.
    for index in range(12):
        seq = len(events) + 1
        events.extend([dict(seq=seq, type='tool.call', attrs={'name':'bash','attemptId':f'large-{index}'}, payload={'command':f'node migration-{index}.test.js'}),
                       dict(seq=seq+1, type='tool.result', causes=[seq], attrs={'exit_code':0}, payload={'stdout':('migration check passed. ' * 180)})])
    data = ''.join(json.dumps(e)+'\n' for e in events).encode()
    (trace/'events.jsonl').write_bytes(data)
    (trace/'manifest.json').write_text(json.dumps({'schema_version':'0.4.0','run_id':'run_abcdef','cwd':str(root),'integrity':{'events_sha256':hashlib.sha256(data).hexdigest()}}))
    for decision in ['decline', 'approve']:
        db = pathlib.Path(tmp) / (decision+'.sqlite3')
        master, slave = pty.openpty()
        proc = subprocess.Popen([shutil.which('node'), str(source/'dist/bin/kiokuko.js'), 'memory-review', '--cwd',str(root),'--trace',str(trace),'--task','task','--session','session','--database',str(db)],stdin=slave,stdout=slave,stderr=slave,cwd=source,env={**os.environ,'HOME':tmp,'XDG_CONFIG_HOME':tmp+'/config'})
        os.close(slave); output = b''
        def until(token):
            global output
            deadline = time.monotonic()+30
            while token.encode() not in output:
                if time.monotonic()>deadline: raise AssertionError('terminal timeout: '+output.decode(errors='replace'))
                ready,_,_=select.select([master],[],[],1)
                if ready:
                    try: part=os.read(master,65536)
                    except OSError: raise AssertionError(output.decode(errors='replace'))
                    if not part: raise AssertionError('terminal ended early')
                    output += part
            assert not db.exists(), 'Database created before human approval'
        try:
            until('Type completed'); os.write(master,b'completed\n')
            until('organize / decline:'); os.write(master,b'organize\n')
            until('approve / decline / comment:'); os.write(master,(decision+'\n').encode())
            deadline=time.monotonic()+30
            while proc.poll() is None and time.monotonic()<deadline:
                if select.select([master],[],[],.1)[0]:
                    try: output += os.read(master,65536)
                    except OSError: break
            assert proc.wait(timeout=5)==0, output.decode(errors='replace')
            assert db.exists() == (decision=='approve'), output.decode(errors='replace')
            if decision=='approve':
                import sqlite3
                with sqlite3.connect(db) as connection:
                    assert connection.execute('SELECT COUNT(*) FROM replay_memories').fetchone()[0]==1
                    assert connection.execute("SELECT COUNT(*) FROM entries WHERE created_by='kiokuko-replay-review'").fetchone()[0]==1
                    workspace = connection.execute("SELECT workspace FROM entries WHERE created_by='kiokuko-replay-review'").fetchone()[0]
                    assert workspace != str(root)
                    assert connection.execute('SELECT workspace FROM replay_memories').fetchone()[0] == workspace
                    assert connection.execute('SELECT length(proposal_json) FROM replay_memories').fetchone()[0] > 20000
        finally:
            if proc.poll() is None: proc.kill(); proc.wait()
            os.close(master)
    # Machine --json cannot assert approval for the legacy direct write route.
    proposed=pathlib.Path(tmp)/'record.json'; proposed.write_text(json.dumps({'kind':'fact','title':'unapproved','body':'unapproved'}))
    result=subprocess.run([shutil.which('node'),str(source/'dist/bin/kiokuko.js'),'record','--workspace','repo','--input-json',str(proposed),'--json'],cwd=source,capture_output=True,env={**os.environ,'HOME':tmp,'XDG_CONFIG_HOME':tmp+'/config'})
    assert result.returncode != 0
    assert b'Human review' in result.stdout + result.stderr
print('PASS real terminal: decline saves nothing; exact approval saves one indexed memory; machine record denied')
