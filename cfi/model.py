"""A genuinely random-born character learner, independent of the guest LLM."""
import hashlib
import json
import time
from pathlib import Path
import torch
from torch import nn
from safetensors.torch import load_file, save_file

ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 .,?!:;'-\n"
VOCAB = ['<PAD>', '<START>'] + list(ALPHABET)
INDEX = {s:i for i,s in enumerate(VOCAB)}
CONFIG = {'embedding':32, 'hidden':96, 'layers':2, 'vocabulary':VOCAB, 'architecture':'character-gru-v1'}
torch.set_num_threads(2)

def encode(text):
    return [1]+[INDEX.get(c,INDEX[' ']) for c in text.upper()]

class TinyEntity(nn.Module):
    def __init__(self):
        super().__init__()
        self.embedding=nn.Embedding(len(VOCAB),32,padding_idx=0)
        self.recurrence=nn.GRU(32,96,num_layers=2,batch_first=True)
        self.output=nn.Linear(96,len(VOCAB))

    def forward(self, ids):
        hidden,_=self.recurrence(self.embedding(ids))
        return self.output(hidden)

def save_checkpoint(root, model, parent=None, details=None):
    root=Path(root)/'models'
    root.mkdir(exist_ok=True,parents=True)
    temp=root/('pending-'+str(time.time_ns())+'.safetensors')
    save_file({k:v.detach().cpu().contiguous() for k,v in model.state_dict().items()},str(temp))
    digest=hashlib.sha256(temp.read_bytes()).hexdigest()
    ident=('generation-' if parent else 'origin-')+digest[:16]
    dest=root/ident
    dest.mkdir(exist_ok=True)
    temp.replace(dest/'weights.safetensors')
    manifest={'id':ident,'parent':parent,'sha256':digest,'created':time.time(),'parameters':sum(p.numel() for p in model.parameters()),'config':CONFIG,'seed':1729 if not parent else None,'training':details or None}
    (dest/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    return manifest

def ensure_origin(root):
    for path in (Path(root)/'models').glob('origin-*/manifest.json'):
        return json.loads(path.read_text())
    with torch.random.fork_rng():
        torch.manual_seed(1729)
        model=TinyEntity()
    return save_checkpoint(root,model)

def load_checkpoint(root, ident):
    if not ident or any(c not in 'abcdefghijklmnopqrstuvwxyz0123456789-' for c in ident): raise ValueError('Invalid checkpoint.')
    path=Path(root)/'models'/ident
    manifest=json.loads((path/'manifest.json').read_text())
    if hashlib.sha256((path/'weights.safetensors').read_bytes()).hexdigest()!=manifest['sha256']:
        raise ValueError('Checkpoint digest does not match its manifest.')
    model=TinyEntity()
    model.load_state_dict(load_file(str(path/'weights.safetensors')))
    model.eval()
    return model,manifest

@torch.inference_mode()
def probabilities(model, text):
    ids=torch.tensor([encode(text)[-384:]],dtype=torch.long)
    probs=torch.softmax(model(ids)[0,-1],dim=-1).tolist()
    return {char:probs[i] for i,char in enumerate(VOCAB) if i>1}

def model_history(root):
    return sorted([json.loads(p.read_text()) for p in (Path(root)/'models').glob('*/manifest.json')],key=lambda m:m['created'],reverse=True)
