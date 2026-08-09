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

config_dir = pathlib.Path(os.environ.get("AUDIBLE_CONFIG_DIR") or "/tmp/fake-audible")

if command == "login-status":
    linked = (config_dir / "config.toml").exists()
    emit({"type": "done", "ok": True, "linked": linked, "marketplace": "de" if linked else ""})
elif command == "login-url":
    marketplace = sys.argv[2]
    if marketplace not in ("de", "us", "uk", "fr", "ca", "it", "au", "in", "jp", "es", "br"):
        emit({"type": "done", "ok": False, "reason": "bad_args", "message": f"Unknown marketplace: {marketplace}"})
        sys.exit(1)
    emit({
        "type": "done", "ok": True,
        "url": f"https://www.amazon.{marketplace}/ap/signin?openid.oa2.response_type=code&fake=1",
        "serial": "FAKESERIAL0123456789012345678901",
        "code_verifier": "ZmFrZS1jb2RlLXZlcmlmaWVyLWZvci10ZXN0aW5nLXB1cnA=",
        "marketplace": marketplace,
    })
elif command == "login-complete":
    marketplace, serial, verifier, url = sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
    if "authorization_code" not in url:
        emit({"type": "done", "ok": False, "reason": "bad_redirect_url", "message": "That URL has no authorization code."})
        sys.exit(1)
    config_dir.mkdir(parents=True, exist_ok=True)
    (config_dir / "audible_backup.json").write_text("{}")
    (config_dir / "config.toml").write_text(
        'title = "Audible Config File"\n\n[APP]\nprimary_profile = "audible_backup"\n\n'
        f'[profile.audible_backup]\nauth_file = "audible_backup.json"\ncountry_code = "{marketplace}"\n'
    )
    emit({"type": "done", "ok": True, "marketplace": marketplace, "account": "Test User"})
elif command == "library":
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
