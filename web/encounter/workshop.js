import { $, esc, api, download, scope, name } from "./instrument-common.js";
let measurement = null,
  tokenResult = null,
  sourceRoom = null,
  sourceNode = null,
  operation = "attention",
  busy = false,
  measurementRequest = 0,
  tokenRequest = 0,
  timer;
const params = new URLSearchParams(location.search),
  saved = window.CFIViews?.read("workshop");
const inputs = [
  "question-input",
  "prefix-input",
  "layer-input",
  "steps-input",
  "append-ids",
  "token-text",
  "token-corpus",
  "merge-count",
  "merge-rules",
];
const n = (id) => Number($(id).value),
  fmt = (v) => Number(v).toPrecision(7);
function notice(text) {
  $("instrument-notice").textContent = text;
  $("instrument-notice").classList.add("active");
  clearTimeout(timer);
  timer = setTimeout(
    () => $("instrument-notice").classList.remove("active"),
    8000,
  );
}
const guard = (fn) => async (e) => {
  try {
    await fn(e);
  } catch (err) {
    notice(err.message);
    $("run-status").textContent = err.message;
  }
};
$("layer-input").innerHTML = Array.from(
  { length: 30 },
  (_, i) => `<option value="${i}">${i + 1} / 30</option>`,
).join("");
$("head-input").innerHTML = Array.from(
  { length: 9 },
  (_, i) => `<option value="${i}">${i + 1}</option>`,
).join("");
function save() {
  window.CFIViews?.write("workshop", {
    inputs: Object.fromEntries(inputs.map((id) => [id, $(id).value])),
    receipt: measurement?.receipt,
    tokenReceipt: tokenResult?.receipt,
    head: n("head-input"),
    query: n("query-input"),
    key: n("key-input"),
    coordinate: n("coordinate-input"),
    operation,
    bench: document.querySelector("[data-bench][aria-pressed=true]")?.dataset
      .bench,
  });
}
if (saved?.inputs)
  for (const id of inputs)
    if (saved.inputs[id] !== undefined) $(id).value = saved.inputs[id];
inputs.forEach((id) =>
  $(id).addEventListener("input", () => {
    save();
    if (
      measurement &&
      [
        "question-input",
        "prefix-input",
        "layer-input",
        "steps-input",
        "append-ids",
      ].includes(id)
    )
      $("run-status").textContent =
        "Input changed. Existing panels still show the labelled previous measurement; run again to measure this input.";
  }),
);
window.addEventListener("pagehide", save);
function bench(id) {
  for (const b of document.querySelectorAll("[data-bench]"))
    b.setAttribute("aria-pressed", String(b.dataset.bench === id));
  for (const name of ["mechanism", "cache", "tokenizer"])
    $(name + "-bench").hidden = name !== id;
  $("measurement-form").hidden = id === "tokenizer";
  history.replaceState(
    null,
    "",
    location.pathname + location.search + "#" + id,
  );
  save();
}
document
  .querySelectorAll("[data-bench]")
  .forEach((b) => (b.onclick = () => bench(b.dataset.bench)));
function measured() {
  const r = measurement;
  $("mechanism-empty").hidden = true;
  $("mechanism-results").hidden = false;
  $("measurement-label").textContent =
    `Measured layer ${r.layer + 1} · ${r.tokens.length} input positions · ${r.runtime.dtype} / ${r.runtime.device} · ${r.model} · Question: ${r.question}${r.prefix ? " · Prefix: " + r.prefix : ""}`;
  $("measurement-receipt").hidden = false;
  $("measurement-receipt").href = "/api/glass/receipt/" + r.receipt;
  const options = r.tokens
    .map(
      (t, i) =>
        `<option value="${i}">${i}: ${esc(JSON.stringify(t.text))} / ID ${t.id}</option>`,
    )
    .join("");
  $("query-input").innerHTML = options;
  $("key-input").innerHTML = options;
  $("query-input").value = r.tokens.length - 1;
  $("key-input").value = r.tokens.length - 1;
  $("checks").textContent =
    JSON.stringify(
      Object.fromEntries(
        Object.entries(r.block).filter(([key]) => key.endsWith("error")),
      ),
      null,
      2,
    ) +
    "\nMaximum absolute differences against captured activations. Zero means exact agreement in this run.";
  $("exact-input").textContent = r.exact_input;
  $("pipeline").innerHTML = [
    ["input", "RESIDUAL IN", "576 coordinates"],
    ["norm", "RMS NORMALIZE", "scale, then learned gain"],
    ["attention", "Q / K / V → ATTEND", "9 queries / 3 K,V"],
    ["concatenated", "JOIN & PROJECT", "9 × 64 → 576"],
    ["post_norm", "ADD & NORMALIZE", "residual connection"],
    ["mlp", "GATED MLP", "576 → 1536 → 576"],
    ["output", "RESIDUAL OUT", "on to the next layer"],
  ]
    .map(
      ([id, label, sub]) =>
        `<button data-operation="${id}">${label}<small>${sub}</small></button>`,
    )
    .join("");
  $("pipeline")
    .querySelectorAll("button")
    .forEach(
      (b) =>
        (b.onclick = () => {
          operation = b.dataset.operation;
          renderOperation();
          save();
        }),
    );
  renderOperation();
  headMap();
  renderAttention();
  renderCache();
}
const operationText = {
  input: [
    "The residual stream enters this block.",
    "At each input position there is a vector of 576 coordinates. It is an activation computed for this sequence. It is not a model weight. Each block adds attention and MLP updates to this stream.",
  ],
  norm: [
    "RMSNorm rescales the incoming vector.",
    "x / √(mean(x²) + ε), multiplied coordinate by coordinate by learned gains. The result is projected through separate learned matrices into Q, K and V. Normalization mixes the magnitude across coordinates; it does not assign words to them.",
  ],
  attention: [
    "Queries compare with keys; the resulting weights mix values.",
    "Q = norm(x)Wq, K = norm(x)Wk, V = norm(x)Wv. RoPE rotates Q and K according to position. For each query: scores = QKᵀ / √64; mask future positions; softmax over the remaining keys; multiply those weights by V. Inspect the exact arithmetic below.",
  ],
  concatenated: [
    "Nine head outputs are joined, then projected.",
    "Each head produces 64 coordinates from a different weighted sum of values. Concatenate the nine vectors into 576 coordinates; the learned output projection mixes them. Its result is added to the incoming residual vector. Heads are not independent agents or one-word proposals.",
  ],
  post_norm: [
    "The first residual addition feeds a second RMSNorm.",
    "y = x + attention_output. Normalize y before the MLP. The original y is also carried around the MLP through the second residual connection. These additions help retain and update information through depth.",
  ],
  mlp: [
    "A gated nonlinear transformation at each position.",
    "gate = Wgate·norm(y); up = Wup·norm(y); intermediate = SiLU(gate) × up; update = Wdown·intermediate. The MLP operates per position. Attention is what mixed positions earlier. Here 1,536 intermediate coordinates return to 576 residual coordinates.",
  ],
  output: [
    "The block adds its MLP update and passes the stream onward.",
    "output = input + attention_output + mlp_update. This is the captured output of the selected block before any final model normalization. After layer 30, the model applies a final RMSNorm and a vocabulary projection; softmax gives a distribution over next-token IDs.",
  ],
};
function renderOperation() {
  if (!measurement) return;
  const [title, text] = operationText[operation],
    b = measurement.block,
    vector = operation === "attention" ? null : b[operation];
  $("pipeline")
    .querySelectorAll("button")
    .forEach((button) =>
      button.classList.toggle("active", button.dataset.operation === operation),
    );
  $("operation-detail").innerHTML =
    `<strong>${esc(title)}</strong><p>${esc(text)}</p>${vector ? `<div class="operation-values"><span>Actual ${esc(operation)} vector / FINAL input position / ${vector.length} coordinates</span><label>COORDINATE <input id="residual-coordinate" type="number" min="0" max="${vector.length - 1}" value="0" style="width:85px"></label><output id="residual-value">${fmt(vector[0])}</output></div><details><summary>Every coordinate in this captured vector</summary><pre>${esc(JSON.stringify(vector))}</pre></details>` : '<p class="fine">The controls below can select any query position, any head and any key position.</p>'}`;
  if (vector)
    $("residual-coordinate").oninput = () => {
      const i = n("residual-coordinate");
      $("residual-value").textContent =
        Number.isInteger(i) && i >= 0 && i < vector.length
          ? fmt(vector[i])
          : "Choose a valid coordinate.";
    };
}
function headMap() {
  const head = n("head-input");
  $("head-map").innerHTML = Array.from(
    { length: 3 },
    (_, kv) =>
      `<div class="head-group"><span>K/V ${kv + 1}<br>shared by →</span>${Array.from(
        { length: 3 },
        (_, j) => kv * 3 + j,
      )
        .map(
          (h) =>
            `<button data-head="${h}" aria-pressed="${h === head}">Q${h + 1}</button>`,
        )
        .join("")}</div>`,
  ).join("");
  $("head-map")
    .querySelectorAll("button")
    .forEach(
      (b) =>
        (b.onclick = () => {
          $("head-input").value = b.dataset.head;
          headMap();
          renderAttention();
          save();
        }),
    );
}
function renderAttention() {
  if (!measurement) return;
  const r = measurement,
    b = r.block,
    h = n("head-input"),
    q = n("query-input"),
    k = n("key-input"),
    c = n("coordinate-input"),
    kv = Math.floor(h / 3),
    T = r.tokens.length;
  if (!Number.isInteger(c) || c < 0 || c > 63) return;
  $("group-mapping").textContent =
    `Query head ${h + 1} uses K/V head ${kv + 1}. Query position ${q} (${JSON.stringify(r.tokens[q].text)}) can attend to positions 0–${q}.`;
  $("matrix").innerHTML =
    `<div class="attention-grid" style="grid-template-columns:repeat(${T},14px)">${b.attention[h].map((row, qi) => row.map((weight, ki) => `<button class="${qi === q && ki === k ? "selected" : ""}" data-query="${qi}" data-key="${ki}" title="Query ${qi} → key ${ki}: ${weight.toPrecision(7)}${ki > qi ? " (causally masked)" : ""}" aria-label="Query ${qi}, key ${ki}, attention ${weight}" style="background:${ki > qi ? "#121110" : `rgba(239,169,108,${0.08 + 0.92 * Math.sqrt(weight)})`}"></button>`).join("")).join("")}</div>`;
  $("matrix")
    .querySelectorAll("button")
    .forEach(
      (cell) =>
        (cell.onclick = () => {
          $("query-input").value = cell.dataset.query;
          $("key-input").value = cell.dataset.key;
          renderAttention();
          save();
        }),
    );
  const products = b.q[h][q].map((v, i) => v * b.k[kv][k][i]);
  const dot = products.reduce((a, v) => a + v, 0),
    weight = b.attention[h][q][k];
  const mixed = b.attention[h][q].reduce(
    (sum, w, i) => sum + w * b.v[kv][i][c],
    0,
  );
  $("arithmetic").innerHTML =
    `<div class="arithmetic-line">Q[${c}] × K[${c}] = <strong>${fmt(b.q[h][q][c])} × ${fmt(b.k[kv][k][c])} = ${fmt(products[c])}</strong></div><div class="arithmetic-line">Sum all 64 products / √64 = <strong>${fmt(dot)} / 8 = ${fmt(b.scores[h][q][k])}</strong><br><small>Score is from the model tensors; the browser dot sum may differ in its last digits.</small></div><div class="arithmetic-line">${k > q ? "Future key → masked before softmax." : "Compare this score with every allowed key, then softmax."}<br>Attention weight = <strong>${fmt(weight)}</strong></div><div class="arithmetic-line">Contribution to head output coordinate ${c}:<br><strong>${fmt(weight)} × V[${k},${c}] ${fmt(b.v[kv][k][c])} = ${fmt(weight * b.v[kv][k][c])}</strong></div><div class="arithmetic-line">Sum that contribution over all keys:<br>head output[${c}] = <strong>${fmt(mixed)}</strong></div><details><summary>Position rotation for this coordinate</summary><p>Before RoPE: Q = ${fmt(b.q_before_rope[h][q][c])}, K = ${fmt(b.k_before_rope[kv][k][c])}. After: Q = ${fmt(b.q[h][q][c])}, K = ${fmt(b.k[kv][k][c])}.</p><p>Q′[i] = Q[i] cos(position,i) + rotate_half(Q)[i] sin(position,i). The two half-vectors exchange places, with a sign change for the first half. cos=${fmt(b.rope_cos[q][c])}, sin=${fmt(b.rope_sin[q][c])}. V is not rotated.</p></details>`;
  const vectors = [
    ["Q after RoPE", b.q[h][q]],
    ["K after RoPE", b.k[kv][k]],
    ["V", b.v[kv][k]],
  ];
  $("vectors").innerHTML = vectors
    .map(([label, values]) => {
      const max = Math.max(...values.map(Math.abs), 1e-12);
      return `<div class="fine">${label} / color indicates sign; intensity indicates magnitude within this vector</div><div class="table-scroll"><div class="vector-field">${values.map((v, i) => `<button data-coordinate="${i}" aria-pressed="${i === c}" title="${label}[${i}] = ${v}" aria-label="${label} coordinate ${i}: ${v}" style="background:rgba(${v >= 0 ? "239,169,108" : "141,176,199"},${0.1 + (0.9 * Math.abs(v)) / max})"></button>`).join("")}</div></div>`;
    })
    .join("");
  $("vectors")
    .querySelectorAll("button")
    .forEach(
      (button) =>
        (button.onclick = () => {
          $("coordinate-input").value = button.dataset.coordinate;
          renderAttention();
          save();
        }),
    );
}
function renderCache() {
  const r = measurement,
    c = r.cache;
  $("cache-results").classList.remove("unmeasured");
  $("cache-results").innerHTML =
    `<div class="section-label">THE SAME PREFIX / TWO EXECUTION PATHS</div><p>${c.prefill_tokens} prefix positions were processed first. Each new token adds <strong>${c.bytes_per_token.toLocaleString()} bytes</strong> across 30 layers: 2 tensors × 3 K/V heads × 64 coordinates × 4 bytes × 30.</p><p class="fine">This measurement rebuilds the cache from the exact input, then appends ${c.steps.length} tokens within the run. ${esc(c.selection)}. It does not share a cache with the chat guests.</p><div class="cache-growth" aria-label="Prefill positions followed by appended tokens">${r.tokens.map((t, i) => `<span class="cache-cell" title="Prefill ${i}: ${esc(t.text)}"></span>`).join("")}${c.steps.map((s) => `<span class="cache-cell new" title="Appended ID ${s.token}">${esc(s.text)}</span>`).join("")}</div><div class="table-scroll"><table><thead><tr><th>Appended token</th><th>Positions processed<br>cache / replay</th><th>Cache bytes</th><th>Prefix K/V unchanged?</th><th>Max logit difference</th><th>Same next argmax?</th><th>Single run ms<br>cache / replay</th></tr></thead><tbody>${c.steps.map((s) => `<tr><td>${s.step}. ${esc(JSON.stringify(s.text))}<br>ID ${s.token}</td><td>${s.cached_input_positions} / ${s.replay_input_positions}</td><td>${s.bytes.toLocaleString()}</td><td>${s.prefill_unchanged ? "Yes, exact" : "NO"}</td><td>${s.max_logit_difference.toExponential(3)}</td><td>${s.same_greedy_next ? "Yes" : "No"}</td><td>${(s.cached_seconds * 1000).toFixed(2)} / ${(s.replay_seconds * 1000).toFixed(2)}</td></tr>`).join("")}</tbody></table></div><p class="fine">${esc(c.timing_note)}</p><div class="section-label">EVERY LAYER HAS ITS OWN CACHE</div><div class="cache-layers">${c.final_shapes.map((l) => `<button class="cache-layer ${l.layer === r.layer ? "active" : ""}" data-layer="${l.layer}">L${l.layer + 1}<span>K ${l.k.join("×")}<br>V ${l.v.join("×")}</span></button>`).join("")}</div><p class="fine">Axes: batch × K/V heads × cached positions × head width. Selecting a layer prepares that layer for the next measurement.</p><details><summary>The appended K/V vectors in measured layer ${r.layer + 1}</summary><pre>${esc(
      JSON.stringify(
        c.steps.map((s) => ({
          step: s.step,
          token: s.token,
          K: s.new_k,
          V: s.new_v,
        })),
        null,
        2,
      ),
    )}</pre></details><div class="section-label">WHERE COULD IT GO NEXT?</div><p class="fine">Actual softmax after the final appended token. These are model probabilities, not votes. Copy an ID into the explicit decode sequence above to test that route.</p><div class="token-map">${c.steps
      .at(-1)
      .next.map(
        (t) =>
          `<button data-next="${t.id}">${esc(JSON.stringify(t.text))}<small>ID ${t.id} / ${(t.p * 100).toPrecision(4)}%</small></button>`,
      )
      .join(
        "",
      )}</div><p class="fine">The listed probabilities are a top-eight subset and need not sum to one.</p>`;
  $("cache-results")
    .querySelectorAll("[data-layer]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          $("layer-input").value = b.dataset.layer;
          $("run-status").textContent =
            "Layer selected. Measure again to inspect its actual cache and block.";
          save();
        }),
    );
  $("cache-results")
    .querySelectorAll("[data-next]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          $("append-ids").value = JSON.stringify([
            ...c.steps.map((s) => s.token),
            Number(b.dataset.next),
          ]);
          $("run-status").textContent =
            "Exact next-token route prepared. Measure again to append it (maximum eight tokens).";
          save();
        }),
    );
}
["head-input", "query-input", "key-input", "coordinate-input"].forEach(
  (id) =>
    ($(id).oninput = () => {
      headMap();
      renderAttention();
      save();
    }),
);
$("measurement-form").onsubmit = guard(async (e) => {
  e.preventDefault();
  if (busy) return;
  busy = true;
  measurementRequest++;
  $("measure").disabled = true;
  $("run-status").textContent =
    "Measuring the actual block, then comparing cached decoding with full replay…";
  try {
    const result = await api("/workshop/mechanism", {
      question: $("question-input").value,
      prefix: $("prefix-input").value,
      layer: n("layer-input"),
      steps: n("steps-input"),
      append_ids: $("append-ids").value.trim()
        ? JSON.parse($("append-ids").value)
        : null,
    });
    measurement = result;
    measured();
    save();
    $("run-status").textContent =
      "Measurement saved. Choose a head, a pair of positions, or the KV cache tab.";
  } finally {
    busy = false;
    $("measure").disabled = false;
  }
});
function renderTokens() {
  const r = tokenResult,
    t = r.toy;
  const chips = (tokens, source) =>
    tokens
      .map(
        (p, i) =>
          `<button data-piece="${i}" data-source="${source}">${esc(JSON.stringify(p.text))}<small>ID ${p.id}${source === "actual" ? " / chars " + p.start + "–" + p.end : " / bytes " + p.byte_start + "–" + p.byte_end}</small></button>`,
      )
      .join("");
  $("token-results").innerHTML =
    `<div class="token-compare"><section><div class="section-label">MEASURED / SMOLLM2 TOKENIZER</div><p>${r.tokens.length} tokens · exact round trip: ${r.roundtrip ? "yes" : "NO"}</p><div class="token-map">${chips(r.tokens, "actual")}</div><div id="actual-detail" class="token-detail">Select a token to inspect its vocabulary spelling and source span.</div></section><section><div class="section-label">YOUR BYTE-BPE TOKENIZER / COMPUTED TOY</div><p>${t.tokens.length} tokens · vocabulary ${t.vocabulary_size} · exact round trip: ${t.roundtrip ? "yes" : "NO"}</p><div class="token-map">${chips(t.tokens, "toy")}</div><div id="toy-detail" class="token-detail">Select a piece to inspect the bytes it contains.</div></section></div><p class="fine">${esc(r.offset_note)}</p><div class="section-label">REPLAY THE MERGES</div><label for="merge-stage">APPLY THE FIRST <output id="merge-stage-number">${t.history.length}</output> RULES</label><input id="merge-stage" type="range" min="0" max="${t.history.length}" value="${t.history.length}" style="width:100%"><div id="merge-stage-map" class="token-map"></div><div id="merge-history">${t.history.map((m, i) => `<div class="merge-step" data-rank="${i}"><button data-stage="${i + 1}">${i + 1}. [${m.pair.join(", ")}] → ID ${m.id}: ${esc(JSON.stringify(m.text))}</button><small>Training adjacency count ${m.occurrences}; sequence ${m.before} → ${m.after} pieces</small></div>`).join("")}</div><p class="fine">Repeated adjacent pairs can overlap; the actual merge pass replaces non-overlapping pairs left to right. Ties during training are resolved by token ID. The editable corpus is treated as one continuous byte sequence.</p><div class="control-row"><button id="edit-current-rules">LOAD THESE RULES INTO THE EDITOR ↑</button><button id="download-tokenizer">DOWNLOAD YOUR TOKENIZER ↓</button><a href="/api/glass/receipt/${r.receipt}">EXACT COMPARISON ↓</a></div><p class="fine">${esc(t.compatibility)} A changed ID-to-byte map needs matching embedding/output weights and training; it cannot be swapped into SmolLM2 as if nothing changed.</p><details><summary>Actual pretrained tokenizer pipeline and exact decoded text</summary><pre>${esc(JSON.stringify(r.pipeline, null, 2))}</pre><pre>${esc(r.decoded)}</pre></details>`;
  $("token-results")
    .querySelectorAll("[data-piece]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          const piece =
            b.dataset.source === "actual"
              ? r.tokens[Number(b.dataset.piece)]
              : t.tokens[Number(b.dataset.piece)];
          $(
            b.dataset.source === "actual" ? "actual-detail" : "toy-detail",
          ).innerHTML =
            "<pre>" + esc(JSON.stringify(piece, null, 2)) + "</pre>";
        }),
    );
  function stage() {
    const index = n("merge-stage");
    $("merge-stage-number").textContent = index;
    const vocab = Array.from({ length: 256 }, (_, i) => [i]);
    for (const m of t.history) vocab.push(m.bytes);
    const decoder = new TextDecoder();
    $("merge-stage-map").innerHTML = t.stages[index]
      .map(
        (id) =>
          `<button title="Bytes ${vocab[id].join(", ")}">${esc(JSON.stringify(decoder.decode(new Uint8Array(vocab[id]))))}<small>ID ${id}</small></button>`,
      )
      .join("");
    $("merge-history")
      .querySelectorAll("[data-rank]")
      .forEach((row) =>
        row.classList.toggle("active", Number(row.dataset.rank) < index),
      );
  }
  $("merge-stage").oninput = stage;
  $("merge-history")
    .querySelectorAll("[data-stage]")
    .forEach(
      (b) =>
        (b.onclick = () => {
          $("merge-stage").value = b.dataset.stage;
          stage();
        }),
    );
  stage();
  $("edit-current-rules").onclick = () => {
    $("merge-rules").value = JSON.stringify(t.merges, null, 2);
    $("merge-rules").closest("details").open = true;
    $("merge-rules").scrollIntoView({ block: "center", behavior: "smooth" });
    save();
  };
  $("download-tokenizer").onclick = () =>
    download("cfi-byte-bpe.json", {
      format: t.format,
      base_vocabulary: "UTF-8 bytes 0–255",
      normalization: t.normalization,
      pretokenization: t.pretokenization,
      merges: t.merges,
      training_corpus: t.corpus,
      sample: t.text,
      compatibility: t.compatibility,
    });
}
async function mapTokens(custom = false) {
  if (busy) return;
  busy = true;
  tokenRequest++;
  $("map-tokens").disabled = true;
  $("run-status").textContent =
    "Mapping exact text and executing the byte-pair rules…";
  try {
    tokenResult = await api("/workshop/tokenizer", {
      text: $("token-text").value,
      corpus: $("token-corpus").value,
      count: n("merge-count"),
      merges: custom ? JSON.parse($("merge-rules").value) : null,
    });
    renderTokens();
    save();
    $("run-status").textContent =
      "Mapped. Select pieces or replay the merge sequence.";
  } finally {
    busy = false;
    $("map-tokens").disabled = false;
  }
}
$("tokenizer-form").onsubmit = guard(async (e) => {
  e.preventDefault();
  await mapTokens();
});
$("use-rules").onclick = guard(() => mapTokens(true));
$("clear-rules").onclick = () => {
  $("merge-rules").value = "";
  save();
};
$("copy-context").onclick = () => {
  $("token-text").value = $("question-input").value;
  save();
};
$("import-question").onclick = () => {
  if (sourceRoom) {
    $("question-input").value = sourceRoom.question;
    save();
    $("run-status").textContent =
      "Exact encounter question copied. Run a new measurement when ready.";
  }
};
$("import-turn").onclick = () => {
  if (sourceNode) {
    $("question-input").value = sourceNode.text;
    save();
    $("run-status").textContent =
      "Exact message copied as a user input to the inspection model. This is a new experiment, not a replay of the guest’s original prompt.";
  }
};
(async () => {
  try {
    const context = window.CFIViews?.read("encounter"),
      rid = params.get("room") || context?.id;
    if (rid) {
      sourceRoom = await api("/encounters/" + rid);
      const nid =
        params.get("node") || (context?.id === rid ? context.node : null);
      sourceNode = sourceRoom.nodes.find((n) => n.id === nid);
      scope(sourceRoom, nid);
      $("context-source").textContent =
        "Source encounter: " +
        sourceRoom.question +
        (sourceNode
          ? " / Selected words by " + name(sourceRoom, sourceNode.author)
          : "");

      $("glass-link").href =
        "glass.html?room=" +
        rid +
        "&question=" +
        encodeURIComponent(sourceRoom.question);
    }
    $("import-question").disabled = !sourceRoom;
    $("import-turn").disabled = !sourceNode;
    if (saved?.receipt) {
      const requestAtStart = measurementRequest;
      const restored = await api("/glass/receipt/" + saved.receipt);
      if (requestAtStart === measurementRequest && !busy) {
        measurement = restored;
        measurement.receipt = saved.receipt;
        measured();
        for (const [id, key] of [
          ["head-input", "head"],
          ["query-input", "query"],
          ["key-input", "key"],
          ["coordinate-input", "coordinate"],
        ])
          if (saved[key] !== undefined) $(id).value = saved[key];
        operation = saved.operation || "attention";
        renderOperation();
        headMap();
        renderAttention();
        $("run-status").textContent =
          "Restored a saved measurement; input edits are not measured until you run again.";
      }
    }
    if (saved?.tokenReceipt) {
      const requestAtStart = tokenRequest;
      const restored = await api("/glass/receipt/" + saved.tokenReceipt);
      if (requestAtStart === tokenRequest && !busy) {
        tokenResult = restored;
        tokenResult.receipt = saved.tokenReceipt;
        renderTokens();
      }
    }
    const selected = location.hash.slice(1) || saved?.bench || "mechanism";
    bench(
      ["mechanism", "cache", "tokenizer"].includes(selected)
        ? selected
        : "mechanism",
    );
  } catch (err) {
    notice(err.message);
  }
})();
