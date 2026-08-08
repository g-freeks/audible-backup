#!/usr/bin/env python3
"""Test stand-in for helper/audible_helper.py. Behavior via FAKE_HELPER_MODE."""
import json
import os
import pathlib
import sys


def emit(obj):
    print(json.dumps(obj), flush=True)


mode = os.environ.get("FAKE_HELPER_MODE", "ok")
command = sys.argv[1] if len(sys.argv) > 1 else ""

if mode == "missing":
    emit({"type": "done", "ok": False, "reason": "missing_dependency", "message": "no audible pkg"})
    sys.exit(1)

if command == "library":
    emit({"type": "log", "message": "fake library fetch"})
    emit({
        "type": "done", "ok": True,
        "items": [
            {"asin": "B0FAKE00001", "title": "Fake Book", "authors": "Fake Author", "downloadable": True},
            {"asin": "B0FAKE00002", "title": "Fake Podcast", "authors": "Someone", "downloadable": False},
        ],
    })
elif command == "download":
    asin, target = sys.argv[2], sys.argv[3]
    if mode == "not_downloadable":
        emit({"type": "done", "ok": False, "reason": "not_downloadable", "message": "License denied"})
        sys.exit(0)
    out = pathlib.Path(target)
    out.mkdir(parents=True, exist_ok=True)
    aaxc = out / f"{asin}_Fake_Book.aaxc"
    voucher = out / f"{asin}_Fake_Book.voucher"
    aaxc.write_bytes(b"fake aaxc bytes")
    voucher.write_text(json.dumps({"key": "a" * 32, "iv": "b" * 32}))
    (out / f"{asin}-chapters.json").write_text("{}")
    (out / f"{asin}_(500).jpg").write_bytes(b"\xff\xd8")
    emit({"type": "progress", "asin": asin, "pct": 50})
    emit({"type": "progress", "asin": asin, "pct": 100})
    emit({"type": "done", "ok": True, "files": {"aaxc": str(aaxc), "voucher": str(voucher)}})
else:
    emit({"type": "done", "ok": False, "reason": "bad_args", "message": f"unknown: {command}"})
    sys.exit(1)
