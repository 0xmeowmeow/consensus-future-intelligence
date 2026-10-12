"""CFI encounter revision. Independent state and port; original pilot preserved."""
import asyncio
import copy
from contextlib import asynccontextmanager
import io
import json
import os
from pathlib import Path
import time
import zipfile

from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse, FileResponse, Response, RedirectResponse
from fastapi.staticfiles import StaticFiles
from .encounter_core import EncounterStore, make_room, add_node, allocation, public_room, uid, clean_text
from .encounter_llm import LocalParticipants, DEFAULT_MODELS
from .seed import SeedLab, contribution_example
from .glass import Glass
from .conversation import feedback, mark, endorse
from .workshop import Workshop

HERE = Path(__file__).resolve().parent.parent
COOKIE = 'cfi_encounter_identity_' + os.environ.get('CFI_ENCOUNTER_PORT', '8775')


class Encounter:
    def __init__(self, store, models):
        self.store, self.models = store, models
        self.room = store.latest()
        self.task = None
        self.present = {}
        self.pending_parent = None
        if self.room and self.room['phase'] not in ('closed', 'interrupted'):
            self.room['phase'] = 'interrupted'
            for p in self.room['participants'].values():
                if p['kind'] == 'model' and p.get('status') in ('calling', 'considering'):
                    p['status'] = 'interrupted'
            store.save(self.room, 'interrupted', payload={'reason': 'Server restarted; recorded contributions were preserved.'})

    def save(self, kind, actor=None, payload=None):
        self.store.save(self.room, kind, actor, payload)

    def alive(self, rid):
        return self.room and self.room['id'] == rid and self.room['phase'] not in ('closed', 'interrupted', 'closing')

    async def gather(self, parent=None, weights_only=False):
        room = self.room
        rid = room['id']
        room['phase'] = 'listening'
        self.save('listening', payload={'parent': parent, 'weights_only': weights_only})
        if not weights_only:
            # A conversation is sequential: every request records the exact prior turns it saw.
            for model in room['models']:
                if not self.alive(rid): return
                actor = 'model:' + model
                person = room['participants'][actor]
                person['status'] = 'calling'
                self.save('calling', actor)
                try:
                    context_nodes = copy.deepcopy(room['nodes'])
                    parent_node = next((n for n in context_nodes if n['id'] == parent), None)
                    conversational = hasattr(self.models, 'reply')
                    if conversational:
                        data, trace = await self.models.reply(model, copy.deepcopy(room), parent)
                    else:
                        data, trace = await self.models.propose(model, room['question'], context_nodes, parent_node)
                    if not self.alive(rid): return
                    trace.update(id=uid(), purpose='contribute', actor=actor)
                    room['calls'].append(trace)
                    contributions = data.get('contributions', [])
                    if not contributions and conversational:
                        person['last_pass'] = {'reason': data.get('pass_reason', ''), 'call': trace['id']}
                        self.save('passed', actor, person['last_pass'])
                    elif not contributions:
                        raise ValueError('The model offered no contribution.')
                    if not isinstance(contributions, list) or len(contributions) > (1 if conversational else 3):
                        raise ValueError('The guest exceeded the number of messages allowed in this turn.')
                    if contributions: person.pop('last_pass', None)
                    for item in contributions:
                        text = clean_text(item.get('text'), 1800)
                        target = item.get('parent') if conversational else parent
                        kind = item.get('kind', 'answer') if conversational else (('question' if item.get('kind') == 'question' else 'continuation') if parent else item.get('kind', 'answer'))
                        node = add_node(room, actor, text, kind=kind, parent=target, source=trace['id'])
                        self.save('contribution', actor, {'node': node})
                    person['status'] = 'present'
                    person.pop('error', None)
                except asyncio.CancelledError as exc:
                    if getattr(exc, 'trace', None):
                        failed = dict(exc.trace, id=uid(), purpose='contribute', actor=actor)
                        room['calls'].append(failed)
                        self.store.save(room, 'call_cancelled', actor, {'call':failed['id']})
                    raise
                except Exception as exc:
                    if getattr(exc, 'trace', None):
                        failed = dict(exc.trace, id=uid(), purpose='contribute', actor=actor)
                        room['calls'].append(failed)
                    person['status'] = 'unavailable'
                    person['error'] = str(exc)[:500] or type(exc).__name__
                    self.save('connection_failed', actor, {'error': person['error']})
        # A fixed snapshot makes each allocation auditable when new humans arrive.
        ballot_nodes = list(room['nodes'])
        if ballot_nodes:
            for model in room['models']:
                if not self.alive(rid): return
                actor = 'model:' + model
                person = room['participants'][actor]
                person['status'] = 'considering'
                self.save('considering', actor)
                try:
                    ballot, trace = await self.models.weigh(model, room['question'], ballot_nodes)
                    if not self.alive(rid): return
                    trace.update(id=uid(), purpose='allocate', actor=actor)
                    room['calls'].append(trace)
                    ballot['based_on'] = [n['id'] for n in ballot_nodes]
                    ballot['source'] = trace['id']
                    room['allocations'][actor] = ballot
                    person['status'] = 'present'
                    person.pop('error', None)
                    self.save('allocation', actor, ballot)
                except asyncio.CancelledError as exc:
                    if getattr(exc, 'trace', None):
                        failed = dict(exc.trace, id=uid(), purpose='allocate', actor=actor)
                        room['calls'].append(failed)
                        self.store.save(room, 'call_cancelled', actor, {'call':failed['id']})
                    raise
                except Exception as exc:
                    if getattr(exc, 'trace', None):
                        failed = dict(exc.trace, id=uid(), purpose='allocate', actor=actor)
                        room['calls'].append(failed)
                    person['status'] = 'unavailable'
                    person['error'] = str(exc)[:500] or type(exc).__name__
                    self.save('connection_failed', actor, {'error': person['error']})
        if self.alive(rid):
            room['phase'] = 'open' if room['nodes'] or any(p.get('last_pass') for p in room['participants'].values()) else 'unavailable'
            self.save('round_complete', payload={'nodes': len(room['nodes'])})
            if len(room.get('markers', [])) < 256:
                moment = mark(room, None, 'round', 'Guest round complete. This records a checkpoint, not consensus.', room['nodes'][-1]['id'] if room['nodes'] else None)
                self.save('marker', payload={'marker': copy.deepcopy(moment)})

    def start(self, **kwargs):
        if self.task and not self.task.done():
            raise ValueError('The guests are still responding. Your contributions are already being saved.')
        async def run():
            await self.gather(**kwargs)
            while self.pending_parent and self.alive(self.room['id']):
                parent, self.pending_parent = self.pending_parent, None
                await self.gather(parent=parent)
        self.task = asyncio.create_task(run())

    def respond_to(self, parent):
        if self.task and not self.task.done():
            self.pending_parent = parent
            self.save('reply_queued', payload={'parent': parent})
        else:
            self.start(parent=parent)


def create_app(root=None, models=None):
    root = Path(root or os.environ.get('CFI_ENCOUNTER_STATE', HERE / 'state' / 'encounter-v2'))
    store = EncounterStore(root)
    circle = Encounter(store, models or LocalParticipants())
    lab = SeedLab(root)
    glass = Glass()
    workshop = Workshop(glass)
    seed_job = {'status': 'idle'}

    @asynccontextmanager
    async def lifespan(app):
        yield
        if circle.task:
            circle.task.cancel()
            try: await circle.task
            except asyncio.CancelledError: pass

    app = FastAPI(lifespan=lifespan)
    app.state.circle = circle
    app.state.store = store
    app.state.lab = lab
    app.state.glass = glass

    @app.middleware('http')
    async def boundaries(request, call_next):
        # No cross-origin write requests; the local app uses its own cookie.
        origin = request.headers.get('origin')
        if request.method not in ('GET', 'HEAD', 'OPTIONS') and origin:
            from urllib.parse import urlparse
            if urlparse(origin).netloc != request.headers.get('host'):
                return JSONResponse({'error': 'Open this encounter on its own address before contributing.'}, status_code=403)
        response = await call_next(request)
        response.headers['X-Content-Type-Options'] = 'nosniff'
        if request.url.path.startswith('/api/'):
            response.headers['Cache-Control'] = 'no-store'
        return response

    @app.exception_handler(ValueError)
    async def invalid(request, exc):
        return JSONResponse({'error': str(exc)}, status_code=400)

    def actor(request, required=True):
        a = store.actor(request.cookies.get(COOKIE))
        if not a and required:
            raise HTTPException(401, 'Give yourself a name before contributing.')
        return a

    def room_open(data=None):
        if not circle.room or circle.room['phase'] in ('closed', 'interrupted', 'closing'):
            raise ValueError('Dial a new encounter first.')
        if data is not None and data.get('room_id') is not None and data['room_id'] != circle.room['id']:
            raise ValueError('The encounter changed while you were working. Read the current question before sending these words or this allocation.')
        return circle.room

    def join(a):
        room = circle.room
        if a['id'] not in room['participants']:
            room['participants'][a['id']] = dict(a, status='present')
            circle.save('joined', a['id'])

    @app.get('/api/state')
    async def state(request: Request, omit: str = None):
        a = actor(request, False)
        if a:
            if circle.room and circle.room['phase'] not in ('closed','interrupted','closing'):
                join(a)
            circle.present[a['id']] = {'id': a['id'], 'name': a['name'], 'seen': time.time()}
        present = [p for p in circle.present.values() if time.time()-p['seen'] < 12]
        return {'me': a, 'room': public_room(circle.room, present, omit), 'history': store.history(),
                'seed_job': seed_job, 'version': 'encounter-v3', 'default_models': DEFAULT_MODELS,
                'glass_available': glass.available()}

    @app.get('/api/models')
    async def available():
        try: return {'models': await circle.models.available()}
        except Exception as exc: return JSONResponse({'error': str(exc)}, status_code=503)

    @app.post('/api/identity')
    async def identity(request: Request):
        old = actor(request, False)
        if old:
            if circle.room and circle.room['phase'] not in ('closed', 'interrupted', 'closing'):
                join(old)
            return old
        data = await request.json()
        a, token = store.register(data.get('name', ''))
        if circle.room and circle.room['phase'] not in ('closed', 'interrupted', 'closing'):
            join(a)
        response = JSONResponse(a)
        response.set_cookie(COOKIE, token, httponly=True, samesite='strict', max_age=365*24*3600)
        return response

    @app.post('/api/dial')
    async def dial(request: Request):
        a = actor(request)
        if circle.room and circle.room['phase'] not in ('closed', 'interrupted'):
            raise ValueError('An encounter is already open. Join it, or its initiator can close it before another call.')
        data = await request.json()
        installed = {m['name'] for m in await circle.models.available()}
        # No await between this recheck and publishing the new room: two dials
        # cannot overwrite one another while model metadata is being fetched.
        if circle.room and circle.room['phase'] not in ('closed', 'interrupted'):
            raise ValueError('Another encounter opened while the line was being checked. Join that encounter first.')
        chosen = data.get('models', DEFAULT_MODELS)
        if not isinstance(chosen, list) or not 1 <= len(chosen) <= 8 or any(not isinstance(m,str) for m in chosen) or len(set(chosen)) != len(chosen) or any(m not in installed for m in chosen):
            raise ValueError('Choose one to eight different installed models.')
        circle.pending_parent = None
        circle.room = make_room(data.get('question'), a['id'], chosen)
        circle.room['participants'][a['id']] = dict(a, status='present')
        for model in chosen:
            circle.room['participants']['model:'+model] = {'id': 'model:'+model, 'name': model, 'kind': 'model', 'status': 'waiting'}
        circle.save('dial', a['id'], {'question': circle.room['question'], 'models': chosen})
        circle.start()
        return {'id': circle.room['id']}

    @app.post('/api/contribute')
    async def contribute(request: Request):
        data = await request.json()
        a = actor(request); room = room_open(data); join(a)
        node = add_node(room, a['id'], data.get('text'), data.get('kind', 'answer'), data.get('parent'), data.get('note', ''))
        circle.save('contribution', a['id'], {'node': node})
        if data.get('respond') is True:
            circle.respond_to(node['id'])
        return node

    @app.post('/api/allocate')
    async def allocate(request: Request):
        data = await request.json()
        a = actor(request); room = room_open(data); join(a)
        reason = data.get('reason', '')
        if not isinstance(reason,str) or len(reason)>1800:
            raise ValueError('An allocation reason must be text of at most 1800 characters; nothing was shortened.')
        values = allocation(data.get('values', {}), {n['id'] for n in room['nodes']})
        ballot = {'values': values, 'reason': reason, 'kind': 'human', 'updated': time.time(),
                  'based_on': [n['id'] for n in room['nodes']]}
        room['allocations'][a['id']] = ballot
        circle.save('allocation', a['id'], ballot)
        return {'allocated': sum(abs(v) for v in values.values())}

    @app.post('/api/listen')
    async def listen(request: Request):
        data = await request.json()
        a = actor(request); room = room_open(data); join(a)
        parent = data.get('parent')
        if parent and parent not in {n['id'] for n in room['nodes']}:
            raise ValueError('Select an existing contribution to develop.')
        circle.start(parent=parent, weights_only=False)
        return {'listening': True}

    @app.post('/api/feedback')
    async def rate(request: Request):
        data = await request.json()
        a = actor(request); room = room_open(data); join(a)
        result = feedback(room, a['id'], data.get('node'), data.get('value'))
        circle.save('feedback', a['id'], result)
        return result

    def annotation_room(data):
        rid = data.get('room_id')
        room = circle.room if circle.room and rid == circle.room['id'] else store.room(rid)
        if not room: raise ValueError('Choose an existing encounter.')
        return room

    @app.post('/api/markers')
    async def marker(request: Request):
        data = await request.json(); a = actor(request); room = annotation_room(data)
        room['participants'].setdefault(a['id'], dict(a, status='present'))
        if data.get('kind') == 'round': raise ValueError('Round checkpoints are recorded by the server.')
        result = mark(room, a['id'], data.get('kind'), data.get('note'), data.get('node'))
        store.save(room, 'marker', a['id'], {'marker': copy.deepcopy(result)})
        return result

    @app.post('/api/endorse')
    async def endorsement(request: Request):
        data = await request.json(); a = actor(request); room = annotation_room(data)
        room['participants'].setdefault(a['id'], dict(a, status='present'))
        result = endorse(room, a['id'], data.get('marker'), data.get('stance'), data.get('note', ''))
        store.save(room, 'endorsement', a['id'], result)
        return result

    @app.post('/api/close')
    async def close(request: Request):
        raw = await request.body()
        data = json.loads(raw) if raw else {}
        a = actor(request); room = room_open(data)
        if a['id'] != room['owner']:
            raise HTTPException(403, 'The person who dialled closes this encounter. Your contribution remains yours.')
        circle.pending_parent = None
        room['phase'] = 'closing'
        if circle.task and not circle.task.done():
            circle.task.cancel()
            try: await circle.task
            except asyncio.CancelledError: pass
        room.update(phase='closed', ended=time.time(), closed_by=a['id'])
        for participant in room['participants'].values():
            if participant.get('status') in ('calling','considering','waiting'):
                participant['status'] = 'departed'
        circle.save('departure', a['id'])
        return {'closed': True, 'id': room['id']}

    @app.get('/api/receipt/{rid}')
    async def receipt(rid: str):
        room = store.room(rid)
        if not room: raise HTTPException(404, 'Encounter not found.')
        return JSONResponse({'format': 'cfi-encounter-2', 'room': room,
            'semantics': {'contributions': 'Exact participant text, typed relationships and parent links.',
                          'allocations': 'Signed declared influence, at most one absolute unit per identity.',
                          'calls': 'Actual local requests and responses; returned logprobs describe generation tokens, not agreement.',
                          'training': 'No encounter is automatically turned into a training example.'}},
            headers={'Content-Disposition': f'attachment; filename="cfi-{rid}.json"'})

    @app.get('/api/encounters/{rid}')
    async def encounter(rid: str):
        room = store.room(rid)
        if not room: raise HTTPException(404, 'Encounter not found.')
        return public_room(room)

    @app.get('/api/call/{rid}/{cid}')
    async def call(rid: str, cid: str):
        room = store.room(rid)
        if room:
            for c in room['calls']:
                if c['id'] == cid: return c
        raise HTTPException(404, 'Call not found.')

    @app.get('/api/seed/example/{rid}/{nid}')
    async def seed_example(rid: str, nid: str):
        room = store.room(rid)
        if not room: raise HTTPException(404, 'Encounter not found.')
        return contribution_example(room, nid)

    @app.post('/api/seed/inspect')
    async def inspect_seed(request: Request):
        data = await request.json()
        return await asyncio.to_thread(lab.inspect, data.get('text', ''), data.get('checkpoint', 'origin'), data.get('target'))

    @app.post('/api/glass/inspect')
    async def inspect_glass(request: Request):
        data = await request.json()
        result = await asyncio.to_thread(glass.inspect, data.get('question', ''), data.get('prefix', ''),
                                         data.get('layer', 15), data.get('head'), data.get('target_token'))
        # A reproducible input and measured result; never silently fed into training.
        folder = root/'inspections'; folder.mkdir(exist_ok=True)
        import hashlib
        raw = json.dumps(result, ensure_ascii=False, allow_nan=False).encode()
        key = hashlib.sha256(raw).hexdigest()[:16]
        (folder/(key+'.json')).write_bytes(raw)
        result['receipt'] = key
        return result

    @app.get('/api/glass/receipt/{key}')
    async def glass_receipt(key: str):
        if len(key)!=16 or any(c not in '0123456789abcdef' for c in key):
            raise HTTPException(404, 'Inspection not found.')
        path=root/'inspections'/(key+'.json')
        if not path.exists(): raise HTTPException(404, 'Inspection not found.')
        return FileResponse(path, media_type='application/json', filename='cfi-inspection-'+key+'.json')

    @app.post('/api/workshop/{instrument}')
    async def workshop_run(instrument: str, request: Request):
        data = await request.json()
        if instrument == 'tokenizer':
            result = await asyncio.to_thread(workshop.tokenize, data.get('text'), data.get('corpus'), data.get('count', 12), data.get('merges'))
        elif instrument == 'mechanism':
            result = await asyncio.to_thread(workshop.inspect, data.get('question'), data.get('prefix', ''), data.get('layer', 0), data.get('steps', 3), data.get('append_ids'))
        else: raise HTTPException(404, 'Unknown instrument.')
        folder = root/'inspections'; folder.mkdir(exist_ok=True)
        import hashlib
        raw = json.dumps(result, ensure_ascii=False, allow_nan=False).encode()
        key = hashlib.sha256(raw).hexdigest()[:16]
        (folder/(key+'.json')).write_bytes(raw)
        result['receipt'] = key
        return result

    @app.post('/api/seed/train')
    async def train_seed(request: Request):
        a = actor(request)
        if seed_job['status'] == 'running': raise ValueError('One seed experiment is already running.')
        data = await request.json()
        prompt, target = data.get('prompt', ''), data.get('target', '')
        if not isinstance(prompt, str) or not isinstance(target, str): raise ValueError('Use exact text for the prompt and target.')
        # Validate before creating a job. Training is an explicit individual test,
        # never a declaration that the circle endorsed the target.
        if not target.strip() or len((prompt + target).encode('utf-8')) > 1023:
            raise ValueError('The exact prompt and target must fit in 1023 UTF-8 bytes.')
        seed_job.clear(); seed_job.update(status='running', actor=a['id'], started=time.time(), prompt=prompt, target=target)
        async def run():
            try:
                result = await asyncio.to_thread(lab.train, prompt, target)
                seed_job.update(status='complete', result=result)
            except Exception as exc: seed_job.update(status='failed', error=str(exc))
        asyncio.create_task(run())
        return {'started': True}

    @app.get('/api/seed/download/{checkpoint}')
    async def download(checkpoint: str):
        lab.load(checkpoint)  # validate before resolving any file path
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as z:
            z.write(lab.root/(checkpoint+'.safetensors'), 'weights.safetensors')
            z.write(lab.root/(checkpoint+'.json'), 'manifest.json')
            z.write(Path(__file__).with_name('seed.py'), 'seed.py')
        return Response(output.getvalue(), media_type='application/zip', headers={'Content-Disposition': f'attachment; filename="{checkpoint}.zip"'})

    @app.get('/')
    async def front_door():
        return RedirectResponse('/table.html')

    app.mount('/', StaticFiles(directory=HERE/'web'/'encounter', html=True), name='encounter')
    return app


app = create_app()
