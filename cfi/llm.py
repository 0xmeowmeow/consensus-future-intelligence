import json
import math
import os
import re
import time
import httpx
from .physics import ALLOWED

def parse_work_choice(content, choices):
    """Accept presentation punctuation without guessing from an explanation."""
    answer=content.strip()
    try:
        parsed=json.loads(answer)
        if isinstance(parsed,dict):answer=str(parsed.get('answer','')).strip()
        elif isinstance(parsed,str):answer=parsed.strip()
    except (json.JSONDecodeError,TypeError):pass
    answer=answer.strip(' \t\r\n"\'*'+chr(96))
    exact=[c for c in choices if c.casefold()==answer.casefold()]
    if len(exact)==1:return exact[0]
    normal=answer.rstrip('.!').strip()
    formatted=[c for c in choices if c.casefold()==normal.casefold()]
    if len(formatted)==1:return formatted[0]
    box=re.fullmatch(r'BOX\s+([A-Z])[.!]?',answer,re.IGNORECASE)
    if box:
        match=[c for c in choices if c.casefold()==box[1].casefold()]
        if len(match)==1:return match[0]
    raise ValueError('The guest did not return a single valid work choice.')

class Guest:
    def __init__(self):
        self.url=os.environ.get('CFI_OLLAMA_URL','http://127.0.0.1:11434').rstrip('/')
        self.model=os.environ.get('CFI_LLM','qwen3:14b')
        self.status='Not dialled'
        self.weights={}
        self.prefix=None
        self.error=None
        self.updated=0.
        self.calls=0

    async def solve_work(self, packet):
        answers={}
        async with httpx.AsyncClient(timeout=60) as client:
            # Independent calls prevent one question's labels leaking into the other.
            # The model is given only the public packet, never the control answer.
            for source,key in [('control','control'),('candidate','interpretation')]:
                question=packet[source]
                prompt=question['prompt']+'\nChoose exactly one of: '+', '.join(question['choices'])+'. Answer with only that choice, without explanation.'
                response=await client.post(self.url+'/api/chat',json={'model':self.model,'stream':False,'think':False,'messages':[{'role':'user','content':prompt}],'options':{'temperature':0,'num_predict':80,'num_ctx':2048},'keep_alive':'15m'})
                response.raise_for_status()
                answer=response.json()['message']['content'].strip().strip('"')
                answers[key]=parse_work_choice(answer,question['choices'])
        return answers

    async def next_pressure(self, question, prefix):
        self.status='Considering the next character'
        letters=sorted(ALLOWED-{' '})+['_'] if prefix else list('ABCDEFGHIJKLMNOPQRSTUVWXYZ')
        schema={'type':'object','properties':{'options':{'type':'array','minItems':1,'maxItems':4,'items':{'type':'object','properties':{'letter':{'type':'string','enum':letters},'weight':{'type':'number','minimum':0.01,'maximum':1}},'required':['letter','weight']}}},'required':['options']}
        system='You are one participant in a collective spirit board. Suggest ONLY the NEXT SINGLE CHARACTER of a short answer to the question, given the answer already written. Other participants may have written something unexpected: continue it. Return options with a letter and a POSITIVE weight. Example format: {"options":[{"letter":"W","weight":0.7},{"letter":"H","weight":0.3}]}. Use UPPERCASE letters, _ for a space, . or ? for punctuation, < to erase, ~ to finish. Do not return a sentence or plan a cursor path.'
        async with httpx.AsyncClient(timeout=50) as client:
            r=await client.post(self.url+'/api/chat',json={'model':self.model,'stream':False,'think':False,'format':schema,'messages':[{'role':'system','content':system},{'role':'user','content':json.dumps({'question':question,'already_written':prefix})}],'options':{'temperature':.65,'num_predict':180,'num_ctx':2048},'keep_alive':'15m'})
            r.raise_for_status()
            data=json.loads(r.json()['message']['content'])
        weights={}
        for item in data.get('options',[]):
            letter=' ' if item.get('letter')=='_' else item.get('letter')
            value=float(item.get('weight',0))
            if letter in ALLOWED and math.isfinite(value) and 0<value<=1:
                if not prefix and letter in {'~','<',' '}: continue
                weights[letter]=weights.get(letter,0)+value
        if not weights: raise ValueError('The LLM returned no usable character pressures. Retry the connection.')
        total=sum(weights.values())
        self.weights={c:v/total for c,v in weights.items()}
        self.prefix=prefix
        self.status='In contact'
        self.error=None
        self.updated=time.time()
        self.calls+=1
        return self.weights
