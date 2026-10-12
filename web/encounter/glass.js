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
let measured = null,
  layer = 15,
  head = null,
  flat = matchMedia("(max-width:700px)").matches,
  busy = false,
  target = null,
  requestSequence = 0,
  yaw = -0.48,
  pitch = 0.52,
  zoom = 1,
  drag = null,
  hover = null,
  focusedToken = null,
  frame = null,
  toastTimer;
const example = window.CFI_GLASS_PREVIEW || null;
const encounter = window.CFIViews?.read("encounter");
const query = new URLSearchParams(location.search);
const inspectionScope = query.get("room") || encounter?.id || "standalone";
const sourceQuestion =
  query.get("question") ||
  (encounter?.id === inspectionScope ? encounter.question : null);
const lastInspection = window.CFIViews?.read("glass");
const restore =
  !example &&
  lastInspection?.scope === inspectionScope &&
  (!query.has("question") || lastInspection.contextQuestion === sourceQuestion)
    ? lastInspection
    : null;
if (!example) {
  const question =
    query.get("question") ||
    (encounter?.id === inspectionScope ? encounter.question : null);
  if (question) {
    $("glass-question").value = question;
    $("glass-prefix").value = "";
  }
  if (restore) {
    $("glass-question").value = restore.question;
    $("glass-prefix").value = restore.prefix;
    layer = restore.layer;
    head = restore.head;
    flat = restore.flat;
    yaw = restore.yaw;
    pitch = restore.pitch;
    zoom = restore.zoom;
    target = restore.target;
    focusedToken = restore.focusedToken;
  }
}
if (example) {
  const banner = document.createElement("div");
  banner.className = "glass-preview-banner";
  banner.textContent =
    "RECORDED REAL TENSOR MEASUREMENT · ROTATE / SELECT / INSPECT";
  document.body.prepend(banner);
}
function tell(t) {
  clearTimeout(toastTimer);
  $("glass-notice").textContent = t;
  $("glass-notice").className = "visible";
  toastTimer = setTimeout(() => ($("glass-notice").className = ""), 7000);
}
function show(id) {
  if (!$(id).open) $(id).showModal();
}
document
  .querySelectorAll("[data-close]")
  .forEach((b) => (b.onclick = () => $(b.dataset.close).close()));
$("glass-info").onclick = () => show("glass-info-dialog");
for (let h = 0; h < 9; h++) {
  const o = document.createElement("option");
  o.value = h;
  o.textContent = "Head " + (h + 1);
  $("head-select").append(o);
}
$("layer-buttons").innerHTML = Array.from(
  { length: 30 },
  (_, i) =>
    `<button data-layer="${i}" class="${i === layer ? "selected" : ""}" aria-label="Layer ${i + 1}" aria-pressed="${i === layer}" tabindex="${i === layer ? 0 : -1}">${i + 1}</button>`,
).join("");
$("layer-buttons")
  .querySelectorAll("button")
  .forEach(
    (b) =>
      (b.onclick = () => {
        layer = Number(b.dataset.layer);
        updateSelection();
        drawSoon();
        renderEffects();
      }),
  );
$("head-select").onchange = () => {
  head = $("head-select").value === "" ? null : Number($("head-select").value);
  updateSelection();
  drawSoon();
  renderEffects();
};
function updateSelection() {
  $("layer-number").textContent = String(layer + 1).padStart(2, "0");
  $("layer-buttons")
    .querySelectorAll("button")
    .forEach((b) => {
      b.classList.toggle("selected", Number(b.dataset.layer) === layer);
      b.setAttribute("aria-pressed", String(Number(b.dataset.layer) === layer));
      b.tabIndex = Number(b.dataset.layer) === layer ? 0 : -1;
    });
  $("mute-head").disabled = busy || head === null || !measured;
}
async function inspect(options = {}) {
  if (busy) return;
  if (example) {
    tell(
      "This preview contains a saved layer 16 / head 1 experiment. Open the live instrument for another input or intervention. Your draft is still here.",
    );
    return;
  }
  busy = true;
  const seq = ++requestSequence;
  $("glass-run").disabled = true;
  $("glass-first-run").disabled = true;
  $("glass-first-run").textContent = "MEASURING…";
  $("mute-head").disabled = true;
  $("glass-status").textContent = options.ablate
    ? "Running the identical input again with the selected head output set to zero…"
    : options.target !== undefined
      ? "Differentiating the selected token loss with respect to the chosen layer activation…"
      : "Measuring actual attention and next-token probabilities…";
  try {
    const body = {
      question:
        (options.ablate || options.target !== undefined) && measured
          ? measured.question
          : $("glass-question").value,
      prefix:
        (options.ablate || options.target !== undefined) && measured
          ? measured.prefix
          : $("glass-prefix").value,
      layer,
      head:
        options.ablate ||
        (options.target !== undefined &&
          measured?.ablation?.layer === layer &&
          measured?.ablation?.head === head)
          ? head
          : null,
      target_token: options.target ?? null,
    };
    const r = await fetch("/api/glass/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await r.json();
    if (!r.ok)
      throw Error(data.error || data.detail || "The inspection failed.");
    if (seq !== requestSequence) return;
    measured = data;
    target = options.target ?? null;
    finish();
    saveInspection();
    const effect =
      options.target !== undefined
        ? $("gradient-effect")
        : options.ablate
          ? $("head-effect")
          : null;
    if (effect && !effect.hidden)
      effect.scrollIntoView({
        block: "nearest",
        behavior: matchMedia("(prefers-reduced-motion:reduce)").matches
          ? "instant"
          : "smooth",
      });
  } catch (e) {
    $("glass-status").textContent = "No new measurement: " + e.message;
    tell(e.message);
  } finally {
    busy = false;
    $("glass-run").disabled = false;
    $("glass-first-run").disabled = false;
    $("glass-first-run").textContent = "RUN THIS INPUT ↗";
    updateSelection();
  }
}
function finish() {
  if (focusedToken !== null && focusedToken >= measured.tokens.length)
    focusedToken = null;
  $("input-strip").innerHTML = measured.tokens
    .map(
      (t, i) =>
        `<button data-input-token="${i}" tabindex="${i === (focusedToken ?? 0) ? 0 : -1}" title="Position ${i}, token ID ${t.id}"><small>${i}</small>${esc(t.text.replace(/ /g, "·").replace(/\n/g, "↵"))}</button>`,
    )
    .join("");
  $("input-strip")
    .querySelectorAll("button")
    .forEach(
      (b) =>
        (b.onclick = () => {
          focusedToken = Number(b.dataset.inputToken);
          $("input-strip")
            .querySelectorAll("button")
            .forEach((x) => {
              x.classList.toggle("chosen", x === b);
              x.tabIndex = x === b ? 0 : -1;
            });
          drawSoon();
        }),
    );
  $("volume-empty").hidden = true;
  $("model-label").textContent =
    "SMOLLM2 / " +
    (measured.parameters / 1e6).toFixed(1) +
    "M / PRETRAINED GUEST";
  $("glass-time").textContent =
    measured.seconds.toFixed(2) +
    " S / " +
    measured.tokens.length +
    " INPUT TOKENS";
  $("glass-status").textContent =
    "Measured on the exact displayed question and prefix. All weights unchanged. Click a next token to measure its activation gradient.";
  if (measured.receipt) {
    $("glass-receipt").hidden = false;
    $("glass-receipt").href = "/api/glass/receipt/" + measured.receipt;
  }
  $("next-tokens").innerHTML = measured.next
    .slice(0, 16)
    .map(
      (t) =>
        `<button class="next-token ${t.id === target ? "chosen" : ""}" data-token="${t.id}"><span class="token-text">${esc(t.text.replace(/ /g, "·").replace(/\n/g, "↵"))}</span><span class="token-prob">${(t.p * 100).toFixed(2)}%</span><i class="prob-line" style="width:${t.p * 100}%"></i></button>`,
    )
    .join("");
  $("next-tokens")
    .querySelectorAll("[data-token]")
    .forEach(
      (b) => (b.onclick = () => inspect({ target: Number(b.dataset.token) })),
    );
  updateSelection();
  renderEffects();
  markInput();
  drawSoon();
}
function renderEffects() {
  const a = measured?.ablation,
    g = measured?.gradient;
  $("head-effect").hidden = !a || a.layer !== layer || a.head !== head;
  if (a && a.layer === layer && a.head === head) {
    $("head-effect").innerHTML =
      `<div class="effect-title">IF HEAD ${head + 1} WERE SILENT</div><p class="effect-copy">Baseline minus muted probability, in percentage points. Positive: this head's presence increased that token's probability in this experiment.</p>${a.changed
        .slice(0, 8)
        .map(
          (t) =>
            `<div class="delta-row"><span>${esc(t.text.replace(/ /g, "·").replace(/\n/g, "↵"))}</span><span>${t.difference >= 0 ? "+" : ""}${(t.difference * 100).toFixed(3)} pp</span></div>`,
        )
        .join(
          "",
        )}<p class="effect-copy">Total variation: ${a.total_variation.toFixed(6)}. Other layers, inputs and weights were unchanged.</p>`;
  }
  $("gradient-effect").hidden = !g || measured.layer !== layer;
  if (g && measured.layer === layer) {
    const max = Math.max(...g.values.map(Math.abs)) || 1;
    $("gradient-effect").innerHTML =
      `<div class="effect-title">LOSS GRADIENT / ${esc(JSON.stringify(g.target_text))}</div><p class="effect-copy">${esc(g.objective)}<br>L2 norm ${g.norm.toFixed(5)} · loss ${g.loss.toFixed(5)}</p><div class="gradient-coordinates">${g.values.map((v, i) => `<i style="height:${Math.max(1, (Math.abs(v) / max) * 58)}px;background:${v >= 0 ? "#ff6e95" : "#f0bb6c"}" title="Coordinate ${i}: ${v}"></i>`).join("")}</div><p class="effect-copy">576 signed coordinates. Pink positive, amber negative. These are derivatives of the specified loss, not labelled concepts.</p>`;
  }
}
$("glass-form").onsubmit = (e) => {
  e.preventDefault();
  inspect();
};
$("mute-head").onclick = () => inspect({ ablate: true });
$("rotate-reset").onclick = () => {
  yaw = -0.48;
  pitch = 0.52;
  zoom = 1;
  hover = null;
  drawSoon();
};
$("flat-view").onclick = () => {
  flat = !flat;
  $("flat-view").setAttribute("aria-pressed", String(flat));
  $("flat-view").textContent = flat ? "VOLUME" : "FLATTEN";
  hover = null;
  drawSoon();
};
function markInput() {
  $("initial-input-summary").textContent =
    $("glass-question").value +
    "\n\nCONTINUATION: " +
    ($("glass-prefix").value || "(empty)");
  const dirty = Boolean(
    measured &&
      ($("glass-question").value !== measured.question ||
        $("glass-prefix").value !== measured.prefix),
  );
  document.body.classList.toggle("unrun-input", dirty);
  if (dirty)
    $("glass-status").textContent =
      "Draft changed. The picture and head interventions still use the last measured input. RUN THIS INPUT measures your draft; READ THE VALUES includes the exact recorded input.";
  else if (measured && !busy)
    $("glass-status").textContent = example
      ? "Saved real measurement. New inputs require the live instrument."
      : "The displayed input matches the measurement. Head interventions use these exact words.";
}
for (const id of ["glass-question", "glass-prefix"])
  $(id).addEventListener("input", markInput);
const canvas = $("volume");
canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || flat) return;
  drag = { x: e.clientX, y: e.clientY, yaw, pitch };
  canvas.setPointerCapture(e.pointerId);
  canvas.classList.add("dragging");
});
canvas.addEventListener("pointermove", (e) => {
  const r = canvas.getBoundingClientRect();
  if (drag) {
    yaw = drag.yaw + (e.clientX - drag.x) * 0.006;
    pitch = Math.max(
      -1.2,
      Math.min(1.2, drag.pitch + (e.clientY - drag.y) * 0.006),
    );
    hover = null;
  } else hover = { x: e.clientX - r.left, y: e.clientY - r.top };
  drawSoon();
});
for (const event of ["pointerup", "pointercancel", "lostpointercapture"])
  canvas.addEventListener(event, () => {
    drag = null;
    canvas.classList.remove("dragging");
  });
canvas.addEventListener("pointerleave", () => {
  hover = null;
  drawSoon();
});
canvas.addEventListener(
  "wheel",
  (e) => {
    if (flat) return;
    e.preventDefault();
    zoom = Math.max(0.45, Math.min(2.8, zoom * Math.exp(-e.deltaY * 0.001)));
    drawSoon();
  },
  { passive: false },
);
canvas.addEventListener("keydown", (e) => {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
    e.preventDefault();
    if (e.key === "ArrowLeft") yaw -= 0.06;
    if (e.key === "ArrowRight") yaw += 0.06;
    if (e.key === "ArrowUp") pitch -= 0.06;
    if (e.key === "ArrowDown") pitch += 0.06;
    drawSoon();
  }
});
function drawSoon() {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    draw();
  });
}
function draw() {
  const rect = canvas.getBoundingClientRect(),
    w = rect.width,
    h = rect.height,
    dpr = Math.min(2, devicePixelRatio || 1);
  if (!w || !h) return;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const c = canvas.getContext("2d");
  c.scale(dpr, dpr);
  c.clearRect(0, 0, w, h);
  if (!measured) return;
  if (flat) {
    drawFlat(c, w, h);
    return;
  }
  $("volume-mode").textContent =
    "LAYER × HEAD × INPUT POSITION / HEIGHT WITHIN STRIP = √ATTENTION";
  const n = measured.tokens.length,
    scale =
      Math.min((w - 85) / (Math.max(n * 7, 300) + 140), (h - 130) / 510) * zoom;
  const cy = h * 0.51,
    cx = w * 0.52;
  function project(x, y, z) {
    const X = x * Math.cos(yaw) + z * Math.sin(yaw),
      Z = -x * Math.sin(yaw) + z * Math.cos(yaw);
    const Y = y * Math.cos(pitch) - Z * Math.sin(pitch),
      depth = y * Math.sin(pitch) + Z * Math.cos(pitch);
    const p = 1200 / (1200 + depth);
    return { x: cx + X * scale * p, y: cy + Y * scale * p, depth };
  }
  function point(l, hd, t, value) {
    return project(
      (t - (n - 1) / 2) * 7,
      (l - 14.5) * 14 - Math.sqrt(value) * 32,
      (hd - 4) * 18,
    );
  }
  let closest = null,
    dist = 22;
  // Back-to-front traversal; inactive sheets remain inspectable context.
  const planes = Array.from({ length: 30 }, (_, l) => l).sort(
    (a, b) =>
      project(0, (b - 14.5) * 14, 0).depth -
      project(0, (a - 14.5) * 14, 0).depth,
  );
  for (const l of planes) {
    for (let hd = 0; hd < 9; hd++) {
      const values = measured.attention[l][hd],
        active = l === layer,
        chosen = active && (head === null || head === hd);
      c.strokeStyle = chosen ? "#ff779e" : active ? "#a56a88" : "#756078";
      c.globalAlpha = chosen ? 0.98 : active ? 0.58 : 0.28;
      c.lineWidth = chosen ? 1.3 : 0.55;
      c.beginPath();
      values.forEach((value, t) => {
        const p = point(l, hd, t, value);
        if (t === 0) c.moveTo(p.x, p.y);
        else c.lineTo(p.x, p.y);
        if (active && hover) {
          const d = Math.hypot(p.x - hover.x, p.y - hover.y);
          if (d < dist) {
            dist = d;
            closest = { ...p, l, hd, t, value };
          }
        }
      });
      c.stroke();
      if (chosen) {
        values.forEach((value, t) => {
          if (value < 0.025) return;
          const p = point(l, hd, t, value);
          c.globalAlpha = Math.min(1, 0.25 + Math.sqrt(value));
          c.fillStyle = "#ffbdcf";
          c.beginPath();
          c.arc(p.x, p.y, 0.9 + Math.sqrt(value) * 2, 0, Math.PI * 2);
          c.fill();
        });
      }
    }
    if (l % 5 === 0 || l === layer || l === 29) {
      const p = project((-(n - 1) / 2) * 7 - 17, (l - 14.5) * 14, -82);
      c.globalAlpha = l === layer ? 1 : 0.5;
      c.fillStyle = l === layer ? "#ff8ead" : "#a58da7";
      c.font = (l === layer ? "10" : "8") + "px Sligoil";
      c.textAlign = "right";
      c.fillText("L" + String(l + 1).padStart(2, "0"), p.x, p.y + 3);
    }
  }
  c.globalAlpha = 0.45;
  c.strokeStyle = "#ba96bd";
  c.lineWidth = 0.7;
  const axisA = project((-(n - 1) / 2) * 7, 230, -90),
    axisB = project(((n - 1) / 2) * 7, 230, -90);
  c.beginPath();
  c.moveTo(axisA.x, axisA.y);
  c.lineTo(axisB.x, axisB.y);
  c.stroke();
  c.font = "8px Sligoil";
  c.textAlign = "center";
  for (let t = 0; t < n; t += Math.max(1, Math.ceil(n / 9))) {
    const p = project((t - (n - 1) / 2) * 7, 247, -90);
    c.fillStyle = "#c3a8c5";
    c.fillText(String(t), p.x, p.y);
  }
  c.globalAlpha = 1;
  if (focusedToken !== null && focusedToken < n) {
    for (let l = 0; l < 30; l++) {
      const hd = head ?? 0,
        p = point(l, hd, focusedToken, measured.attention[l][hd][focusedToken]);
      c.fillStyle = l === layer ? "#f0bb6c" : "#f0bb6c77";
      c.beginPath();
      c.arc(p.x, p.y, l === layer ? 4 : 1.5, 0, Math.PI * 2);
      c.fill();
    }
    const p = point(
      layer,
      head ?? 0,
      focusedToken,
      measured.attention[layer][head ?? 0][focusedToken],
    );
    tooltip(
      c,
      w,
      h,
      p,
      `#${focusedToken} ${JSON.stringify(measured.tokens[focusedToken].text)} · H${(head ?? 0) + 1} · ${(measured.attention[layer][head ?? 0][focusedToken] * 100).toFixed(3)}%`,
    );
  }
  if (closest)
    tooltip(
      c,
      w,
      h,
      closest,
      `L${closest.l + 1} H${closest.hd + 1} · #${closest.t} ${JSON.stringify(measured.tokens[closest.t].text)} · ${(closest.value * 100).toFixed(3)}%`,
    );
}
function drawFlat(c, w, h) {
  $("volume-mode").textContent =
    "LAYER " + (layer + 1) + " / NINE HEADS × ACTUAL INPUT TOKENS";
  const n = measured.tokens.length,
    left = 42,
    top = 130,
    gridW = w - 65,
    rowH = Math.min(34, (h - 250) / 9),
    cw = gridW / n;
  c.font = "9px Sligoil";
  c.textAlign = "right";
  for (let hd = 0; hd < 9; hd++) {
    c.fillStyle = head === null || head === hd ? "#ecb2c5" : "#816a81";
    c.fillText("H" + (hd + 1), left - 10, top + hd * rowH + rowH * 0.65);
    measured.attention[layer][hd].forEach((v, t) => {
      const strength = Math.sqrt(v),
        active = head === null || head === hd;
      c.fillStyle = `rgba(255,110,149,${active ? 0.04 + strength * 0.96 : 0.025 + strength * 0.25})`;
      c.fillRect(
        left + t * cw,
        top + hd * rowH,
        Math.max(0.5, cw - 1),
        rowH - 4,
      );
    });
  }
  if (focusedToken !== null && focusedToken < n) {
    c.strokeStyle = "#f0bb6c";
    c.lineWidth = 1;
    c.strokeRect(left + focusedToken * cw, top, cw, 9 * rowH - 4);
  }
  c.textAlign = "center";
  c.fillStyle = "#a58da7";
  for (let t = 0; t < n; t += Math.max(1, Math.ceil(n / 10)))
    c.fillText(String(t), left + (t + 0.5) * cw, top + 9 * rowH + 17);
  c.textAlign = "left";
  c.font = "8px Sligoil";
  c.fillText(
    "Brightness = √attention. Exact values on hover or in READ THE VALUES.",
    left,
    top + 9 * rowH + 45,
    gridW,
  );
  if (hover) {
    const t = Math.floor((hover.x - left) / cw),
      hd = Math.floor((hover.y - top) / rowH);
    if (t >= 0 && t < n && hd >= 0 && hd < 9) {
      const value = measured.attention[layer][hd][t];
      tooltip(
        c,
        w,
        h,
        hover,
        `H${hd + 1} · #${t} ${JSON.stringify(measured.tokens[t].text)} · ${(value * 100).toFixed(3)}%`,
      );
    }
  }
}
function tooltip(c, w, h, p, text) {
  c.font = "9px Sligoil";
  const tw = Math.min(w - 20, c.measureText(text).width + 18),
    x = Math.max(10, Math.min(w - tw - 10, p.x - tw / 2)),
    y = Math.max(70, Math.min(h - 100, p.y - 30));
  c.fillStyle = "#f4dfd9";
  c.fillRect(x, y, tw, 23);
  c.fillStyle = "#141016";
  c.textAlign = "left";
  c.fillText(text, x + 9, y + 15, tw - 18);
}
$("show-attention").onclick = () => {
  if (!measured) {
    tell("Run an input first.");
    return;
  }
  $("attention-title").textContent =
    "LAYER " + (layer + 1) + " / EXACT ATTENTION WEIGHTS";
  $("attention-values").innerHTML =
    `<p><strong>MEASURED QUESTION</strong><br>${esc(measured.question)}</p><p><strong>MEASURED CONTINUATION</strong><br>${esc(measured.prefix) || "(empty)"}</p><p>Each head's row of weights sums to one across these input positions. Values below are percentages. The selected prediction position is the final input token.</p><table class="attention-table"><thead><tr><th>INPUT TOKEN</th>${Array.from({ length: 9 }, (_, h) => "<th>H" + (h + 1) + "</th>").join("")}</tr></thead><tbody>${measured.tokens.map((t, i) => `<tr><td>${i}: ${esc(JSON.stringify(t.text))}</td>${measured.attention[layer].map((a) => `<td class="${a[i] > 0.05 ? "strong" : ""}">${(a[i] * 100).toFixed(2)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  show("attention-dialog");
};
window.addEventListener("resize", drawSoon);
document.fonts.ready.then(drawSoon);
if (example) {
  $("glass-question").value = example.question;
  $("glass-prefix").value = example.prefix;
  measured = structuredClone(example);
  layer = measured.layer;
  head = measured.head;
  $("head-select").value = head ?? "";
  target = measured.gradient?.target_token ?? null;
  finish();
  $("glass-status").textContent =
    "Saved real measurement. Rotation, layer selection and exact values work locally; new inputs require the live instrument.";
}

$("glass-first-run").onclick = () => inspect();
$("flat-view").textContent = flat ? "VOLUME" : "FLATTEN";
$("flat-view").setAttribute("aria-pressed", String(flat));
for (const id of ["layer-buttons", "input-strip"]) {
  $(id).addEventListener("keydown", (event) => {
    const keys = [
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Home",
      "End",
    ];
    if (!keys.includes(event.key) || event.target.tagName !== "BUTTON") return;
    event.preventDefault();
    const buttons = [...$(id).querySelectorAll("button")],
      i = buttons.indexOf(event.target);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : (i +
              (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) +
              buttons.length) %
            buttons.length;
    buttons[next].click();
    buttons[next].focus();
    buttons[next].scrollIntoView({ block: "nearest", inline: "nearest" });
  });
}
markInput();

function saveInspection() {
  if (example) return;
  window.CFIViews?.write("glass", {
    scope: inspectionScope,
    contextQuestion: sourceQuestion,
    question: $("glass-question").value,
    prefix: $("glass-prefix").value,
    receipt: measured?.receipt || restore?.receipt || null,
    layer,
    head,
    flat,
    yaw,
    pitch,
    zoom,
    target,
    focusedToken,
  });
}
$("glass-question").addEventListener("input", saveInspection);
$("glass-prefix").addEventListener("input", saveInspection);
window.addEventListener("pagehide", saveInspection);
if (restore) {
  $("head-select").value = head ?? "";
  updateSelection();
  if (restore.receipt) {
    const sequence = requestSequence;
    fetch("/api/glass/receipt/" + encodeURIComponent(restore.receipt))
      .then(async (response) => {
        if (!response.ok)
          throw Error(
            "The saved measurement is no longer available. Your input is still here; run it again when ready.",
          );
        const data = await response.json();
        if (sequence !== requestSequence) return;
        measured = { ...data, receipt: restore.receipt };
        finish();
      })
      .catch((error) => {
        if (sequence === requestSequence) tell(error.message);
      });
  }
}
