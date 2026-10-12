#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
exec .venv/bin/python -m uvicorn cfi.encounter:app --host "${CFI_ENCOUNTER_HOST:-127.0.0.1}" --port "${CFI_ENCOUNTER_PORT:-8775}" "$@"
