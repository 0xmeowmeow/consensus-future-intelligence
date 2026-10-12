"""Inspect a small pretrained guest through actual tensors and interventions.

Read-only weights. Attention is measured; ablation is a fresh forward pass.
The model is separate from the three Ollama guests and from the random seed.
"""
import os
import hashlib
import importlib.util
import threading
import time
from pathlib import Path
import torch

MODEL = 'HuggingFaceTB/SmolLM2-135M-Instruct'
REVISION = '12fd25f77366fa6b3b4b768ec3050bf629380bac'
WEIGHTS_SHA256 = '5af571cbf074e6d21a03528d2330792e532ca608f24ac70a143f6b369968ab8c'
DEFAULT_PATH = '/home/meow/data/machine/ai/models/huggingface/SmolLM2-135M-Instruct'


class Glass:
    def __init__(self):
        self.lock = threading.Lock()
        self.model = self.tokenizer = None
        self.path = Path(os.environ.get('CFI_GLASS_MODEL', DEFAULT_PATH))

    def available(self):
        return (self.path/'model.safetensors').exists() and importlib.util.find_spec('transformers') is not None

    def load(self):
        if self.model is not None: return
        if not self.available():
            raise ValueError('The optional inspection model or runtime is not installed. The encounter and seed remain available.')
        with (self.path/'model.safetensors').open('rb') as f:
            self.weights_sha256 = hashlib.file_digest(f, 'sha256').hexdigest()
        if self.weights_sha256 != WEIGHTS_SHA256:
            raise ValueError('These inspection weights do not match the pinned SmolLM2 revision. Restore the optional model with install-inspection-model.py.')
        import transformers
        self.runtime = {'torch':torch.__version__, 'transformers':transformers.__version__, 'dtype':'float32', 'device':'cpu', 'attention_implementation':'eager'}
        self.artifacts = {}
        for name in ('config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','merges.txt','vocab.json'):
            path=self.path/name
            if path.is_file():
                with path.open('rb') as f:self.artifacts[name]=hashlib.file_digest(f,'sha256').hexdigest()
        from transformers import AutoModelForCausalLM, AutoTokenizer
        self.tokenizer = AutoTokenizer.from_pretrained(str(self.path), local_files_only=True, trust_remote_code=False)
        self.model = AutoModelForCausalLM.from_pretrained(str(self.path), local_files_only=True, trust_remote_code=False,
                                                        dtype=torch.float32, attn_implementation='eager')
        self.model.eval()
        for parameter in self.model.parameters(): parameter.requires_grad_(False)

    def inputs(self, question, prefix):
        if not isinstance(question, str) or not question.strip() or len(question) > 1200:
            raise ValueError('Use a question of 1–1200 characters.')
        if not isinstance(prefix, str) or len(prefix) > 1200:
            raise ValueError('Use a continuation prefix of at most 1200 characters.')
        messages = [{'role':'system','content':'You are a participant in a collective encounter. Answer the question precisely and preserve meaningful conditions.'},
                    {'role':'user','content':question}]
        text = self.tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True) + prefix
        ids = self.tokenizer.encode(text, add_special_tokens=False)
        if len(ids) > 192:
            raise ValueError('This inspection allows at most 192 input tokens. Shorten the question or prefix explicitly; no text was cropped.')
        return torch.tensor([ids]), text

    def token(self, i):
        return self.tokenizer.decode([int(i)], clean_up_tokenization_spaces=False)

    def top(self, probs, count=24):
        values, indices = probs.topk(count)
        return [{'id':int(i), 'text':self.token(i), 'p':float(v)} for v,i in zip(values,indices)]

    def inspect(self, question, prefix='', layer=15, head=None, target_token=None):
        with self.lock:
            self.load()
            if not isinstance(layer, int) or isinstance(layer, bool) or not 0 <= layer < 30:
                raise ValueError('Select layer 1–30.')
            if head is not None and (not isinstance(head,int) or isinstance(head,bool) or not 0 <= head < 9):
                raise ValueError('Select head 1–9.')
            ids, exact_input = self.inputs(question, prefix)
            started=time.monotonic()
            with torch.no_grad():
                result = self.model(ids, use_cache=False, output_attentions=True, output_hidden_states=True)
                p = result.logits[0,-1].softmax(-1)
                attention = [a[0,:,-1,:].float().tolist() for a in result.attentions]
                # Measure the RMS residual update per layer and token position.
                changes = []
                for i in range(30):
                    a,b = result.hidden_states[i],result.hidden_states[i+1]
                    changes.append((b[0]-a[0]).square().mean(-1).sqrt().tolist())
                residual = result.hidden_states[layer+1][0,-1].float().tolist()
                baseline = self.top(p)
            output = {'model':MODEL,'revision':REVISION,'weights_sha256':self.weights_sha256,'artifact_sha256':self.artifacts,'runtime':self.runtime,'parameters':sum(p.numel() for p in self.model.parameters()),
                      'question':question,'prefix':prefix,'exact_input':exact_input,'layer':layer,'head':head,
                      'tokens':[{'id':int(i),'text':self.token(i)} for i in ids[0]],'attention':attention,
                      'residual_update_rms':changes,'residual':residual,'next':baseline,'layers':30,'heads':9,
                      'measurement':'Actual last-position attention in all layers; final next-token softmax. Residual update at the final layer includes final RMS normalization.',
                      'weights_changed':False}
            if head is not None:
                # The input to o_proj is the concatenation of individual head
                # outputs. Zero only this head at the final sequence position.
                width = self.model.config.hidden_size // self.model.config.num_attention_heads
                def mute(module, args):
                    value=args[0].clone()
                    value[:,-1,head*width:(head+1)*width]=0
                    return (value,) + args[1:]
                handle=self.model.model.layers[layer].self_attn.o_proj.register_forward_pre_hook(mute)
                try:
                    with torch.no_grad():
                        muted = self.model(ids,use_cache=False).logits[0,-1].softmax(-1)
                finally: handle.remove()
                delta=p-muted
                _, greatest=delta.abs().topk(16)
                output['ablation']={'layer':layer,'head':head,'method':'Zero this attention head output at the final token position before the output projection; all weights and other inputs unchanged.',
                    'changed':[{'id':int(i),'text':self.token(i),'baseline_p':float(p[i]),'muted_p':float(muted[i]),'difference':float(delta[i])} for i in greatest],
                    'total_variation':float((p-muted).abs().sum()/2),'next':self.top(muted)}
            if target_token is not None:
                if not isinstance(target_token,int) or isinstance(target_token,bool) or not 0 <= target_token < self.model.config.vocab_size:
                    raise ValueError('Choose an actual token ID from this model.')
                retained={}
                def capture(module,args,value):
                    retained['state']=value
                handle=self.model.model.layers[layer].register_forward_hook(capture)
                try:
                    embeddings=self.model.get_input_embeddings()(ids).detach().requires_grad_(True)
                    scores=self.model(inputs_embeds=embeddings,use_cache=False).logits[0,-1]
                    loss=-scores.log_softmax(-1)[target_token]
                    grad=torch.autograd.grad(loss,retained['state'])[0][0,-1].detach()
                finally: handle.remove()
                output['gradient']={'target_token':target_token,'target_text':self.token(target_token),'loss':float(loss.detach()),
                    'tensor':f'layer {layer+1} output, final token, 576 residual coordinates','values':grad.tolist(),'norm':float(grad.norm()),
                    'objective':'Negative log likelihood of the selected next token. This is a derivative with respect to an activation vector; no parameter update.'}
            output['seconds']=time.monotonic()-started
            return output
