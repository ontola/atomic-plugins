"""Check canonical OAD paths, revision filenames, and catalog selections.

With --directory, also check against full Git history. Historical revisions
remain valid: each pin must be a commit that last changed that OAD, rather than
an unrelated later repository commit. The same mode reads each pinned OAD (a
blobless clone fetches the blobs on demand) and applies every overlay the way
integration-proxy's strict loader does: an action whose target does not exist
fails. Overlays a dated catalog selects are applied in that catalog's order, so
a target an earlier overlay adds counts; every other overlay must resolve
against its pinned OAD composed with its sibling overlays for the same pin, in
whichever order resolves. Swagger 2.0 documents have no `components`, so an
overlay for one must target `$` and add root `x-` members (see README.md).
"""
import argparse
import concurrent.futures
import copy
import json
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys

import yaml

ROOT = Path(__file__).resolve().parents[1]
OAD_BASE = "https://raw.githubusercontent.com/ontola/openapi-directory/"
PAGES_BASE = "https://ontola.github.io/atomic-plugins/overlays/"
PIN = re.compile(re.escape(OAD_BASE) + r"([0-9a-f]{40})/(APIs/.+/(?:openapi|swagger)\.yaml)")


class LOADER(getattr(yaml, "CSafeLoader", yaml.SafeLoader)):
    """Like the proxy's serde_yaml, keep timestamps and `=` keys as strings; some OADs have ones PyYAML rejects."""


LOADER.add_constructor("tag:yaml.org,2002:timestamp", LOADER.construct_yaml_str)
LOADER.add_constructor("tag:yaml.org,2002:value", LOADER.construct_yaml_str)


def parse_target(target):
    """Split an action target as integration-proxy's catalog.rs parse_target does.

    Only `$`, then `.key` or `['key']` segments. Anything else, including
    filters and wildcards, fails the whole catalog load there.
    """
    if not isinstance(target, str) or not target.startswith("$"):
        raise ValueError(f"unsupported overlay target {target!r}")
    rest, keys = target[1:], []
    while rest:
        if rest.startswith("."):
            after = rest[1:]
            end = next((index for index, char in enumerate(after) if char in ".["), len(after))
            if end == 0:
                raise ValueError(f"unsupported overlay target {target!r}")
            keys.append(after[:end])
            rest = after[end:]
        elif rest.startswith("['"):
            after = rest[2:]
            end = after.find("']")
            if end < 0:
                raise ValueError(f"unsupported overlay target {target!r}")
            keys.append(after[:end])
            rest = after[end + 2:]
        else:
            raise ValueError(f"unsupported overlay target {target!r}")
    return keys


def merge(destination, update):
    """Deep-merge objects and replace everything else, as the proxy does."""
    if isinstance(destination, dict) and isinstance(update, dict):
        for key, value in update.items():
            destination[key] = merge(destination.get(key), value)
        return destination
    return update


def apply_overlay(document, overlay, label):
    """Apply `overlay` to `document` in place; return the proxy's load errors.

    The proxy only knows `update` actions, and refuses a target that does not
    exist in the document as composed so far. A failed action is skipped so
    that one report lists every missing target.
    """
    errors = []
    for action in overlay.get("actions") or []:
        target = action.get("target") if isinstance(action, dict) else None
        if not isinstance(action, dict) or "update" not in action:
            errors.append(f"{label}: action {target!r} must have an update (the proxy supports no other action)")
            continue
        try:
            keys = parse_target(target)
        except ValueError as error:
            errors.append(f"{label}: {error}")
            continue
        node, exists = document, True
        for key in keys:
            if isinstance(node, dict) and key in node:
                node = node[key]
            else:
                errors.append(f"{label}: target {target!r} does not exist")
                exists = False
                break
        if not exists:
            continue
        if keys:
            parent = document
            for key in keys[:-1]:
                parent = parent[key]
            parent[keys[-1]] = merge(parent[keys[-1]], copy.deepcopy(action["update"]))
        else:
            document = merge(document, copy.deepcopy(action["update"]))
    return document, errors


def overlay_pin(path, root=ROOT):
    document = yaml.safe_load(path.read_text())
    url = document.get("extends", "")
    match = PIN.fullmatch(url)
    if not match:
        raise ValueError(f"{path}: extends must pin an ontola/openapi-directory OAD by full SHA")
    sha, source = match.groups()
    if PurePosixPath(source).parent != PurePosixPath(path.parent.relative_to(root).as_posix()):
        raise ValueError(f"{path}: folder must match {source}")
    if not re.fullmatch(r".+-" + sha + r"-overlay\.yaml", path.name):
        raise ValueError(f"{path}: filename must include its extends commit before -overlay.yaml")
    return url, sha, source


def pinned_oad(directory, sha, source):
    return yaml.load(subprocess.check_output(["git", "-C", str(directory), "show", f"{sha}:{source}"]), Loader=LOADER)


def prefetch_blobs(directory, pins):
    """Fetch the pinned OADs' blobs in a few batches instead of one lazy fetch each.

    Best effort: a full clone has them already, and a failed batch only means
    `git show` fetches on demand later (or fails with its own message).
    """
    def git(*args):
        return subprocess.check_output(["git", "-C", str(directory), *args], text=True).strip()
    blobs = []
    for _, sha, source in set(pins):
        try:
            entry = git("ls-tree", sha, "--", source).split()
        except subprocess.CalledProcessError:
            continue  # reported by the pin check
        if len(entry) >= 3 and entry[1] == "blob":
            blobs.append(entry[2])
    if not git("remote"):
        return
    for start in range(0, len(blobs), 100):
        subprocess.run(["git", "-C", str(directory), "fetch", "--quiet", "origin", *blobs[start:start + 100]], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def revision(path, sha):
    """(kind, version) of `<kind>-<sha>-overlay.yaml` or `<kind>-v<N>-<sha>-overlay.yaml`."""
    kind = path.name[: -len(f"-{sha}-overlay.yaml")]
    match = re.fullmatch(r"(.+)-v([2-9]|[1-9][0-9]+)", kind)
    return (match.group(1), int(match.group(2))) if match else (kind, 1)


def superseded(pins):
    """Revision files a higher `-vN-` of the same kind and pin replaces.

    They stay published, and a catalog may still select one (then it is
    checked in that composition), but on their own they are not checked: a
    newer revision usually exists because the old one does not compose.
    """
    latest = {}
    for path, (_, sha, _) in pins.items():
        kind, version = revision(path, sha)
        key = (path.parent, kind, sha)
        latest[key] = max(latest.get(key, 0), version)
    return {path for path, (_, sha, _) in pins.items() if revision(path, sha)[1] < latest[(path.parent, revision(path, sha)[0], sha)]}


def target_errors(root, pins, catalogs, directory, warnings=None):
    """Every action target must exist in its pinned OAD, or in the catalog composition up to it.

    Overlays no catalog selects are composed per pin with their sibling
    overlays in whichever order resolves (a historical catalog's order is not
    recorded here), and a target none of those orders supplies is an error. An
    OAD this loader cannot parse is a warning, not an error: nothing about the
    overlay can be checked against it.
    """
    errors, selected, cache = [], superseded(pins), {}
    warnings = warnings if warnings is not None else []

    def document_at(sha, source):
        key = (sha, source)
        if key not in cache:
            try:
                cache[key] = pinned_oad(directory, sha, source)
            except (subprocess.CalledProcessError, yaml.YAMLError) as error:
                cache[key] = f"{source}: cannot check overlay targets, the OAD at {sha} does not parse: {error}"
        document = cache[key]
        return (None, document) if isinstance(document, str) else (copy.deepcopy(document), None)

    def relative(path):
        return path.relative_to(root).as_posix()

    prefetch_blobs(directory, pins.values())
    for catalog_path, catalog in catalogs:
        for platform in catalog["platforms"]:
            label = f"{catalog_path.name} {platform['name']}"
            match = PIN.fullmatch(platform["openapi"])
            if match:
                document, error = document_at(*match.groups())
            elif platform["openapi"].startswith(PAGES_BASE):
                document, error = yaml.load((root / platform["openapi"][len(PAGES_BASE):]).read_bytes(), Loader=LOADER), None
            else:
                document, error = None, f"{label}: cannot check overlay targets against an OAD outside {OAD_BASE} and {PAGES_BASE}"
            if error:
                errors.append(f"{label}: {error}")
                continue
            for url in platform.get("overlays", []):
                path = root / url[len(PAGES_BASE):] if url.startswith(PAGES_BASE) else None
                if path not in pins:
                    continue  # reported by the catalog check
                selected.add(path)
                document, action_errors = apply_overlay(document, yaml.load(path.read_bytes(), Loader=LOADER), f"{label}: {relative(path)}")
                errors.extend(action_errors)
    groups = {}
    for path, (_, sha, source) in sorted(pins.items()):
        if path not in selected:
            groups.setdefault((sha, source), []).append(path)
    for (sha, source), paths in sorted(groups.items()):
        document, error = document_at(sha, source)
        if error:
            warnings.append(error)
            continue
        overlays = {path: yaml.load(path.read_bytes(), Loader=LOADER) for path in paths}
        pending, progress = list(paths), True
        while pending and progress:
            progress = False
            for path in list(pending):
                trial = document if len(pending) == 1 else copy.deepcopy(document)
                trial, action_errors = apply_overlay(trial, overlays[path], relative(path))
                if not action_errors:
                    document, progress = trial, True
                    pending.remove(path)
                elif len(pending) == 1:
                    errors.extend(action_errors)
                    pending.remove(path)
        for path in pending:
            errors.extend(apply_overlay(copy.deepcopy(document), overlays[path], relative(path))[1])
    return errors


def published_errors(root, ref):
    """Published revision files are immutable; catalog selections may change."""
    repository = Path(subprocess.check_output(["git", "-C", str(root), "rev-parse", "--show-toplevel"], text=True).strip())
    prefix = root.resolve().relative_to(repository.resolve()).as_posix()
    paths = subprocess.check_output(["git", "-C", str(repository), "ls-tree", "-r", "--name-only", ref, "--", prefix + "/APIs", prefix + "/catalog"], text=True).splitlines()
    errors = []
    for relative in paths:
        if not re.search(r"-[0-9a-f]{40}-overlay\.yaml$", relative) and not relative.startswith(prefix + "/catalog/"):
            continue  # The initial flag-day migration replaces unversioned paths.
        path = repository / relative
        old = subprocess.check_output(["git", "-C", str(repository), "show", ref + ":" + relative])
        if not path.is_file() or path.read_bytes() != old:
            errors.append(f"{relative}: published revision must not be changed or removed; add a new filename")
    return errors


def validate(root=ROOT, directory=None, latest_ref=None, published=None, fetch_missing=False, warnings=None):
    errors, pins = [], {}
    overlays = sorted(root.rglob("*-overlay.yaml"))
    if not overlays:
        return ["No overlays found"]
    for path in overlays:
        try:
            pins[path] = overlay_pin(path, root)
        except (ValueError, yaml.YAMLError) as error:
            errors.append(str(error))
    catalogs = sorted((root / "catalog").glob("*.json"))
    if (root / "catalog.json").is_file():
        catalogs.append(root / "catalog.json")
    if not catalogs:
        errors.append("No platform catalogs found")
    catalogs = [(catalog_path, json.loads(catalog_path.read_text())) for catalog_path in catalogs]
    for catalog_path, catalog in catalogs:
        for platform in catalog["platforms"]:
            for url in platform.get("overlays", []):
                if not url.startswith(PAGES_BASE):
                    errors.append(f"{platform['name']}: overlay is outside the Pages base: {url}")
                    continue
                path = root / url[len(PAGES_BASE):]
                if path not in pins:
                    errors.append(f"{platform['name']}: missing or invalid overlay: {url}")
                elif pins[path][0] != platform["openapi"]:
                    errors.append(f"{platform['name']}: overlay extends differs from catalog OAD: {url}")
    if directory:
        def git(*args):
            return subprocess.check_output(["git", "-C", str(directory), *args], text=True).strip()
        if git("rev-parse", "--is-shallow-repository") == "true":
            errors.append("OAD checkout is shallow; fetch --unshallow before checking last-change commits")
            return errors
        if fetch_missing:
            missing = [sha for sha in {pin[1] for pin in pins.values()} if subprocess.run(["git", "-C", str(directory), "cat-file", "-e", sha + "^{commit}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode]
            if missing:
                subprocess.check_call(["git", "-C", str(directory), "fetch", "--filter=blob:none", "origin", *sorted(missing)])
        def check(pin):
            _, sha, source = pin
            try:
                if git("ls-tree", "--name-only", sha, "--", source) != source:
                    return f"{sha}: missing OAD {source}"
                changed = git("log", "-1", "--format=%H", sha, "--", source)
                if changed != sha:
                    return f"{source}: {sha} did not last change the OAD (use {changed})"
                if latest_ref:
                    latest = git("log", "-1", "--format=%H", latest_ref, "--", source)
                    if latest != sha:
                        return f"{source}: {sha} is historical; latest at {latest_ref} is {latest}"
            except subprocess.CalledProcessError:
                return f"{sha}: cannot inspect {source} in the OAD checkout"
            return None
        with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
            errors.extend(error for error in pool.map(check, set(pins.values())) if error)
        errors.extend(target_errors(root, pins, catalogs, directory, warnings))
    if published:
        errors.extend(published_errors(root, published))
    return errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, help="full-history openapi-directory checkout")
    parser.add_argument("--latest-ref", help="also require newest OAD revisions at this Git ref")
    parser.add_argument("--published", help="Git ref whose published revision files must remain unchanged")
    parser.add_argument("--fetch-missing", action="store_true", help="fetch historical pinned commits absent from the directory checkout")
    args = parser.parse_args()
    if args.latest_ref and not args.directory:
        parser.error("--latest-ref requires --directory")
    warnings = []
    errors = validate(directory=args.directory, latest_ref=args.latest_ref, published=args.published, fetch_missing=args.fetch_missing, warnings=warnings)
    for warning in warnings:
        print(f"warning: {warning}", file=sys.stderr)
    if errors:
        raise SystemExit("\n".join(errors))
    checked = " and every action target" if args.directory else ""
    print(f"Validated {len(list(ROOT.rglob('*-overlay.yaml')))} revision-pinned overlays and catalog selections{checked}")


if __name__ == "__main__":
    main()
