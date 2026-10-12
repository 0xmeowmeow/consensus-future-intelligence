"""New, grounded controls plus independently collected interpretations."""
import json
import random
import secrets
import time

def lesson(rng=None):
    rng = rng or random.SystemRandom()
    labels = rng.sample(list('ABCDEFGHJKLMNPQRSTUVWXYZ'), 4)
    a,b,c,d = labels
    templates = [
        (f'A KEY STARTS IN BOX {a}. IT MOVES TO BOX {b}. IT THEN MOVES TO BOX {c}. WHERE IS THE KEY?', c),
        (f'A KEY IS IN BOX {a}. BOX {b} IS EMPTY. A COIN MOVES TO BOX {c}. WHERE IS THE KEY?', a),
        (f'BOX {a} IS INSIDE BOX {b}. BOX {b} IS INSIDE BOX {c}. WHICH BOX DIRECTLY CONTAINS BOX {a}?', b),
        (f'A KEY STARTS IN BOX {d}. IT MOVES TO BOX {a}. IT RETURNS TO BOX {d}. WHERE IS THE KEY?', d),
    ]
    prompt, answer = rng.choice(templates)
    rng.shuffle(labels)
    return {'prompt': prompt, 'answer': answer, 'choices': labels}

def seed_candidates(store):
    if store.one('SELECT id FROM candidates LIMIT 1'): return
    rng = random.Random(801)
    with store.connect() as db:
        for i in range(32):
            item = lesson(rng)
            db.execute('INSERT INTO candidates VALUES(?,?,?,?,?)', (f'origin-{i}', item['prompt'], json.dumps(item['choices']+['UNCLEAR']), 'Original prototype task; votes establish an interpretation.', time.time()))
        db.execute('INSERT INTO candidates VALUES(?,?,?,?,?)', ('ambiguous-1','ALEX TOLD ROBIN THAT THEY HAD THE KEY. WHO HAS THE KEY?',json.dumps(['ALEX','ROBIN','UNCLEAR']), 'Original ambiguity task. Disagreement is retained.',time.time()))

def issue(store, actor):
    old = store.one('SELECT * FROM packets WHERE actor=? AND submitted=0 ORDER BY created DESC LIMIT 1',(actor,))
    if old: return public_packet(store, old)
    rows = store.rows('SELECT * FROM candidates WHERE id NOT IN (SELECT candidate FROM annotations WHERE actor=?) ORDER BY created',(actor,))
    if not rows: raise ValueError('You have reviewed every available item. Submit a new teaching question or return when another person adds one.')
    # Small groups see the same candidates before the queue expands.
    candidate = rows[0]
    control = lesson()
    packet = {'id':secrets.token_hex(12),'actor':actor,'candidate':candidate['id'],'control':control['prompt'],'answer':control['answer'],'choices':json.dumps(control['choices']),'created':time.time()}
    with store.connect() as db:
        db.execute('INSERT INTO packets(id,actor,candidate,control,answer,choices,created) VALUES(:id,:actor,:candidate,:control,:answer,:choices,:created)', packet)
    return public_packet(store, packet)

def public_packet(store, packet):
    candidate=store.one('SELECT * FROM candidates WHERE id=?',(packet['candidate'],))
    return {'id':packet['id'],'control':{'prompt':packet['control'],'choices':json.loads(packet['choices'])},'candidate':{'id':candidate['id'],'prompt':candidate['body'],'choices':json.loads(candidate['choices']),'source':candidate['source']}}

def submit(store, actor, packet_id, control_answer, answer):
    with store.connect() as db:
        db.execute('BEGIN IMMEDIATE')
        row=db.execute('SELECT * FROM packets WHERE id=? AND actor=?',(packet_id,actor)).fetchone()
        if not row: raise ValueError('Work packet not found.')
        if row['submitted']: return {'earned':0,'already_submitted':True,'balance':store.balance_db(db,actor)}
        if control_answer != row['answer']: raise ValueError('The control does not match the recorded movements. Check it and try again; no tokens were spent.')
        candidate=db.execute('SELECT * FROM candidates WHERE id=?',(row['candidate'],)).fetchone()
        if answer not in json.loads(candidate['choices']): raise ValueError('Choose an interpretation, including UNCLEAR if needed.')
        db.execute('INSERT INTO annotations(actor,candidate,answer,created) VALUES(?,?,?,?)',(actor,row['candidate'],answer,time.time()))
        db.execute('UPDATE packets SET submitted=1 WHERE id=?',(packet_id,))
        store.credit(db,actor,1,'Checked work packet',f'work:{packet_id}')
        # The control is retired immediately. Future controls are generated afresh.
        db.execute('INSERT INTO examples VALUES(?,?,?,?,?)',(f'control:{packet_id}',row['control'],row['answer'],'Verified movement record, checked by '+actor,time.time()))
        votes=db.execute('SELECT answer,COUNT(*) n FROM annotations WHERE candidate=? GROUP BY answer ORDER BY n DESC',(row['candidate'],)).fetchall()
        total=sum(v['n'] for v in votes)
        best=votes[0]
        accepted=best['n']>=2 and best['n']/total>=.75 and best['answer']!='UNCLEAR'
        if accepted:
            db.execute('INSERT INTO examples VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET answer=excluded.answer,source=excluded.source',(f'consensus:{row["candidate"]}',candidate['body'],best['answer'],f'Provisional consensus: {best["n"]}/{total}; candidate {row["candidate"]}',time.time()))
        else:
            db.execute('DELETE FROM examples WHERE id=?',(f'consensus:{row["candidate"]}',))
        return {'earned':1,'balance':store.balance_db(db,actor),'distribution':[dict(v) for v in votes],'accepted':accepted,'message':'Your control became a training example. The new interpretation is recorded, including disagreement.'}
