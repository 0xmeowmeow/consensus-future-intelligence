# Consensus Future Intelligence

A modem, a table, and several minds trying to call something into being.

CFI is a local art/research prototype for human–model conversation, collective influence and explicit experiments with training a small model. Its séance is a theatrical frame around recorded computational events. No hidden author writes the collective answer in advance.

[Project and pictures](https://meow-meow.io/consensus-future-intelligence/)

## Run the current encounter

Tested with Python 3.13 on Linux. Install Ollama separately and make at least one chat model available locally. You choose installed guests in the interface; the three suggested models are `qwen2.5:1.5b`, `phi3:mini`, and `qwen3:14b`. You do not need all three.

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/pip install torch==2.14.1 --index-url https://download.pytorch.org/whl/cpu
./run-encounter.sh
```

Open **http://127.0.0.1:8775/table.html**. Give yourself a name, place a call, choose the guests, and ask a question. Reply to individual messages or add a new thought; each guest gets one reply or explicit pass per round. Sending a message invites another round. GOODBYE closes the encounter.

Run one server process. `CFI_OLLAMA_URL`, `CFI_ENCOUNTER_HOST`, `CFI_ENCOUNTER_PORT` and `CFI_ENCOUNTER_STATE` override the default local model URL, localhost address, port and storage location. This is a prototype for a small trusted group, not a hardened public inference service.

## Five views of one encounter

- **The Table:** a chronological conversation, named participants, replies and per-message feedback.
- **The Exchange:** exact authored contributions and their relationships. Each identity allocates one absolute unit across support and opposition.
- **The Record:** attributed markers for an agreement, a change of direction or an unresolved difference. Snapshots let you compare what changed. Silence is never counted as endorsement.
- **Under the Glass:** measured attention and token predictions from an optional, separately identified inspection model.
- **The Workshop:** Q/K/V arithmetic, grouped-query attention, transformer blocks, cached versus uncached decoding, tokenizer mapping, and editable byte-BPE experiments.

Helpful/unhelpful feedback, support allocations, token probabilities and attention weights are different measurements. The interface preserves that distinction. A guest's declared support is not a reading of its internal tensors. Inspecting the separate model is not inspecting the guests' thoughts.

## Optional transformer instruments

The tensor instruments use a pinned `HuggingFaceTB/SmolLM2-135M-Instruct` checkpoint. The downloader verifies the weight checksum and downloads data files only. Weights are not included in this repository; the model has its own upstream terms.

```sh
.venv/bin/pip install -r requirements-inspection.txt
.venv/bin/python scripts/install-inspection-model.py --destination "$PWD/models/SmolLM2-135M-Instruct"
export CFI_GLASS_MODEL="$PWD/models/SmolLM2-135M-Instruct"
./run-encounter.sh
```

The editable byte-BPE tokenizer is a separate toy. Changing its merges does not silently replace the pretrained model's tokenizer.

## Two small learners, two generations of the experiment

The current encounter includes an explicit **199,362-parameter byte transformer** experiment: select material, fit a separate candidate, inspect the result. Discussion does not silently update a guest's pretrained weights.

The original pilot remains available through `./run.sh` on port **8771**. It has shared physical board motion, work packets, an internal token ledger, paid-in-game question submission/voting, a local guest and a **99,504-parameter character GRU** starting from random weights. Its learner uses frozen batches, real AdamW training and explicit checkpoint adoption. Its default guest is `qwen3:14b`; override with `CFI_LLM`. Pilot tokens are game accounting, not payments or a cryptocurrency.

Neither the narrow tests nor the tiny learners establish general intelligence or alignment. Donations, distributed compute, mass participation, model-PR governance and commercial payments are proposals, not implemented capabilities.

## Data and checks

Conversation text, prompts, model responses, markers, feedback and training receipts are stored locally under `state/`. People who can access an encounter server can read its encounters. Cookie identities do not establish unique people. Back up local state deliberately; it is excluded from Git.

```sh
.venv/bin/python -m pytest -q
```

The suite covers accounting, physical causality, conversation ordering, failure recovery, markers, exact context, training and tensor measurements. Optional real-model checks skip when the checkpoint is absent. Automated checks establish software behaviour, not the quality of the social experiment.

Source snapshots exclude participant records, checkpoints and private development archives. Contribute only material you have permission to contribute for the stated uses. Fonts retain their notices in `web/encounter/assets/`; the Table artwork and synthesised modem are project assets. See `web/encounter/credits.html`.
