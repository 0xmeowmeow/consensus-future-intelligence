import asyncio
import json
import time
import pytest
from fastapi.testclient import TestClient
from cfi.llm import Guest, parse_work_choice
from cfi.server import create_app, refund_unanswered
from cfi import work

@pytest.mark.parametrize('answer',['A','A.','a!','"A"','**A**','Box A.','{"answer":"A"}'])
def test_answer_formatting_does_not_reject_correct_choice(answer):
    assert parse_work_choice(answer,['Q','Z','V','A'])=='A'

@pytest.mark.parametrize('answer',['A or Q','The answer could be A','Z or A.','', '{"answer":"not an option"}'])
def test_ambiguous_or_explanatory_answers_do_not_become_a_guessed_choice(answer):
    with pytest.raises(ValueError):parse_work_choice(answer,['Q','Z','V','A'])

def test_exact_punctuated_choice_takes_precedence():
    assert parse_work_choice('Maybe.',['Maybe.','Maybe'])=='Maybe.'

class FailingGuest:
    model='explicit failed-connection fixture'
    status='Not dialled';weights={};prefix=None;error=None;calls=0
    attempts=0
    async def solve_work(self,packet):
        self.attempts+=1
        raise ValueError('No unambiguous work answer')
    async def next_pressure(self,question,prefix):
        raise AssertionError('A guest that failed its work must never supply a field')

def test_failed_guest_gets_bounded_retries_visible_failure_and_entry_refund(tmp_path):
    guest=FailingGuest();app=create_app(tmp_path,guest);store=app.state.store
    with TestClient(app) as client:
        actor=client.post('/api/identity',json={'name':'Caller'}).json()
        with store.connect() as db:store.credit(db,actor['id'],2,'Test setup','setup')
        q=client.post('/api/questions',json={'title':'WHAT WILL WE MAKE?','request_id':'question-test'}).json()
        client.post('/api/room/join',json={})
        client.post('/api/room/dial',json={})
        deadline=time.monotonic()+5
        while time.monotonic()<deadline:
            data=client.get('/api/state').json()
            if data['room']['phase']=='unavailable':break
            time.sleep(.02)
        assert data['room']['phase']=='unavailable'
        assert guest.attempts==2
        assert data['room']['guest']['joined'] is False
        assert data['balance']==0
        assert len(store.rows("SELECT * FROM events WHERE kind='guest_work_rejected'"))==2
        assert len(store.rows("SELECT * FROM events WHERE kind='guest_error'"))==1
        assert client.post('/api/room/goodbye',json={}).status_code==200
        closed=client.get('/api/state').json()
        assert closed['balance']==1
        assert closed['questions'][0]['id']==q['id']
        assert 'returned' in closed['room']['message']
        assert refund_unanswered(store,closed['room']['episode'])==0
        assert store.balance(actor['id'])==1
        # Repeating recovery later must not requeue a question already called again.
        with store.connect() as db:db.execute('UPDATE questions SET used=1 WHERE id=?',(q['id'],))
        refund_unanswered(store,closed['room']['episode'])
        assert store.one('SELECT used FROM questions WHERE id=?',(q['id'],))['used']==1

def test_successful_contact_is_not_refunded(tmp_path):
    app=create_app(tmp_path,FailingGuest());store=app.state.store
    actor,_=store.create_actor('Caller')
    with store.connect() as db:
        store.credit(db,actor['id'],1,'Test setup','setup')
        store.credit(db,actor['id'],-1,'Entry','entry:circle:'+actor['id'])
    store.event('pressure',None,{'episode':'circle','guest':{'A':1}})
    assert refund_unanswered(store,'circle')==0
    assert store.balance(actor['id'])==0
