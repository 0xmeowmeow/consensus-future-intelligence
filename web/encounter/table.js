let postingWords = false,
  composerRoom = null;
const $ = (id) => document.getElementById(id),
  esc = (t) =>
    String(t ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
let state = null,
  selected = null,
  composerParent = null,
  revision = null,
  roomId = null,
  intent = 1,
  holding = false,
  bubbleActor = null,
  holdTimer,
  sending = false,
  enabledSound = false,
  audio,
  soundNodes = [],
  toastTimer;
const preview = window.CFI_PREVIEW ? structuredClone(window.CFI_PREVIEW) : null;
if (preview) {
  preview.me = {
    id: "preview-human",
    name: "Your hand / local preview",
    kind: "human",
  };
  preview.room.participants[preview.me.id] = {
    ...preview.me,
    status: "present",
  };
  const b = document.createElement("div");
  b.className = "table-preview-banner";
  b.textContent = "RECORDED REAL ENCOUNTER · YOUR CHANGES STAY IN THIS PREVIEW";
  document.body.append(b);
}
function totals(room) {
  const out = Object.fromEntries(
    room.nodes.map((n) => [n.id, { support: 0, oppose: 0, voices: [] }]),
  );
  for (const [actor, b] of Object.entries(room.allocations))
    for (const [id, v] of Object.entries(b.values)) {
      if (out[id]) {
        out[id][v >= 0 ? "support" : "oppose"] += Math.abs(v);
        out[id].voices.push({ actor, amount: v });
      }
    }
  return out;
}
async function api(path, body) {
  if (body && ["/contribute", "/allocate", "/listen", "/close"].includes(path))
    body = { room_id: state?.room?.id, ...body };
  if (preview) {
    const r = preview.room;
    if (path === "/state") {
      r.totals = totals(r);
      return structuredClone(preview);
    }
    if (path === "/models")
      return { models: r.models.map((name) => ({ name })) };
    if (path === "/allocate") {
      r.allocations[preview.me.id] = {
        values: body.values,
        kind: "human",
        reason: "Local preview only.",
      };
      r.revision++;
      return {};
    }
    if (path === "/contribute") {
      const n = {
        id: "preview-" + crypto.randomUUID(),
        author: preview.me.id,
        text: body.text,
        kind: body.kind,
        parent: body.parent,
        created: Date.now() / 1000,
      };
      r.nodes.push(n);
      r.revision++;
      return n;
    }
    throw Error(
      "This picker contains a recorded real encounter. Open the live table on port 8775 for a new model response.",
    );
  }
  const response = await fetch(
    "/api" + path,
    body === undefined
      ? {}
      : {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
  );
  let data;
  try {
    data = await response.json();
  } catch {
    throw Error("The local line returned an unreadable response.");
  }
  if (!response.ok)
    throw Error(data.error || data.detail || "The local request failed.");
  return data;
}
function tell(text) {
  clearTimeout(toastTimer);
  $("table-notice").textContent = text;
  $("table-notice").className = "visible";
  toastTimer = setTimeout(() => ($("table-notice").className = ""), 7500);
}
const guard = (fn) => async (e) => {
  try {
    await fn(e);
  } catch (err) {
    tell(err.message);
  }
};
function show(id) {
  if (!$(id).open) $(id).showModal();
}
document
  .querySelectorAll("[data-close]")
  .forEach((b) => (b.onclick = () => $(b.dataset.close).close()));
document.querySelectorAll("dialog").forEach((d) =>
  d.addEventListener("click", (e) => {
    if (e.target === d) {
      const r = d.getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      )
        d.close();
    }
  }),
);
function who(id) {
  return state.room.participants[id]?.name || "Participant";
}
function current() {
  return state?.room?.nodes.find((n) => n.id === selected);
}
function open() {
  return (
    state?.room &&
    !["closed", "interrupted", "closing"].includes(state.room.phase)
  );
}
function needName() {
  if (state?.me) return false;
  show("name-dialog");
  return true;
}
async function refresh() {
  state = await api("/state");
  const r = state.room;
  renderGuide();
  window.CFIViews?.room(r);
  if (roomId !== r?.id) {
    stopHold();
    roomId = r?.id;
    selected = window.CFIViews?.selected(r?.id) || null;
    revision = null;
  }
  if (!r) {
    $("table-close").textContent = "PLACE A CALL ↗";
    $("table-listen").disabled = true;
    $("table-add").disabled = true;
    $("table-qualify").disabled = true;
    return;
  }
  if (!r.nodes.some((n) => n.id === selected)) selected = null;
  if (!selected && r.nodes.length) selected = r.nodes[0].id;
  if (holding && !open()) stopHold();
  $("table-phase").textContent =
    {
      calling: "DIALLING",
      listening: "LISTENING TO THE OTHER END",
      open: "IN CONTACT",
      closed: "THIS ENCOUNTER HAS DEPARTED",
      unavailable: "NO CARRIER",
      interrupted: "THE LINE WAS INTERRUPTED",
    }[r.phase] || r.phase;
  $("table-id").textContent =
    r.id.slice(0, 8).toUpperCase() +
    " / " +
    Object.keys(r.participants).length +
    " PARTICIPANTS";
  $("table-question").textContent = r.question;
  $("table-age").innerHTML = "THE QUESTION<br>REMAINS OPEN";
  $("table-close").textContent = open()
    ? "GOODBYE ↙"
    : "PLACE ANOTHER CALL ↗";
  $("table-close").disabled = Boolean(open() && r.owner !== state.me?.id);
  $("empty-invitation").hidden = Boolean(
    r.nodes.length || ["calling", "listening", "unavailable"].includes(r.phase),
  );
  $("table-wait").hidden = Boolean(
    r.nodes.length ||
      !["calling", "listening", "unavailable"].includes(r.phase),
  );
  $("retry-line").hidden = r.phase !== "unavailable";
  $("table-wait").querySelector("p").innerHTML =
    r.phase === "unavailable"
      ? "No carrier.<br>The line is still here."
      : "Listening for<br>the other end.";
  $("table-who").textContent = Object.values(r.participants)
    .filter((p) => ["calling", "considering"].includes(p.status))
    .map((p) => p.name)
    .join(" / ");
  $("table-add").disabled = !open();
  $("table-qualify").disabled = !open() || !selected;
  $("table-listen").disabled =
    !open() || ["calling", "listening"].includes(r.phase);
  $("table-total").textContent = r.nodes.length + " CONTRIBUTIONS";
  $("handpiece").hidden = !r.nodes.length;
  $("handpiece-name").textContent = state.me?.name || "TAKE A PLACE";
  $("lean").disabled = !open();
  $("quarter-share").disabled = !open();
  $("oppose-share").disabled = !open();
  $("release-share").disabled = !open();
  if (revision !== r.revision) {
    renderRibbon();
    renderSelected();
    revision = r.revision;
  }
  renderVoices();
  renderHand();
  if (bubbleActor) renderBubble();
}
function renderSelected() {
  const n = current();
  $("utterance").hidden = !n;
  if (!n) return;
  window.CFIViews?.focus(state.room.id, n.id);
  $("utterance-author").textContent = who(n.author);
  $("utterance-kind").textContent = n.kind.toUpperCase();
  $("utterance-text").textContent = n.text;
  const parent = state.room.nodes.find((x) => x.id === n.parent);
  $("utterance-parent").textContent = parent
    ? "IN RESPONSE TO: " + parent.text
    : "";
  $("utterance-count").textContent =
    String(state.room.nodes.indexOf(n) + 1).padStart(2, "0") +
    " / " +
    String(state.room.nodes.length).padStart(2, "0") +
    " CONTRIBUTIONS";
  const totals = state.room.totals?.[n.id] || { support: 0, oppose: 0 };
  $("utterance-tally").textContent =
    "SUPPORT " +
    totals.support.toFixed(2) +
    " / OPPOSE " +
    totals.oppose.toFixed(2);
  renderVoices();
  renderHand();
}
function renderRibbon() {
  $("table-ribbon").innerHTML = state.room.nodes
    .map(
      (n, i) =>
        `<button class="ribbon-word ${n.id === selected ? "current" : ""}" data-id="${n.id}" aria-pressed="${n.id === selected}"><span class="ribbon-number">${String(i + 1).padStart(2, "0")}</span><span class="ribbon-text">${esc(n.text)}</span></button>`,
    )
    .join("");
  $("table-ribbon")
    .querySelectorAll("[data-id]")
    .forEach((b) => (b.onclick = () => choose(b.dataset.id)));
}
function choose(id) {
  stopHold();
  selected = id;
  renderRibbon();
  renderSelected();
}
$("prev-word").onclick = () => {
  const n = state.room.nodes,
    i = n.findIndex((x) => x.id === selected);
  choose(n[(i + n.length - 1) % n.length].id);
};
$("next-word").onclick = () => {
  const n = state.room.nodes,
    i = n.findIndex((x) => x.id === selected);
  choose(n[(i + 1) % n.length].id);
};
function renderVoices() {
  if (!state?.room) return;
  $("table-voices").innerHTML = Object.values(state.room.participants)
    .map((p, i) => {
      const v = state.room.allocations[p.id]?.values[selected] || 0;
      let status = ["calling", "considering", "waiting"].includes(p.status)
        ? p.status.toUpperCase()
        : p.status === "unavailable"
          ? "NO CARRIER"
          : v === 0
            ? "NO SHARE ON THESE WORDS"
            : `${v > 0 ? "SUPPORT" : "OPPOSITION"} ${Math.abs(v).toFixed(2)}`;
      if (
        !preview &&
        p.kind === "human" &&
        !state.room.present?.some((person) => person.id === p.id)
      )
        status += " · AWAY";
      return `<button class="table-voice ${v > 0 ? "supporting" : v < 0 ? "opposing" : ""}" data-actor="${esc(p.id)}" title="${esc(state.room.allocations[p.id]?.reason || "Read this participant’s contribution.")}" aria-label="${esc(p.name + ": " + status)}"><span class="voice-numeral">${String(i + 1).padStart(2, "0")}</span><span class="voice-label">${esc(p.name)}</span><span class="voice-detail">${esc(status)}</span></button>`;
    })
    .join("");
  $("table-voices")
    .querySelectorAll("[data-actor]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          bubbleActor =
            bubbleActor === b.dataset.actor ? null : b.dataset.actor;
          renderBubble();
        }),
    );
}
function renderBubble() {
  const box = $("voice-bubble");
  box.hidden = !bubbleActor;
  if (!bubbleActor || !state?.room) return;
  const p = state.room.participants[bubbleActor],
    ballot = state.room.allocations[bubbleActor];
  if (!p) {
    bubbleActor = null;
    box.hidden = true;
    return;
  }
  const words = state.room.nodes.filter((n) => n.author === bubbleActor);
  box.innerHTML = `<div class="bubble-heading"><span>${esc(p.name)}</span><button id="close-voice-bubble" aria-label="Close participant’s position">×</button></div><p>${esc(ballot?.reason || (p.kind === "human" ? "This person has not placed a share yet. Their words can still be part of the encounter." : open() ? "Waiting for this model’s declared allocation." : "No allocation was completed before departure."))}</p>${p.error ? `<p class="bubble-error">${esc(p.error)}${ballot ? " The previous allocation remains in the trace." : ""}</p>` : ""}<div class="bubble-allocations">${Object.entries(
    ballot?.values || {},
  )
    .map(
      ([id, v]) =>
        `<button data-bubble-node="${id}">${v > 0 ? "+" : ""}${v.toFixed(2)} → ${String(state.room.nodes.findIndex((n) => n.id === id) + 1).padStart(2, "0")}</button>`,
    )
    .join(
      "",
    )}</div>${words.length ? `<div class="bubble-caption">THIS PARTICIPANT PUT ${words.length} CONTRIBUTION${words.length === 1 ? "" : "S"} ON THE TABLE</div>` : ""}<div class="bubble-caption">DECLARED INFLUENCE · ${p.kind === "model" ? "NOT INTERNAL ATTENTION" : "ONE SHARE IN TOTAL"}</div>`;
  $("close-voice-bubble").onclick = () => {
    bubbleActor = null;
    box.hidden = true;
  };
  box.querySelectorAll("[data-bubble-node]").forEach(
    (b) =>
      (b.onclick = () => {
        choose(b.dataset.bubbleNode);
        bubbleActor = null;
        box.hidden = true;
        $("utterance").scrollIntoView({ block: "center" });
      }),
  );
  if (innerWidth > 660) {
    const button = [...$("table-voices").querySelectorAll("[data-actor]")].find(
        (b) => b.dataset.actor === bubbleActor,
      ),
      rect = button?.getBoundingClientRect();
    if (rect) {
      box.style.left =
        Math.max(15, Math.min(innerWidth - 375, rect.left)) + "px";
      box.style.top =
        Math.max(
          20,
          Math.min(
            innerHeight - box.offsetHeight - 20,
            rect.top - box.offsetHeight - 12,
          ),
        ) + "px";
    }
  } else {
    box.style.left = "";
    box.style.top = "";
  }
}
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    bubbleActor = null;
    $("voice-bubble").hidden = true;
  }
});
window.addEventListener("resize", () => {
  if (bubbleActor) renderBubble();
});
function renderHand() {
  const r = state?.room;
  if (!r) return;
  const b = r.allocations[state.me?.id]?.values || {},
    v = b[selected] || 0,
    used = Object.values(b).reduce((s, n) => s + Math.abs(n), 0);
  $("handpiece-budget").textContent =
    (1 - used).toFixed(2) +
    " FREE / " +
    (v > 0 ? "+" : "") +
    v.toFixed(2) +
    " HERE";
  $("handpiece-progress").style.strokeDashoffset = String(
    106.82 * (1 - Math.abs(v)),
  );
  $("lean").querySelector("span").innerHTML =
    "HOLD TO<br>" + (intent > 0 ? "SUPPORT" : "OPPOSE");
  $("handpiece-explain").textContent = holding
    ? "Moving your existing share here. Release to stop."
    : "Click ±¼, or hold the glass for more. You have one share across the whole table.";
}
document.querySelectorAll("[data-intent]").forEach(
  (b) =>
    (b.onclick = guard(async () => {
      stopHold();
      intent = Number(b.dataset.intent);
      document.querySelectorAll("[data-intent]").forEach((x) => {
        x.classList.toggle("chosen", x === b);
        x.setAttribute("aria-pressed", String(x === b));
      });
      renderHand();
      await moveShare(0.25);
    })),
);
async function moveShare(step) {
  if (needName() || !selected || !open() || sending) return;
  sending = true;
  try {
    const values = { ...(state.room.allocations[state.me.id]?.values || {}) };
    const old = values[selected] || 0;
    const next =
      step === null
        ? 0
        : Math.round(Math.max(-1, Math.min(1, old + intent * step)) * 10000) /
          10000;
    let others = Object.entries(values)
        .filter(([id]) => id !== selected)
        .reduce((sum, [, v]) => sum + Math.abs(v), 0),
      capacity = 1 - Math.abs(next);
    if (others > capacity)
      for (const id of Object.keys(values))
        if (id !== selected) values[id] = (values[id] * capacity) / others;
    if (next) values[selected] = next;
    else delete values[selected];
    await api("/allocate", {
      values,
      reason:
        "Explicit " +
        (intent > 0 ? "support" : "opposition") +
        " placed with the table control.",
    });
    await refresh();
  } finally {
    sending = false;
  }
}
function stopHold() {
  holding = false;
  clearTimeout(holdTimer);
  $("lean").classList.remove("holding");
  renderHand();
}
async function advanceHold() {
  if (!holding) return;
  try {
    await moveShare(0.1);
  } catch (e) {
    tell(e.message);
    stopHold();
    return;
  }
  if (holding) holdTimer = setTimeout(advanceHold, 180);
}
function startHold() {
  if (needName() || !selected || !open()) return;
  holding = true;
  $("lean").classList.add("holding");
  advanceHold();
}
$("lean").addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  $("lean").setPointerCapture(e.pointerId);
  startHold();
});
for (const e of ["pointerup", "pointercancel", "lostpointercapture"])
  $("lean").addEventListener(e, stopHold);
$("lean").addEventListener("keydown", (e) => {
  if ([" ", "Enter"].includes(e.key)) {
    e.preventDefault();
    if (!e.repeat) startHold();
  }
});
$("lean").addEventListener("keyup", (e) => {
  if ([" ", "Enter"].includes(e.key)) {
    e.preventDefault();
    stopHold();
  }
});
window.addEventListener("blur", stopHold);
document.addEventListener("visibilitychange", () => {
  if (document.hidden) stopHold();
});

$("release-share").onclick = guard(() => moveShare(null));
function compose(kind) {
  if (needName()) return;
  if (!$("table-words").value || !composerRoom) {
    composerParent = selected;
    composerRoom = state.room.id;
    $("table-relation").value = kind;
  }
  $("table-inline").hidden = false;
  showDraftAnchor();
  [...$("table-relation").options].forEach(
    (o) =>
      (o.disabled =
        !selected &&
        ["qualification", "objection", "continuation"].includes(o.value)),
  );
  saveDraft();
  $("table-words").focus();
  $("table-inline").scrollIntoView({
    behavior: matchMedia("(prefers-reduced-motion:reduce)").matches
      ? "instant"
      : "smooth",
    block: "nearest",
  });
}
$("table-add").onclick = () => compose("answer");
$("table-qualify").onclick = () => compose("qualification");
$("hide-inline").onclick = () => ($("table-inline").hidden = true);
$("table-contribution").onsubmit = guard(async (e) => {
  e.preventDefault();
  if (postingWords) return;
  postingWords = true;
  const submitter = e.submitter;
  if (submitter) submitter.disabled = true;
  try {
    const kind = $("table-relation").value;
    const node = await api("/contribute", {
      room_id: composerRoom,
      text: $("table-words").value,
      kind,
      parent: ["qualification", "objection", "continuation"].includes(kind)
        ? composerParent
        : null,
    });
    selected = node.id;
    $("table-words").value = "";
    window.CFIViews?.write("table-draft", null);
    $("table-add").textContent = "ADD YOUR WORDS +";
    $("table-inline").hidden = true;
    await refresh();
    $("table-guide").scrollIntoView({ block: "start" });
    tell("Your exact words have a place. The others can now respond to them.");
  } finally {
    postingWords = false;
    if (submitter) submitter.disabled = false;
  }
});
$("table-listen").onclick = guard(async () => {
  if (needName()) return;
  await api("/listen", {});
  await refresh();
});
$("table-close").onclick = guard(async () => {
  if (open()) {
    await api("/close", {});
    stopHold();
    stopAudio();
    await refresh();
    tell("The whole encounter is preserved.");
  } else show("call-dialog");
});
$("retry-line").onclick = guard(async () => {
  if (needName()) return;
  await api("/listen", {});
  await refresh();
});
$("first-dial").onclick = () => show("call-dialog");
$("table-rules").onclick = () => show("rules-dialog");
$("table-help-top").onclick = () => show("rules-dialog");
$("table-name-form").onsubmit = guard(async (e) => {
  e.preventDefault();
  await api("/identity", { name: $("late-name").value });
  $("name-dialog").close();
  await refresh();
});
$("table-dial-form").onsubmit = guard(async (e) => {
  e.preventDefault();
  const button = e.submitter;
  button.disabled = true;
  try {
    if (!state.me) await api("/identity", { name: $("caller-name").value });
    await api("/dial", {
      question: $("call-question").value,
      models: [...document.querySelectorAll("#table-models input:checked")].map(
        (i) => i.value,
      ),
    });
    $("call-dialog").close();
    dialSound();
    revision = null;
    await refresh();
  } finally {
    button.disabled = false;
  }
});
$("table-read").onclick = () => {
  if (!state?.room) {
    tell("There is no trace yet. Place a call first.");
    return;
  }
  const r = state.room;
  $("trace-contents").innerHTML =
    `<h2>${esc(r.question)}</h2><p>${r.nodes.length} contributions. Support and opposition remain separate. Nothing has been collapsed into a winning answer.</p>` +
    r.nodes
      .map((n, i) => {
        const t = r.totals?.[n.id] || { support: 0, oppose: 0 };
        return `<article class="trace-statement"><header><span>${String(i + 1).padStart(2, "0")} / ${esc(who(n.author))}</span><span>${esc(n.kind.toUpperCase())}</span></header><p>${esc(n.text)}</p><footer>SUPPORT ${t.support.toFixed(2)} / OPPOSE ${t.oppose.toFixed(2)}${n.parent ? " / RESPONDS TO " + (r.nodes.findIndex((x) => x.id === n.parent) + 1) : ""}</footer></article>`;
      })
      .join("") +
    (!preview
      ? `<a class="trace-download" href="/api/receipt/${r.id}" download>TAKE THE EXACT RECEIPT ↓</a>`
      : "<p>This is a local preview of an actual recorded encounter.</p>");
  show("trace-dialog");
};
function stopAudio() {
  soundNodes.forEach((n) => {
    try {
      n.stop();
    } catch {}
  });
  soundNodes = [];
}
$("table-sound").onclick = () => {
  enabledSound = !enabledSound;
  $("table-sound").textContent = enabledSound ? "SOUND ON" : "SOUND OFF";
  $("table-sound").setAttribute("aria-pressed", String(enabledSound));
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
  tone(2100, 2.5, 1.3, 0.025);
  for (let i = 0; i < 30; i++)
    tone(800 + ((i * 571) % 2400), 4 + i * 0.055, 0.052, 0.012, "sawtooth");
  tone(1200, 5.8, 0.4, 0.01);
  tone(2400, 5.8, 0.4, 0.01);
}
async function init() {
  await refresh();
  const data = await api("/models");
  $("table-models").innerHTML = data.models
    .map(
      (m) =>
        `<label><input type="checkbox" value="${esc(m.name)}" ${["qwen3:14b", "phi3:mini", "qwen2.5:1.5b"].includes(m.name) ? "checked" : ""}>${esc(m.name)}</label>`,
    )
    .join("");
  if (state.me) {
    $("caller-name").value = state.me.name;
    $("caller-name").disabled = true;
  }
}
init().catch((e) => tell(e.message));
setInterval(() => {
  if (!document.hidden && !sending)
    refresh().catch(() => {
      if (holding && !open()) stopHold();
      $("table-phase").textContent = "THE LOCAL LINE HAS GONE QUIET";
    });
}, 1300);

$("memory-question").onclick = () => {
  $("call-question").value =
    "We can preserve one shared memory, but one person wants their contribution erased. What should happen?";
  $("call-question").focus();
};

// A visible catalogue gives the whole encounter a reachable place.
function browse() {
  const text = $("browse-filter").value.toLocaleLowerCase();
  const nodes = state.room.nodes.filter((n) =>
    (n.text + " " + who(n.author)).toLocaleLowerCase().includes(text),
  );
  $("browse-count").textContent =
    nodes.length +
    " of " +
    state.room.nodes.length +
    " contributions · select one to return to it";
  $("browse-results").innerHTML = nodes
    .map(
      (n) =>
        `<button class="browse-result" data-node="${n.id}"><span>${String(state.room.nodes.indexOf(n) + 1).padStart(2, "0")} / ${esc(who(n.author))} / ${esc(n.kind)}</span><p>${esc(n.text)}</p></button>`,
    )
    .join("");
  $("browse-results")
    .querySelectorAll("button")
    .forEach(
      (b) =>
        (b.onclick = () => {
          choose(b.dataset.node);
          $("browse-dialog").close();
          $("browse-words").focus();
        }),
    );
}
$("browse-words").onclick = () => {
  $("browse-filter").value = "";
  browse();
  show("browse-dialog");
};
$("browse-filter").oninput = browse;
function showDraftAnchor() {
  const n =
    state?.room?.id === composerRoom
      ? state.room.nodes.find((n) => n.id === composerParent)
      : null;
  const related = ["qualification", "objection", "continuation"].includes(
    $("table-relation").value,
  );
  $("compose-anchor").textContent = related
    ? n
      ? "Replying to " + who(n.author) + ": “" + n.text + "”"
      : "This draft belongs to the earlier encounter. Its original link has been retained."
    : "A new contribution to encounter " +
      (composerRoom?.slice(0, 8).toUpperCase() || "");
}
function saveDraft() {
  window.CFIViews?.write(
    "table-draft",
    $("table-words").value
      ? {
          text: $("table-words").value,
          kind: $("table-relation").value,
          room: composerRoom,
          parent: composerParent,
        }
      : null,
  );
}
$("table-words").addEventListener("input", saveDraft);
$("table-relation").addEventListener("change", () => {
  showDraftAnchor();
  saveDraft();
});
window.addEventListener("pagehide", () => {
  stopHold();
  saveDraft();
});
const savedDraft = window.CFIViews?.read("table-draft");
if (savedDraft?.text) {
  $("table-words").value = savedDraft.text;
  $("table-relation").value = savedDraft.kind;
  composerRoom = savedDraft.room;
  composerParent = savedDraft.parent;
  $("table-add").textContent = "RESUME YOUR WORDS +";
}

function renderGuide() {
  const r = state?.room;
  let title = "BEGIN WITH A QUESTION",
    text =
      "Place a call and invite the other hands. Then read their answers and add your own.",
    label = "",
    action = null;
  if (r) {
    if (r.phase === "closing") {
      title = "CLOSING THE LINE";
      text =
        "The current call is finishing. Its words and positions will stay in the trace.";
    } else if (["closed", "interrupted"].includes(r.phase)) {
      title = "THIS ENCOUNTER IS PRESERVED";
      text =
        "You can still read every contribution and compare the views. Begin another question when you are ready.";
      label = "PLACE ANOTHER CALL ↗";
      action = () => show("call-dialog");
    } else if (r.phase === "unavailable") {
      title = "NO ONE ANSWERED YET";
      text =
        "The question is still here. Try the line again to invite the same models.";
      label = "TRY AGAIN ↗";
      action = () => $("retry-line").click();
    } else if (["calling", "listening"].includes(r.phase)) {
      title = "THE OTHER HANDS ARE WRITING";
      text =
        "Replies will appear on the table as they arrive. You can read, switch views, or add your words while you wait.";
      label = "ADD YOUR WORDS +";
      action = () => compose("answer");
    } else if (!state.me) {
      title = "THERE IS A PLACE FOR YOU";
      text =
        "Read any contribution. Take a place when you want to add words or put your share behind them.";
      label = "TAKE A PLACE ↗";
      action = () => needName();
    } else {
      const ballots = Object.entries(r.allocations).filter(([id]) =>
        id.startsWith("model:"),
      );
      const fresh = r.nodes.some(
        (n) =>
          n.author === state.me.id &&
          ballots.some(([, b]) => !b.based_on?.includes(n.id)),
      );
      if (fresh) {
        title = "YOUR WORDS ARE ON THE TABLE";
        text =
          "The models have not considered them yet. Invite a response when you are ready; your exact words stay in the encounter.";
        label = "ASK THE MODELS TO RESPOND ↗";
        action = () => $("table-listen").click();
      } else {
        title = "WHERE DO YOU STAND?";
        text =
          "Browse the contributions. Click +¼ to support or −¼ to oppose these words. Add your own if something is missing.";
        label = "ADD YOUR WORDS +";
        action = () => compose("answer");
      }
    }
  }
  $("guide-title").textContent = title;
  $("table-next-step").textContent = text;
  $("guide-action").hidden = !action;
  $("guide-action").textContent = label;
  $("guide-action").onclick = action;
}

window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    selected = window.CFIViews?.selected(roomId) || selected;
    revision = null;
    refresh().catch((e) => tell(e.message));
  }
});
