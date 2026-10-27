#!/usr/bin/env python3
"""Compose a candidate onboarding catalog entry from its pinned OAD and overlays."""
import json
import os
from pathlib import Path
import sys

import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "overlays" / "scripts"))
from validate_oad_pins import apply_overlay
from pinned_oad import read_pinned_oad


def main(platform="gitlab"):
    catalog_path = Path(os.environ.get("ONBOARDING_CATALOG_PATH", os.environ.get("GITLAB_CATALOG_PATH", "overlays/catalog/2026-10-08-gitlab.json")))
    if not catalog_path.is_absolute():
        catalog_path = ROOT / catalog_path
    catalog = json.loads(catalog_path.read_text())
    entry = next(item for item in catalog["platforms"] if item["name"] == platform)
    source = entry["openapi"]
    prefix, suffix = source.split("/APIs/", 1)
    pin = prefix.rsplit("/", 1)[1]
    source_path = "APIs/" + suffix
    # OPENAPI_DIRECTORY_REPO set: that clone only, a failed read an error.
    raw = read_pinned_oad(
        pin,
        source_path,
        source,
        [ROOT.parent / "openapi-directory", ROOT.parent / "more-openapi-directory"],
    )
    document = yaml.safe_load(raw)
    for url in entry.get("overlays", []):
        relative = url.split("/overlays/", 1)[1]
        overlay_path = ROOT / "overlays" / relative
        overlay = yaml.safe_load(overlay_path.read_text())
        document, errors = apply_overlay(document, overlay, str(overlay_path))
        if errors:
            raise RuntimeError("\n".join(errors))
    # YAML dates and times (unquoted examples, as in Box's OAD) as ISO 8601
    # text. Only such values reach `default`, so every document that composed
    # before composes to the same bytes.
    print(json.dumps(document, separators=(",", ":"), default=lambda value: value.isoformat()))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "gitlab")
