#!/usr/bin/env python3
"""Compose one local dated-catalog platform using the overlay validator."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import urllib.request

import yaml

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "overlays" / "scripts"))
from validate_oad_pins import apply_overlay


def main(platform, catalog_path, output=None):
    catalog = json.loads(catalog_path.read_text())
    entry = next(item for item in catalog["platforms"] if item["name"] == platform)
    source = entry["openapi"]
    prefix, suffix = source.split("/APIs/", 1)
    pin = prefix.rsplit("/", 1)[1]
    source_path = "APIs/" + suffix
    directory_repo = ROOT.parent / "openapi-directory"
    if directory_repo.is_dir():
        raw = subprocess.check_output(
            ["git", "-C", str(directory_repo), "show", f"{pin}:{source_path}"]
        )
    else:
        raw = urllib.request.urlopen(source, timeout=30).read()
    document = yaml.safe_load(raw)
    for url in entry.get("overlays", []):
        relative = url.split("/overlays/", 1)[1]
        path = ROOT / "overlays" / relative
        overlay = yaml.safe_load(path.read_text())
        document, errors = apply_overlay(document, overlay, str(path))
        if errors:
            raise RuntimeError("\n".join(errors))
    rendered = json.dumps(document, indent=2) + "\n" if output else json.dumps(document, separators=(",", ":"))
    if output:
        output.write_text(rendered)
    else:
        print(rendered)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("platform")
    parser.add_argument("--catalog", type=Path, default=ROOT / "overlays/catalog/2026-10-08-asana-airtable.json")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    main(args.platform, args.catalog, args.output)
