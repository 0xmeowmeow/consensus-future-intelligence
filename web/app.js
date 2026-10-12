const $ = id => document.getElementById(id);
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const uuid = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2,'0')).join('');
let state, live, socket, packet, toastTimer, replayTimer, replaying=false, holding=false;
let pointer={x:500,y:525}, keyDirections=new Set(), peopleKey='', chatKey='', nodesBuilt=false;
let soundEnabled=localStorage.getItem('cfi-sound')!=='off', audioContext;
const busy=new Set();

function toast(text) {$('toast').textContent=text;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,6500);}
async function api(path,body) {
  const response=await fetch('/api'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  let result;try{result=await response.json();}catch{throw Error('The local server did not return a readable response.');}
  if(!response.ok)throw Error(result.error||result.detail||'The request failed.');
  return result;
}
async function action(key,fn) {
  if(busy.has(key))return;
  busy.add(key);const button=$(key);if(button?.tagName==='BUTTON')button.disabled=true;
  try{await fn();await refresh();}catch(error){toast(error.message);}finally{busy.delete(key);if(state)renderState();}
}
function setDisabled(id,disabled) {$(id).disabled=disabled||busy.has(id);}
async function refresh() {
  state=await api('/state');
  live=state.room;
  renderState();
  if(!replaying)renderRoom(live);
  if(state.actor)connect();else $('connection').textContent='Local circle';
}

function renderState() {
  const a=state.actor,b=state.balance;
  $('identity-form').hidden=!!a;$('welcome').hidden=!a;
  $('identity-label').textContent=a?.name||'Visitor';
  $('welcome-name').textContent=a?'A seat for '+a.name+'.':'';
  $('balance').textContent=b+(b===1?' token':' tokens');
  ['get-work','submit-teach'].forEach(id=>setDisabled(id,!a));
  setDisabled('submit-question',!a||b<1);
  $('questions').innerHTML=state.questions.length?state.questions.map(q=>'<div class="question-row"><div><p>'+escape(q.title)+'</p><small>'+escape(q.name)+' · '+q.votes+' votes</small></div><button data-vote="'+escape(q.id)+'" '+(!a||b<1?'disabled':'')+'>↑ 1 token</button></div>').join(''):'<p class="muted">No questions queued. The first circle asks: “What should we become?”</p>';
  $('ledger').innerHTML=state.ledger.map(l=>'<li><b>'+(l.amount>0?'+':'')+l.amount+'</b><span>'+escape(l.reason)+'</span></li>').join('')||'<li>No tokens have moved yet.</li>';
  $('example-count').textContent=state.examples;
  $('generation-count').textContent=state.models.filter(m=>m.parent).length;
  $('active-kind').textContent=state.active_model.startsWith('origin-')?'Origin':'Trained';
  $('download-active').href='/api/models/'+encodeURIComponent(state.active_model)+'/download';
  const running=state.jobs.find(j=>['queued','running'].includes(j.status));
  setDisabled('train',!a||state.examples<2||!!running);
  const last=state.jobs[0];
  $('training-status').innerHTML=running?'<label>Training · '+Math.round(running.progress*100)+'%<progress max="1" value="'+running.progress+'"></progress></label>':last?.status==='failed'?'Training stopped: '+escape(last.error):last?.status==='complete'?'Candidate ready. Inspect its result below.':'';
  $('models').innerHTML=state.models.slice(0,6).map(m=>{
    const t=m.training,active=m.id===state.active_model;
    return '<div class="model"><h3>'+(active?'● ':'○ ')+escape(m.id)+'</h3>'+
      (t?'<p>'+t.examples+' examples · '+t.steps+' steps · '+t.seconds.toFixed(1)+' seconds</p><p>Unseen movement questions: <strong>'+t.before.correct+'/'+t.before.total+' → '+t.after.correct+'/'+t.after.total+'</strong> correct. Random-choice baseline: 25%.</p><p>Unseen-answer loss: '+t.before.choice_nll.toFixed(3)+' → '+t.after.choice_nll.toFixed(3)+' (lower is better).</p><p>Training loss: '+t.loss_start.toFixed(3)+' → '+t.loss_end.toFixed(3)+'. A lower training loss alone does not mean better reasoning.</p><small>Parent: '+escape(m.parent)+'</small>':'<p>Random weights. No pretrained knowledge. Seed '+m.seed+'.</p>')+
      '<div class="actions"><a href="/api/models/'+encodeURIComponent(m.id)+'/download">Download ↓</a>'+(!active?'<button data-adopt="'+escape(m.id)+'" '+(!a||!['idle','closed'].includes(live.phase)?'disabled':'')+'>Use in next circle</button>':'<span class="muted">Active on the board</span>')+'</div></div>';
  }).join('');
  $('episodes').innerHTML=state.episodes.filter(e=>e.status!=='contact').map(e=>'<article class="episode"><div><p>'+escape(e.question)+'</p><small>'+new Date(e.created*1000).toLocaleString()+' · '+escape(e.status)+'</small></div><p class="answer">'+escape(e.transcript||'(No characters committed)')+'</p><div class="actions"><button data-replay="'+escape(e.id)+'">Replay ↗</button><a href="/api/episodes/'+encodeURIComponent(e.id)+'/replay" target="_blank" rel="noopener">Raw record</a></div></article>').join('')||'<p class="muted">No completed encounters yet.</p>';
  const grouped=new Map();
  for(const i of state.interpretations){if(!grouped.has(i.id))grouped.set(i.id,{body:i.body,votes:[]});grouped.get(i.id).votes.push(i.answer+': '+i.n);}
  $('interpretations').innerHTML=[...grouped.values()].slice(0,12).map(i=>'<div class="interpretation"><p>'+escape(i.body)+'</p><span>'+escape(i.votes.join(' · '))+'</span></div>').join('')||'<p>No interpretations submitted yet.</p>';
}

function buildNodes(nodes) {
  if(nodesBuilt)return;nodesBuilt=true;
  $('letters').innerHTML=nodes.map((n,i)=>'<g id="node-'+i+'" transform="translate('+n.x+' '+n.y+')"><circle class="guest-halo" r="28"/><circle class="entity-halo" r="31"/><circle class="letter-hit" r="23"/><text y="'+(n.char.length===1&&/^[A-Z?.]$/.test(n.char)?10:5)+'" class="'+(/^[A-Z?.]$/.test(n.char)?'letter':'node-label')+'">'+escape({' ':'SPACE','<':'ERASE','~':'GOODBYE'}[n.char]||n.char)+'</text></g>').join('');
}
function renderBoard(r) {
  buildNodes(r.nodes||live.nodes);
  const s=r.board;
  $('planchette').setAttribute('transform','translate('+s.x+' '+s.y+')');
  $('dwell').setAttribute('stroke-dasharray',Math.min(100,s.dwell/.65*100)+' 100');
  const weights=r.guest?.weights||{}, entity=r.entity?.weights||{};
  (r.nodes||live.nodes).forEach((n,i)=>{
    const g=$('node-'+i);
    g.querySelector('.guest-halo').style.opacity=(weights[n.char]||0)*.5;
    g.querySelector('.entity-halo').style.opacity=Math.min(.9,(entity[n.char]||0)*8);
    g.querySelector('.letter-hit').style.opacity=s.near===n.char?.14:0;
  });
  $('hands').innerHTML=(r.contacts||[]).filter(c=>c.holding).map(c=>'<g stroke="'+(c.id===state.actor?.id?'#eac18c':'#dc997f')+'" fill="none"><line x1="'+s.x+'" y1="'+s.y+'" x2="'+c.x+'" y2="'+c.y+'" opacity=".45" stroke-dasharray="3 5"/><circle cx="'+c.x+'" cy="'+c.y+'" r="8" fill="#d3b17420"/><text x="'+c.x+'" y="'+(c.y-14)+'" stroke="none" fill="#e4c49a" text-anchor="middle" font-size="10">'+escape(c.name)+'</text></g>').join('');
  const text=s.text||'· · ·';if($('transcript').textContent!==text)$('transcript').textContent=text;
}
function renderRoom(r) {
  if(!state)return;
  renderBoard(r);
  $('active-question').textContent=r.question;
  $('phase').textContent={idle:'WAITING FOR CONTACT',dialling:'DIALLING…',contact:'CIRCLE IN CONTACT',unavailable:'GUEST COULD NOT CONNECT',closed:'THE ENTITY HAS DEPARTED'}[r.phase];
  $('instruction').textContent=r.message;
  $('guest-status').textContent=r.guest.status+(r.guest.error?' · '+r.guest.error:'');
  const joined=!!r.people.find(p=>p.id===state.actor?.id&&p.joined)||state.joined&&state.room.round===r.round;
  setDisabled('join',!state.actor||state.balance<1||joined||r.phase==='closed'||replaying);
  $('join').textContent=joined?'Your place is held':'Join circle · 1 token';
  setDisabled('dial',!joined||r.phase!=='idle'||replaying);
  setDisabled('goodbye',!joined||!['dialling','contact','unavailable'].includes(r.phase)||replaying);
  $('retry').hidden=!r.guest.error||r.phase==='closed';setDisabled('retry',!joined||replaying);$('retry').textContent='Retry connection · free';
  $('new-circle').hidden=r.phase!=='closed';setDisabled('new-circle',!state.actor||replaying);
  $('reflection').hidden=!(r.phase==='closed'&&joined&&r.episode&&!replaying);
  const pk=JSON.stringify([r.people,r.guest.joined,r.entity.trained,r.chat.filter(c=>Date.now()/1000-c.at<7)]);
  if(pk!==peopleKey) {
    peopleKey=pk;
    $('people').innerHTML=r.people.map(p=>{
      const message=[...r.chat].reverse().find(c=>c.id===p.id&&Date.now()/1000-c.at<7);
      return '<div class="seat '+(p.joined?'joined':'')+'"><span class="seat-dot"></span>'+escape(p.name)+(p.id===state.actor?.id?' (you)':'')+(message?'<span class="bubble">'+escape(message.text)+'</span>':'')+'</div>';
    }).join('')+'<div class="seat guest"><span class="seat-dot"></span>'+escape(r.guest.name)+(r.guest.joined?' · entry earned':' · awaiting entry')+'</div><div class="seat entity"><span class="seat-dot"></span>Tiny entity · '+(r.entity.trained?'trained':'random-born')+'</div>';
  }
  const ck=JSON.stringify(r.chat);
  if(ck!==chatKey){chatKey=ck;$('chat-log').innerHTML=r.chat.map(c=>'<p><b>'+escape(c.name)+': </b>'+escape(c.text)+'</p>').join('')||'<span class="muted">The room is listening.</span>';$('chat-log').scrollTop=$('chat-log').scrollHeight;}
}
function connect() {
  if(socket&&[WebSocket.OPEN,WebSocket.CONNECTING].includes(socket.readyState))return;
  socket=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/api/live');
  socket.onopen=()=>{$('connection').textContent='● Live circle';};
  socket.onmessage=event=>{live=JSON.parse(event.data);if(!replaying)renderRoom(live);};
  socket.onclose=()=>{$('connection').textContent='Reconnecting…';holding=false;setTimeout(()=>state?.actor&&connect(),1500);};
  socket.onerror=()=>{$('connection').textContent='Connection interrupted';};
}
function send(message){if(socket?.readyState===WebSocket.OPEN)socket.send(JSON.stringify(message));}
function push(){send({type:'push',...pointer,holding:holding&&!replaying});}
function coordinates(event){const p=new DOMPoint(event.clientX,event.clientY).matrixTransform($('board').getScreenCTM().inverse());return {x:p.x,y:p.y};}
$('board').addEventListener('pointerdown',event=>{
  if(replaying)return;
  if(!state?.joined&&!live?.people.some(p=>p.id===state?.actor?.id&&p.joined)){toast('Earn a token and join the circle to place your hand.');return;}
  if(!['contact','dialling'].includes(live.phase)){toast('Dial the other side before pushing.');return;}
  event.preventDefault();$('board').setPointerCapture(event.pointerId);pointer=coordinates(event);holding=true;push();
});
$('board').addEventListener('pointermove',event=>{if(holding)pointer=coordinates(event);});
function release(){holding=false;keyDirections.clear();push();}
['pointerup','pointercancel','lostpointercapture'].forEach(type=>$('board').addEventListener(type,release));
window.addEventListener('blur',release);
document.addEventListener('visibilitychange',()=>{if(document.hidden)release();});
$('board').addEventListener('keydown',e=>{if(['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)){e.preventDefault();if(!replaying&&state?.joined&&['contact','dialling'].includes(live.phase)){keyDirections.add(e.key);holding=true;}}});
$('board').addEventListener('keyup',e=>{keyDirections.delete(e.key);if(!keyDirections.size)release();});
setInterval(()=>{
  if(keyDirections.size&&live){pointer={x:live.board.x+(keyDirections.has('ArrowRight')?60:0)-(keyDirections.has('ArrowLeft')?60:0),y:live.board.y+(keyDirections.has('ArrowDown')?60:0)-(keyDirections.has('ArrowUp')?60:0)};}
  if(holding)push();
},60);

$('identity-form').addEventListener('submit',e=>{e.preventDefault();action('identity-form',async()=>{await api('/identity',{name:$('name').value});toast('Your seat is saved. Start with a work packet to earn a token.');});});
function questionField(id,question,name,label) {
  $(id).innerHTML='<legend><small>'+label+'</small>'+escape(question.prompt)+'</legend><div class="choices">'+question.choices.map(c=>'<label><input type="radio" name="'+name+'" value="'+escape(c)+'" required><span>'+escape(c)+'</span></label>').join('')+'</div>';
}
async function getWork() {
  packet=await api('/work');questionField('control-question',packet.control,'control','A · CHECK THE MOVEMENTS');questionField('candidate-question',packet.candidate,'interpretation','B · YOUR INTERPRETATION');
  $('work-form').hidden=false;$('get-work').textContent='Resume current packet';$('work-result').textContent='';
}
$('get-work').onclick=()=>action('get-work',getWork);
$('work-form').addEventListener('submit',e=>{e.preventDefault();action('work-form',async()=>{
  const data=new FormData(e.currentTarget);const result=await api('/work',{id:packet.id,control:data.get('control'),interpretation:data.get('interpretation')});
  $('work-form').hidden=true;$('get-work').textContent='Do another packet';
  toast(result.earned?'+1 token. Your checked work is now available for training.':'This packet was already credited.');
});});
$('join').onclick=()=>action('join',async()=>{await api('/room/join',{});toast('Your place is held for this circle.');});
$('dial').onclick=()=>{modem();action('dial',()=>api('/room/dial',{}));};
$('retry').onclick=()=>action('retry',()=>api('/room/retry',{}));
$('goodbye').onclick=()=>{release();action('goodbye',()=>api('/room/goodbye',{}));};
$('new-circle').onclick=()=>action('new-circle',()=>api('/room/new',{}));
$('question-form').addEventListener('submit',e=>{e.preventDefault();action('submit-question',async()=>{await api('/questions',{title:$('question').value,request_id:uuid()});$('question').value='';toast('Question added to the live list.');});});
$('questions').onclick=e=>{const b=e.target.closest('[data-vote]');if(b)action('vote-'+b.dataset.vote,()=>api('/questions/'+b.dataset.vote+'/vote',{request_id:uuid()}));};
$('teach-form').addEventListener('submit',e=>{e.preventDefault();action('submit-teach',async()=>{await api('/teach',{prompt:$('teach-prompt').value,choices:$('teach-choices').value.split('\n'),rights:$('rights').checked});$('teach-form').reset();toast('Your task is in the interpretation pool.');});});
$('chat-form').addEventListener('submit',e=>{e.preventDefault();if(!state.actor){toast('Take a seat first.');return;}send({type:'chat',text:$('chat').value});$('chat').value='';});
$('reflection').addEventListener('submit',e=>{e.preventDefault();action('reflection',async()=>{await api('/reflections',{episode:live.episode,verdict:new FormData(e.currentTarget).get('verdict'),note:$('reflection-note').value});toast('Reflection recorded. You can revise it while this circle remains closed.');});});
$('train').onclick=()=>action('train',async()=>{await api('/train',{});toast('Training a new candidate on a frozen copy of the current examples.');});
$('models').onclick=e=>{const b=e.target.closest('[data-adopt]');if(b)action('adopt',async()=>{await api('/models/'+b.dataset.adopt+'/adopt',{});toast('The next circle will use this checkpoint.');});};
$('mechanics-toggle').onclick=()=>{const open=$('mechanics').hidden;$('mechanics').hidden=!open;$('mechanics-toggle').setAttribute('aria-expanded',open);};
$('episodes').onclick=e=>{const b=e.target.closest('[data-replay]');if(b)action('replay',async()=>{
  release();const record=await api('/episodes/'+b.dataset.replay+'/replay');if(!record.frames.length){toast('No motion frames were recorded for this encounter.');return;}
  clearInterval(replayTimer);replaying=true;$('replay-badge').hidden=false;$('board').scrollIntoView({block:'center'});
  let index=0;$('active-question').textContent=record.episode.question;$('phase').textContent='RECORDED ENCOUNTER';
  $('instruction').textContent='Recorded motion, replaying at the original speed. No live pushes are sent.';
  ['join','dial','retry','goodbye','new-circle'].forEach(id=>$(id).disabled=true);$('reflection').hidden=true;
  replayTimer=setInterval(()=>{const f=record.frames[index++];if(!f){clearInterval(replayTimer);return;}renderBoard({board:f.state,contacts:f.contacts,guest:{weights:f.llm},entity:{weights:f.entity}});},50);
});};
$('exit-replay').onclick=()=>{clearInterval(replayTimer);replaying=false;$('replay-badge').hidden=true;renderRoom(live);};

function updateSound() {$('sound').textContent=soundEnabled?'Sound on':'Sound off';$('sound').setAttribute('aria-pressed',soundEnabled);}
$('sound').onclick=()=>{soundEnabled=!soundEnabled;localStorage.setItem('cfi-sound',soundEnabled?'on':'off');if(audioContext)(soundEnabled?audioContext.resume():audioContext.suspend());updateSound();};
function modem() {
  if(!soundEnabled)return;
  const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)return;
  audioContext??=new Audio();audioContext.resume();
  const base=audioContext.currentTime, master=audioContext.createGain();master.gain.value=.055;master.connect(audioContext.destination);
  function tone(freq,start,duration,type='sine'){
    const osc=audioContext.createOscillator(),gain=audioContext.createGain();osc.type=type;osc.frequency.value=freq;
    gain.gain.setValueAtTime(0,base+start);gain.gain.linearRampToValueAtTime(1,base+start+.008);gain.gain.setValueAtTime(1,base+start+duration-.015);gain.gain.linearRampToValueAtTime(0,base+start+duration);
    osc.connect(gain).connect(master);osc.start(base+start);osc.stop(base+start+duration+.01);
  }
  tone(350,0,.6);tone(440,0,.6);
  [[697,1209],[770,1336],[852,1477],[941,1336],[697,1477],[852,1209],[770,1209]].forEach((pair,i)=>pair.forEach(f=>tone(f,.7+i*.18,.12)));
  [2.2,3.2].forEach(t=>{tone(440,t,.5);tone(480,t,.5);});
  tone(2100,4,1.1);
  for(let i=0;i<28;i++)tone([1200,1800,2400,1650][i%4],5.15+i*.045,.045,'square');
  const buffer=audioContext.createBuffer(1,audioContext.sampleRate*.8,audioContext.sampleRate),data=buffer.getChannelData(0);
  for(let i=0;i<data.length;i++)data[i]=(Math.random()*2-1)*.55;
  const noise=audioContext.createBufferSource(),filter=audioContext.createBiquadFilter();noise.buffer=buffer;filter.type='bandpass';filter.frequency.value=1900;filter.Q.value=.8;
  noise.connect(filter).connect(master);noise.start(base+6.45);
  tone(1800,7.3,.1);tone(1200,7.45,.1);
}
updateSound();
refresh().catch(error=>toast(error.message));
setInterval(()=>refresh().catch(()=>{$('connection').textContent='Server unavailable';}),3000);
