import {
  $,
  esc,
  api,
  kinds,
  name,
  when,
  scope,
  download,
} from "./instrument-common.js";
let room, me, selectedMarker, selectedTurn, noticeTimer;
const params = new URLSearchParams(location.search);
const tell = (text) => {
  $("instrument-notice").textContent = text;
  $("instrument-notice").classList.add("active");
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(
    () => $("instrument-notice").classList.remove("active"),
    7000,
  );
};
const guard = (fn) => async (e) => {
  try {
    await fn(e);
  } catch (error) {
    tell(error.message);
  }
};
async function load(rid) {
  const result = await api("/receipt/" + rid);
  room = result.room;
  $("record-updated").textContent =
    `Reading revision ${room.revision} · fetched ${new Date().toLocaleTimeString()}. Refresh to include later events.`;
  scope(room);
  $("record-question").textContent = room.question;
  $("full-receipt").href = "/api/receipt/" + rid;
  selectedMarker =
    (room.markers || []).find(
      (m) => m.id === (selectedMarker?.id || params.get("marker")),
    ) || room.markers?.at(-1);
  const options =
    '<option value="start">Before the first turn</option>' +
    (room.markers || [])
      .map(
        (m, i) =>
          `<option value="${m.id}">${i + 1}. ${esc(kinds[m.kind])} / ${when(m.created)}</option>`,
      )
      .join("") +
    '<option value="now">Latest recorded state</option>';
  const priorFrom = $("from-marker").value,
    priorTo = $("to-marker").value;
  $("from-marker").innerHTML = options;
  $("to-marker").innerHTML = options;
  $("from-marker").value = priorFrom || selectedMarker?.id || "start";
  $("to-marker").value = priorTo || "now";
  $("compare-voice").innerHTML =
    '<option value="all">All voices</option>' +
    Object.values(room.participants)
      .map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`)
      .join("");
  renderMarkers();
  flow();
  renderMarker();
  compare();
  events();
  const node = params.get("node") || window.CFIViews?.selected(room.id);
  if (node) showTurn(node);
}
function renderMarkers() {
  $("record-markers").innerHTML =
    (room.markers || [])
      .map(
        (m, i) =>
          `<button class="record-marker ${m.kind === "round" ? "round" : ""} ${m.id === selectedMarker?.id ? "active" : ""}" data-marker="${m.id}"><small>${String(i + 1).padStart(2, "0")} / ${kinds[m.kind]}</small><p>${esc(m.note)}</p><small>${esc(name(room, m.author))} / ${when(m.created)} / ${m.snapshot.nodes.length} MESSAGES</small></button>`,
      )
      .join("") ||
    '<p class="fine">No markers in this earlier encounter. You can place one from the Table while reviewing its current state.</p>';
  $("record-markers")
    .querySelectorAll("button")
    .forEach(
      (b) =>
        (b.onclick = () => {
          selectedMarker = room.markers.find((m) => m.id === b.dataset.marker);
          renderMarkers();
          renderMarker();
          $("from-marker").value = selectedMarker.id;
          compare();
        }),
    );
}
function renderMarker() {
  const m = selectedMarker;
  if (!m) {
    $("marker-detail").innerHTML = "";
    return;
  }
  const entries = Object.entries(m.endorsements),
    agreements = entries.filter(([, e]) => e.stance === "agree").length,
    conditions = entries.filter(([, e]) => e.stance === "condition").length,
    opposition = entries.filter(([, e]) => e.stance === "oppose").length;
  $("marker-detail").innerHTML =
    `<div class="section-label">${kinds[m.kind]} / ${when(m.created)}</div><p class="marker-account">${esc(m.note)}</p><p class="fine">Placed by ${esc(name(room, m.author))}. Snapshot at revision ${m.revision}. This claim is not automatically consensus.</p><p>${agreements} agree · ${conditions} with conditions · ${opposition} disagree</p>${entries.map(([id, e]) => `<div class="endorsement"><strong>${esc(name(room, id))}</strong> / ${esc(e.stance)}<br>${esc(e.note)}</div>`).join("") || '<p class="fine">No explicit endorsements yet. Silence has no assigned meaning.</p>'}<div class="control-row"><button id="endorse-marker" ${!me ? "disabled" : ""}>ADD / CHANGE MY POSITION ↗</button><button id="download-marker">EXACT SNAPSHOT ↓</button></div>${!me ? '<p class="fine">Take a place at the Table to add a named position.</p>' : ""}<details><summary>Everyone represented in this snapshot</summary><p>${m.snapshot.participants.map((id) => esc(name(room, id))).join(" · ")}</p><p class="fine">Being present in the snapshot does not mean someone endorsed this marker.</p></details>`;
  $("endorse-marker").onclick = () => {
    const prior = m.endorsements[me.id];
    $("stance").value = prior?.stance || "agree";
    $("stance-note").value = prior?.note || "";
    $("endorse-dialog").showModal();
  };
  $("download-marker").onclick = () =>
    download("cfi-marker-" + m.id + ".json", {
      encounter: room.id,
      question: room.question,
      marker: m,
      messages: room.nodes.filter((n) => m.snapshot.nodes.includes(n.id)),
      participants: room.participants,
    });
}
function flow() {
  const actors = Object.keys(room.participants),
    width = Math.max(700, 190 + room.nodes.length * 34),
    height = actors.length * 52 + 55;
  const x = (i) => 190 + i * 34,
    y = (id) => 28 + actors.indexOf(id) * 52;
  const index = Object.fromEntries(room.nodes.map((n, i) => [n.id, i]));
  let svg = `<svg role="img" aria-label="Message and reply timeline" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;
  actors.forEach((id) => {
    svg += `<text x="0" y="${y(id) + 4}" class="flow-label">${esc(name(room, id).slice(0, 25))}</text><line x1="185" y1="${y(id)}" x2="${width}" y2="${y(id)}" stroke="#594d36" stroke-dasharray="2 5"/>`;
  });
  room.nodes.forEach((n, i) => {
    if (n.parent in index) {
      const parent = room.nodes[index[n.parent]];
      svg += `<path d="M${x(index[n.parent])},${y(parent.author)} C${x(i)},${y(parent.author)} ${x(index[n.parent])},${y(n.author)} ${x(i)},${y(n.author)}" stroke="#efa96c66" fill="none"/>`;
    }
  });
  room.nodes.forEach((n, i) => {
    svg += `<circle class="flow-dot" tabindex="0" role="button" aria-label="Message ${i + 1} by ${esc(name(room, n.author))}" data-turn="${n.id}" cx="${x(i)}" cy="${y(n.author)}" r="7" fill="${room.participants[n.author]?.kind === "human" ? "#efa96c" : "#a9bca6"}"><title>${i + 1}. ${esc(n.text)}</title></circle>`;
  });
  $("flow").innerHTML = svg + "</svg>";
  $("flow")
    .querySelectorAll("[data-turn]")
    .forEach((dot) => {
      dot.onclick = () => showTurn(dot.dataset.turn);
      dot.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          showTurn(dot.dataset.turn);
        }
      };
    });
}
function showTurn(id) {
  const n = room.nodes.find((n) => n.id === id);
  if (!n) return;
  selectedTurn = id;
  scope(room, id);
  $("turn-detail").innerHTML =
    `<article class="turn-inspection"><div class="section-label">MESSAGE ${room.nodes.indexOf(n) + 1} / ${esc(name(room, n.author))} / ${when(n.created)}</div><p>${esc(n.text)}</p><div class="control-row"><a href="workshop.html?room=${room.id}&node=${id}">TAKE THESE WORDS APART ↗</a><a href="index.html">OPEN RELATIONSHIPS & SEED ↗</a><button id="example">EXACT TRAINING HANDOFF ↓</button>${n.source ? '<button id="inspect-call">WHAT DID THIS GUEST SEE? ↗</button>' : ""}</div><div id="turn-call"></div></article>`;
  $("example").onclick = guard(async () =>
    download("cfi-example-" + id + ".json", {
      ...(await api("/seed/example/" + room.id + "/" + id)),
      feedback: room.feedback?.[id] || {},
      training_policy:
        "Export only. Ratings are contextual feedback, not automatic target truth.",
    }),
  );
  if (n.source)
    $("inspect-call").onclick = guard(async () => {
      const call = await api("/call/" + room.id + "/" + n.source);
      $("turn-call").innerHTML =
        `<p class="fine">Exact request and response, including any output constraints. These are the words the model received; no paraphrase is substituted.</p><pre>${esc(JSON.stringify(call, null, 2))}</pre>`;
    });
}
function snapshot(id) {
  if (id === "start") return { nodes: [], allocations: {}, feedback: {} };
  if (id === "now")
    return {
      nodes: room.nodes.map((n) => n.id),
      allocations: room.allocations,
      feedback: room.feedback || {},
    };
  return room.markers?.find((m) => m.id === id)?.snapshot || snapshot("start");
}
function scores(s, nid, voice) {
  let support = 0,
    oppose = 0,
    recorded = 0;
  for (const [actor, ballot] of Object.entries(s.allocations)) {
    if (voice !== "all" && actor !== voice) continue;
    recorded++;
    const value = ballot.values[nid] || 0;
    if (value > 0) support += value;
    else oppose -= value;
  }
  return { support, oppose, recorded };
}
function compare() {
  const from = snapshot($("from-marker").value),
    to = snapshot($("to-marker").value),
    voice = $("compare-voice").value;
  const added = to.nodes.filter((n) => !from.nodes.includes(n)),
    removed = from.nodes.filter((n) => !to.nodes.includes(n));
  let rows = "";
  for (const n of room.nodes) {
    if (!from.nodes.includes(n.id) && !to.nodes.includes(n.id)) continue;
    const a = scores(from, n.id, voice),
      b = scores(to, n.id, voice);
    const helpful = (s) =>
      Object.entries(s.feedback?.[n.id] || {})
        .filter(([id]) => voice === "all" || id === voice)
        .reduce((v, [, f]) => v + f.value, 0);
    rows += `<tr><td><button data-turn="${n.id}">${room.nodes.indexOf(n) + 1}. ${esc(name(room, n.author))}</button><br>${esc(n.text.slice(0, 120))}${n.text.length > 120 ? "…" : ""}</td><td>${a.recorded ? `+${a.support.toFixed(2)} / −${a.oppose.toFixed(2)}` : "No allocation"}</td><td>${b.recorded ? `+${b.support.toFixed(2)} / −${b.oppose.toFixed(2)}` : "No allocation"}</td><td>${(b.support - a.support).toFixed(2)} / ${(b.oppose - a.oppose).toFixed(2)}</td><td>${helpful(from)} → ${helpful(to)}</td></tr>`;
  }
  $("comparison").innerHTML =
    `<p>${added.length} messages added; ${removed.length} outside the destination snapshot.</p><div class="table-scroll"><table><thead><tr><th>Exact message available on click</th><th>From / support & opposition</th><th>To / support & opposition</th><th>Change / support & opposition</th><th>Helpful minus unhelpful</th></tr></thead><tbody>${rows}</tbody></table></div><p class="fine">Message previews are abbreviated here. Selecting a row opens the complete text above; receipts retain every word.</p>`;
  $("comparison")
    .querySelectorAll("[data-turn]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          showTurn(b.dataset.turn);
          $("turn-detail").scrollIntoView({
            block: "center",
            behavior: "smooth",
          });
        }),
    );
}
function events() {
  const filter = $("event-filter").value;
  $("events").innerHTML =
    room.events
      .filter((e) => filter === "all" || e.kind === filter)
      .map(
        (e) =>
          `<details class="ledger-event"><summary>${when(e.time)} / ${esc(name(room, e.actor))} / ${esc(e.kind)}</summary><pre>${esc(JSON.stringify(e.payload, null, 2))}</pre></details>`,
      )
      .join("") || "<p>No matching events.</p>";
}
$("from-marker").onchange = compare;
$("to-marker").onchange = compare;
$("compare-voice").onchange = compare;
$("event-filter").onchange = events;
$("close-endorse").onclick = () => $("endorse-dialog").close();
$("endorse-form").onsubmit = guard(async (e) => {
  e.preventDefault();
  await api("/endorse", {
    room_id: room.id,
    marker: selectedMarker.id,
    stance: $("stance").value,
    note: $("stance-note").value,
  });
  $("endorse-dialog").close();
  await load(room.id);
});
$("refresh-record").onclick = guard(async () => {
  if (room) await load(room.id);
});
$("encounter-choice").onchange = guard(async () => {
  selectedMarker = null;
  await load($("encounter-choice").value);
  history.replaceState(null, "", "record.html?room=" + room.id);
});
(async () => {
  try {
    const state = await api("/state");
    me = state.me;
    $("encounter-choice").innerHTML = state.history
      .map(
        (r) =>
          `<option value="${r.id}">${esc(r.question)} / ${r.phase}</option>`,
      )
      .join("");
    const id = params.get("room") || state.room?.id;
    if (id) {
      $("encounter-choice").value = id;
      await load(id);
    } else
      $("record-question").textContent =
        "No encounters recorded yet. Begin at the Table.";
  } catch (e) {
    tell(e.message);
  }
})();
