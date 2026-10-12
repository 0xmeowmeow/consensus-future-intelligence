import asyncio
import json
import pytest
import httpx
from fastapi.testclient import TestClient
from cfi.encounter import create_app
from cfi.encounter_llm import LocalParticipants, ParticipantFailure


def test_oversize_context_is_not_silently_submitted():
    guest=LocalParticipants()
    with pytest.raises(ParticipantFailure) as error:
        asyncio.run(guest.call('not-called','system',{'text':'x'*7100},{'type':'object'}))
    assert 'No text was cropped' in str(error.value)
    assert error.value.trace['request']['messages'][1]['content']==json.dumps({'text':'x'*7100},ensure_ascii=False)
    assert 'response' not in error.value.trace


def test_invalid_allocation_text_is_preserved_without_an_allocation(monkeypatch,tmp_path):
    actual_client=httpx.AsyncClient
    transport=httpx.MockTransport(lambda request:httpx.Response(200,json={'message':{'content':'not valid JSON' if 'format' in json.loads(request.content) else 'A natural-language reply.'},'eval_count':4}))
    monkeypatch.setattr(httpx,'AsyncClient',lambda *a,**kw:actual_client(*a,transport=transport,**kw))
    guest=LocalParticipants()
    async def available(): return [{'name':'fixture-broken'}]
    guest.available=available
    app=create_app(tmp_path,guest)
    with TestClient(app) as client:
        client.post('/api/identity',json={'name':'Test harness'})
        client.post('/api/dial',json={'question':'Can you answer?','models':['fixture-broken']})
        async def finish(): await app.state.circle.task
        client.portal.call(finish)
        room=client.get('/api/state').json()['room']
        assert room['phase']=='open'
        assert len(room['nodes'])==1 and room['allocations']=={}
        assert room['nodes'][0]['text']=='A natural-language reply.'
        receipt=client.get('/api/receipt/'+room['id']).json()['room']
        assert len(receipt['calls'])==2
        trace=receipt['calls'][-1]
        assert trace['response']['message']['content']=='not valid JSON'
        assert trace['request']['model']=='fixture-broken'
        assert 'unreadable JSON' in trace['error']


def test_guest_list_excludes_embedding_only_models_and_caches_metadata(monkeypatch):
    actual_client=httpx.AsyncClient;calls=[]
    def handle(request):
        calls.append(request.url.path)
        if request.url.path=='/api/tags':return httpx.Response(200,json={'models':[{'name':'speaker','digest':'one'},{'name':'embedder','digest':'two'}]})
        name=json.loads(request.content)['model']
        return httpx.Response(200,json={'capabilities':['completion'] if name=='speaker' else ['embedding']})
    transport=httpx.MockTransport(handle)
    monkeypatch.setattr(httpx,'AsyncClient',lambda *a,**kw:actual_client(*a,transport=transport,**kw))
    guest=LocalParticipants()
    async def run():
        first=await guest.available();second=await guest.available();return first,second
    first,second=asyncio.run(run())
    assert first==second and [m['name'] for m in first]==['speaker']
    assert first[0]['digest']=='one'
    assert calls.count('/api/tags')==1 and calls.count('/api/show')==2


def test_departure_waits_for_cancelled_call_and_preserves_its_attempt(tmp_path):
    class SlowGuest:
        async def available(self):return [{'name':'fixture-slow'}]
        async def propose(self,*args):
            try:await asyncio.Event().wait()
            except asyncio.CancelledError as exc:
                exc.trace={'request':{'model':'fixture-slow'},'cancelled':True,'error':'Call cancelled before completion.'}
                raise
    app=create_app(tmp_path,SlowGuest())
    with TestClient(app) as client:
        client.post('/api/identity',json={'name':'Operator'})
        response=client.post('/api/dial',json={'question':'Can we close the line?','models':['fixture-slow']})
        rid=response.json()['id']
        assert client.post('/api/close').status_code==200
        room=client.get('/api/receipt/'+rid).json()['room']
        assert room['phase']=='closed'
        assert room['participants']['model:fixture-slow']['status']=='departed'
        assert room['calls'][0]['cancelled'] and room['calls'][0]['request']['model']=='fixture-slow'
        assert any(event['kind']=='call_cancelled' for event in room['events'])
        assert room['events'][-1]['kind']=='departure'
        assert app.state.circle.task.done()
        assert client.post('/api/dial',json={'question':'The next call','models':['fixture-slow']}).status_code==200


def test_empty_failed_encounter_can_retry_without_replacing_the_question(tmp_path):
    class FlakyGuest:
        attempts=0
        async def available(self):return [{'name':'fixture-retry'}]
        async def propose(self,*args):
            self.attempts+=1
            if self.attempts==1:raise ValueError('Fixture line temporarily unavailable')
            return {'contributions':[{'kind':'answer','text':'The same question reached me on retry.'}]},{'request':{},'response':{}}
        async def weigh(self,model,question,nodes):
            return {'values':{nodes[0]['id']:1},'reason':'A fixture choice.','kind':'model'},{'request':{},'response':{}}
    guest=FlakyGuest();app=create_app(tmp_path,guest)
    with TestClient(app) as client:
        client.post('/api/identity',json={'name':'Operator'})
        rid=client.post('/api/dial',json={'question':'Keep this exact question.','models':['fixture-retry']}).json()['id']
        async def finish():await app.state.circle.task
        client.portal.call(finish)
        assert client.get('/api/state').json()['room']['phase']=='unavailable'
        assert client.post('/api/listen',json={}).status_code==200
        client.portal.call(finish)
        room=client.get('/api/state').json()['room']
        assert room['id']==rid and room['question']=='Keep this exact question.'
        assert room['phase']=='open' and guest.attempts==2
        assert len(room['nodes'])==1 and len(room['allocations'])==1


def test_simultaneous_dials_cannot_replace_an_in_flight_encounter(tmp_path):
    class RacingGuest:
        count=0
        gate=None
        async def available(self):
            if self.gate is None:self.gate=asyncio.Event()
            self.count+=1
            if self.count==2:self.gate.set()
            await self.gate.wait()
            return [{'name':'fixture-race'}]
        async def propose(self,*args):await asyncio.Event().wait()
    app=create_app(tmp_path,RacingGuest())
    async def run():
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://testserver') as client:
            await client.post('/api/identity',json={'name':'Operator'})
            results=await asyncio.gather(*(client.post('/api/dial',json={'question':question,'models':['fixture-race']}) for question in ['First question','Second question']))
            assert sorted(r.status_code for r in results)==[200,400]
            winner=next(i for i,r in enumerate(results) if r.status_code==200)
            room=(await client.get('/api/state')).json()['room']
            assert room['question']==['First question','Second question'][winner]
            assert room['id']==results[winner].json()['id']
            assert len(app.state.store.history())==1
            await client.post('/api/close')
    asyncio.run(run())


def test_stale_browser_cannot_put_old_words_into_a_new_question(tmp_path):
    class QuietGuest:
        async def available(self):return [{'name':'fixture-quiet'}]
        async def propose(self,*args):await asyncio.Event().wait()
    app=create_app(tmp_path,QuietGuest())
    with TestClient(app) as client:
        client.post('/api/identity',json={'name':'Operator'})
        old=client.post('/api/dial',json={'question':'Old question','models':['fixture-quiet']}).json()['id']
        client.post('/api/close')
        new=client.post('/api/dial',json={'question':'New question','models':['fixture-quiet']}).json()['id']
        for route,data in [('contribute',{'text':'Words about the old question'}),('allocate',{'values':{}}),('listen',{}),('close',{})]:
            assert client.post('/api/'+route,json=dict(data,room_id=old)).status_code==400
        room=client.get('/api/state').json()['room']
        assert room['id']==new and room['nodes']==[] and room['phase']!='closed'
