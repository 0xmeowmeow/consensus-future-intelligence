"""A separate, random-born byte transformer whose small internals can be seen.

This never replaces the original GRU or claims to expose the guest LLMs' heads.
"""
import hashlib
import json
import math
import threading
from pathlib import Path
import torch
from torch import nn
from safetensors.torch import save_file, load_file

CONFIG = {'architecture': 'cfi-byte-transformer-v2', 'width': 64, 'heads': 4, 'layers': 3,
          'context': 1024, 'vocabulary': 258, 'seed': 1996}
torch.set_num_threads(2)


def encode(text):
    return [256] + list(text.encode('utf-8'))


def label(token):
    if token == 256: return 'START'
    if token == 257: return 'PAD'
    if token == 32: return 'SPACE'
    if token == 10: return '↵'
    if 33 <= token <= 126: return chr(token)
    return f'0x{token:02x}'


class Block(nn.Module):
    def __init__(self):
        super().__init__()
        self.norm = nn.LayerNorm(64)
        self.qkv = nn.Linear(64, 192)
        self.proj = nn.Linear(64, 64)
        self.norm2 = nn.LayerNorm(64)
        self.ff = nn.Sequential(nn.Linear(64, 128), nn.GELU(), nn.Linear(128, 64))

    def forward(self, x):
        b, t, d = x.shape
        q, k, v = self.qkv(self.norm(x)).chunk(3, dim=-1)
        q, k, v = [a.view(b, t, 4, 16).transpose(1, 2) for a in (q, k, v)]
        scores = q @ k.transpose(-2, -1) / 4
        scores = scores.masked_fill(torch.triu(torch.ones(t, t, device=x.device, dtype=torch.bool), 1), float('-inf'))
        attention = scores.softmax(-1)
        x = x + self.proj((attention @ v).transpose(1, 2).contiguous().view(b, t, d))
        x = x + self.ff(self.norm2(x))
        return x, attention


class Seed(nn.Module):
    def __init__(self):
        super().__init__()
        self.embedding = nn.Embedding(258, 64, padding_idx=257)
        self.position = nn.Embedding(CONFIG['context'], 64)
        self.layers = nn.ModuleList([Block() for _ in range(3)])
        self.norm = nn.LayerNorm(64)
        self.readout = nn.Linear(64, 258)

    def forward(self, ids, inspect=False):
        x = self.embedding(ids) + self.position(torch.arange(ids.shape[1], device=ids.device))
        heads, states = [], []
        for layer in self.layers:
            x, a = layer(x)
            if inspect:
                heads.append(a)
                states.append(x)
        logits = self.readout(self.norm(x))
        return (logits, heads, states) if inspect else logits


class SeedLab:
    def __init__(self, root):
        self.root = Path(root) / 'seed-v2'
        self.root.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()
        with torch.random.fork_rng():
            torch.manual_seed(CONFIG['seed'])
            model = Seed()
        self.parameters = sum(p.numel() for p in model.parameters())
        origin = self.root / 'origin.safetensors'
        if not origin.exists():
            save_file(model.state_dict(), str(origin))
            (self.root / 'origin.json').write_text(json.dumps({'config': CONFIG, 'parameters': self.parameters,
                'sha256': hashlib.sha256(origin.read_bytes()).hexdigest(), 'parent': None}, indent=2))

    def load(self, checkpoint='origin'):
        if checkpoint != 'origin' and (not checkpoint.startswith('candidate-') or not checkpoint[10:].isalnum()):
            raise ValueError('Unknown seed checkpoint.')
        path = self.root / (checkpoint + '.safetensors')
        if not path.is_file():
            raise ValueError('This seed checkpoint is not available in this local experiment.')
        model = Seed()
        model.load_state_dict(load_file(str(self.root / (checkpoint + '.safetensors'))))
        model.eval()
        return model

    def inspect(self, text, checkpoint='origin', target=None):
        if not isinstance(text, str) or target is not None and not isinstance(target, str):
            raise ValueError('Use exact text for the prompt and target.')
        if len(text.encode('utf-8')) > 1023:
            raise ValueError('The seed sees at most 1023 UTF-8 bytes. Choose an exact shorter passage; nothing was silently cropped.')
        with self.lock:
            model = self.load(checkpoint)
            ids = torch.tensor([encode(text)])
            with torch.no_grad():
                logits, heads, states = model(ids, inspect=True)
                p = logits[0, -1].softmax(-1)
                top = torch.topk(p, 16)
                attention = [h[0, :, -1, :].tolist() for h in heads]
                # These are the actual 64 activation coordinates, not labelled concepts.
                activations = [s[0, -1].tolist() for s in states]
            result = {'config': CONFIG, 'parameters': self.parameters, 'checkpoint': checkpoint, 'text': text,
                      'bytes': [{'id': i, 'label': label(i)} for i in encode(text)], 'attention': attention,
                      'activations': activations, 'next': [{'token': int(i), 'label': label(int(i)), 'p': float(v)} for v, i in zip(top.values, top.indices)],
                      'measurement': 'Actual final-position attention per layer and head, residual activations, and next-byte softmax from this seed checkpoint.'}
            if target is not None:
                target_bytes = list(target.encode('utf-8'))
                if not target_bytes or len(encode(text)) + len(target_bytes) > 1024:
                    raise ValueError('Prompt and target must fit in the seed context (1023 UTF-8 bytes).')
                seq = encode(text) + target_bytes
                x, y = torch.tensor([seq[:-1]]), torch.tensor([seq[1:]])
                out = model(x)
                start = len(encode(text)) - 1
                loss = nn.functional.cross_entropy(out[:, start:].reshape(-1, 258), y[:, start:].reshape(-1))
                model.zero_grad()
                loss.backward()
                gradients = []
                for name, param in model.named_parameters():
                    g = param.grad
                    if g is not None:
                        gradients.append({'name': name, 'shape': list(g.shape), 'norm': float(g.norm()),
                                          'mean_abs': float(g.abs().mean()), 'max_abs': float(g.abs().max())})
                result['gradient'] = {'loss': float(loss.detach()), 'target': target, 'objective': 'Mean negative log likelihood of the exact target bytes, conditioned on the exact prompt.',
                                      'parameters': gradients, 'weights_changed': False}
            return result

    def train(self, prompt, target, steps=80):
        if not target.strip():
            raise ValueError('Choose exact target text.')
        if len(encode(prompt)) + len(target.encode('utf-8')) > 1024:
            raise ValueError('Prompt and target must fit in 1023 UTF-8 bytes. Nothing was truncated.')
        with self.lock:
            model = self.load()
            seq = encode(prompt) + list(target.encode('utf-8'))
            x, y = torch.tensor([seq[:-1]]), torch.tensor([seq[1:]])
            start = len(encode(prompt)) - 1
            def objective():
                return nn.functional.cross_entropy(model(x)[:, start:].reshape(-1, 258), y[:, start:].reshape(-1))
            with torch.no_grad(): before = float(objective())
            optimizer = torch.optim.AdamW(model.parameters(), lr=.001)
            losses = []
            model.train()
            for _ in range(steps):
                optimizer.zero_grad()
                loss = objective()
                loss.backward()
                nn.utils.clip_grad_norm_(model.parameters(), 1.)
                optimizer.step()
                losses.append(float(loss.detach()))
            model.eval()
            with torch.no_grad(): after = float(objective())
            record = {'prompt': prompt, 'target': target, 'steps': steps, 'before_nll': before, 'after_nll': after,
                      'losses': losses, 'parent': 'origin', 'config': CONFIG, 'parameters': self.parameters,
                      'meaning': 'This measures fitting this exact example, not understanding or generalisation. The origin remains unchanged.'}
            raw = json.dumps(record, ensure_ascii=False, sort_keys=True).encode()
            key = 'candidate-' + hashlib.sha256(raw).hexdigest()[:16]
            save_file(model.state_dict(), str(self.root / (key + '.safetensors')))
            record['id'] = key
            record['sha256'] = hashlib.sha256((self.root / (key + '.safetensors')).read_bytes()).hexdigest()
            (self.root / (key + '.json')).write_text(json.dumps(record, ensure_ascii=False, indent=2))
            return record


def contribution_example(room, node_id):
    """Carry exact authored meaning into an explicit experiment, including ancestry."""
    by_id={n['id']:n for n in room['nodes']}
    if node_id not in by_id:
        raise ValueError('That contribution is not in this encounter.')
    node=by_id[node_id]
    ancestors=[];parent=node.get('parent');seen={node_id}
    while parent:
        if parent in seen or parent not in by_id:
            raise ValueError('The contribution has an invalid parent chain.')
        seen.add(parent);ancestor=by_id[parent];ancestors.append(ancestor);parent=ancestor.get('parent')
    ancestors.reverse()
    sections=['QUESTION\n'+room['question']]
    for ancestor in ancestors:
        sections.append('PARENT CONTRIBUTION ('+ancestor['kind']+')\n'+ancestor['text'])
    sections.append('NEXT CONTRIBUTION ('+node['kind']+')\n')
    prompt='\n\n'.join(sections);target=node['text'];length=len((prompt+target).encode('utf-8'))
    return {'prompt':prompt,'target':target,'bytes':length,'fits':length<=CONFIG['context']-1,
            'source':{'encounter':room['id'],'contribution':node_id,'parents':[n['id'] for n in ancestors]},
            'meaning':'An individual proposed experiment, not collective endorsement. The exact question and ancestor text are included in the training prompt.'}
