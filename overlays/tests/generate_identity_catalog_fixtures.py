"""Compose selected catalog-pinned OADs and overlays (historical identity defaults).

Outputs are reproducible snapshots for integration-proxy tests. The manifest
records every URL and SHA-256 used to produce them.
"""
import argparse
import copy
import hashlib
import json
import pathlib
import re
import urllib.request

import yaml
from openapi_spec_validator import validate


ROOT = pathlib.Path(__file__).parents[1]
CATALOG = json.loads((ROOT / "catalog/2026-10-02.json").read_text())
IDENTITY_PLATFORMS = ("google-calendar", "github-issues")
# GitHub Pages publishes this folder here once merged to ontola/atomic-plugins'
# main. Sources under it are read from the checkout instead, so a change is
# validated before it is published.
PAGES_BASE = "https://ontola.github.io/atomic-plugins/overlays/"


def fetch(url, cache):
    if url.startswith(PAGES_BASE):
        data = (ROOT / url[len(PAGES_BASE):]).read_bytes()
        return data, {"url": url, "sha256": hashlib.sha256(data).hexdigest()}
    name = hashlib.sha256(url.encode()).hexdigest() + ".yaml"
    path = cache / name
    if not path.exists():
        path.write_bytes(urllib.request.urlopen(url, timeout=30).read())
    data = path.read_bytes()
    return data, {"url": url, "sha256": hashlib.sha256(data).hexdigest()}


def merge(destination, update):
    if not isinstance(destination, dict) or not isinstance(update, dict):
        return copy.deepcopy(update)
    for key, value in update.items():
        destination[key] = merge(destination.get(key), value)
    return destination


def target(document, expression):
    node = document
    for bare, quoted in re.findall(r"\.([A-Za-z][A-Za-z0-9]*)|\['([^']+)'\]", expression[1:]):
        node = node[quoted or bare]
    return node


def apply(document, source):
    for action in source["actions"]:
        keys = [quoted or bare for bare, quoted in re.findall(r"\.([A-Za-z][A-Za-z0-9]*)|\['([^']+)'\]", action["target"][1:])]
        parent = document
        for key in keys[:-1]:
            parent = parent[key]
        if keys:
            last = keys[-1]
            parent[last] = merge(parent[last], action["update"])
        else:
            merge(document, action["update"])


def platform_config(name, catalog=None):
    catalog = CATALOG if catalog is None else catalog
    return next(platform for platform in catalog["platforms"] if platform["name"] == name)


def compose(name, cache, catalog=None):
    config = platform_config(name, catalog)
    base, base_record = fetch(config["openapi"], cache)
    provenance = [base_record]
    document = yaml.safe_load(base)
    for url in config["overlays"]:
        raw, record = fetch(url, cache)
        apply(document, yaml.safe_load(raw))
        provenance.append(record)
    # Existing pagination/CRUD proposals use non-`x-` component members. They
    # remain in the fixture; remove only those extension members for ordinary
    # OpenAPI validation.
    standard = copy.deepcopy(document)
    components = standard.get("components", {})
    for key in ("paginationSchemes", "crudResources"):
        components.pop(key, None)
    validate(standard)
    return document, provenance


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=pathlib.Path)
    parser.add_argument("--catalog", type=pathlib.Path, default=ROOT / "catalog/2026-10-02.json",
                        help="Dated catalog to compose; historical default remains unchanged")
    parser.add_argument("--platform", action="append", dest="platforms",
                        help="Exact catalog provider ID; repeat to select several")
    parser.add_argument("--cache", type=pathlib.Path, default=pathlib.Path(".cache/identity-catalog"))
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    args.cache.mkdir(parents=True, exist_ok=True)
    catalog = json.loads(args.catalog.read_text())
    catalog_path = args.catalog.resolve()
    catalog_name = str(catalog_path.relative_to(ROOT.resolve())) if catalog_path.is_relative_to(ROOT.resolve()) else str(catalog_path)
    manifest = {"catalog": {"path": catalog_name, "sha256": hashlib.sha256(args.catalog.read_bytes()).hexdigest()}, "platforms": {}}
    for name in args.platforms or IDENTITY_PLATFORMS:
        document, provenance = compose(name, args.cache, catalog)
        (args.output / f"{name}-composed.yaml").write_text(yaml.safe_dump(document, sort_keys=False))
        manifest["platforms"][name] = provenance
    (args.output / "sources.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
