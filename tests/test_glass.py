"""Optional real-weight inspection checks; no generated fixtures presented as data."""
from pathlib import Path
import math
import pytest
import torch
from cfi.glass import Glass, DEFAULT_PATH
pytestmark = pytest.mark.skipif(not (Path(DEFAULT_PATH)/'model.safetensors').exists(), reason='Optional pinned inspection model is not installed')

@pytest.fixture(scope='module')
def glass():
    g=Glass();g.load();g.inspect('Warm the output capture once.')
    g.baseline_hooks={i:dict(layer._forward_hooks) for i,layer in enumerate(g.model.model.layers)}
    return g

def test_measured_attention_intervention_and_derivative_leave_weights_untouched(glass):
    versions=[p._version for p in glass.model.parameters()]
    question='Keep a shared memory if one person wants to leave?'
    first=glass.inspect(question,'Only if',layer=15,head=0)
    again=glass.inspect(question,'Only if',layer=15,head=0,target_token=first['next'][0]['id'])
    assert first['next']==again['next']
    assert first['ablation']==again['ablation']
    assert 0 < first['ablation']['total_variation'] < 1
    assert len(first['attention'])==30
    assert all(len(layer)==9 for layer in first['attention'])
    for layer in first['attention']:
        for head in layer:
            assert len(head)==len(first['tokens'])
            assert abs(sum(head)-1)<1e-5
            assert all(0<=v<=1 for v in head)
    for t in first['ablation']['changed']:
        assert abs(t['baseline_p']-t['muted_p']-t['difference'])<1e-7
    gradient=again['gradient']
    assert len(gradient['values'])==576
    assert all(math.isfinite(v) for v in gradient['values'])
    assert gradient['norm']>0
    assert abs(gradient['loss']+math.log(first['next'][0]['p']))<1e-5
    assert versions==[p._version for p in glass.model.parameters()]
    assert not any(p.requires_grad or p.grad is not None for p in glass.model.parameters())
    layer=glass.model.model.layers[15]
    assert not layer.self_attn.o_proj._forward_pre_hooks
    assert dict(layer._forward_hooks)==glass.baseline_hooks[15]

def test_glass_rejects_truncation_and_invalid_coordinates_and_cleans_hooks(glass):
    with pytest.raises(ValueError): glass.inspect('hello '*190)
    for options in ({'layer':-1},{'head':9},{'layer':True},{'head':False},{'head':0,'target_token':-1}):
        with pytest.raises(ValueError): glass.inspect('Exact question?',**options)
    assert not glass.model.model.layers[15].self_attn.o_proj._forward_pre_hooks
    assert dict(glass.model.model.layers[15]._forward_hooks)==glass.baseline_hooks[15]
    exact='  Consent?\nDo not remove this space.  '
    result=glass.inspect(exact,' Yes',layer=0)
    assert result['question']==exact
    assert exact in result['exact_input']
    assert result['exact_input'].endswith(' Yes')


def test_reported_activation_gradient_agrees_with_finite_difference(glass):
    measured=glass.inspect('May the memory be kept?','Only if',layer=15)
    target=measured['next'][0]['id']
    measured=glass.inspect('May the memory be kept?','Only if',layer=15,target_token=target)
    gradient=measured['gradient']['values']
    coordinate=max(range(len(gradient)),key=lambda i:abs(gradient[i]))
    ids,_=glass.inputs(measured['question'],measured['prefix'])
    def loss_at(displacement):
        def alter(module,args,value):
            result=value.clone();result[0,-1,coordinate]+=displacement;return result
        handle=glass.model.model.layers[15].register_forward_hook(alter)
        try:
            with torch.no_grad():return float(-glass.model(ids,use_cache=False).logits[0,-1].log_softmax(-1)[target])
        finally:handle.remove()
    numeric=(loss_at(.01)-loss_at(-.01))/.02
    assert math.isclose(numeric,gradient[coordinate],rel_tol=.025,abs_tol=1e-4)
    assert dict(glass.model.model.layers[15]._forward_hooks)==glass.baseline_hooks[15]
