#!/usr/bin/env python3
"""Generate the offline source lists the Flatpak build needs.

Flathub builds have no network access, so every dependency must be declared
up front as a URL with a checksum. This writes two flatpak-builder module
files from the versions this repository actually pins:

    flatpak/node-modules.json     from package-lock.json
    flatpak/python3-audible.json  from resolving the `audible` package

Run it after changing either dependency set, and commit the result:

    python3 scripts/generate-flatpak-sources.py

Nothing here is used at runtime — it is a maintainer tool, and the generated
files are what the build consumes.
"""

from __future__ import annotations

import argparse
import base64
import json
import pathlib
import subprocess
import sys
import tempfile
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "flatpak"

# The Python that org.gnome.Platform 50 ships (freedesktop-sdk 25.08).
# Only packages without a pure-Python wheel care, which today means Pillow.
DEFAULT_PYTHON = "3.13"
# Flatpak arch name -> the manylinux platform tag fragment PyPI uses.
ARCHES = {"x86_64": "x86_64", "aarch64": "aarch64"}

PYPI_JSON = "https://pypi.org/pypi/{name}/{version}/json"

# Two of the dependencies ship only an sdist, and one of them still says
# `from distutils.core import setup` — which needs setuptools' compatibility
# shim, since distutils itself was removed in Python 3.12. Rather than trust
# whatever setuptools the SDK happens to carry, a known-good pair is vendored
# and used for the build only; it never reaches /app.
BUILD_REQUIREMENTS = ["setuptools", "wheel"]


def fetch_json(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.load(response)


# --- npm ---------------------------------------------------------------


def npm_sources() -> list[dict]:
    """Every production dependency in package-lock.json, as archive sources.

    The lockfile already carries an integrity hash and a resolved URL for each
    package, so this needs no network access and cannot disagree with what
    `npm ci` would install.
    """
    lock = json.loads((ROOT / "package-lock.json").read_text())
    sources = []

    for path, entry in sorted(lock["packages"].items()):
        if not path.startswith("node_modules/") or entry.get("dev"):
            continue

        integrity = entry.get("integrity", "")
        algorithm, _, encoded = integrity.partition("-")
        if algorithm not in ("sha512", "sha256"):
            raise SystemExit(f"{path}: unsupported integrity {integrity!r}")

        sources.append(
            {
                "type": "archive",
                "url": entry["resolved"],
                algorithm: base64.b64decode(encoded).hex(),
                "dest": path,
                # npm tarballs all wrap their contents in a "package/" directory.
                "strip-components": 1,
            }
        )

    if not sources:
        raise SystemExit("no production dependencies found in package-lock.json")
    return sources


# --- pip ---------------------------------------------------------------


def resolve_python_packages(*requirements: str) -> list[tuple[str, str]]:
    """Ask pip to resolve `requirements` without installing anything."""
    with tempfile.TemporaryDirectory() as tmp:
        report_path = pathlib.Path(tmp) / "report.json"
        subprocess.run(
            [
                sys.executable, "-m", "pip", "install",
                "--dry-run", "--ignore-installed", "--quiet",
                "--report", str(report_path), *requirements,
            ],
            check=True,
        )
        report = json.loads(report_path.read_text())

    packages = [
        (item["metadata"]["name"], item["metadata"]["version"])
        for item in report["install"]
    ]
    return sorted(packages, key=lambda p: p[0].lower())


def select_distributions(name: str, version: str, python: str) -> list[dict]:
    """Pick the files to vendor for one package.

    Preference order matters. A pure-Python wheel is one source for every
    architecture. Failing that, a compiled wheel has to be pinned per
    architecture *and* per Python version — that is the fragile case, so it is
    kept as small as possible. A package with no wheel at all falls back to its
    sdist, which the build compiles.
    """
    files = fetch_json(PYPI_JSON.format(name=name, version=version))["urls"]
    tag = f"cp{python.replace('.', '')}"

    def source(entry: dict, **extra) -> dict:
        return {
            "type": "file",
            "url": entry["url"],
            "sha256": entry["digests"]["sha256"],
            **extra,
        }

    for entry in files:
        if entry["packagetype"] == "bdist_wheel" and "-none-any.whl" in entry["filename"]:
            return [source(entry)]

    per_arch = []
    for flatpak_arch, pypi_arch in ARCHES.items():
        match = next(
            (
                entry
                for entry in files
                if entry["packagetype"] == "bdist_wheel"
                and f"-{tag}-" in entry["filename"]
                and "manylinux" in entry["filename"]
                and entry["filename"].endswith(f"_{pypi_arch}.whl")
            ),
            None,
        )
        if match:
            per_arch.append(source(match, **{"only-arches": [flatpak_arch]}))

    if per_arch:
        if len(per_arch) != len(ARCHES):
            missing = len(ARCHES) - len(per_arch)
            print(f"  warning: {name} {version} has no {tag} wheel for {missing} arch(es)")
        return per_arch

    for entry in files:
        if entry["packagetype"] == "sdist":
            return [source(entry)]

    raise SystemExit(f"{name} {version}: no usable wheel or sdist on PyPI")


def python_module(requirement: str, python: str) -> tuple[dict, list[str]]:
    packages = resolve_python_packages(requirement)
    sources: list[dict] = []
    pinned: list[str] = []

    for name, version in packages:
        print(f"  {name} {version}")
        sources.extend(select_distributions(name, version, python))
        pinned.append(f"{name}=={version}")

    # The whole resolved closure, not just the named tools: `wheel` pulls in
    # `packaging`, and an offline install fails on anything left out.
    build_pinned = []
    already = {name.lower() for name, _ in packages}
    for name, version in resolve_python_packages(*BUILD_REQUIREMENTS):
        print(f"  (build only) {name} {version}")
        if name.lower() not in already:
            sources.extend(select_distributions(name, version, python))
        build_pinned.append(f"{name}=={version}")

    module = {
        "name": "python3-audible",
        "buildsystem": "simple",
        "build-commands": [
            # Step one needs no build backend — these are plain wheels — and
            # gives step two a setuptools new enough to build the sdists.
            "python3 -m pip install --no-index"
            ' --find-links="file://${PWD}" --target="${PWD}/_buildtools"'
            f" {' '.join(build_pinned)}",
            # --no-index/--find-links keep this offline. _buildtools is under
            # the build directory, so it is discarded once the module is done.
            'PYTHONPATH="${PWD}/_buildtools" python3 -m pip install'
            " --no-index --no-build-isolation"
            ' --find-links="file://${PWD}"'
            " --target=/app/lib/audible-python"
            f" {' '.join(pinned)}",
        ],
        "sources": sources,
    }
    return module, pinned


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python-version", default=DEFAULT_PYTHON)
    parser.add_argument("--requirement", default="audible==0.12.0")
    args = parser.parse_args()

    OUT_DIR.mkdir(exist_ok=True)

    print("npm dependencies from package-lock.json:")
    sources = npm_sources()
    for entry in sources:
        print(f"  {entry['dest']}")
    node_module = {
        "name": "node-modules",
        "buildsystem": "simple",
        # Unpacked straight into place; there is nothing to compile.
        "build-commands": [
            "mkdir -p /app/share/audible-backup",
            "cp -r node_modules /app/share/audible-backup/node_modules",
        ],
        "sources": sources,
    }
    (OUT_DIR / "node-modules.json").write_text(json.dumps(node_module, indent=2) + "\n")

    print(f"\npython dependencies for {args.requirement} (cpython {args.python_version}):")
    module, pinned = python_module(args.requirement, args.python_version)
    (OUT_DIR / "python3-audible.json").write_text(json.dumps(module, indent=2) + "\n")
    (OUT_DIR / "python-requirements.txt").write_text(
        "# Generated by scripts/generate-flatpak-sources.py — do not edit.\n"
        + "\n".join(pinned)
        + "\n"
    )

    print(f"\nwrote {OUT_DIR.relative_to(ROOT)}/node-modules.json,"
          " python3-audible.json, python-requirements.txt")


if __name__ == "__main__":
    main()
