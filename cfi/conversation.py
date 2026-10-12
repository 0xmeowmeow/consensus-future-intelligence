"""Conversation annotations preserve claims, disagreement and the state at a moment."""
import copy
import time
from .encounter_core import clean_text, uid

KINDS = ('agreement', 'direction', 'disagreement', 'question', 'round')

def feedback(room, actor, node, value):
    if node not in {n['id'] for n in room['nodes']}:
        raise ValueError('Choose a message in this encounter.')
    if isinstance(value, bool) or value not in (-1, 0, 1):
        raise ValueError('Use helpful, unhelpful or clear feedback.')
    record = {'value': value, 'updated': time.time()}
    room.setdefault('feedback', {}).setdefault(node, {})[actor] = record
    return {'node': node, **record}

def mark(room, actor, kind, note, node=None):
    if kind not in KINDS:
        raise ValueError('Choose a marker kind.')
    if len(room.get('markers', [])) >= 256:
        raise ValueError('This encounter already has 256 markers.')
    if node is not None and node not in {n['id'] for n in room['nodes']}:
        raise ValueError('Choose a message in this encounter.')
    marker = {'id': uid(), 'kind': kind, 'note': clean_text(note, 1000),
              'author': actor, 'node': node, 'created': time.time(),
              'revision': room['revision'], 'endorsements': {},
              'snapshot': {'nodes': [n['id'] for n in room['nodes']],
                           'allocations': copy.deepcopy(room['allocations']),
                           'feedback': copy.deepcopy(room.get('feedback', {})),
                           'participants': list(room['participants'])}}
    room.setdefault('markers', []).append(marker)
    return marker

def endorse(room, actor, marker_id, stance, note=''):
    marker = next((m for m in room.get('markers', []) if m['id'] == marker_id), None)
    if marker is None:
        raise ValueError('That marker is not in this encounter.')
    if stance not in ('agree', 'condition', 'oppose', 'withdraw'):
        raise ValueError('Choose agree, condition, oppose or withdraw.')
    if not isinstance(note, str) or len(note) > 1000:
        raise ValueError('Use a note of at most 1000 characters.')
    if stance == 'condition' and not note.strip():
        raise ValueError('Write the condition that matters to you.')
    record = {'stance': stance, 'note': note, 'updated': time.time()}
    marker['endorsements'][actor] = record
    return {'marker': marker_id, **record}
