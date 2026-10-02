"""Check canonical OAD paths, revision filenames, and catalog selections.

With --directory, also check against full Git history (no OAD blobs needed).
Historical revisions remain valid: each pin must be a commit that last changed
that OAD, rather than an unrelated later repository commit.
"""
import argparse
import concurrent.futures
import json
from pathlib import Path, PurePosixPath
import re
import subprocess

import yaml

ROOT = Path(__file__).resolve().parents[1]
OAD_BASE = "https://raw.githubusercontent.com/ontola/openapi-directory/"
PAGES_BASE = "https://ontola.github.io/atomic-plugins/overlays/"
PIN = re.compile(re.escape(OAD_BASE) + r"([0-9a-f]{40})/(APIs/.+/(?:openapi|swagger)\.yaml)")


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


def validate(root=ROOT, directory=None, latest_ref=None, published=None, fetch_missing=False):
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
    for catalog_path in catalogs:
        catalog = json.loads(catalog_path.read_text())
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
    errors = validate(directory=args.directory, latest_ref=args.latest_ref, published=args.published, fetch_missing=args.fetch_missing)
    if errors:
        raise SystemExit("\n".join(errors))
    print(f"Validated {len(list(ROOT.rglob('*-overlay.yaml')))} revision-pinned overlays and catalog selections")


if __name__ == "__main__":
    main()
