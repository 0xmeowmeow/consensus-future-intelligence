from pathlib import Path
import pytest
import torch
from cfi.glass import Glass,DEFAULT_PATH
from cfi.workshop import Workshop,byte_bpe

@pytest.mark.parametrize('text',['  café 👻\n','aaaaa','\x00\t猫','\r\n  exact spaces  '])
def test_editable_byte_merges_preserve_exact_unicode_and_ids(text):
    r=byte_bpe(text,text*2,16)
    assert r['roundtrip'] and r['decoded']==text
    again=byte_bpe(text,text*2,merges=r['merges'])
    assert again['tokens']==r['tokens']
    assert len(r['stages'])==len(r['merges'])+1
    assert b''.join(bytes(t['bytes']) for t in r['tokens'])==text.encode('utf-8')

def test_manual_rules_really_change_segmentation_and_reject_future_ids():
    a=byte_bpe('abab','abab',merges=[])
    b=byte_bpe('abab','abab',merges=[[97,98],[256,256]])
    assert [t['id'] for t in a['tokens']]==[97,98,97,98]
    assert [t['id'] for t in b['tokens']]==[257]
    assert b['tokens'][0]['text']=='abab'
    for rules in ([[256,97]],[[True,98]],[[97,98],[97,98]]):
        with pytest.raises(ValueError):byte_bpe('ab','ab',merges=rules)

@pytest.mark.skipif(not (Path(DEFAULT_PATH)/'model.safetensors').exists(),reason='Pinned optional model missing')
def test_actual_block_cache_and_tokenizer_match_without_weight_changes():
    torch.set_num_threads(4);g=Glass();w=Workshop(g);g.load();versions=[p._version for p in g.model.parameters()]
    r=w.inspect('Can a shared memory change?',layer=29,steps=2)
    assert r['architecture']['query_to_kv']==[0,0,0,1,1,1,2,2,2]
    assert r['architecture']['kv_heads']==3
    for key in ('attention_error','concatenation_error','residual_error','cache_key_error','cache_value_error'):
        assert r['block'][key]<1e-5
    for step in r['cache']['steps']:
        assert step['prefill_unchanged'] and step['same_greedy_next']
        assert step['max_logit_difference']<1e-4
        assert step['probability_total_variation']<1e-5
        assert step['bytes']==step['sequence_length']*r['cache']['bytes_per_token']
        assert step['cached_input_positions']==1
    ids=[s['token'] for s in r['cache']['steps']]
    again=w.inspect('Can a shared memory change?',layer=0,append_ids=ids)
    assert [s['token'] for s in again['cache']['steps']]==ids
    assert r['cache']['final_shapes'][29]['k']==[1,3,len(r['tokens'])+2,64]
    t=w.tokenize('  café 👻\n');assert t['roundtrip'] and t['toy']['roundtrip']
    assert versions==[p._version for p in g.model.parameters()]
    assert not g.model.model.layers[29]._forward_pre_hooks
    assert not g.model.model.layers[29].self_attn.o_proj._forward_pre_hooks
    for options in ({'layer':True},{'steps':9},{'append_ids':[49152]}):
        with pytest.raises(ValueError):w.inspect('No call',**options)
