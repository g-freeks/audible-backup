#!/usr/bin/env python3
"""JSON-over-stdout helper around the `audible` Python package.

Bridges the Node app to the Audible API for the things audible-cli's text
output can't express: structured library listings and AAXC downloads with
per-file decryption vouchers. Every stdout line is a JSON event; the final
event has type "done" with ok true/false. Reads audible-cli's config from
AUDIBLE_CONFIG_DIR (default ~/.audible), so `audible quickstart` remains the
single sign-in step.

Commands:
  library                          List the library as structured JSON.
  download <asin> <dir> [title]    Download AAXC + voucher + chapters + cover.
"""

import json
import os
import pathlib
import re
import sys


def emit(obj):
    print(json.dumps(obj), flush=True)


def done_fail(reason, message=""):
    emit({"type": "done", "ok": False, "reason": reason, "message": message})
    sys.exit(1)


def load_audible():
    try:
        import audible  # noqa: F401
        return audible
    except ImportError:
        done_fail("missing_dependency", "Python package 'audible' is not installed")


def get_auth(audible):
    import tomllib

    config_dir = pathlib.Path(
        os.environ.get("AUDIBLE_CONFIG_DIR") or pathlib.Path.home() / ".audible"
    )
    config_file = config_dir / "config.toml"
    if not config_file.exists():
        done_fail(
            "no_config",
            f"No audible-cli config at {config_file}. Run 'audible quickstart' first.",
        )
    with open(config_file, "rb") as f:
        config = tomllib.load(f)

    profiles = config.get("profile", {})
    primary = config.get("APP", {}).get("primary_profile")
    profile = profiles.get(primary) or next(iter(profiles.values()), None)
    if not profile or "auth_file" not in profile:
        done_fail("no_config", "No profile with an auth_file in config.toml")

    auth_file = config_dir / profile["auth_file"]
    if not auth_file.exists():
        done_fail("no_config", f"Auth file not found: {auth_file}")
    try:
        return audible.Authenticator.from_file(str(auth_file))
    except Exception as exc:  # encrypted auth files etc.
        done_fail("auth_error", f"Could not load auth file: {exc}")


def cmd_library():
    audible = load_audible()
    auth = get_auth(audible)
    items = []
    with audible.Client(auth) as client:
        page = 1
        while True:
            response = client.get(
                "library",
                num_results=1000,
                page=page,
                response_groups="product_desc,product_attrs",
            )
            batch = response.get("items") or []
            for item in batch:
                asin = item.get("asin")
                if not asin:
                    continue
                authors = ", ".join(
                    a.get("name", "") for a in (item.get("authors") or []) if a.get("name")
                )
                delivery = item.get("content_delivery_type") or ""
                items.append(
                    {
                        "asin": asin,
                        "title": item.get("title") or asin,
                        "authors": authors,
                        "downloadable": delivery not in ("PodcastParent", "Periodical"),
                    }
                )
            if len(batch) < 1000:
                break
            page += 1
    emit({"type": "done", "ok": True, "items": items})


def safe_filename(name):
    name = re.sub(r"[^A-Za-z0-9._-]+", "_", name).strip("_")
    return name[:80]


def download_url(url, dest, asin=None):
    import httpx

    with httpx.stream(
        "GET", url, follow_redirects=True, timeout=120,
        headers={"User-Agent": "Audible/671 CFNetwork/1240.0.4 Darwin/20.6.0"},
    ) as response:
        response.raise_for_status()
        total = int(response.headers.get("content-length") or 0)
        received = 0
        last_pct = -1
        with open(dest, "wb") as f:
            for chunk in response.iter_bytes(chunk_size=1 << 16):
                f.write(chunk)
                received += len(chunk)
                if total and asin:
                    pct = int(received * 100 / total)
                    if pct != last_pct:
                        last_pct = pct
                        emit({"type": "progress", "asin": asin, "pct": pct})


def cmd_download(asin, target_dir, title=""):
    audible = load_audible()
    from audible.aescipher import decrypt_voucher_from_licenserequest

    auth = get_auth(audible)
    out = pathlib.Path(target_dir)
    out.mkdir(parents=True, exist_ok=True)

    with audible.Client(auth) as client:
        license_response = client.post(
            f"content/{asin}/licenserequest",
            body={
                "drm_type": "Adrm",
                "consumption_type": "Download",
                "quality": "High",
            },
        )
        content_license = license_response.get("content_license") or {}
        if content_license.get("status_code") == "Denied":
            reason = content_license.get("license_denial_reasons") or []
            done_fail("not_downloadable", f"License denied: {reason}")
        content_url = (
            content_license.get("content_metadata", {})
            .get("content_url", {})
            .get("offline_url")
        )
        if not content_url:
            done_fail("not_downloadable", "License response contained no download URL")

        voucher = decrypt_voucher_from_licenserequest(auth, license_response)

        chapters = client.get(
            f"content/{asin}/metadata",
            response_groups="chapter_info,content_reference",
            quality="High",
        )

        cover_url = None
        try:
            product = client.get(
                f"catalog/products/{asin}",
                response_groups="media",
                image_sizes="500",
            )
            cover_url = (product.get("product") or {}).get("product_images", {}).get("500")
        except Exception:
            pass  # cover is nice-to-have

    stem = f"{asin}_{safe_filename(title)}" if title else asin
    aaxc_file = out / f"{stem}.aaxc"
    voucher_file = out / f"{stem}.voucher"
    chapters_file = out / f"{asin}-chapters.json"
    cover_file = out / f"{asin}_(500).jpg"

    emit({"type": "log", "message": f"Downloading AAXC for {asin}..."})
    download_url(content_url, aaxc_file, asin=asin)
    voucher_file.write_text(json.dumps(voucher, indent=2))
    chapters_file.write_text(json.dumps(chapters, indent=2))
    if cover_url:
        try:
            download_url(cover_url, cover_file)
        except Exception as exc:
            emit({"type": "log", "message": f"Cover download failed: {exc}"})

    emit(
        {
            "type": "done",
            "ok": True,
            "files": {
                "aaxc": str(aaxc_file),
                "voucher": str(voucher_file),
                "chapters": str(chapters_file),
                "cover": str(cover_file) if cover_url else None,
            },
        }
    )


def main():
    if len(sys.argv) < 2:
        done_fail("bad_args", "Usage: audible_helper.py library | download <asin> <dir> [title]")
    command = sys.argv[1]
    try:
        if command == "library":
            cmd_library()
        elif command == "download":
            if len(sys.argv) < 4:
                done_fail("bad_args", "Usage: audible_helper.py download <asin> <dir> [title]")
            cmd_download(sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else "")
        else:
            done_fail("bad_args", f"Unknown command: {command}")
    except SystemExit:
        raise
    except Exception as exc:
        done_fail("error", f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    main()
