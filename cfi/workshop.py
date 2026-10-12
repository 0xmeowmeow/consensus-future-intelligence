"""Measured transformer instruments plus an explicitly separate, editable byte-BPE toy."""
from collections import Counter
import hashlib
import json
import time
import torch
from .glass import MODEL, REVISION


def integer(value, low, high, name):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError(f'{name} must be an integer from {low} to {high}.')
    return value


def byte_bpe(text, corpus, count=12, merges=None):
    """No normalisation/pretokenization: deterministic adjacent UTF-8 byte pair merges."""
    if not isinstance(text, str) or not text or len(text.encode('utf-8')) > 6000:
        raise ValueError('Use 1–6000 UTF-8 bytes of sample text.')
    if not isinstance(corpus, str) or not corpus or len(corpus.encode('utf-8')) > 16000:
        raise ValueError('Use 1–16000 UTF-8 bytes of training corpus.')
    integer(count, 0, 64, 'Merge count')
    vocab = {i: bytes([i]) for i in range(256)}
    training = list(corpus.encode('utf-8'))
    rules, history = [], []
    if merges is not None and (not isinstance(merges, list) or len(merges) > 64):
        raise ValueError('Supply at most 64 merge pairs as a JSON array.')
    def merge(sequence, pair, token):
        result=[]; i=0
        while i<len(sequence):
            if i+1<len(sequence) and (sequence[i],sequence[i+1])==pair:
                result.append(token); i+=2
            else:result.append(sequence[i]); i+=1
        return result
    for rank in range(len(merges) if merges is not None else count):
        counts=Counter(zip(training, training[1:]))
        if merges is None:
            if not counts:break
            pair = min(counts, key=lambda p: (-counts[p], p))
        else:
            pair=merges[rank]
            if not isinstance(pair, list) or len(pair)!=2 or any(isinstance(i,bool) or not isinstance(i,int) or i not in vocab for i in pair):
                raise ValueError(f'Merge {rank+1} must reference two byte IDs or earlier merge IDs.')
            pair=tuple(pair)
            if pair in rules:raise ValueError('A merge pair cannot be repeated.')
        token=256+rank; vocab[token]=vocab[pair[0]]+vocab[pair[1]]
        before=len(training); training=merge(training,pair,token); rules.append(pair)
        history.append({'rank':rank,'id':token,'pair':list(pair),'occurrences':counts.get(pair,0),
                        'before':before,'after':len(training),'bytes':list(vocab[token]),'text':vocab[token].decode('utf-8', errors='replace')})
    sample=list(text.encode('utf-8')); stages=[sample]
    for rank,pair in enumerate(rules):
        sample=merge(sample,pair,256+rank); stages.append(sample)
    offset=0; pieces=[]
    for token in sample:
        raw=vocab[token]; pieces.append({'id':token,'bytes':list(raw),'text':raw.decode('utf-8',errors='replace'),'byte_start':offset,'byte_end':offset+len(raw)}); offset+=len(raw)
    decoded=b''.join(vocab[i] for i in sample).decode('utf-8')
    return {'kind':'computed toy: byte BPE', 'text':text,'corpus':corpus,'merges':[list(p) for p in rules],
            'history':history,'stages':stages,'tokens':pieces,'decoded':decoded,'roundtrip':decoded==text,
            'vocabulary_size':len(vocab),'format':'cfi-byte-bpe-1','normalization':'none','pretokenization':'none',
            'compatibility':'Independent tokenizer. These IDs do not address the pretrained model embeddings. Training this tokenizer does not train a language model.'}


class Workshop:
    def __init__(self, glass):self.glass=glass

    def manifest(self):
        g=self.glass
        return {'model':MODEL,'revision':REVISION,'weights_sha256':g.weights_sha256,
                'artifact_sha256':g.artifacts,'runtime':g.runtime,'weights_changed':False}

    def tokenize(self, text, corpus=None, count=12, merges=None):
        if not isinstance(text,str) or not text or len(text.encode('utf-8'))>6000:
            raise ValueError('Use 1–6000 UTF-8 bytes of exact text.')
        with self.glass.lock:
            g=self.glass;g.load()
            encoded=g.tokenizer(text,add_special_tokens=False,return_offsets_mapping=True)
            tokens=[]
            for i,span in zip(encoded['input_ids'],encoded['offset_mapping']):
                a,b=span
                tokens.append({'id':i,'piece':g.tokenizer.convert_ids_to_tokens(i),'text':g.token(i),
                               'start':a,'end':b,'source':text[a:b],
                               'byte_start':len(text[:a].encode('utf-8')),'byte_end':len(text[:b].encode('utf-8'))})
            result={**self.manifest(),'kind':'measured tokenizer','text':text,'tokens':tokens,
                    'decoded':g.tokenizer.decode(encoded['input_ids'],clean_up_tokenization_spaces=False),
                    'pipeline':json.loads(g.tokenizer.backend_tokenizer.to_str()),
                    'offset_note':'Offsets refer to Unicode code points in the input. Byte-fallback tokens may overlap the same character span. A token alone may decode as a replacement character; the complete sequence is the round-trip test.'}
            # The complete vocabulary is already available as a pinned local artifact.
            result['pipeline']['model']={k:v for k,v in result['pipeline']['model'].items() if k not in ('vocab','merges')}
            result['roundtrip']=result['decoded']==text
        result['toy']=byte_bpe(text, corpus if corpus is not None else text, count, merges)
        return result

    def inspect(self, question, prefix='', layer=0, steps=3, append_ids=None):
        integer(layer,0,29,'Layer');integer(steps,1,8,'Decode steps')
        if append_ids is not None and (not isinstance(append_ids,list) or not 1<=len(append_ids)<=8):
            raise ValueError('Supply 1–8 exact token IDs, or leave them automatic.')
        with self.glass.lock, torch.no_grad():
            g=self.glass;g.load()
            if append_ids is not None:
                for i in append_ids:integer(i,0,g.model.config.vocab_size-1,'Token ID')
                steps=len(append_ids)
            ids,exact=g.inputs(question,prefix)
            selected=g.model.model.layers[layer];held={};handles=[]
            def pre(name):
                def capture(module,args):held[name]=args[0].detach().clone()
                return capture
            def post(name):
                def capture(module,args,out):held[name]=out.detach().clone()
                return capture
            handles.append(selected.register_forward_pre_hook(pre('input')))
            handles.append(selected.register_forward_hook(post('output')))
            for name,module in [('norm',selected.input_layernorm),('q',selected.self_attn.q_proj),('k',selected.self_attn.k_proj),('v',selected.self_attn.v_proj),('attention_output',selected.self_attn.o_proj),('post_norm',selected.post_attention_layernorm),('gate',selected.mlp.gate_proj),('up',selected.mlp.up_proj),('mlp',selected.mlp.down_proj)]:
                handles.append(module.register_forward_hook(post(name)))
            handles.append(selected.self_attn.o_proj.register_forward_pre_hook(pre('concatenated')))
            try:
                started=time.perf_counter()
                baseline=g.model(ids,use_cache=True,output_attentions=True)
                prefill_seconds=time.perf_counter()-started
            finally:
                for handle in handles:handle.remove()
            cache=baseline.past_key_values;length=ids.shape[1]
            # Reconstruct RoPE Q/K using the same installed implementation, then
            # independently reconstruct masked scores, softmax and head values.
            from transformers.models.llama.modeling_llama import apply_rotary_pos_emb,repeat_kv
            q=held['q'].view(1,length,9,64).transpose(1,2)
            k=held['k'].view(1,length,3,64).transpose(1,2)
            v=held['v'].view(1,length,3,64).transpose(1,2)
            cos,sin=g.model.model.rotary_emb(held['input'],torch.arange(length).unsqueeze(0))
            qr,kr=apply_rotary_pos_emb(q,k,cos,sin)
            scores=(qr @ repeat_kv(kr,3).transpose(-2,-1))/8
            mask=torch.ones(length,length,dtype=torch.bool).triu(1)
            weights=scores.masked_fill(mask,float('-inf')).softmax(-1)
            joined=(weights @ repeat_kv(v,3)).transpose(1,2).reshape(1,length,576)
            reconstructed=held['input']+held['attention_output']+held['mlp']
            block={name:value[0,-1].tolist() for name,value in held.items() if name not in ('q','k','v')}
            block.update(q_before_rope=q[0].tolist(),k_before_rope=k[0].tolist(),
                         q=qr[0].tolist(),k=kr[0].tolist(),v=v[0].tolist(),scores=scores[0].tolist(),
                         attention=baseline.attentions[layer][0].tolist(),
                         rope_cos=cos[0].tolist(),rope_sin=sin[0].tolist(),
                         attention_error=float((weights-baseline.attentions[layer]).abs().max()),
                         concatenation_error=float((joined-held['concatenated']).abs().max()),
                         residual_error=float((reconstructed-held['output']).abs().max()),
                         cache_key_error=float((kr-cache.layers[layer].keys).abs().max()),
                         cache_value_error=float((v-cache.layers[layer].values).abs().max()))
            # Keep the actual K/V for all prefill positions in the selected layer.
            old_keys=[c.keys.clone() for c in cache.layers]
            old_values=[c.values.clone() for c in cache.layers]
            cached_logits=baseline.logits[0,-1];sequence=ids;rows=[]
            for step in range(steps):
                token=append_ids[step] if append_ids is not None else int(cached_logits.argmax())
                token_tensor=torch.tensor([[token]])
                sequence=torch.cat((sequence,token_tensor),dim=1)
                t=time.perf_counter();cached=g.model(token_tensor,past_key_values=cache,use_cache=True)
                cached_time=time.perf_counter()-t
                t=time.perf_counter();replay=g.model(sequence,use_cache=False)
                replay_time=time.perf_counter()-t
                cached_logits=cached.logits[0,-1];full=replay.logits[0,-1]
                unchanged=all(torch.equal(c.keys[:,:,:length],k0) and torch.equal(c.values[:,:,:length],v0) for c,k0,v0 in zip(cache.layers,old_keys,old_values))
                rows.append({'step':step+1,'token':token,'text':g.token(token),'sequence_length':sequence.shape[1],
                             'cached_input_positions':1,'replay_input_positions':sequence.shape[1],
                             'cached_seconds':cached_time,'replay_seconds':replay_time,
                             'max_logit_difference':float((cached_logits-full).abs().max()),
                             'probability_total_variation':float((cached_logits.softmax(-1)-full.softmax(-1)).abs().sum()/2),
                             'same_greedy_next':int(cached_logits.argmax())==int(full.argmax()),'prefill_unchanged':unchanged,
                             'bytes':sum(c.keys.numel()*c.keys.element_size()+c.values.numel()*c.values.element_size() for c in cache.layers),
                             'new_k':cache.layers[layer].keys[0,:,-1].tolist(),'new_v':cache.layers[layer].values[0,:,-1].tolist(),
                             'next':g.top(cached_logits.softmax(-1),8)})
            shapes=[{'layer':i,'k':list(c.keys.shape),'v':list(c.values.shape)} for i,c in enumerate(cache.layers)]
            return {**self.manifest(),'kind':'measured forward passes','question':question,'prefix':prefix,'exact_input':exact,
                    'layer':layer,'tokens':[{'id':int(i),'text':g.token(i)} for i in ids[0]],
                    'architecture':{'layers':30,'query_heads':9,'kv_heads':3,'head_width':64,'residual_width':576,'mlp_width':1536,'query_to_kv':[i//3 for i in range(9)],'normalization':'RMSNorm','mlp':'SiLU(gate) × up → down','position':'RoPE'},
                    'block':block,'prefill_next':g.top(baseline.logits[0,-1].softmax(-1)),
                    'cache':{'prefill_tokens':length,'prefill_seconds':prefill_seconds,
                             'prefill_bytes':30*2*3*length*64*4,'bytes_per_token':30*2*3*64*4,
                             'steps':rows,'final_shapes':shapes,'selection': 'Greedy argmax' if append_ids is None else 'Exact operator token IDs',
                             'timing_note':'Single CPU measurements; no warm-up or timing benchmark. Tensor bytes exclude allocator overhead and model weights. Numerical differences compare cached decoding against full recomputation with the exact same token IDs.'}}
