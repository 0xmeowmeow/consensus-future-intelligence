"""Bounded training jobs; frozen input records and independent before/after probes."""
import argparse
import json
import random
import time
import traceback
from pathlib import Path
import torch
from torch import nn
from .model import encode, probabilities, load_checkpoint, save_checkpoint
from .storage import Store
from .work import lesson

def render(example): return 'Q: '+example['prompt'].upper()+'\nA: '+example['answer'].upper()+'\n'

def evaluate(model, probes):
    good=0
    nll=0.
    with torch.inference_mode():
        for p in probes:
            distribution=probabilities(model,'Q: '+p['prompt']+'\nA: ')
            prediction=max(p['choices'],key=lambda c:distribution.get(c,0))
            good+=prediction==p['answer']
            mass=sum(distribution.get(c,0) for c in p['choices'])
            import math
            nll-=math.log(max(1e-12,distribution[p['answer']]/mass))
    return {'correct':good,'total':len(probes),'accuracy':good/len(probes),'choice_nll':nll/len(probes)}

def train_job(root, ident, steps=160):
    store=Store(root)
    job=store.one('SELECT * FROM jobs WHERE id=?',(ident,))
    if not job: raise ValueError('Unknown job')
    try:
        with store.connect() as db: db.execute('UPDATE jobs SET status=? WHERE id=?',('running',ident))
        records=json.loads((Path(root)/'jobs'/f'{ident}.json').read_text())
        if len(records)<2: raise ValueError('Complete at least two work packets first.')
        model,parent=load_checkpoint(root,job['parent'])
        # These generated probes are never added to the training examples.
        rng=random.Random(80491)
        probes=[lesson(rng) for _ in range(24)]
        training_prompts={r['prompt'] for r in records}
        probes=[p for p in probes if p['prompt'] not in training_prompts]
        before=evaluate(model,probes)
        torch.manual_seed(733)
        rng=random.Random(733)
        batches=[encode(render(r))[:384] for r in records]
        optimizer=torch.optim.AdamW(model.parameters(),lr=.002)
        model.train()
        started=time.time()
        losses=[]
        for step in range(steps):
            chosen=[rng.choice(batches) for _ in range(8)]
            width=max(len(x) for x in chosen)-1
            x=torch.zeros((8,width),dtype=torch.long)
            y=torch.zeros((8,width),dtype=torch.long)
            for i,s in enumerate(chosen):
                x[i,:len(s)-1]=torch.tensor(s[:-1])
                y[i,:len(s)-1]=torch.tensor(s[1:])
            optimizer.zero_grad(set_to_none=True)
            logits=model(x)
            loss=nn.functional.cross_entropy(logits.reshape(-1,logits.shape[-1]),y.reshape(-1),ignore_index=0)
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(),1.)
            optimizer.step()
            losses.append(float(loss.detach()))
            if step%8==0:
                with store.connect() as db: db.execute('UPDATE jobs SET progress=? WHERE id=?',((step+1)/steps,ident))
        model.eval()
        after=evaluate(model,probes)
        details={'job':ident,'steps':steps,'examples':len(records),'example_ids':[r['id'] for r in records],'before':before,'after':after,'loss_start':losses[0],'loss_end':losses[-1],'seconds':time.time()-started,'method':'Character next-token prediction on reviewed examples; AdamW, lr 0.002, batch 8. Optimizer restarts per candidate.','evaluation':'24 fixed, generated movement/containment questions; overlap with training removed. This measures a narrow task, not general alignment.'}
        manifest=save_checkpoint(root,model,parent['id'],details)
        with store.connect() as db: db.execute('UPDATE jobs SET status=?,progress=1,result=? WHERE id=?',('complete',manifest['id'],ident))
        store.event('checkpoint_created',None,manifest)
        print(json.dumps(manifest),flush=True)
        return manifest
    except Exception as exc:
        with store.connect() as db: db.execute('UPDATE jobs SET status=?,error=? WHERE id=?',('failed',str(exc)[:800],ident))
        traceback.print_exc()
        raise

if __name__=='__main__':
    p=argparse.ArgumentParser()
    p.add_argument('--state',required=True)
    p.add_argument('--job',required=True)
    args=p.parse_args()
    train_job(args.state,args.job)
