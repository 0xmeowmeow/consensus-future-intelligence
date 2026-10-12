let postingWords = false,
  composerRoom = null,
  composerParent = null;
const $ = (id) => document.getElementById(id);
const esc = (text) =>
  String(text ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const palette = [
  "#ff957a",
  "#b3a8ff",
  "#9cccde",
  "#d9f57a",
  "#e9ba6b",
  "#da92c0",
];
let state = null,
  selected = null,
  lastRevision = null,
  lastRoom = null,
  omitted = null,
  models = [],
  pending = false;
let sound = false,
  audio = null,
  audioNodes = [],
  noticeTimer,
  coordinates = {},
  latestTrace = null;
let listMode = matchMedia("(max-width:760px)").matches;
let seedResultSeen = null;
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
  const banner = document.createElement("div");
  banner.className = "preview-banner";
  banner.textContent =
    "RECORDED REAL ENCOUNTER · YOUR CHANGES STAY IN THIS PREVIEW";
  document.body.prepend(banner);
}

async function api(path, body) {
  if (body && ["/contribute", "/allocate", "/listen", "/close"].includes(path))
    body = { room_id: state?.room?.id, ...body };
  if (preview) {
    const r = preview.room;
    if (path.startsWith("/state")) {
      function sum(omit) {
        const t = Object.fromEntries(
          r.nodes.map((n) => [
            n.id,
            { support: 0, oppose: 0, net: 0, voices: [] },
          ]),
        );
        for (const [a, b] of Object.entries(r.allocations)) {
          if (a === omit) continue;
          for (const [id, v] of Object.entries(b.values)) {
            if (t[id]) {
              t[id][v >= 0 ? "support" : "oppose"] += Math.abs(v);
              t[id].net += v;
              t[id].voices.push({ actor: a, amount: v });
            }
          }
        }
        return t;
      }
      r.totals = sum();
      const omit = new URLSearchParams(path.split("?")[1]).get("omit");
      if (omit) r.without = sum(omit);
      return structuredClone(preview);
    }
    if (path.startsWith("/seed/example/")) {
      const example = preview.seed_examples?.[path.split("/").at(-1)];
      if (example) return structuredClone(example);
    }
    if (path === "/models")
      return { models: r.models.map((name) => ({ name })) };
    if (path === "/allocate") {
      if (
        Object.values(body.values).reduce((s, v) => s + Math.abs(v), 0) >
        1.000001
      )
        throw Error(
          "You have one share in total. Release some pressure first.",
        );
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
    if (path.startsWith("/call/")) {
      const call = preview.call_records?.find(
        (c) => c.id === path.split("/").at(-1),
      );
      if (call) return call;
    }
    if (
      path === "/seed/inspect" &&
      preview.seed_inspection &&
      body.text === preview.seed_inspection.text &&
      body.target === preview.seed_inspection.gradient?.target
    )
      return structuredClone(preview.seed_inspection);
    throw Error(
      "This picker preserves a recorded real encounter. Open the live instrument on port 8775 to call models or inspect a different input.",
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
    throw Error(
      "The local server returned an unreadable response. Your last saved trace remains on disk.",
    );
  }
  if (!response.ok)
    throw Error(data.error || data.detail || "The local request failed.");
  return data;
}
function notice(text, error = false) {
  clearTimeout(noticeTimer);
  $("notice").textContent = text;
  $("notice").className = "notice visible" + (error ? " error" : "");
  noticeTimer = setTimeout(
    () => $("notice").classList.remove("visible"),
    error ? 9000 : 5000,
  );
}
function guarded(fn) {
  return async (event) => {
    try {
      await fn(event);
    } catch (e) {
      notice(e.message, true);
    }
  };
}
function colour(id) {
  if (!state?.room) return palette[3];
  const people = Object.values(state.room.participants),
    modelPeople = people.filter((p) => p.kind === "model");
  const index = modelPeople.findIndex((p) => p.id === id);
  return index >= 0
    ? palette[index % 3]
    : palette[
        3 +
          (Math.max(
            0,
            people
              .filter((p) => p.kind === "human")
              .findIndex((p) => p.id === id),
          ) %
            3)
      ];
}
function person(id) {
  return state?.room?.participants[id]?.name || "Participant";
}
function date(value) {
  return new Date(value * 1000).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
function show(id) {
  if (!$(id).open) $(id).showModal();
}
$("my-name").onclick = () => {
  if (!state?.me) show("join-dialog");
  else
    notice(
      "You are " +
        state.me.name +
        ". Your identity has one share across all tabs.",
    );
};
$("join-form").onsubmit = guarded(async (e) => {
  e.preventDefault();
  await api("/identity", { name: $("join-name").value });
  $("join-dialog").close();
  await refresh();
});
document
  .querySelectorAll("[data-close]")
  .forEach(
    (button) => (button.onclick = () => $(button.dataset.close).close()),
  );
document.querySelectorAll("dialog").forEach((dialog) =>
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      )
        dialog.close();
    }
  }),
);

async function loadModels() {
  const data = await api("/models");
  models = data.models;
  $("model-choices").innerHTML = models
    .map(
      (m) =>
        `<label><input type="checkbox" value="${esc(m.name)}" ${["qwen2.5:1.5b", "phi3:mini", "qwen3:14b"].includes(m.name) ? "checked" : ""}><span>${esc(m.name)} <small>${esc(m.parameters || "")}</small></span></label>`,
    )
    .join("");
}
$("refresh-models").onclick = guarded(loadModels);
document.querySelectorAll("[data-question]").forEach(
  (b) =>
    (b.onclick = () => {
      $("question").value = b.dataset.question;
      $("question").focus();
    }),
);
$("dial-form").onsubmit = guarded(async (e) => {
  e.preventDefault();
  if (pending) return;
  pending = true;
  $("dial-button").disabled = true;
  try {
    if (!state?.me) await api("/identity", { name: $("name").value });
    const chosen = [
      ...document.querySelectorAll("#model-choices input:checked"),
    ].map((x) => x.value);
    await api("/dial", { question: $("question").value, models: chosen });
    selected = null;
    omitted = null;
    modem();
    await refresh();
  } finally {
    pending = false;
    $("dial-button").disabled = false;
  }
});
$("sound-toggle").onclick = () => {
  sound = !sound;
  $("sound-toggle").textContent = sound ? "SOUND ON" : "SOUND OFF";
  $("sound-toggle").setAttribute("aria-pressed", String(sound));
  if (sound) {
    audio ||= new AudioContext();
    audio.resume();
  } else stopSound();
};
function stopSound() {
  for (const n of audioNodes) {
    try {
      n.stop();
    } catch {}
  }
  audioNodes = [];
}
function modem() {
  if (!sound) return;
  audio ||= new AudioContext();
  audio.resume();
  stopSound();
  const start = audio.currentTime;
  function tone(freq, delay, length, level = 0.025, type = "sine") {
    const o = audio.createOscillator(),
      g = audio.createGain();
    o.type = type;
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, start + delay);
    g.gain.linearRampToValueAtTime(level, start + delay + 0.015);
    g.gain.setValueAtTime(level, start + delay + Math.max(0.02, length - 0.03));
    g.gain.linearRampToValueAtTime(0, start + delay + length);
    o.connect(g).connect(audio.destination);
    o.start(start + delay);
    o.stop(start + delay + length);
    audioNodes.push(o);
  }
  tone(350, 0, 0.6);
  tone(440, 0, 0.6);
  [
    [697, 1209],
    [770, 1336],
    [852, 1477],
    [941, 1209],
    [697, 1336],
    [852, 1209],
  ].forEach((p, i) => p.forEach((f) => tone(f, 0.85 + i * 0.22, 0.12)));
  tone(2100, 2.5, 1.25, 0.02);
  tone(1200, 3.85, 0.4, 0.03, "square");
  tone(1800, 4.3, 0.3, 0.018, "square");
  for (let i = 0; i < 28; i++)
    tone(900 + ((i * 577) % 2300), 4.7 + i * 0.044, 0.046, 0.012, "sawtooth");
  tone(1200, 6, 0.5, 0.012);
  tone(2400, 6, 0.5, 0.008);
}
function tickSound() {
  if (!sound || !audio) return;
  const o = audio.createOscillator(),
    g = audio.createGain();
  o.frequency.value = 430;
  g.gain.value = 0.014;
  o.connect(g).connect(audio.destination);
  g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.12);
  o.start();
  o.stop(audio.currentTime + 0.13);
}

async function refresh() {
  const data = await api(
    "/state" + (omitted ? "?omit=" + encodeURIComponent(omitted) : ""),
  );
  state = data;
  if (data.me) {
    $("name").value = data.me.name;
    $("name").disabled = true;
    $("my-name").textContent = data.me.name;
  }
  const room = data.room;
  window.CFIViews?.room(room);
  if (room?.id !== lastRoom) {
    selected = window.CFIViews?.selected(room?.id) || null;
    lastRevision = null;
    lastRoom = room?.id;
  }
  const active =
    room && !["closed", "interrupted", "closing"].includes(room.phase);
  $("call-slip").hidden = Boolean(active);
  $("hand-panel").hidden = !room;
  $("close-call").hidden = !active || room.owner !== data.me?.id;
  $("close-call").disabled = false;
  if (room) {
    $("question-strip").innerHTML =
      `<span>${esc(room.id.slice(0, 8).toUpperCase())} / ${esc(room.phase.toUpperCase())}</span><p>${esc(room.question)}</p>`;
    $("trace-count").textContent =
      `${room.nodes.length} CONTRIBUTIONS / ${Object.keys(room.allocations).length} ALLOCATIONS`;
    $("frame-note").textContent = omitted
      ? "RECALCULATED WITHOUT ONE VOICE"
      : "EXACT WORDS / DECLARED INFLUENCE";
    $("connection-state").textContent =
      {
        calling: "PLACING THE CALL",
        listening: "THE OTHER SIDE IS RESPONDING",
        open: "IN CONTACT",
        closed: "THE LINE HAS CLOSED",
        interrupted: "THE TRACE SURVIVED THE INTERRUPTION",
        unavailable: "NO GUEST CONNECTED",
      }[room.phase] || room.phase.toUpperCase();
    $("connection-lamp").classList.toggle("active", active);
    $("foot-state").textContent =
      `ENCOUNTER ${room.id.slice(0, 8).toUpperCase()} / ${active ? "OPEN" : "PRESERVED"}`;
    const busy = ["calling", "listening"].includes(room.phase);
    $("hear-again").disabled = busy || !active;
    $("add-words").disabled = !active;
    $("field-caption").hidden = room.nodes.length > 0;
    if (room.revision !== lastRevision) {
      renderGraph();
      renderVoices();
      renderSelection();
      lastRevision = room.revision;
    }
    updateShare();
  } else {
    $("field-caption").hidden = false;
    drawQuiet();
  }
  if (
    data.seed_job.status === "complete" &&
    data.seed_job.result.id !== seedResultSeen
  ) {
    seedResultSeen = data.seed_job.result.id;
    seedFinished(data.seed_job.result);
  }
  if (data.seed_job.status === "failed")
    $("seed-status").textContent = "Training stopped: " + data.seed_job.error;
  if (data.seed_job.status === "running")
    $("seed-status").textContent =
      "Fitting a separate copy to your exact prompt and target. The origin is untouched.";
  $("seed-train").disabled = data.seed_job.status === "running";
}
function updateShare() {
  const values = state.room?.allocations[state.me?.id]?.values || {};
  const used = Object.values(values).reduce((a, v) => a + Math.abs(v), 0);
  $("share-value").textContent = Math.max(0, 1 - used).toFixed(2);
  $("share-ring").style.strokeDashoffset = String(182.2 * used);
}
function renderVoices() {
  const room = state.room;
  $("voices").innerHTML = Object.values(room.participants)
    .map((p) => {
      const ballot = room.allocations[p.id];
      const used = Object.values(ballot?.values || {}).reduce(
        (a, v) => a + Math.abs(v),
        0,
      );
      const status = p.error
        ? "UNAVAILABLE · " + p.error
        : p.status === "considering"
          ? "CONSIDERING THE CIRCLE"
          : p.status === "calling"
            ? "CONNECTING…"
            : `${used.toFixed(2)} / 1 SHARE PLACED`;
      return `<button class="voice ${omitted === p.id ? "omitted" : ""}" data-voice="${esc(p.id)}" style="--voice:${colour(p.id)}" title="${esc(ballot?.reason || "Compare the declared result with this voice removed.")}" aria-pressed="${omitted === p.id}"><span class="voice-symbol ${p.kind === "human" ? "human" : ""}"></span><span class="voice-name">${esc(p.name)}</span><span class="voice-state">${esc(status)}</span></button>`;
    })
    .join("");
  $("voices")
    .querySelectorAll("[data-voice]")
    .forEach(
      (b) =>
        (b.onclick = guarded(async () => {
          omitted = omitted === b.dataset.voice ? null : b.dataset.voice;
          lastRevision = null;
          await refresh();
          notice(
            omitted
              ? "Comparison only: removing this declared allocation. No contribution has been deleted."
              : "All voices restored to the comparison.",
          );
        })),
    );
}
function renderGraph() {
  const room = state.room,
    nodes = room.nodes,
    wrap = $("graph-wrap"),
    width = wrap.clientWidth;
  $("field").classList.toggle("list-mode", listMode);
  $("list-view").setAttribute("aria-pressed", String(listMode));
  $("list-view").textContent = listMode ? "CIRCUIT VIEW" : "TEXT VIEW";
  $("quiet-field").hidden = nodes.length > 0;
  if (!nodes.length) {
    $("graph").innerHTML = "";
    $("wires").innerHTML = "";
    drawQuiet();
    return;
  }
  const columns = Math.max(1, Math.min(4, Math.floor(width / 235)));
  const rows = Math.ceil(nodes.length / columns),
    height = Math.max(470, rows * 166 + 110);
  wrap.style.minHeight = listMode ? "420px" : Math.min(height, 950) + "px";
  if (!listMode) {
    wrap.style.overflowY = height > 950 ? "auto" : "hidden";
    $("graph").style.height = height + "px";
    $("wires").style.height = height + "px";
  } else {
    $("graph").style.height = "";
    $("wires").style.height = "";
    wrap.style.overflowY = "auto";
  }
  coordinates = {};
  const totals = omitted ? room.without : room.totals;
  $("graph").innerHTML = nodes
    .map((n, index) => {
      const row = Math.floor(index / columns),
        col = index % columns;
      const x = ((col + 0.5) * width) / columns,
        y = 80 + row * 166 + (col % 2 ? 25 : 0);
      coordinates[n.id] = { x, y };
      const t = totals?.[n.id] || { support: 0, oppose: 0 };
      return `<button class="node ${n.parent ? "related" : ""} ${selected === n.id ? "selected" : ""}" style="left:${x}px;top:${y}px;--node-color:${colour(n.author)}" data-node="${n.id}" aria-pressed="${selected === n.id}"><span class="node-meta"><span>${esc(person(n.author))}</span><span>${String(index + 1).padStart(2, "0")}</span></span><span class="node-preview">${esc(n.text)}</span><span class="node-score"><span>+${t.support.toFixed(2)}</span><span>−${t.oppose.toFixed(2)}</span><span>${esc(n.kind.toUpperCase())}</span></span></button>`;
    })
    .join("");
  $("graph")
    .querySelectorAll("[data-node]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          selected = b.dataset.node;
          window.CFIViews?.focus(state.room.id, selected);
          document.querySelectorAll(".node.selected").forEach((n) => {
            n.classList.remove("selected");
            n.setAttribute("aria-pressed", "false");
          });
          b.classList.add("selected");
          b.setAttribute("aria-pressed", "true");
          renderSelection();
          drawWires();
          if (innerWidth < 761)
            $("hand-panel").scrollIntoView({
              behavior: matchMedia("(prefers-reduced-motion:reduce)").matches
                ? "instant"
                : "smooth",
              block: "start",
            });
        }),
    );
  drawWires();
}
function drawWires() {
  if (listMode || !state?.room?.nodes.length) return;
  const room = state.room,
    width = $("graph-wrap").clientWidth,
    height = parseFloat($("graph").style.height) || 500;
  const svg = $("wires");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  let paths = "";
  for (const n of room.nodes) {
    if (n.parent && coordinates[n.parent]) {
      const p = coordinates[n.parent],
        c = coordinates[n.id];
      paths += `<path d="M${p.x} ${p.y + 50} C${p.x} ${p.y + 100},${c.x} ${c.y - 90},${c.x} ${c.y - 48}" fill="none" stroke="${colour(n.author)}" stroke-width="1" stroke-dasharray="3 5" opacity=".65"/>`;
    }
  }
  const voices = Object.keys(room.participants);
  voices.forEach((id, i) => {
    const sx = 24 + (i * (width - 48)) / Math.max(1, voices.length - 1),
      sy = height - 32,
      c = colour(id);
    const ballot = room.allocations[id]?.values || {};
    if (id === omitted) return;
    for (const [nid, v] of Object.entries(ballot)) {
      const point = coordinates[nid];
      if (!point) continue;
      const strong = !selected || selected === nid;
      paths += `<path d="M${sx} ${sy} C${sx} ${sy - 100},${point.x} ${point.y + 100},${point.x} ${point.y + 45}" fill="none" stroke="${c}" stroke-width="${0.7 + Math.abs(v) * 2.5}" ${v < 0 ? 'stroke-dasharray="4 7"' : ""} opacity="${strong ? 0.6 : 0.12}"/>`;
    }
    const r = 10;
    paths += `<g transform="translate(${sx},${sy})"><path d="M0 -${r + 6} C-${r + 12} -${r + 4},-${r + 7} 8,0 19 C${r + 7} 8,${r + 12} -${r + 4},0 -${r + 6}Z" fill="#14160f" stroke="${c}" stroke-width="1.5"/><circle r="4" fill="${c}"/></g>`;
  });
  svg.innerHTML = paths;
}
function renderSelection() {
  const room = state.room,
    n = room.nodes.find((n) => n.id === selected);
  if (!n) {
    $("selected").innerHTML =
      '<p class="selection-empty">Every thread begins<br>with someone\'s<br>actual words.</p>';
    return;
  }
  const t = (omitted ? room.without : room.totals)?.[n.id] || {
    support: 0,
    oppose: 0,
    voices: [],
  };
  const current = room.allocations[state.me?.id]?.values[n.id] || 0;
  const active = !["closed", "interrupted", "closing"].includes(room.phase);
  const parent = room.nodes.find((p) => p.id === n.parent);
  $("selected").innerHTML =
    `<div class="node-author" style="--node-color:${colour(n.author)}"><span>${esc(person(n.author))}</span><span>${esc(n.kind.toUpperCase())}</span></div><p class="node-full">${esc(n.text)}</p>${parent ? `<p class="node-relation">RESPONDS TO: “${esc(parent.text)}”</p>` : ""}<div class="node-tally"><span>SUPPORT <strong>${t.support.toFixed(2)}</strong></span><span>OPPOSE <strong>${t.oppose.toFixed(2)}</strong></span></div>${t.voices.map((v) => `<div class="allocation-voice" style="--voice:${colour(v.actor)}">${esc(person(v.actor))} ${v.amount > 0 ? "+" : ""}${v.amount.toFixed(2)}</div>`).join("")}<div class="allocation-controls"><button class="support" id="support-node" ${!active ? "disabled" : ""}>+¼ SUPPORT</button><button class="oppose" id="oppose-node" ${!active ? "disabled" : ""}>−¼ OPPOSE</button><button id="release-node" ${!active ? "disabled" : ""}>RELEASE</button></div><p class="quiet">Your allocation here: ${current > 0 ? "+" : ""}${current.toFixed(2)}. Hovering and reading do not change it.</p><div class="node-links"><button id="qualify-node" ${!active ? "disabled" : ""}>ADD A CONDITION ↗</button><button id="object-node" ${!active ? "disabled" : ""}>WRITE AN OBJECTION ↗</button><button id="develop-node" ${!active || ["calling", "listening"].includes(room.phase) ? "disabled" : ""}>ASK THEM TO FOLLOW THIS THREAD ↗</button>${n.source ? '<button id="inspect-tokens">SEE THE GENERATION TOKENS ↗</button>' : ""}<a href="workshop.html?room=${room.id}&node=${n.id}">INSPECT THESE WORDS ↗</a><a href="record.html?room=${room.id}&node=${n.id}">FOLLOW THEIR CHANGES ↗</a><button id="to-seed">TAKE THESE WORDS TO THE SEED ↗</button></div>`;
  $("support-node").onclick = guarded(() => shiftAllocation(n.id, 0.25));
  $("oppose-node").onclick = guarded(() => shiftAllocation(n.id, -0.25));
  $("release-node").onclick = guarded(() => shiftAllocation(n.id, null));
  $("qualify-node").onclick = () => compose("qualification");
  $("object-node").onclick = () => compose("objection");
  $("develop-node").onclick = guarded(async () => {
    await api("/listen", { parent: n.id });
    notice("Each guest will receive this exact contribution and its context.");
    await refresh();
  });
  if ($("inspect-tokens"))
    $("inspect-tokens").onclick = guarded(() => inspectTokens(n.source));
  $("to-seed").onclick = async () => {
    try {
      const example = await api("/seed/example/" + room.id + "/" + n.id);
      show("seed-dialog");
      $("seed-prompt").value = example.prompt;
      $("seed-target").value = example.target;
      $("seed-status").textContent =
        "Exact question, parent chain and contribution copied. " +
        example.bytes +
        " UTF-8 bytes. " +
        (example.fits
          ? "Ready to inspect; training still requires your explicit action."
          : "This exceeds the seed context. Nothing was shortened; choose a smaller explicit experiment.");
    } catch (e) {
      notice(e.message, true);
    }
  };
}
async function shiftAllocation(id, amount) {
  if (!state.me) {
    show("join-dialog");
    return;
  }
  const values = { ...(state.room.allocations[state.me.id]?.values || {}) };
  if (amount === null) delete values[id];
  else values[id] = Math.round(((values[id] || 0) + amount) * 100) / 100;
  await api("/allocate", { values });
  tickSound();
  lastRevision = null;
  await refresh();
}
function compose(kind = "answer") {
  if (!state.me) {
    show("join-dialog");
    return;
  }
  if (!$("contribution").value || !composerRoom) {
    composerParent = selected;
    composerRoom = state.room.id;
    $("relation").value = kind;
  }
  $("compose-context").textContent = selected
    ? "You can respond to the selected contribution, or add an independent possibility."
    : "Add an idea the existing options missed.";
  [...$("relation").options].forEach(
    (o) =>
      (o.disabled =
        !selected &&
        ["qualification", "objection", "continuation"].includes(o.value)),
  );
  show("compose-dialog");
  $("contribution").focus();
}
$("add-words").onclick = () => compose();
$("compose-form").onsubmit = guarded(async (e) => {
  e.preventDefault();
  if (postingWords) return;
  postingWords = true;
  const submitter = e.submitter;
  if (submitter) submitter.disabled = true;
  try {
    const kind = $("relation").value;
    const node = await api("/contribute", {
      room_id: composerRoom,
      text: $("contribution").value,
      kind,
      parent: ["qualification", "objection", "continuation"].includes(kind)
        ? composerParent
        : null,
    });
    selected = node.id;
    window.CFIViews?.focus(state.room.id, selected);
    window.CFIViews?.write("exchange-draft", null);
    $("add-words").textContent = "ADD YOUR WORDS +";
    $("compose-dialog").close();
    $("contribution").value = "";
    lastRevision = null;
    await refresh();
    notice(
      "Your exact words are in the trace. Ask the others to respond when you are ready.",
    );
  } finally {
    postingWords = false;
    if (submitter) submitter.disabled = false;
  }
});
$("hear-again").onclick = guarded(async () => {
  await api("/listen", {});
  await refresh();
  notice("The guests will reconsider the current contributions.");
});
$("close-call").onclick = guarded(async () => {
  await api("/close", {});
  stopSound();
  await refresh();
  notice("The encounter is preserved, including its disagreements.");
});
$("export-trace").onclick = () => {
  if (preview) {
    notice(
      "The full original receipt is available with the live instrument. This local preview includes your unsaved experiments.",
    );
    return;
  }
  if (state.room)
    window.open("/api/receipt/" + state.room.id, "_blank", "noopener");
};
$("list-view").onclick = () => {
  listMode = !listMode;
  renderGraph();
};
$("fit-graph").onclick = () => {
  renderGraph();
  $("graph-wrap").scrollTop = 0;
};
$("how-it-works").onclick = () => show("help-dialog");
$("open-book").onclick = () => {
  $("history").innerHTML = state?.history?.length
    ? state.history
        .map(
          (r) =>
            `<div class="history-row"><div class="history-question">${esc(r.question)}</div><a href="/api/receipt/${r.id}" download>TAKE TRACE ↓</a><div class="history-meta">${esc(date(r.created))} / ${esc(r.phase.toUpperCase())} / ${esc(r.id.slice(0, 8))}</div></div>`,
        )
        .join("")
    : "<p>No encounter has left a trace here yet.</p>";
  show("book-dialog");
};
async function inspectTokens(source) {
  show("tokens-dialog");
  $("token-inspector").textContent = "Reading the actual local response…";
  const call = await api("/call/" + state.room.id + "/" + source),
    tokens = call.response.logprobs || [];
  latestTrace = call;
  if (!tokens.length) {
    $("token-inspector").innerHTML =
      "<p>This runtime did not return token probabilities for this call. The exact response remains in the receipt.</p>";
    return;
  }
  $("token-inspector").innerHTML =
    `<h2>${esc(call.model)}</h2><p class="quiet">${tokens.length} actual generation steps. ${call.request?.format ? "This call used a JSON output constraint, visible below." : "This reply used natural-language chat messages without a JSON output constraint."} Click a token to inspect the alternatives returned at that step. These are generation probabilities, not votes or attention heads.</p><div class="token-stream">${tokens.map((t, i) => `<button data-token="${i}" title="Generation token ${i + 1}">${esc(t.token)}</button>`).join("")}</div><div id="token-position" class="quiet"></div><div id="token-details" class="token-details"></div>`;
  $("token-inspector")
    .querySelectorAll("[data-token]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          $("token-inspector")
            .querySelector(".active")
            ?.classList.remove("active");
          b.classList.add("active");
          const index = Number(b.dataset.token),
            t = tokens[index];
          $("token-position").textContent =
            `STEP ${index + 1} · ACTUALLY GENERATED ${JSON.stringify(t.token)} · P = ${(Math.exp(t.logprob) * 100).toFixed(3)}%`;
          $("token-details").innerHTML = (t.top_logprobs || [])
            .map(
              (v) =>
                `<div class="token-option">${esc(JSON.stringify(v.token))}<span>${(Math.exp(v.logprob) * 100).toFixed(3)}% of next-token probability</span><div class="token-bar" style="width:${Math.exp(v.logprob) * 100}%"></div></div>`,
            )
            .join("");
        }),
    );
  $("token-inspector").querySelector("[data-token]")?.click();
}

$("open-seed").onclick = () => show("seed-dialog");
$("seed-form").onsubmit = guarded(async (e) => {
  e.preventDefault();
  $("seed-status").textContent =
    "Computing actual attention, activations and the specified gradient…";
  const data = await api("/seed/inspect", {
    text: $("seed-prompt").value,
    target: $("seed-target").value || null,
    checkpoint: $("seed-checkpoint").value,
  });
  renderSeed(data);
  $("seed-status").textContent =
    `${data.parameters.toLocaleString()} parameters · ${data.checkpoint} · weights unchanged by inspection.`;
});
function renderSeed(data) {
  let html = `<p class="seed-byte-legend">INPUT BYTES: ${data.bytes.map((b, i) => `${i}:${esc(b.label)}`).join(" · ")}</p>`;
  data.attention.forEach((layer, l) => {
    html += `<div class="layer-label"><span>LAYER ${l + 1} / FINAL INPUT POSITION ATTENDING TO EARLIER BYTES</span><span>4 HEADS</span></div><div class="head-grid">`;
    layer.forEach((head, h) => {
      html += `<div class="head"><span>HEAD ${h + 1}</span><div class="attention-strip">${head.map((v, i) => `<div class="attention-byte" style="background:rgba(217,245,122,${Math.min(1, 0.04 + v * head.length * 0.35)})" title="Layer ${l + 1}, head ${h + 1}, byte ${i} (${esc(data.bytes[i].label)}): ${(v * 100).toFixed(4)}% attention"></div>`).join("")}</div></div>`;
    });
    html +=
      '</div><div class="activation-strip">' +
      data.activations[l]
        .map(
          (v, i) =>
            `<i style="background:${v > 0 ? "rgba(179,168,255," : "rgba(255,149,122,"}${Math.min(1, Math.abs(v) / 4)})" title="Residual coordinate ${i}: ${v.toFixed(5)}"></i>`,
        )
        .join("") +
      "</div>";
  });
  html +=
    '<p class="quiet">Attention strips show measured weights; brightness is scaled by context length for visibility. Hover for the exact value. Residual strips show 64 signed activation coordinates, purple positive and orange negative; brightness saturates at magnitude 4. Coordinates have no assigned word meanings.</p><div class="layer-label">ACTUAL NEXT-BYTE PROBABILITIES</div><div class="seed-next">' +
    data.next
      .map(
        (v) =>
          `<span>${esc(v.label)}<small>${(v.p * 100).toFixed(2)}%</small></span>`,
      )
      .join("") +
    "</div>";
  if (data.gradient) {
    const g = data.gradient,
      max = Math.max(...g.parameters.map((p) => p.norm));
    html += `<div class="layer-label">GRADIENT OF THE EXACT TARGET LOSS / NLL ${g.loss.toFixed(5)}</div><p class="quiet">${esc(g.objective)} No update was applied. This gradient belongs to this checkpoint, input and objective.</p><table class="gradient-table"><thead><tr><th>PARAMETER TENSOR</th><th>SHAPE</th><th>GRADIENT L2 NORM</th></tr></thead><tbody>${g.parameters.map((p) => `<tr><td>${esc(p.name)}</td><td>${p.shape.join(" × ")}</td><td>${p.norm.toFixed(5)}<i class="gradient-norm" style="width:${(p.norm / max) * 100}%"></i></td></tr>`).join("")}</tbody></table>`;
  }
  $("seed-output").innerHTML = html;
}
$("seed-train").onclick = guarded(async () => {
  if (!state?.me) {
    show("join-dialog");
    notice(
      "Put your name on the experiment, then choose TRAIN A SEPARATE COPY again.",
    );
    return;
  }
  await api("/seed/train", {
    prompt: $("seed-prompt").value,
    target: $("seed-target").value,
  });
  $("seed-status").textContent =
    "Training a separate copy. This is your explicit example, not an endorsement by the circle.";
  $("seed-train").disabled = true;
});
function seedFinished(result) {
  if (!$("seed-checkpoint").querySelector(`[value="${result.id}"]`)) {
    const option = document.createElement("option");
    option.value = result.id;
    option.textContent = "Fitted copy " + result.id.slice(-6);
    $("seed-checkpoint").append(option);
  }
  $("seed-status").textContent =
    `Fitted-copy target loss: ${result.before_nll.toFixed(4)} → ${result.after_nll.toFixed(4)}. Select the copy to compare its actual internals. This is memorisation evidence, not a semantic understanding test.`;
  const old = $("seed-output").querySelector(".seed-result");
  if (old) old.remove();
  $("seed-output").insertAdjacentHTML(
    "afterbegin",
    `<div class="seed-result">A separate copy was trained for ${result.steps} steps on the exact target.<br>Target NLL ${result.before_nll.toFixed(4)} → ${result.after_nll.toFixed(4)}. Origin preserved.<br><a href="/api/seed/download/${result.id}" download>DOWNLOAD WEIGHTS, RECIPE AND ARCHITECTURE ↓</a></div>`,
  );
}
function drawQuiet() {
  const canvas = $("quiet-field"),
    wrap = $("graph-wrap"),
    w = wrap.clientWidth,
    h = wrap.clientHeight,
    dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const c = canvas.getContext("2d");
  c.scale(dpr, dpr);
  c.clearRect(0, 0, w, h);
  const cx = w * 0.56,
    cy = h * 0.44,
    r = Math.min(w * 0.28, h * 0.33);
  c.lineWidth = 1;
  c.strokeStyle = "#465239";
  for (let i = 0; i < 3; i++) {
    const a = -Math.PI / 2 + (i * Math.PI * 2) / 3,
      px = cx + Math.cos(a) * r,
      py = cy + Math.sin(a) * r;
    c.strokeStyle = palette[i];
    c.globalAlpha = 0.5;
    c.beginPath();
    c.arc(px, py, 20, 0, Math.PI * 2);
    c.stroke();
    c.beginPath();
    c.arc(px, py, 6, 0, Math.PI * 2);
    c.stroke();
    c.globalAlpha = 0.25;
    c.beginPath();
    c.moveTo(px, py);
    c.bezierCurveTo(px, cy, cx, py, cx, cy);
    c.stroke();
    c.fillStyle = palette[i];
    c.globalAlpha = 0.8;
    c.font = "9px Sligoil";
    c.textAlign = "center";
    c.fillText(["01 / QWEN", "02 / PHI", "03 / QWEN"][i], px, py + 38);
  }
  c.globalAlpha = 0.35;
  c.strokeStyle = "#9daa80";
  c.setLineDash([2, 8]);
  c.beginPath();
  c.arc(cx, cy, r + 55, 0, Math.PI * 2);
  c.stroke();
  c.setLineDash([]);
  c.globalAlpha = 0.8;
  c.strokeStyle = "#d9f57a";
  c.lineWidth = 1.5;
  c.beginPath();
  c.moveTo(cx, cy - 28);
  c.bezierCurveTo(cx - 47, cy - 29, cx - 32, cy + 14, cx, cy + 49);
  c.bezierCurveTo(cx + 32, cy + 14, cx + 47, cy - 29, cx, cy - 28);
  c.stroke();
  c.beginPath();
  c.arc(cx, cy, 11, 0, Math.PI * 2);
  c.stroke();
  c.globalAlpha = 1;
  c.fillStyle = "#a1ac8f";
  c.textAlign = "center";
  c.font = "8px Sligoil";
  c.fillText(
    state?.room?.phase === "listening"
      ? "AWAITING ACTUAL RESPONSES"
      : "THE CIRCUIT IS NOT YET CLOSED",
    cx,
    cy + r + 95,
  );
}
let resizeTimer;
window.addEventListener("resize", () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (state?.room) renderGraph();
    else drawQuiet();
  }, 120);
});
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) refresh().catch(() => {});
});
loadModels().catch((e) => {
  $("model-choices").textContent =
    "Local model service unavailable. Retry ↻ when it returns.";
  notice(e.message, true);
});
refresh().catch((e) => notice(e.message, true));
setInterval(() => {
  if (!document.hidden)
    refresh().catch(() => {
      $("connection-state").textContent = "LOCAL CONNECTION INTERRUPTED";
      $("connection-lamp").classList.remove("active");
    });
}, 1100);
document.fonts.ready.then(drawQuiet);

function saveExchangeDraft() {
  window.CFIViews?.write(
    "exchange-draft",
    $("contribution").value
      ? {
          text: $("contribution").value,
          kind: $("relation").value,
          room: composerRoom,
          parent: composerParent,
        }
      : null,
  );
}
$("contribution").addEventListener("input", saveExchangeDraft);
$("relation").addEventListener("change", saveExchangeDraft);
window.addEventListener("pagehide", saveExchangeDraft);
const savedDraft = window.CFIViews?.read("exchange-draft");
if (savedDraft?.text) {
  $("contribution").value = savedDraft.text;
  $("relation").value = savedDraft.kind;
  composerRoom = savedDraft.room;
  composerParent = savedDraft.parent;
  $("add-words").textContent = "RESUME YOUR WORDS +";
}

window.addEventListener("pageshow", (event) => {
  if (event.persisted) {
    selected = window.CFIViews?.selected(lastRoom) || selected;
    lastRevision = null;
    refresh().catch((e) => notice(e.message));
  }
});
