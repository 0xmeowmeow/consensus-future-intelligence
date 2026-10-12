import hashlib
import json
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

SCHEMA = '''
CREATE TABLE IF NOT EXISTS actors(id TEXT PRIMARY KEY, name TEXT NOT NULL, secret TEXT UNIQUE NOT NULL, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS ledger(id INTEGER PRIMARY KEY, actor TEXT NOT NULL, amount INTEGER NOT NULL, reason TEXT NOT NULL, ref TEXT UNIQUE NOT NULL, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS candidates(id TEXT PRIMARY KEY, body TEXT NOT NULL, choices TEXT NOT NULL, source TEXT NOT NULL, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS packets(id TEXT PRIMARY KEY, actor TEXT NOT NULL, candidate TEXT NOT NULL, control TEXT NOT NULL, answer TEXT NOT NULL, choices TEXT NOT NULL, submitted INTEGER DEFAULT 0, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS annotations(id INTEGER PRIMARY KEY, actor TEXT NOT NULL, candidate TEXT NOT NULL, answer TEXT NOT NULL, created REAL NOT NULL, UNIQUE(actor,candidate));
CREATE TABLE IF NOT EXISTS examples(id TEXT PRIMARY KEY, prompt TEXT NOT NULL, answer TEXT NOT NULL, source TEXT NOT NULL, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS questions(id TEXT PRIMARY KEY, actor TEXT NOT NULL, title TEXT NOT NULL, votes INTEGER DEFAULT 0, used INTEGER DEFAULT 0, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, actor TEXT NOT NULL, response TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS entries(round TEXT NOT NULL, actor TEXT NOT NULL, PRIMARY KEY(round,actor));
CREATE TABLE IF NOT EXISTS episodes(id TEXT PRIMARY KEY, question TEXT NOT NULL, model TEXT NOT NULL, transcript TEXT DEFAULT '', status TEXT NOT NULL, created REAL NOT NULL, ended REAL);
CREATE TABLE IF NOT EXISTS frames(episode TEXT NOT NULL, seq INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(episode,seq));
CREATE TABLE IF NOT EXISTS reflections(episode TEXT NOT NULL, actor TEXT NOT NULL, verdict TEXT NOT NULL, note TEXT NOT NULL, created REAL NOT NULL, PRIMARY KEY(episode,actor));
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, parent TEXT NOT NULL, status TEXT NOT NULL, progress REAL DEFAULT 0, result TEXT, error TEXT, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, kind TEXT NOT NULL, actor TEXT, payload TEXT NOT NULL, created REAL NOT NULL);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
'''

class Store:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True)
        self.path = self.root/'cfi.sqlite3'
        with self.connect() as db:
            db.executescript(SCHEMA)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.path, timeout=20)
        db.row_factory = sqlite3.Row
        db.execute('PRAGMA journal_mode=WAL')
        db.execute('PRAGMA foreign_keys=ON')
        try:
            yield db
            db.commit()
        except Exception:
            db.rollback()
            raise
        finally: db.close()

    def rows(self, sql, args=()):
        with self.connect() as db: return [dict(r) for r in db.execute(sql, args)]

    def one(self, sql, args=()):
        rows = self.rows(sql, args)
        return rows[0] if rows else None

    def actor(self, token):
        if not token: return None
        return self.one('SELECT id,name,created FROM actors WHERE secret=?', (hashlib.sha256(token.encode()).hexdigest(),))

    def create_actor(self, name):
        aid, token = secrets.token_hex(10), secrets.token_urlsafe(32)
        with self.connect() as db:
            db.execute('INSERT INTO actors VALUES(?,?,?,?)', (aid, name, hashlib.sha256(token.encode()).hexdigest(), time.time()))
        return {'id': aid, 'name': name}, token

    @staticmethod
    def balance_db(db, actor):
        return db.execute('SELECT COALESCE(SUM(amount),0) FROM ledger WHERE actor=?', (actor,)).fetchone()[0]

    @staticmethod
    def credit(db, actor, amount, reason, ref):
        if db.execute('SELECT 1 FROM ledger WHERE ref=?', (ref,)).fetchone(): return False
        if amount < 0 and Store.balance_db(db, actor) + amount < 0:
            raise ValueError('You need more tokens. Complete a work packet to earn one.')
        db.execute('INSERT INTO ledger(actor,amount,reason,ref,created) VALUES(?,?,?,?,?)', (actor, amount, reason, ref, time.time()))
        return True

    def balance(self, actor):
        with self.connect() as db: return self.balance_db(db, actor)

    def event(self, kind, actor, payload):
        with self.connect() as db:
            db.execute('INSERT INTO events(kind,actor,payload,created) VALUES(?,?,?,?)', (kind, actor, json.dumps(payload), time.time()))

    def setting(self, key, value=None):
        with self.connect() as db:
            if value is not None:
                db.execute('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', (key, value))
            row = db.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()
            return row[0] if row else None
