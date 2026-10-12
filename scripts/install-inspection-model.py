#!/usr/bin/env python3
"""Download only pinned weights/tokenizer data for the optional read-only lens."""
import argparse
import hashlib
from pathlib import Path
from huggingface_hub import snapshot_download

MODEL='HuggingFaceTB/SmolLM2-135M-Instruct'
REVISION='12fd25f77366fa6b3b4b768ec3050bf629380bac'
SHA256='5af571cbf074e6d21a03528d2330792e532ca608f24ac70a143f6b369968ab8c'
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--destination',default='/home/meow/data/machine/ai/models/huggingface/SmolLM2-135M-Instruct')
args=parser.parse_args()
path=Path(snapshot_download(MODEL,revision=REVISION,local_dir=args.destination,
    allow_patterns=['*.json','*.txt','*.safetensors','README.md'],ignore_patterns=['*.bin','*.py']))
with (path/'model.safetensors').open('rb') as f:
    digest=hashlib.file_digest(f,'sha256').hexdigest()
if digest!=SHA256:raise SystemExit('The downloaded weights did not match the pinned revision.')
print(f'Installed {MODEL} at revision {REVISION}\n{path}\nSHA-256 {digest}')
