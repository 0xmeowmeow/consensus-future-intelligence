#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
if [[ ! -x .venv/bin/python ]]; then
  python3 -m venv .venv
fi
if [[ ! -f .venv/.cfi-deps-installed ]]; then
  .venv/bin/python -m pip install -r requirements.txt
  .venv/bin/python -m pip install torch==2.14.1 --index-url https://download.pytorch.org/whl/cpu
  touch .venv/.cfi-deps-installed
fi
exec .venv/bin/python -m uvicorn cfi.server:app --host "${CFI_HOST:-127.0.0.1}" --port "${CFI_PORT:-8771}" "$@"
