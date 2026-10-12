"""Exact contributions and bounded influence for CFI's second encounter.

The graph stores speech, relationships and declared allocations. It does not
pretend that an allocation is attention, a probability, or an internal belief.
"""
import copy
import hashlib
import json
import math
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path


def uid():
    return secrets.token_hex(8)


def clean_text(value, maximum=1800):
    if not isinstance(value, str) or not value.strip():
        raise ValueError('Write the actual words you want to contribute.')
    if len(value) > maximum:
        raise ValueError(f'This field allows {maximum} characters. Your text has not been shortened or saved.')
    return value


def allocation(values, allowed, normalize=False):
    """One signed unit per identity, conserved across all branches."""
    if not isinstance(values, dict):
        raise ValueError('An allocation must name contributions and amounts.')
    result = {}
    for key, value in values.items():
        if key not in allowed:
            raise ValueError('A contribution in this allocation no longer exists.')
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise ValueError('Influence must be a finite number.')
        if value:
            result[key] = float(value)
    total = sum(abs(v) for v in result.values())
    if total > 1.000001:
        if not normalize:
            raise ValueError('You have one share in total. Take pressure off another contribution first.')
        result = {key: value / total for key, value in result.items()}
    return result


def tally(room, omit=None):
    ids = {n['id'] for n in room['nodes']}
    rows = {nid: {'support': 0., 'oppose': 0., 'net': 0., 'voices': []} for nid in ids}
    for actor, ballot in room['allocations'].items():
        if actor == omit:
            continue
        for nid, amount in ballot['values'].items():
            if nid not in rows or not amount:
                continue
            row = rows[nid]
            row['support' if amount > 0 else 'oppose'] += abs(amount)
            row['net'] += amount
            row['voices'].append({'actor': actor, 'amount': amount})
    return rows


def make_room(question, owner, models):
    return {'id': uid(), 'question': clean_text(question, 800), 'owner': owner,
            'created': time.time(), 'ended': None, 'phase': 'calling', 'revision': 0,
            'nodes': [], 'allocations': {}, 'participants': {}, 'models': models,
            'calls': [], 'events': [], 'focus': None, 'closed_by': None}


class EncounterStore:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root / 'encounters.sqlite3'
        with self.connect() as db:
            db.executescript('''
                CREATE TABLE IF NOT EXISTS people(id TEXT PRIMARY KEY, name TEXT NOT NULL, secret TEXT UNIQUE NOT NULL, created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, state TEXT NOT NULL, updated REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, room TEXT NOT NULL, actor TEXT, kind TEXT NOT NULL, payload TEXT NOT NULL, created REAL NOT NULL);
                CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
            ''')

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=20)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA journal_mode=WAL')
        try:
            yield db
            db.commit()
        except BaseException:
            db.rollback()
            raise
        finally:
            db.close()

    def register(self, name):
        name = clean_text(name, 36)
        token = secrets.token_urlsafe(32)
        actor = {'id': uid(), 'name': name, 'kind': 'human'}
        with self.connect() as db:
            db.execute('INSERT INTO people VALUES(?,?,?,?)', (actor['id'], name, hashlib.sha256(token.encode()).hexdigest(), time.time()))
        return actor, token

    def actor(self, token):
        if not token:
            return None
        with self.connect() as db:
            r = db.execute('SELECT id,name FROM people WHERE secret=?', (hashlib.sha256(token.encode()).hexdigest(),)).fetchone()
        return dict(r, kind='human') if r else None

    def save(self, room, kind=None, actor=None, payload=None):
        room['revision'] += 1
        if kind:
            event = {'kind': kind, 'actor': actor, 'time': time.time(), 'payload': payload or {}}
            room['events'].append(event)
        with self.connect() as db:
            if kind:
                db.execute('INSERT INTO events(room,actor,kind,payload,created) VALUES(?,?,?,?,?)',
                           (room['id'], actor, kind, json.dumps(payload or {}, ensure_ascii=False), event['time']))
            db.execute('INSERT INTO rooms VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,updated=excluded.updated',
                       (room['id'], json.dumps(room, ensure_ascii=False, allow_nan=False), time.time()))

    def latest(self):
        with self.connect() as db:
            row = db.execute("SELECT state FROM rooms ORDER BY json_extract(state, '$.created') DESC LIMIT 1").fetchone()
        return json.loads(row['state']) if row else None

    def room(self, rid):
        with self.connect() as db:
            row = db.execute('SELECT state FROM rooms WHERE id=?', (rid,)).fetchone()
        return json.loads(row['state']) if row else None

    def history(self):
        with self.connect() as db:
            records = db.execute("SELECT state FROM rooms ORDER BY json_extract(state, '$.created') DESC LIMIT 20").fetchall()
        return [{k: json.loads(r['state'])[k] for k in ('id', 'question', 'created', 'ended', 'phase')} for r in records]


def add_node(room, actor, text, kind='answer', parent=None, note='', source=None):
    if len(room['nodes']) >= 96:
        raise ValueError('This encounter has 96 contributions. Close it and begin another; the full trace remains available.')
    if kind not in ('answer', 'question', 'qualification', 'objection', 'continuation'):
        raise ValueError('Choose a contribution relationship.')
    if parent and parent not in {n['id'] for n in room['nodes']}:
        raise ValueError('The parent contribution is missing.')
    if kind in ('qualification', 'objection', 'continuation') and not parent:
        raise ValueError('Select the contribution these words respond to.')
    if not isinstance(note,str) or len(note)>1000:
        raise ValueError('A contribution note must be text of at most 1000 characters; nothing was shortened.')
    node = {'id': uid(), 'author': actor, 'text': clean_text(text), 'kind': kind,
            'parent': parent, 'note': note, 'created': time.time(), 'source': source}
    room['nodes'].append(node)
    return node


def public_room(room, people=None, omit=None):
    if room is None:
        return None
    result = copy.deepcopy(room)
    # Full requests, outputs and token traces live in the downloadable receipt.
    result['calls'] = [{k: v for k, v in c.items() if k not in ('request', 'response')} for c in result['calls']]
    result['events'] = result['events'][-14:]
    result['totals'] = tally(room)
    if omit:
        result['without'] = tally(room, omit)
    if people:
        result['present'] = people
    return result
