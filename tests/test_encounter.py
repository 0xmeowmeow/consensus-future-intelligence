import asyncio
import copy
import json
import math
import pytest
import torch
from fastapi.testclient import TestClient
from cfi.encounter_core import EncounterStore, make_room, add_node, allocation, tally
from cfi.encounter import create_app
from cfi.seed import SeedLab, Seed, encode


def test_signed_budget_rejects_nonfinite_and_overallocation():
    for values in ({'a': 1, 'b': .01}, {'a': -1, 'b': -.01}, {'a': math.nan}, {'a': True}, {'a': math.inf}, {'missing': .2}):
        with pytest.raises(ValueError): allocation(values, {'a', 'b'})
    assert allocation({'a': .25, 'b': -.75}, {'a', 'b'}) == {'a': .25, 'b': -.75}
    assert allocation({'a': 8, 'b': -2}, {'a', 'b'}, normalize=True) == {'a': .8, 'b': -.2}


def test_another_branch_cannot_multiply_a_voice():
    room = make_room('A question?', 'human', ['model-a', 'model-b'])
    a = add_node(room, 'model-a', 'Only if everyone consents.')
    b = add_node(room, 'human', 'Keep it regardless.')
    for actor in ['model-a', 'model-b']:
        room['allocations'][actor] = {'values': {a['id']: 1}}
    room['allocations']['human'] = {'values': {b['id']: 1}}
    totals = tally(room)
    assert totals[a['id']]['net'] == 2
    assert totals[b['id']]['net'] == 1
    assert tally(room, 'model-a')[a['id']]['net'] == 1
    assert set(totals) == {a['id'], b['id']}
    assert tally(room)[a['id']]['net'] == 2  # comparison did not erase a ballot
    room['allocations']['human']['values'] = {a['id']: -.5, b['id']: .5}
    assert tally(room)[a['id']]['net'] == 1.5


def test_exact_words_relationship_and_dissent_survive_reload(tmp_path):
    store = EncounterStore(tmp_path)
    room = make_room('Does consent matter?', 'human', [])
    text = '  Only if everyone consents.\nThat includes “no”, not just silence.  '
    parent = add_node(room, 'human', 'Share the memory.')
    child = add_node(room, 'human2', text, 'qualification', parent['id'])
    room['allocations']['human2'] = {'values': {parent['id']: -.25, child['id']: .75}, 'reason': 'Consent is a condition.'}
    store.save(room, 'contribution', 'human2', child)
    loaded = EncounterStore(tmp_path).latest()
    assert loaded['nodes'][1]['text'] == text
    assert loaded['nodes'][1]['parent'] == parent['id']
    assert loaded['allocations']['human2']['reason'] == 'Consent is a condition.'
    assert loaded['events'][0]['payload']['text'] == text


class Guests:
    async def available(self): return [{'name': 'fixture-a'}, {'name': 'fixture-b'}]
    async def propose(self, model, question, nodes, parent):
        return {'contributions': [{'text': 'Yes, only with consent.' if model == 'fixture-a' else 'Keep the objection in the record.', 'kind': 'answer'}]}, {'request': {'question': question, 'parent': parent}, 'response': {}, 'seconds': 0}
    async def weigh(self, model, question, nodes):
        return {'values': {nodes[0]['id']: .75, nodes[1]['id']: -.25}, 'reason': 'A declared fixture preference.', 'updated': 1, 'kind': 'model'}, {'request': {}, 'response': {}, 'seconds': 0}


def test_api_two_people_exact_record_budget_and_receipt(tmp_path):
    app = create_app(tmp_path, Guests())
    with TestClient(app) as client:
        assert client.post('/api/contribute', json={'text': 'unregistered'}).status_code == 401
        one = client.post('/api/identity', json={'name': 'One'}).json()
        assert client.post('/api/dial', json={'question': 'May we share it?', 'models': ['fixture-a', 'fixture-b']}).status_code == 200
        # Wait on the event loop, not a sleep-based assumption.
        async def finish(): await app.state.circle.task
        client.portal.call(finish)
        first = client.get('/api/state').json()
        assert first['room']['phase'] == 'open'
        assert len(first['room']['nodes']) == 2
        assert len(first['room']['allocations']) == 2
        nid = first['room']['nodes'][0]['id']
        assert client.post('/api/allocate', json={'values': {nid: 1.25}}).status_code == 400
        assert client.post('/api/allocate', json={'values': {nid: 1}}).status_code == 200
        assert client.post('/api/allocate', json={'values': {nid: .5}}).status_code == 200
        assert client.get('/api/state').json()['room']['totals'][nid]['support'] == 2.0
        owner_cookies = dict(client.cookies)
        client.cookies.clear()
        two = client.post('/api/identity', json={'name': 'Two'}).json()
        assert two['id'] in client.get('/api/state').json()['room']['participants']
        exact = '<script>alert(1)</script>\nOnly if they say yes. 🐈'
        response = client.post('/api/contribute', json={'text': exact, 'kind': 'qualification', 'parent': nid})
        assert response.status_code == 200
        assert response.json()['text'] == exact
        assert client.post('/api/close').status_code == 403
        client.cookies.clear(); client.cookies.update(owner_cookies)
        assert client.post('/api/close').status_code == 200
        rid = first['room']['id']
        receipt = client.get('/api/receipt/'+rid).json()
        assert receipt['room']['nodes'][-1]['text'] == exact
        assert receipt['room']['nodes'][-1]['parent'] == nid
        assert receipt['room']['allocations'][one['id']]['values'][nid] == .5
        assert client.post('/api/allocate', json={'values': {nid: 1}}).status_code == 400
        assert client.post('/api/identity', json={'name':'extra'}, headers={'origin':'https://unrelated.example'}).status_code == 403


def test_attention_is_causal_normalized_and_has_all_heads():
    model = Seed()
    with torch.no_grad():
        _, heads, _ = model(torch.tensor([encode('hello')]), inspect=True)
    assert len(heads) == 3
    for attention in heads:
        assert attention.shape == (1, 4, 6, 6)
        assert torch.allclose(attention.sum(-1), torch.ones(1, 4, 6), atol=1e-6)
        assert torch.count_nonzero(torch.triu(attention, 1)) == 0


def test_seed_gradient_does_not_change_weights_and_copy_can_fit(tmp_path):
    lab = SeedLab(tmp_path)
    original = (lab.root/'origin.safetensors').read_bytes()
    inspected = lab.inspect('Q: consent?\nA:', target=' Only with consent.')
    assert len(inspected['attention']) == 3
    assert all(len(x) == 4 for x in inspected['attention'])
    assert inspected['gradient']['weights_changed'] is False
    assert any(p['norm'] > 0 for p in inspected['gradient']['parameters'])
    assert original == (lab.root/'origin.safetensors').read_bytes()
    candidate = lab.train('Q: consent?\nA:', ' Only with consent.', steps=35)
    assert candidate['after_nll'] < candidate['before_nll'] * .5
    assert original == (lab.root/'origin.safetensors').read_bytes()
    assert candidate['target'] == ' Only with consent.'
    assert lab.inspect('Q: consent?\nA:', candidate['id'])['checkpoint'] == candidate['id']


def test_seed_does_not_silently_truncate_unicode(tmp_path):
    lab = SeedLab(tmp_path)
    assert encode('🐈') == [256, 240, 159, 144, 136]
    with pytest.raises(ValueError): lab.inspect('🐈'*300)
    with pytest.raises(ValueError): lab.train('a'*1010, 'b'*20)
    with pytest.raises(ValueError): lab.load('../origin')


def test_seed_handoff_keeps_the_exact_question_and_parent_chain():
    from cfi.seed import contribution_example
    room=make_room('  May we preserve this memory?  ', 'operator', [])
    parent=add_node(room,'one','Preserve it if everyone agrees.\nNo default consent.')
    condition=add_node(room,'two','  Except when a contributor leaves.  ','qualification',parent['id'])
    objection=add_node(room,'three','Erasure may change everyone’s memory.','objection',condition['id'])
    example=contribution_example(room,objection['id'])
    assert room['question'] in example['prompt']
    assert parent['text'] in example['prompt']
    assert condition['text'] in example['prompt']
    assert example['target']==objection['text']
    assert example['source']['parents']==[parent['id'],condition['id']]
    assert example['fits']
    condition['text']='🐈'*300
    too_long=contribution_example(room,objection['id'])
    assert not too_long['fits'] and condition['text'] in too_long['prompt']


def test_contribution_notes_are_preserved_or_rejected_without_truncation():
    room=make_room('Exactness matters?', 'one', [])
    note='  A condition in the margin.\nLeave the whitespace.  '
    assert add_node(room,'one','A contribution.',note=note)['note']==note
    with pytest.raises(ValueError):add_node(room,'one','A second contribution.',note='x'*1001)
    assert len(room['nodes'])==1
