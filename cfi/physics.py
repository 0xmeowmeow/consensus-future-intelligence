"""The board's deterministic, server-owned motion. No preselected message."""
import math

NODES = []
for row, text in enumerate(("QWERTYUIOP", "ASDFGHJKL", "ZXCVBNM")):
    for col, char in enumerate(text):
        NODES.append({"char": char, "x": 500 + (col - (len(text)-1)/2)*66, "y": 210 + row*74})
for char, x in ((" ", 360), ("?", 450), (".", 525), ("<", 610), ("~", 720)):
    NODES.append({"char": char, "x": x, "y": 443})
ALLOWED = {n['char'] for n in NODES}

def initial():
    return dict(x=500., y=525., vx=0., vy=0., dwell=0., near=None, armed=True, last_letter=None, text="")

def limited(x, y, maximum):
    length = math.hypot(x, y)
    scale = min(1., maximum / max(length, 1e-9))
    return x*scale, y*scale

def attraction(state, weights, strength):
    fx = fy = 0.
    total = sum(max(0., weights.get(n['char'], 0.)) for n in NODES) or 1.
    for node in NODES:
        w = max(0., weights.get(node['char'], 0.)) / total
        dx, dy = node['x']-state['x'], node['y']-state['y']
        length = max(32., math.hypot(dx, dy))
        fx += strength*w*dx/length
        fy += strength*w*dy/length
    return fx, fy

def step(state, contacts, llm_weights, entity_weights, ready, dt=.05):
    s = dict(state)
    active = [p for p in contacts if p.get('holding')]
    forces = []
    for p in active:
        fx, fy = limited((p['x']-s['x'])*12, (p['y']-s['y'])*12, 720.)
        forces.append({'id': p['id'], 'fx': fx, 'fy': fy})
    if ready and active:
        fx, fy = attraction(s, llm_weights, 170.)
        forces.append({'id': 'llm', 'fx': fx, 'fy': fy})
        fx, fy = attraction(s, entity_weights, 45.)
        forces.append({'id': 'entity', 'fx': fx, 'fy': fy})
    fx, fy = sum(p['fx'] for p in forces), sum(p['fy'] for p in forces)
    # Each human adds one capped contribution. Damping keeps a larger circle usable.
    damping = 5.5 + max(0, len(active)-1)*1.5
    s['vx'], s['vy'] = limited((s['vx']+fx*dt)*math.exp(-damping*dt), (s['vy']+fy*dt)*math.exp(-damping*dt), 230.)
    s['x'] = min(925., max(75., s['x']+s['vx']*dt))
    s['y'] = min(535., max(120., s['y']+s['vy']*dt))
    nearest = min(NODES, key=lambda n: math.hypot(n['x']-s['x'], n['y']-s['y']))
    inside = math.hypot(nearest['x']-s['x'], nearest['y']-s['y']) < 22
    char = nearest['char'] if inside else None
    if not active or char != s['last_letter']:
        s['armed'] = True
    if char == s['near'] and active and ready and s['armed'] and math.hypot(s['vx'], s['vy']) < 70:
        s['dwell'] += dt
    else:
        s['dwell'] = 0.
    s['near'] = char
    emitted = None
    if char and s['dwell'] >= .65:
        emitted = char
        if char == '<': s['text'] = s['text'][:-1]
        elif char != '~': s['text'] += char
        s['last_letter'], s['armed'], s['dwell'] = char, False, 0.
    return s, forces, emitted
