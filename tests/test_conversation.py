import asyncio
import copy
import json
import pytest
from fastapi.testclient import TestClient
from cfi.encounter import create_app
from cfi.encounter_core import make_room, add_node
from cfi.conversation import mark, endorse, feedback
from cfi.encounter_llm import LocalParticipants

class ChatGuests:
    def __init__(self):self.seen=[]
    async def available(self):return [{'name':'one'},{'name':'two'}]
    async def reply(self,model,room,parent):
        self.seen.append((model,copy.deepcopy(room),parent))
        parent=parent or (room['nodes'][-1]['id'] if room['nodes'] else None)
        return {'contributions':[{'text':f'{model} received {len(room["nodes"])} turns.', 'kind':'continuation' if parent else 'answer','parent':parent}]},{'request':{'question':room['question']},'response':{}}
    async def weigh(self,model,question,nodes):return {'values':{nodes[-1]['id']:.5},'kind':'model','reason':'Test choice.'},{'request':{},'response':{}}

def finish(client,app):
    async def wait():await app.state.circle.task
    client.portal.call(wait)

def test_conversation_rounds_see_prior_authored_turns_and_listen_really_replies(tmp_path):
    guests=ChatGuests();app=create_app(tmp_path,guests)
    with TestClient(app) as client:
        me=client.post('/api/identity',json={'name':'Human'}).json()
        rid=client.post('/api/dial',json={'question':'An exact question?','models':['one','two']}).json()['id'];finish(client,app)
        assert [len(x[1]['nodes']) for x in guests.seen]==[0,1]
        node=client.post('/api/contribute',json={'text':'  Reframe it.\nKeep this exact.','room_id':rid,'respond':True}).json();finish(client,app)
        assert guests.seen[2][2]==node['id']
        assert guests.seen[2][1]['nodes'][-1]['author']==me['id']
        assert guests.seen[2][1]['nodes'][-1]['text']=='  Reframe it.\nKeep this exact.'
        before=len(client.get('/api/state').json()['room']['nodes'])
        client.post('/api/listen',json={'room_id':rid});finish(client,app)
        room=client.get('/api/receipt/'+rid).json()['room']
        assert len(room['nodes'])==before+2
        assert len(room['markers'])==3
        assert all(m['kind']=='round' for m in room['markers'])
        assert len(room['markers'][0]['snapshot']['nodes'])==2

def test_ratings_markers_and_conditions_preserve_the_state_at_the_moment(tmp_path):
    app=create_app(tmp_path,ChatGuests())
    with TestClient(app) as c:
        me=c.post('/api/identity',json={'name':'Human'}).json()
        rid=c.post('/api/dial',json={'question':'Where did we turn?','models':['one']}).json()['id'];finish(c,app)
        node=c.get('/api/state').json()['room']['nodes'][0]['id']
        assert c.post('/api/feedback',json={'room_id':rid,'node':node,'value':True}).status_code==400
        c.post('/api/feedback',json={'room_id':rid,'node':node,'value':1})
        marker=c.post('/api/markers',json={'room_id':rid,'node':node,'kind':'agreement','note':'We might agree, conditional on consent.'}).json()
        c.post('/api/feedback',json={'room_id':rid,'node':node,'value':-1})
        assert c.post('/api/endorse',json={'room_id':rid,'marker':marker['id'],'stance':'condition','note':''}).status_code==400
        c.post('/api/endorse',json={'room_id':rid,'marker':marker['id'],'stance':'condition','note':'Only with consent.'})
        c.post('/api/close',json={'room_id':rid})
        assert c.post('/api/markers',json={'room_id':rid,'kind':'direction','note':'After closing, reconsider the premise.'}).status_code==200
        room=c.get('/api/receipt/'+rid).json()['room'];m=next(m for m in room['markers'] if m['id']==marker['id'])
        assert m['snapshot']['feedback'][node][me['id']]['value']==1
        assert room['feedback'][node][me['id']]['value']==-1
        assert m['endorsements'][me['id']]['note']=='Only with consent.'
        created=next(e for e in room['events'] if e['kind']=='marker' and e['payload']['marker']['id']==m['id'])
        assert created['payload']['marker']['endorsements']=={}
        assert sum(e['kind']=='feedback' for e in room['events'])==2
        assert c.post('/api/feedback',json={'room_id':rid,'node':node,'value':1}).status_code==400

def test_new_human_turn_during_round_gets_one_followup_round(tmp_path):
    class Waiting(ChatGuests):
        calls=0
        async def reply(self,model,room,parent):
            self.calls+=1
            if self.calls==1:await self.gate.wait()
            return await super().reply(model,room,parent)
    guest=Waiting();app=create_app(tmp_path,guest)
    with TestClient(app) as c:
        async def prepare():guest.gate=asyncio.Event()
        c.portal.call(prepare);c.post('/api/identity',json={'name':'Human'})
        rid=c.post('/api/dial',json={'question':'Wait for my point.','models':['one']}).json()['id']
        node=c.post('/api/contribute',json={'room_id':rid,'text':'The point arrived mid-turn.','respond':True}).json()
        c.portal.call(guest.gate.set);finish(c,app)
        assert guest.calls==2 and guest.seen[-1][2]==node['id']
        assert app.state.circle.pending_parent is None

def test_reply_prompt_keeps_roles_parentage_and_pass_is_available():
    guest=LocalParticipants();captured={}
    async def capture(model,system,payload,schema,messages=None):
        captured.update(system=system,messages=messages,schema=schema)
        return {'reply':'[PASS] Nothing to add.'},{'request':{'messages':messages}}
    guest.call=capture
    room=make_room('Question?','human',['guest']);room['participants']={'human':{'name':'Me','kind':'human'}}
    node=add_node(room,'human','Exact words.')
    result,trace=asyncio.run(guest.reply('guest',room,node['id']))
    assert captured['messages'][1]['role']=='user'
    assert captured['messages'][1]['content'].endswith('Exact words.')
    assert '[human: Me;' in captured['messages'][1]['content']
    assert captured['messages'][-1]['content'].endswith('Exact words.')
    assert trace['based_on']==[node['id']]
    assert captured['schema'] is None
    assert result=={'contributions':[],'pass_reason':'Nothing to add.'}


def test_annotating_an_archive_does_not_make_it_the_current_encounter(tmp_path):
    from cfi.encounter_core import EncounterStore
    store=EncounterStore(tmp_path)
    old=make_room('Old encounter','human',[]);old['created']=1
    new=make_room('Current encounter','human',[]);new['created']=2
    store.save(old);store.save(new)
    marker=mark(old,'human','direction','Retrospective annotation.')
    store.save(old,'marker','human',{'marker':marker})
    assert store.latest()['id']==new['id']
    assert store.history()[0]['id']==new['id']


def test_a_guest_can_pass_explicitly_without_looking_like_a_connection_failure(tmp_path):
    class Passing(ChatGuests):
        async def reply(self,*args):
            return {'contributions':[], 'pass_reason':'I have no new point to add.'}, {'request':{},'response':{}}
    app=create_app(tmp_path,Passing())
    with TestClient(app) as c:
        c.post('/api/identity',json={'name':'Human'})
        c.post('/api/dial',json={'question':'Can you pass?','models':['one']});finish(c,app)
        room=c.get('/api/state').json()['room']
        assert room['phase']=='open' and room['nodes']==[]
        assert room['participants']['model:one']['last_pass']['reason']=='I have no new point to add.'
        assert any(e['kind']=='passed' for e in room['events'])


def test_empty_native_reply_preserves_failed_attempt_without_inventing_a_turn(monkeypatch,tmp_path):
    import httpx
    actual_client=httpx.AsyncClient
    transport=httpx.MockTransport(lambda request:httpx.Response(200,json={'message':{'content':''}}))
    monkeypatch.setattr(httpx,'AsyncClient',lambda *a,**kw:actual_client(*a,transport=transport,**kw))
    guest=LocalParticipants()
    async def available():return [{'name':'empty'}]
    guest.available=available;app=create_app(tmp_path,guest)
    with TestClient(app) as c:
        c.post('/api/identity',json={'name':'Human'})
        rid=c.post('/api/dial',json={'question':'Can you answer?','models':['empty']}).json()['id'];finish(c,app)
        room=c.get('/api/receipt/'+rid).json()['room']
        assert room['phase']=='unavailable' and room['nodes']==[]
        assert room['calls'][0]['response']['message']['content']==''
        assert 'empty reply' in room['calls'][0]['error']
        assert 'format' not in room['calls'][0]['request']
