"""One authoritative circle: ledger, motion, evidence and bounded local training."""
import asyncio
from contextlib import asynccontextmanager
import io
import json
import math
import os
from pathlib import Path
import secrets
import subprocess
import sys
import time
import zipfile

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.responses import JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from .storage import Store
from . import physics, work
from .model import ensure_origin, load_checkpoint, probabilities, model_history
from .llm import Guest

HERE=Path(__file__).resolve().parent.parent
NOTICE='Only submit material you have the rights or permission to contribute for CFI’s model training and stated uses. Do not submit unauthorised material.'

def ident(): return secrets.token_hex(12)

def refund_unanswered(store, episode):
    """Return entry stakes only when this encounter never obtained a guest field."""
    with store.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        contacted=db.execute("SELECT 1 FROM events WHERE kind='pressure' AND json_extract(payload,'$.episode')=? LIMIT 1",(episode,)).fetchone()
        if contacted:return 0
        entries=db.execute("SELECT id,actor,amount FROM ledger WHERE ref LIKE ? AND amount<0",(f'entry:{episode}:%',)).fetchall()
        refunded=0
        for entry in entries:
            if store.credit(db,entry['actor'],-entry['amount'],'Entry returned: guest never connected',f'refund-entry:{entry["id"]}'):
                refunded-=entry['amount']
        dial=db.execute("SELECT payload FROM events WHERE kind='dial' AND json_extract(payload,'$.episode')=? LIMIT 1",(episode,)).fetchone()
        question_id=json.loads(dial['payload']).get('question_id') if dial else None
        if question_id and refunded:db.execute('UPDATE questions SET used=0 WHERE id=?',(question_id,))
        return refunded

class Room:
    def __init__(self, store, guest=None):
        self.store=store
        self.guest=guest or Guest()
        self.clients={}
        self.contacts={}
        self.chat=[]
        self.round=ident()
        self.phase='idle'
        self.question='WHAT SHOULD WE BECOME?'
        self.board=physics.initial()
        self.forces=[]
        self.episode=None
        self.seq=0
        self.frames=[]
        self.pressure_task=None
        self.entity_weights={}
        self.started=0
        self.message='The line is quiet. Earn a token, join the circle, then dial.'
        self.job_process=None
        origin=ensure_origin(store.root)
        active=store.setting('active_model') or store.setting('active_model',origin['id'])
        self.entity,self.manifest=load_checkpoint(store.root,active)
        self.guest_actor=store.setting('guest_actor')
        if not self.guest_actor:
            actor,_=store.create_actor('Silicon guest · '+self.guest.model)
            self.guest_actor=actor['id']
            store.setting('guest_actor',self.guest_actor)
        for ep in store.rows("SELECT id FROM episodes WHERE status='contact'"):
            refund_unanswered(store,ep['id'])
        with store.connect() as db:
            db.execute("UPDATE episodes SET status='interrupted',ended=? WHERE status='contact'",(time.time(),))
            db.execute("UPDATE jobs SET status='failed',error='Server stopped during this training job. Start a new candidate.' WHERE status IN ('queued','running')")

    def joined(self, actor):
        return bool(self.store.one('SELECT 1 FROM entries WHERE round=? AND actor=?',(self.round,actor)))

    def human_contacts(self):
        now=time.monotonic()
        # One hand per identity, even with several tabs. Missing heartbeats release it.
        return [dict(c,holding=c['holding'] and now-c['seen']<1.2) for aid,c in self.contacts.items() if self.joined(aid)]

    def snapshot(self):
        humans={v['actor']['id']:v['actor'] for v in self.clients.values()}
        return {'round':self.round,'phase':self.phase,'question':self.question,'board':self.board,'forces':self.forces,
            'nodes':physics.NODES,'episode':self.episode,'message':self.message,
            'people':[dict(a,joined=self.joined(a['id'])) for a in humans.values()],
            'contacts':self.human_contacts(),'chat':self.chat[-12:],
            'guest':{'name':self.guest.model,'status':self.guest.status,'error':self.guest.error,'weights':self.guest.weights,'fresh':self.guest.prefix==self.board['text'],'balance':self.store.balance(self.guest_actor),'joined':self.joined(self.guest_actor),'calls':self.guest.calls},
            'entity':{'id':self.manifest['id'],'weights':self.entity_weights,'trained':bool(self.manifest['parent'])}}

    async def broadcast(self):
        if not self.clients: return
        snapshot=json.dumps(self.snapshot(),allow_nan=False)
        async def send(ws):
            try: await asyncio.wait_for(ws.send_text(snapshot),timeout=.5)
            except Exception: self.clients.pop(ws,None)
        await asyncio.gather(*(send(ws) for ws in list(self.clients)))

    def flush(self):
        if self.frames:
            with self.store.connect() as db:
                db.executemany('INSERT INTO frames VALUES(?,?,?)',self.frames)
            self.frames=[]

    def finish(self, reason):
        if self.phase not in ('contact','dialling','unavailable'): return
        if self.pressure_task and not self.pressure_task.done(): self.pressure_task.cancel()
        self.phase='closed'
        self.message=reason
        self.guest.status='Departed'
        for c in self.contacts.values(): c['holding']=False
        self.flush()
        if self.episode:
            with self.store.connect() as db:
                db.execute('UPDATE episodes SET transcript=?,status=?,ended=? WHERE id=?',(self.board['text'],'closed',time.time(),self.episode))
            returned=refund_unanswered(self.store,self.episode)
            if returned:self.message+=' No guest connected; entry tokens were returned and the question is back in the queue.'
        self.store.event('departure',None,{'episode':self.episode,'reason':reason})

    async def refresh(self, first=False):
        prefix=self.board['text']
        try:
            if first and not self.joined(self.guest_actor):
                if self.store.balance(self.guest_actor)<1:
                    packet=work.issue(self.store,self.guest_actor)
                    for attempt in range(1,3):
                        self.guest.status=f'Checking guest work · attempt {attempt}/2'
                        self.message='The guest is earning its entry. Your work is saved; no extra tokens are spent on retries.'
                        try:
                            solved=await self.guest.solve_work(packet)
                            result=work.submit(self.store,self.guest_actor,packet['id'],solved.get('control'),solved.get('interpretation'))
                            self.store.event('guest_work',self.guest_actor,{'packet':packet['id'],'result':result})
                            break
                        except ValueError as exc:
                            self.store.event('guest_work_rejected',self.guest_actor,{'episode':self.episode,'packet':packet['id'],'attempt':attempt,'error':str(exc)})
                            if attempt==2:raise
                            await asyncio.sleep(.3)
                with self.store.connect() as db:
                    db.execute('BEGIN IMMEDIATE')
                    self.store.credit(db,self.guest_actor,-1,'Entry to the circle',f'entry:{self.round}:{self.guest_actor}')
                    db.execute('INSERT INTO entries VALUES(?,?)',(self.round,self.guest_actor))
            await self.guest.next_pressure(self.question,prefix)
            raw=probabilities(self.entity,'Q: '+self.question+'\nA: '+prefix)
            self.entity_weights={c:raw.get(c,0) for c in physics.ALLOWED}
            self.phase='contact'
            if first:self.started=time.time()
            self.message='Hold and push. Settle over a character to write it; release between repeated letters.'
            self.store.event('pressure',self.guest_actor,{'episode':self.episode,'prefix':prefix,'guest':self.guest.weights,'entity':self.entity_weights})
        except asyncio.CancelledError: raise
        except Exception as exc:
            self.guest.status='Connection interrupted'
            self.guest.error=str(exc)[:350] or type(exc).__name__
            self.guest.prefix=None
            self.phase='unavailable'
            self.message='The guest could not connect. Retry is free. If no guest has connected, Goodbye returns your entry token and puts the question back.'
            self.store.event('guest_error',self.guest_actor,{'episode':self.episode,'error':self.guest.error,'prefix':prefix})

    def refresh_soon(self, first=False):
        if not self.pressure_task or self.pressure_task.done():
            self.guest.error=None
            if first:
                self.phase='dialling'
                self.started=time.time()
                self.message='Calling the other side. Checking the guest’s entry and next-character response.'
            self.pressure_task=asyncio.create_task(self.refresh(first))

    async def loop(self):
        while True:
            started=time.monotonic()
            if self.phase in ('contact','dialling'):
                if time.time()-self.started>600:
                    self.finish('The ten-minute pilot circle has ended. Leave a reflection, then open another.')
                else:
                    contacts=self.human_contacts()
                    ready=self.phase=='contact' and self.guest.prefix==self.board['text'] and not self.guest.error and self.joined(self.guest_actor)
                    before=dict(self.board)
                    self.board,self.forces,emitted=physics.step(self.board,contacts,self.guest.weights,self.entity_weights,ready)
                    payload={'before':before,'dt':.05,'contacts':contacts,'llm':self.guest.weights,'entity':self.entity_weights,'ready':bool(ready),'state':dict(self.board),'forces':self.forces,'emitted':emitted}
                    self.frames.append((self.episode,self.seq,json.dumps(payload,allow_nan=False)))
                    self.seq+=1
                    if self.seq%20==0: self.flush()
                    if emitted:
                        with self.store.connect() as db: db.execute('UPDATE episodes SET transcript=? WHERE id=?',(self.board['text'],self.episode))
                        if emitted=='~': self.finish('GOODBYE. The line is closed. Decide what this encounter should teach.')
                        elif len(self.board['text'])>=120: self.finish('The 120-character pilot transmission is complete.')
                        else: self.refresh_soon()
            await self.broadcast()
            await asyncio.sleep(max(.001,.05-(time.monotonic()-started)))


def create_app(state=None, guest=None):
    store=Store(state or os.environ.get('CFI_STATE',HERE/'state'))
    work.seed_candidates(store)
    room=Room(store,guest)
    @asynccontextmanager
    async def lifespan(app):
        task=asyncio.create_task(room.loop())
        yield
        room.finish('The local server has stopped.')
        task.cancel()
        try: await task
        except asyncio.CancelledError: pass
        if room.pressure_task:
            room.pressure_task.cancel()
            try: await room.pressure_task
            except asyncio.CancelledError: pass
        if room.job_process and room.job_process.poll() is None:
            room.job_process.terminate()
            try: await asyncio.to_thread(room.job_process.wait,5)
            except subprocess.TimeoutExpired: room.job_process.kill()
    app=FastAPI(lifespan=lifespan)
    app.state.store=store
    app.state.room=room

    def actor(request):
        found=store.actor(request.cookies.get('cfi_session'))
        if not found: raise HTTPException(401,'Enter a name to take part.')
        return found

    def need_entry(request):
        a=actor(request)
        if not room.joined(a['id']): raise ValueError('Join this circle for one token first.')
        return a

    def idempotent(db, a, body, kind):
        value=body.get('request_id')
        if not isinstance(value,str) or not 8<=len(value)<=100: raise ValueError('A request identifier is required.')
        key=f'{kind}:{a["id"]}:{value}'
        old=db.execute('SELECT response FROM requests WHERE id=?',(key,)).fetchone()
        return key,json.loads(old['response']) if old else None

    @app.middleware('http')
    async def origins(request,call_next):
        if request.method not in ('GET','HEAD','OPTIONS'):
            origin=request.headers.get('origin')
            if origin and origin!=str(request.base_url).rstrip('/'):
                return JSONResponse({'error':'Use the app from the same origin.'},status_code=403)
            if request.headers.get('sec-fetch-site')=='cross-site':
                return JSONResponse({'error':'Cross-site request rejected.'},status_code=403)
        response=await call_next(request)
        response.headers['X-Content-Type-Options']='nosniff'
        response.headers['Referrer-Policy']='same-origin'
        response.headers['Content-Security-Policy']="default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'"
        if request.url.path.startswith('/api/'): response.headers['Cache-Control']='no-store'
        return response

    @app.exception_handler(ValueError)
    async def value_error(request,exc): return JSONResponse({'error':str(exc)},status_code=400)

    @app.get('/api/state')
    async def state_view(request:Request):
        a=store.actor(request.cookies.get('cfi_session'))
        return {'actor':a,'balance':store.balance(a['id']) if a else 0,'joined':bool(a and room.joined(a['id'])),
            'room':room.snapshot(),'notice':NOTICE,'models':model_history(store.root),'active_model':room.manifest['id'],
            'examples':store.one('SELECT COUNT(*) n FROM examples')['n'],
            'questions':store.rows('SELECT q.*,a.name FROM questions q JOIN actors a ON a.id=q.actor WHERE used=0 ORDER BY votes DESC,created LIMIT 40'),
            'jobs':store.rows('SELECT * FROM jobs ORDER BY created DESC LIMIT 5'),
            'episodes':store.rows('SELECT * FROM episodes ORDER BY created DESC LIMIT 10'),
            'ledger':store.rows('SELECT amount,reason,created FROM ledger WHERE actor=? ORDER BY id DESC LIMIT 12',(a['id'],)) if a else [],
            'interpretations':store.rows('SELECT c.id,c.body,a.answer,COUNT(*) n FROM candidates c JOIN annotations a ON c.id=a.candidate GROUP BY c.id,a.answer ORDER BY c.created LIMIT 100')}

    @app.post('/api/identity')
    async def identity(request:Request):
        old=store.actor(request.cookies.get('cfi_session'))
        if old: return old
        body=await request.json()
        name=str(body.get('name','')).strip()[:32]
        if not name: raise ValueError('Choose a name for the circle.')
        a,token=store.create_actor(name)
        response=JSONResponse(a)
        response.set_cookie('cfi_session',token,max_age=60*60*24*365,httponly=True,samesite='strict',secure=request.url.scheme=='https')
        return response

    @app.get('/api/work')
    async def work_get(request:Request): return work.issue(store,actor(request)['id'])

    @app.post('/api/work')
    async def work_post(request:Request):
        a=actor(request); b=await request.json()
        return work.submit(store,a['id'],b.get('id'),b.get('control'),b.get('interpretation'))

    @app.post('/api/teach')
    async def teach(request:Request):
        a=actor(request);b=await request.json()
        prompt=str(b.get('prompt','')).strip()
        choices=list(dict.fromkeys(str(c).strip()[:80] for c in b.get('choices',[]) if str(c).strip()))
        if not b.get('rights'): raise ValueError('Please acknowledge the contribution notice.')
        if not 8<=len(prompt)<=260 or not 2<=len(choices)<=4: raise ValueError('Use a question of 8–260 characters and 2–4 distinct choices.')
        choices=[c for c in choices if c!='UNCLEAR']+['UNCLEAR']
        cid=ident()
        with store.connect() as db:
            db.execute('INSERT INTO candidates VALUES(?,?,?,?,?)',(cid,prompt,json.dumps(choices),'Contributed by '+a['name'],time.time()))
        store.event('contribution',a['id'],{'candidate':cid,'notice':NOTICE})
        return {'id':cid}

    @app.post('/api/questions')
    async def question_post(request:Request):
        a=actor(request);b=await request.json();title=str(b.get('title','')).strip()
        if not 3<=len(title)<=160: raise ValueError('Questions need 3–160 characters.')
        with store.connect() as db:
            db.execute('BEGIN IMMEDIATE');key,old=idempotent(db,a,b,'question')
            if old: return old
            qid=ident();store.credit(db,a['id'],-1,'Proposed a question',key)
            db.execute('INSERT INTO questions VALUES(?,?,?,0,0,?)',(qid,a['id'],title,time.time()))
            result={'id':qid};db.execute('INSERT INTO requests VALUES(?,?,?)',(key,a['id'],json.dumps(result)))
        return result

    @app.post('/api/questions/{qid}/vote')
    async def vote(qid:str,request:Request):
        a=actor(request);b=await request.json()
        with store.connect() as db:
            db.execute('BEGIN IMMEDIATE');key,old=idempotent(db,a,b,'vote')
            if old:return old
            if not db.execute('SELECT 1 FROM questions WHERE id=? AND used=0',(qid,)).fetchone():raise ValueError('That question has already been called or is unavailable.')
            store.credit(db,a['id'],-1,'Voted on a question',key)
            db.execute('UPDATE questions SET votes=votes+1 WHERE id=?',(qid,))
            result={'voted':True};db.execute('INSERT INTO requests VALUES(?,?,?)',(key,a['id'],json.dumps(result)))
        return result

    @app.post('/api/room/join')
    async def join(request:Request):
        a=actor(request)
        if room.phase=='closed': raise ValueError('Open the next circle first.')
        with store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            if not db.execute('SELECT 1 FROM entries WHERE round=? AND actor=?',(room.round,a['id'])).fetchone():
                store.credit(db,a['id'],-1,'Entry to the circle',f'entry:{room.round}:{a["id"]}')
                db.execute('INSERT INTO entries VALUES(?,?)',(room.round,a['id']))
        return {'joined':True,'round':room.round}

    @app.post('/api/room/dial')
    async def dial(request:Request):
        a=need_entry(request)
        if room.phase!='idle': raise ValueError('This circle has already been dialled.')
        q=store.one('SELECT * FROM questions WHERE used=0 ORDER BY votes DESC,created LIMIT 1')
        room.question=q['title'] if q else 'WHAT SHOULD WE BECOME?'
        room.phase='dialling';room.started=time.time();room.episode=room.round;room.seq=0
        room.guest.error=None;room.guest.prefix=None;room.guest.weights={};room.entity_weights={}
        with store.connect() as db:
            if q: db.execute('UPDATE questions SET used=1 WHERE id=?',(q['id'],))
            db.execute('INSERT INTO episodes(id,question,model,status,created) VALUES(?,?,?,?,?)',(room.episode,room.question,room.manifest['id'],'contact',time.time()))
        store.event('dial',a['id'],{'episode':room.episode,'question':room.question,'question_id':q['id'] if q else None})
        room.message='Calling the other side. The guest must earn its entry before the line opens.'
        room.refresh_soon(first=True)
        return {'dialling':True}

    @app.post('/api/room/retry')
    async def retry(request:Request):
        need_entry(request)
        if room.phase not in ('contact','dialling','unavailable'):raise ValueError('Dial a circle first.')
        room.refresh_soon(first=True)
        return {'retrying':True}

    @app.post('/api/room/goodbye')
    async def goodbye(request:Request):
        need_entry(request);room.finish('A participant said goodbye. The line is closed.');return {'closed':True}

    @app.post('/api/room/new')
    async def new_circle(request:Request):
        actor(request)
        if room.phase!='closed':raise ValueError('Close the current circle first.')
        room.round=ident();room.board=physics.initial();room.phase='idle';room.episode=None
        room.forces=[];room.contacts={};room.entity_weights={};room.guest.weights={};room.guest.prefix=None
        room.guest.status='Not dialled';room.guest.error=None;room.message='A new circle. Each participant earns their place again.'
        return {'round':room.round}

    @app.post('/api/reflections')
    async def reflection(request:Request):
        a=actor(request);b=await request.json();eid=b.get('episode');verdict=b.get('verdict');note=str(b.get('note',''))[:400]
        if verdict not in ('keep','discard','contested'):raise ValueError('Choose keep, discard or contested.')
        ep=store.one('SELECT * FROM episodes WHERE id=? AND status IN (\'closed\',\'interrupted\')',(eid,))
        if not ep or not store.one('SELECT 1 FROM entries WHERE round=? AND actor=?',(eid,a['id'])):raise ValueError('Only participants can reflect on a completed circle.')
        with store.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            db.execute('INSERT INTO reflections VALUES(?,?,?,?,?) ON CONFLICT(episode,actor) DO UPDATE SET verdict=excluded.verdict,note=excluded.note,created=excluded.created',(eid,a['id'],verdict,note,time.time()))
            counts={r['verdict']:r['n'] for r in db.execute('SELECT verdict,COUNT(*) n FROM reflections WHERE episode=? GROUP BY verdict',(eid,))}
            # An objection keeps this out of the answer corpus. The encounter remains replayable.
            if counts.get('keep',0)>=2 and not counts.get('discard',0) and not counts.get('contested',0) and ep['transcript'].strip():
                db.execute('INSERT OR REPLACE INTO examples VALUES(?,?,?,?,?)',('episode:'+eid,ep['question'],ep['transcript'],'Approved encounter '+eid,time.time()))
            else: db.execute('DELETE FROM examples WHERE id=?',('episode:'+eid,))
        store.event('reflection',a['id'],{'episode':eid,'verdict':verdict,'note':note})
        return {'recorded':True,'votes':counts}

    @app.post('/api/train')
    async def train(request:Request):
        a=actor(request)
        if store.one("SELECT 1 FROM jobs WHERE status IN ('queued','running')"):raise ValueError('A candidate is already training.')
        records=store.rows('SELECT * FROM examples ORDER BY id')
        if len(records)<2:raise ValueError('Complete at least two work packets first.')
        jid=ident();folder=store.root/'jobs';folder.mkdir(exist_ok=True)
        (folder/f'{jid}.json').write_text(json.dumps(records,indent=2))
        with store.connect() as db:db.execute('INSERT INTO jobs(id,parent,status,created) VALUES(?,?,?,?)',(jid,room.manifest['id'],'queued',time.time()))
        try:
            with (folder/f'{jid}.log').open('w') as log:
                room.job_process=subprocess.Popen([sys.executable,'-m','cfi.train','--state',str(store.root),'--job',jid],cwd=HERE,stdout=log,stderr=subprocess.STDOUT)
        except Exception as exc:
            with store.connect() as db:db.execute("UPDATE jobs SET status='failed',error=? WHERE id=?",(str(exc),jid))
            raise
        store.event('training_requested',a['id'],{'job':jid,'examples':len(records)})
        return {'job':jid}

    @app.post('/api/models/{mid}/adopt')
    async def adopt(mid:str,request:Request):
        a=actor(request)
        if room.phase not in ('idle','closed'):raise ValueError('Close the circle before changing its entity.')
        entity,manifest=load_checkpoint(store.root,mid)
        previous=room.manifest['id'];room.entity,room.manifest=entity,manifest
        store.setting('active_model',mid)
        store.event('model_adopted',a['id'],{'previous':previous,'model':mid})
        return {'active_model':mid}

    @app.get('/api/models/{mid}/download')
    async def download(mid:str):
        _,manifest=load_checkpoint(store.root,mid)
        target=io.BytesIO()
        with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as z:
            for name in ('manifest.json','weights.safetensors'):z.write(store.root/'models'/mid/name,name)
            z.write(HERE/'cfi/model.py','model.py')
            z.writestr('predict.py',"import sys\nimport torch\nfrom safetensors.torch import load_file\nfrom model import TinyEntity, probabilities\nm=TinyEntity(); m.load_state_dict(load_file('weights.safetensors')); m.eval()\np=probabilities(m, ' '.join(sys.argv[1:]) or 'Q: WHAT SHOULD WE BECOME?\\nA: ')\nprint(sorted(p.items(),key=lambda x:-x[1])[:10])\n")
            z.writestr('README.txt','CFI character learner. Install torch, safetensors and numpy. Run: python predict.py "Q: YOUR QUESTION\nA: "\nThe origin is random. Training metrics describe a narrow task, not general intelligence.\n'+NOTICE+'\n')
        return Response(target.getvalue(),media_type='application/zip',headers={'Content-Disposition':f'attachment; filename="cfi-{mid}.zip"'})

    @app.get('/api/episodes/{eid}/replay')
    async def replay(eid:str):
        ep=store.one('SELECT * FROM episodes WHERE id=?',(eid,))
        if not ep:raise HTTPException(404,'No such encounter.')
        room.flush()
        frames=[json.loads(f['payload']) for f in store.rows('SELECT payload FROM frames WHERE episode=? ORDER BY seq',(eid,))]
        return {'episode':ep,'frames':frames,'reflections':store.rows('SELECT r.*,a.name FROM reflections r JOIN actors a ON a.id=r.actor WHERE episode=?',(eid,))}

    @app.websocket('/api/live')
    async def live(ws:WebSocket):
        origin=ws.headers.get('origin')
        expected=('https' if ws.url.scheme=='wss' else 'http')+'://'+ws.headers.get('host','')
        a=store.actor(ws.cookies.get('cfi_session'))
        if not a or (origin and origin!=expected):await ws.close(code=1008);return
        await ws.accept();room.clients[ws]={'actor':a}
        last_chat=0.;last_input=0.
        try:
            while True:
                raw=await ws.receive_text()
                if len(raw)>2048:await ws.close(code=1009);break
                try:b=json.loads(raw)
                except json.JSONDecodeError:continue
                if not isinstance(b,dict):continue
                now=time.monotonic()
                if b.get('type')=='push' and room.joined(a['id']):
                    if b.get('holding') and now-last_input<.025:continue
                    last_input=now
                    try:x,y=float(b['x']),float(b['y'])
                    except (ValueError,TypeError,KeyError):continue
                    if not math.isfinite(x+y):continue
                    room.contacts[a['id']]={'id':a['id'],'name':a['name'],'x':min(925,max(75,x)),'y':min(535,max(120,y)),'holding':bool(b.get('holding')),'seen':now}
                elif b.get('type')=='chat' and now-last_chat>1:
                    message=str(b.get('text','')).strip()[:180]
                    if message:
                        last_chat=now;room.chat.append({'id':a['id'],'name':a['name'],'text':message,'at':time.time()})
                        room.chat=room.chat[-30:];store.event('chat',a['id'],{'episode':room.episode,'text':message})
        except (WebSocketDisconnect,RuntimeError):pass
        finally:
            room.clients.pop(ws,None)
            if a['id'] in room.contacts:room.contacts[a['id']]['holding']=False

    app.mount('/',StaticFiles(directory=HERE/'web',html=True),name='web')
    return app

app=create_app()
