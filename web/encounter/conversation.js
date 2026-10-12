import { $, esc, api, kinds, name, when, scope } from "./instrument-common.js";
let state,
  selected = null,
  reply = null,
  revision = "",
  markerNode = null,
  posting = false,
  timer;
const draft = window.CFIViews?.read("conversation-draft");
if (draft) {
  $("words").value = draft.text || "";
  $("relation").value = draft.kind || "answer";
  reply = draft.parent;
}
const active = () =>
  state?.room &&
  !["closed", "interrupted", "closing"].includes(state.room.phase);
function notice(text) {
  $("notice").textContent = text;
  $("notice").classList.add("active");
  clearTimeout(timer);
  timer = setTimeout(() => $("notice").classList.remove("active"), 7000);
}
const guard = (fn) => async (e) => {
  try {
    await fn(e);
  } catch (error) {
    notice(error.message);
  }
};
function saveDraft() {
  window.CFIViews?.write("conversation-draft", {
    text: $("words").value,
    kind: $("relation").value,
    parent: reply,
    room: state?.room?.id || draft?.room,
  });
}
$("words").oninput = saveDraft;
$("relation").onchange = saveDraft;
window.addEventListener("pagehide", saveDraft);
function needsName() {
  if (state?.me) return false;
  $("name-dialog").showModal();
  return true;
}
function body(data) {
  return { room_id: state.room.id, ...data };
}
function replyLabel() {
  const n = state?.room?.nodes.find((n) => n.id === reply);
  $("reply-label").textContent = n
    ? "↳ " + name(state.room, n.author) + ": " + n.text
    : "";
  $("clear-reply").hidden = !reply;
}
function choose(id) {
  selected = id;
  scope(state.room, id);
  document
    .querySelectorAll(".message")
    .forEach((e) => e.classList.toggle("chosen", e.dataset.id === id));
}
function render() {
  const r = state.room;
  scope(r);
  $("join").hidden = !!state.me;
  $("close-call").disabled = !active() || r.owner !== state.me?.id;
  $("new-call").disabled = !!active();
  $("another-round").disabled =
    !active() || ["calling", "listening"].includes(r.phase);
  $("add-marker").disabled = !r;
  $("receipt").href = r ? "/api/receipt/" + r.id : "#";
  $("send").disabled = !active() || posting;
  $("words").disabled = !active();
  $("record-link").href = r ? "record.html?room=" + r.id : "record.html";
  $("question").textContent = r?.question || "Who are we calling into being?";
  $("phase").textContent = r?.phase.toUpperCase() || "THE LINE IS OPEN";
  $("next-action").textContent = !r
    ? "Place a call, invite the other hands, and begin with a question."
    : !active()
      ? "This call has ended. Read its conversation, inspect its changes, or place a new call."
      : !state.me
        ? "Take a place to add your words. You can read everything before joining."
        : ["calling", "listening"].includes(r.phase)
          ? "The other hands are taking their turns. You can keep writing; new words are saved immediately."
          : "Reply to a message or add your own thought below. Sending invites one round, then the room waits for you.";
  $("composer-status").textContent = reply
    ? "Your reply stays attached to the selected message."
    : active()
      ? "Exact words are saved. Training remains an explicit, separate experiment."
      : "Your draft is kept on this browser tab.";
  $("people").innerHTML = r
    ? Object.values(r.participants)
        .map(
          (p, i) =>
            `<div class="person"><span class="person-symbol">${p.kind === "human" ? "◉" : "⠿"}</span><div>${esc(p.name)}<small>${esc(p.kind === "human" ? "HUMAN" : p.status.toUpperCase())}${p.kind === "model" ? " / TURN " + (r.models.indexOf(p.name) + 1) : ""}</small>${p.last_pass ? `<small>Passed: ${esc(p.last_pass.reason || "Nothing to add this round.")}</small>` : ""}${p.error ? `<small title="${esc(p.error)}">${esc(p.error)}</small>` : ""}</div></div>`,
        )
        .join("")
    : "";
  $("markers").innerHTML = (r?.markers || [])
    .filter((m) => m.kind !== "round")
    .slice(-6)
    .map(
      (m) =>
        `<a class="marker-chip" href="record.html?room=${r.id}&marker=${m.id}"><small>⚑ ${kinds[m.kind]}</small>${esc(m.note)}</a>`,
    )
    .join("");
  const nextRevision = r?.id + ":" + r?.revision + ":" + state.me?.id;
  if (nextRevision !== revision) {
    const oldCount = $("messages").childElementCount;
    const nearBottom =
      window.scrollY + window.innerHeight >=
      document.documentElement.scrollHeight - 300;
    const focus = document.activeElement?.dataset.key;
    $("messages").innerHTML = r?.nodes.length
      ? r.nodes
          .map((n, i) => {
            const parent = r.nodes.find((p) => p.id === n.parent),
              votes = r.feedback?.[n.id] || {},
              own = votes[state.me?.id]?.value || 0;
            const help = Object.values(votes).filter(
                (v) => v.value === 1,
              ).length,
              unhelp = Object.values(votes).filter(
                (v) => v.value === -1,
              ).length,
              t = r.totals[n.id];
            const ownShare = r.allocations[state.me?.id]?.values[n.id] || 0;
            return `<article class="message ${r.participants[n.author]?.kind === "human" ? "human" : ""} ${n.id === selected ? "chosen" : ""}" data-id="${n.id}" id="word-${n.id}"><div class="message-head"><span>${String(i + 1).padStart(2, "0")}</span><strong>${esc(name(r, n.author))}</strong><span>${esc(n.kind)}</span><time>${when(n.created)}</time></div>${parent ? `<button class="message-parent" data-action="jump" data-target="${parent.id}">↳ ${esc(name(r, parent.author))}: ${esc(parent.text.slice(0, 120))}${parent.text.length > 120 ? "…" : ""}</button>` : ""}<p class="message-text">${esc(n.text)}</p><div class="message-tools"><button data-action="reply" data-key="reply-${n.id}" ${!active() ? "disabled" : ""}>REPLY ↩</button><button data-action="help" data-value="1" data-key="help-${n.id}" aria-pressed="${own === 1}" ${!active() ? "disabled" : ""}>HELPFUL ${help}</button><button data-action="help" data-value="-1" data-key="unhelp-${n.id}" aria-pressed="${own === -1}" ${!active() ? "disabled" : ""}>UNHELPFUL ${unhelp}</button><button data-action="mark" data-key="mark-${n.id}">PIN ⚑</button><a data-action="inspect" href="workshop.html?room=${r.id}&node=${n.id}">TAKE APART ↗</a><details><summary>SHARES & TRACE +</summary><span class="score-caption">Support ${t.support.toFixed(2)} / opposition ${t.oppose.toFixed(2)} · your share ${ownShare.toFixed(2)}</span> <button data-action="share" data-value="0.25" ${!active() ? "disabled" : ""}>+¼ SUPPORT</button> <button data-action="share" data-value="-0.25" ${!active() ? "disabled" : ""}>−¼ OPPOSE</button> <button data-action="share" data-value="0" ${!active() ? "disabled" : ""}>CLEAR</button> <a data-action="inspect" href="index.html">RELATIONSHIPS ↗</a>${n.source ? ` <a href="/api/call/${r.id}/${n.source}" target="_blank" rel="noopener">EXACT MODEL REQUEST ↗</a>` : ""}</details></div></article>`;
          })
          .join("")
      : `<div class="room-empty"><strong>${active() ? (r.phase === "open" ? "YOUR TURN AT THE TABLE." : "LISTENING FOR THE OTHER END.") : "WE ARE TRYING TO CONTACT WHAT WE MIGHT BECOME."}</strong><p>${active() ? "The first reply will appear here. You can put your words on the table now." : "A question brings the circle together. What happens next belongs to the people and models who answer."}</p></div>`;
    if (focus)
      document
        .querySelector(`[data-key="${CSS.escape(focus)}"]`)
        ?.focus({ preventScroll: true });
    if (oldCount && r?.nodes.length > oldCount) {
      if (nearBottom)
        requestAnimationFrame(() =>
          $("composer").scrollIntoView({ block: "end" }),
        );
      else $("latest").hidden = false;
    }
    revision = nextRevision;
  }
  replyLabel();
}
async function refresh() {
  state = await api("/state");
  if (selected === null) selected = window.CFIViews?.selected(state.room?.id);
  render();
}
$("messages").onclick = guard(async (e) => {
  const b = e.target.closest("[data-action]");
  if (!b) return;
  const article = b.closest("[data-id]"),
    nid = article.dataset.id;
  choose(nid);
  if (b.dataset.action === "inspect") return;
  if (b.dataset.action === "jump") {
    document
      .getElementById("word-" + b.dataset.target)
      ?.scrollIntoView({ block: "center", behavior: "smooth" });
    return;
  }
  if (b.dataset.action === "reply") {
    reply = nid;
    $("relation").value = "continuation";
    replyLabel();
    saveDraft();
    $("composer").scrollIntoView({ block: "end", behavior: "smooth" });
    $("words").focus({ preventScroll: true });
    return;
  }
  if (needsName()) return;
  if (b.dataset.action === "mark") {
    openMarker(nid);
    return;
  }
  if (b.dataset.action === "help") {
    const value = Number(b.dataset.value),
      old = state.room.feedback?.[nid]?.[state.me.id]?.value;
    await api(
      "/feedback",
      body({ node: nid, value: old === value ? 0 : value }),
    );
  }
  if (b.dataset.action === "share") {
    const values = { ...(state.room.allocations[state.me.id]?.values || {}) },
      step = Number(b.dataset.value);
    values[nid] = step
      ? Math.max(-1, Math.min(1, (values[nid] || 0) + step))
      : 0;
    const others = Object.entries(values).filter(([id]) => id !== nid),
      total = others.reduce((sum, [, v]) => sum + Math.abs(v), 0),
      left = 1 - Math.abs(values[nid]);
    if (total > left)
      for (const [id, v] of others) values[id] = (v * left) / total;
    await api(
      "/allocate",
      body({
        values,
        reason: "Moved my conserved share from the conversation.",
      }),
    );
  }
  await refresh();
});
$("clear-reply").onclick = () => {
  reply = null;
  $("relation").value = "answer";
  replyLabel();
  saveDraft();
};
$("latest").onclick = () => {
  $("composer").scrollIntoView({ block: "end", behavior: "smooth" });
  $("latest").hidden = true;
};
$("composer").onsubmit = guard(async (e) => {
  e.preventDefault();
  if (posting || needsName()) return;
  const stored = window.CFIViews?.read("conversation-draft");
  if (stored?.room && stored.room !== state.room.id)
    throw Error(
      "This draft belongs to a previous encounter. Copy it aside or clear it before starting a new message here.",
    );
  posting = true;
  render();
  try {
    const node = await api(
      "/contribute",
      body({
        text: $("words").value,
        kind: $("relation").value,
        parent: reply,
        respond: $("ask-guests").checked,
      }),
    );
    $("words").value = "";
    reply = null;
    $("relation").value = "answer";
    selected = node.id;
    saveDraft();
    await refresh();
    $("composer").scrollIntoView({ block: "end", behavior: "smooth" });
  } finally {
    posting = false;
    render();
  }
});
$("another-round").onclick = guard(async () => {
  if (needsName()) return;
  await api("/listen", body({}));
  await refresh();
});
$("close-call").onclick = guard(async () => {
  await api("/close", body({}));
  stopAudio();
  await refresh();
});
$("join").onclick = () => $("name-dialog").showModal();
$("name-form").onsubmit = guard(async (e) => {
  e.preventDefault();
  await api("/identity", { name: $("my-name").value });
  $("name-dialog").close();
  await refresh();
});
$("new-call").onclick = guard(async () => {
  $("caller").value = state?.me?.name || "";
  const result = await api("/models");
  $("models").innerHTML = result.models
    .map(
      (m) =>
        `<label><input type="checkbox" name="model" value="${esc(m.name)}" ${state.default_models.includes(m.name) ? "checked" : ""}><span>${esc(m.name)} <small>${esc(m.parameters || "")}</small></span></label>`,
    )
    .join("");
  $("dial-dialog").showModal();
});
$("dial-form").onsubmit = guard(async (e) => {
  e.preventDefault();
  const models = [...document.querySelectorAll("#models input:checked")].map(
    (i) => i.value,
  );
  if (models.length < 1 || models.length > 8)
    throw Error("Invite 1–8 installed models.");
  await api("/identity", { name: $("caller").value });
  await api("/dial", { question: $("call-question").value, models });
  $("dial-dialog").close();
  dialSound();
  reply = null;
  selected = null;
  await refresh();
});
function openMarker(nid) {
  markerNode = nid || selected || state.room.nodes.at(-1)?.id || null;
  $("marker-anchor").textContent = markerNode
    ? "Attached to message " +
      (state.room.nodes.findIndex((n) => n.id === markerNode) + 1) +
      ". Snapshot taken when you save."
    : "Attached to the encounter.";
  $("marker-dialog").showModal();
}
$("add-marker").onclick = () => {
  if (!needsName()) openMarker();
};
$("marker-form").onsubmit = guard(async (e) => {
  e.preventDefault();
  await api(
    "/markers",
    body({
      kind: $("marker-kind").value,
      note: $("marker-note").value,
      node: markerNode,
    }),
  );
  $("marker-dialog").close();
  $("marker-note").value = "";
  await refresh();
  notice("Moment pinned. Open the Record to compare it or add endorsements.");
});
document
  .querySelectorAll("[data-close]")
  .forEach((b) => (b.onclick = () => $(b.dataset.close).close()));
let enabledSound = false,
  audio,
  soundNodes = [];
function stopAudio() {
  soundNodes.forEach((n) => {
    try {
      n.stop();
    } catch {}
  });
  soundNodes = [];
}
$("sound").onclick = () => {
  enabledSound = !enabledSound;
  $("sound").textContent = enabledSound ? "SOUND ON" : "SOUND OFF";
  $("sound").setAttribute("aria-pressed", String(enabledSound));
  if (enabledSound) {
    audio ||= new AudioContext();
    audio.resume();
  } else stopAudio();
};
function dialSound() {
  if (!enabledSound) return;
  audio ||= new AudioContext();
  audio.resume();
  stopAudio();
  const now = audio.currentTime;
  const tone = (f, t, d, volume = 0.025, type = "sine") => {
    const o = audio.createOscillator(),
      g = audio.createGain();
    o.type = type;
    o.frequency.value = f;
    g.gain.setValueAtTime(0, now + t);
    g.gain.linearRampToValueAtTime(volume, now + t + 0.01);
    g.gain.setValueAtTime(volume, now + t + d - 0.02);
    g.gain.linearRampToValueAtTime(0, now + t + d);
    o.connect(g).connect(audio.destination);
    o.start(now + t);
    o.stop(now + t + d);
    soundNodes.push(o);
  };
  tone(350, 0, 0.7);
  tone(440, 0, 0.7);
  [
    [697, 1209],
    [770, 1336],
    [852, 1477],
    [941, 1209],
    [697, 1336],
    [852, 1209],
  ].forEach((p, i) => p.forEach((f) => tone(f, 0.9 + i * 0.21, 0.12)));
  tone(2100, 2.5, 1.3);
  for (let i = 0; i < 30; i++)
    tone(800 + ((i * 571) % 2400), 4 + i * 0.055, 0.052, 0.012, "sawtooth");
}
async function poll() {
  try {
    await refresh();
  } catch (e) {
    notice(e.message);
  }
  setTimeout(poll, 1600);
}
poll();
