#!/usr/bin/env python3
"""Compose the candidate GitLab catalog entry from its pinned OAD and overlays."""
import json
import os
from pathlib import Path
import subprocess
import sys

import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "overlays" / "scripts"))
from validate_oad_pins import apply_overlay


def main():
    catalog_path = Path(os.environ.get("GITLAB_CATALOG_PATH", "overlays/catalog/2026-10-08-gitlab.json"))
    if not catalog_path.is_absolute():
        catalog_path = ROOT / catalog_path
    catalog = json.loads(catalog_path.read_text())
    entry = next(item for item in catalog["platforms"] if item["name"] == "gitlab")
    source = entry["openapi"]
    prefix, suffix = source.split("/APIs/", 1)
    pin = prefix.rsplit("/", 1)[1]
    source_path = "APIs/" + suffix
    directory_repo = Path(os.environ.get("OPENAPI_DIRECTORY_REPO", ROOT.parent / "openapi-directory"))
    if not directory_repo.exists():
        directory_repo = ROOT.parent / "more-openapi-directory"
    raw = subprocess.check_output(["git", "-C", str(directory_repo), "show", f"{pin}:{source_path}"])
    document = yaml.safe_load(raw)
    for url in entry.get("overlays", []):
        relative = url.split("/overlays/", 1)[1]
        overlay_path = ROOT / "overlays" / relative
        overlay = yaml.safe_load(overlay_path.read_text())
        document, errors = apply_overlay(document, overlay, str(overlay_path))
        if errors:
            raise RuntimeError("\n".join(errors))
    print(json.dumps(document, separators=(",", ":")))


if __name__ == "__main__":
    main()
