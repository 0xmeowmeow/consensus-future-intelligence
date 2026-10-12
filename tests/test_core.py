import io
import json
import random
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
import pytest
from fastapi.testclient import TestClient
from cfi import physics, work
from cfi.storage import Store
from cfi.model import ensure_origin, load_checkpoint, probabilities
from cfi.train import train_job
from cfi.server import create_app

def solve(prompt):
    """An independent symbolic solver for the four explicit movement controls."""
    import re
    boxes=re.findall(r'BOX ([A-Z])',prompt)
    if 'DIRECTLY CONTAINS' in prompt:return boxes[1]
    if 'A COIN MOVES' in prompt:return boxes[0]
    return boxes[-1]

def earn(store,actor,answer=None):
    p=work.issue(store,actor)
    return work.submit(store,actor,p['id'],solve(p['control']['prompt']),answer or solve(p['candidate']['prompt']))

def motion(letter, ready=True, humans=True, llm=None):
    state=physics.initial();node=next(n for n in physics.NODES if n['char']==letter)
    contacts=[dict(node,id='human',holding=True)] if humans else []
    for _ in range(240):
        state,_,emitted=physics.step(state,contacts,llm or {'A':.7,'Z':.3},{'T':.1},ready)
        if emitted:return state,emitted
    return state,None

def test_human_choice_changes_outcome_with_identical_model():
    assert motion('R')[1]=='R'
    assert motion('M')[1]=='M'

def test_no_autotyping_without_humans_or_fresh_guest():
    assert motion('A',humans=False)[1] is None
    assert motion('A',ready=False)[1] is None

def test_guest_pressure_really_changes_motion():
    a=motion('R',llm={'A':1})[0]
    b=motion('R',llm={'P':1})[0]
    assert a['x']!=b['x']

def test_release_prevents_commit_and_repeat_requires_rearm():
    s,letter=motion('A');assert letter=='A'
    node=next(n for n in physics.NODES if n['char']=='A')
    for _ in range(60):
        s,_,emitted=physics.step(s,[dict(node,id='human',holding=True)],{'A':1},{},True)
        assert emitted is None
    s,_,emitted=physics.step(s,[],{'A':1},{},True)
    assert emitted is None
    for _ in range(60):
        s,_,emitted=physics.step(s,[dict(node,id='human',holding=True)],{'A':1},{},True)
        if emitted:break
    assert emitted=='A' and s['text']=='AA'

def test_control_hidden_wrong_answer_not_rewarded_and_retries_idempotent(tmp_path):
    store=Store(tmp_path);work.seed_candidates(store);a,_=store.create_actor('Person')
    packet=work.issue(store,a['id']);assert 'answer' not in packet['control']
    with pytest.raises(ValueError):work.submit(store,a['id'],packet['id'],'WRONG','UNCLEAR')
    assert store.balance(a['id'])==0
    arguments=(store,a['id'],packet['id'],solve(packet['control']['prompt']),'UNCLEAR')
    with ThreadPoolExecutor(2) as executor:
        results=list(executor.map(lambda _:work.submit(*arguments),range(2)))
    assert sum(r['earned'] for r in results)==1
    assert store.balance(a['id'])==1
    assert store.one('SELECT COUNT(*) n FROM examples')['n']==1

def test_disagreement_removes_provisional_example_without_erasing_votes(tmp_path):
    store=Store(tmp_path);work.seed_candidates(store)
    actors=[store.create_actor(str(i))[0]['id'] for i in range(3)]
    first=work.issue(store,actors[0]);correct=solve(first['candidate']['prompt'])
    earn(store,actors[0],correct);result=earn(store,actors[1],correct)
    assert result['accepted']
    example='consensus:'+first['candidate']['id']
    assert store.one('SELECT * FROM examples WHERE id=?',(example,))
    result=earn(store,actors[2],'UNCLEAR')
    assert not result['accepted']
    assert not store.one('SELECT * FROM examples WHERE id=?',(example,))
    assert store.one('SELECT COUNT(*) n FROM annotations')['n']==3

def test_tokens_cannot_go_negative(tmp_path):
    store=Store(tmp_path)
    with store.connect() as db:
        with pytest.raises(ValueError):store.credit(db,'a',-1,'entry','one')
    assert store.balance('a')==0

class TestGuest:
    """Explicit deterministic transport fixture; the shipped app never uses it."""
    __test__=False
    model='test transport only'
    status='Not dialled'
    weights={}
    prefix=None
    error=None
    calls=0
    async def solve_work(self,packet):
        return {'control':solve(packet['control']['prompt']),'interpretation':solve(packet['candidate']['prompt'])}
    async def next_pressure(self,question,prefix):
        self.weights={'A':.8,'B':.2};self.prefix=prefix;self.error=None;self.status='In contact';self.calls+=1
        return self.weights

@pytest.fixture
def app(tmp_path):
    return create_app(tmp_path,TestGuest())

def signup(client,name='Person'):
    response=client.post('/api/identity',json={'name':name})
    assert response.status_code==200
    return response.json()

def earned_client(client,n=1):
    for _ in range(n):
        p=client.get('/api/work').json()
        r=client.post('/api/work',json={'id':p['id'],'control':solve(p['control']['prompt']),'interpretation':solve(p['candidate']['prompt'])})
        assert r.status_code==200

def test_sessions_ledger_questions_and_persistence(app):
    with TestClient(app) as client:
        a=signup(client)
        assert client.post('/api/room/join',json={}).status_code==400
        earned_client(client,3)
        assert client.post('/api/room/join',json={}).status_code==200
        assert client.post('/api/room/join',json={}).status_code==200
        q={'title':'WHAT SHOULD WE BECOME?','request_id':'question-1234'}
        one=client.post('/api/questions',json=q).json()
        assert client.post('/api/questions',json=q).json()==one
        vote={'request_id':'vote-1234567'}
        assert client.post('/api/questions/'+one['id']+'/vote',json=vote).status_code==200
        assert client.post('/api/questions/'+one['id']+'/vote',json=vote).status_code==200
        assert client.get('/api/state').json()['balance']==0
        token=client.cookies.get('cfi_session')
    reopened=create_app(app.state.store.root,TestGuest())
    with TestClient(reopened) as client:
        client.cookies.set('cfi_session',token)
        data=client.get('/api/state').json()
        assert data['actor']['id']==a['id'] and data['balance']==0
        assert data['questions'][0]['votes']==1

def test_foreign_origin_and_missing_identity_rejected(app):
    with TestClient(app) as client:
        assert client.post('/api/identity',json={'name':'x'},headers={'Origin':'https://elsewhere.example'}).status_code==403
        assert client.get('/api/work').status_code==401

def test_shared_websockets_guest_entry_and_replay(app):
    with TestClient(app) as client:
        a=signup(client,'First');earned_client(client)
        client.post('/api/room/join',json={});first_token=client.cookies.get('cfi_session')
        client.cookies.clear();b=signup(client,'Second');earned_client(client)
        client.post('/api/room/join',json={});second_token=client.cookies.get('cfi_session')
        with client.websocket_connect('/api/live',headers={'cookie':'cfi_session='+first_token}) as ws1:
            with client.websocket_connect('/api/live',headers={'cookie':'cfi_session='+second_token}) as ws2:
                assert client.post('/api/room/dial',json={}).status_code==200
                for _ in range(100):
                    message=ws1.receive_json()
                    if message['phase']=='contact' and len(message['people'])==2:break
                assert message['guest']['joined']
                assert message['guest']['balance']==0
                assert {p['name'] for p in message['people']}=={'First','Second'}
                node=next(n for n in physics.NODES if n['char']=='A')
                for i in range(130):
                    ws1.send_json({'type':'push','x':node['x'],'y':node['y'],'holding':True})
                    msg=ws1.receive_json()
                    if msg['board']['text']:break
                assert msg['board']['text']=='A'
                ws1.send_json({'type':'push','x':node['x'],'y':node['y'],'holding':False})
                assert client.post('/api/room/goodbye',json={}).status_code==200
                replay=client.get('/api/episodes/'+msg['episode']+'/replay').json()
                assert replay['episode']['transcript']=='A'
                assert replay['frames']
                for frame in replay['frames']:
                    result,forces,emitted=physics.step(frame['before'],frame['contacts'],frame['llm'],frame['entity'],frame['ready'],frame['dt'])
                    assert result==frame['state']
                    assert forces==frame['forces']
                    assert emitted==frame['emitted']
                payload={'episode':msg['episode'],'verdict':'keep','note':'test'}
                client.post('/api/reflections',json=payload)
                assert not app.state.store.one("SELECT 1 FROM examples WHERE id=?",('episode:'+msg['episode'],))
                client.cookies.set('cfi_session',first_token)
                client.post('/api/reflections',json=payload)
                assert app.state.store.one("SELECT 1 FROM examples WHERE id=?",('episode:'+msg['episode'],))
                payload['verdict']='contested';client.post('/api/reflections',json=payload)
                assert not app.state.store.one("SELECT 1 FROM examples WHERE id=?",('episode:'+msg['episode'],))

def test_expired_hand_is_released(app):
    room=app.state.room;store=app.state.store
    actor,_=store.create_actor('Stale')
    with store.connect() as db:db.execute('INSERT INTO entries VALUES(?,?)',(room.round,actor['id']))
    room.contacts[actor['id']]={'id':actor['id'],'x':203,'y':210,'holding':True,'seen':time.monotonic()-2}
    assert not room.human_contacts()[0]['holding']

def test_origin_reproducibility_and_download(tmp_path):
    first=ensure_origin(tmp_path/'one');second=ensure_origin(tmp_path/'two')
    assert first['sha256']==second['sha256']
    assert first['parameters']==99504
    app=create_app(tmp_path/'one',TestGuest())
    with TestClient(app) as client:
        response=client.get('/api/models/'+first['id']+'/download')
        assert response.status_code==200
        with zipfile.ZipFile(io.BytesIO(response.content)) as z:
            assert {'weights.safetensors','manifest.json','model.py','predict.py'}<=set(z.namelist())
            assert json.loads(z.read('manifest.json'))['sha256']==first['sha256']

def test_real_training_creates_distinct_checkpoint_and_preserves_parent(tmp_path):
    store=Store(tmp_path);origin=ensure_origin(tmp_path)
    parent,_=load_checkpoint(tmp_path,origin['id']);before=probabilities(parent,'Q: WHERE IS THE KEY?\nA: ')
    rng=random.Random(42);records=[]
    for i in range(4):
        item=work.lesson(rng)
        records.append(dict(item,id=str(i),source='test generated control'))
    (tmp_path/'jobs').mkdir()
    (tmp_path/'jobs/test.json').write_text(json.dumps(records))
    with store.connect() as db:db.execute('INSERT INTO jobs(id,parent,status,created) VALUES(?,?,?,?)',('test',origin['id'],'queued',time.time()))
    candidate=train_job(tmp_path,'test',steps=3)
    assert candidate['parent']==origin['id'] and candidate['sha256']!=origin['sha256']
    assert candidate['training']['before']['total']==24
    child,_=load_checkpoint(tmp_path,candidate['id'])
    assert probabilities(child,'Q: WHERE IS THE KEY?\nA: ')!=before
    parent_again,_=load_checkpoint(tmp_path,origin['id'])
    assert probabilities(parent_again,'Q: WHERE IS THE KEY?\nA: ')==before
