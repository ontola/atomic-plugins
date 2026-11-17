#!/usr/bin/env python3
"""Measure whether an overlay test notices a wrong overlay (mutation testing).

Opt-in and not run in CI. For one test module under `overlays/tests/`, it
makes small changes ("mutants") to the overlays the test is about, one at a
time, runs the test against each, and reports the mutants the test still
passes ("survivors"). A survivor is an overlay change the test cannot see.

Mutations, applied to each overlay's `actions` (the `update` and `remove`
values) and to the `x-` keys of its `info`:

- drop a whole action, a mapping key or a list item;
- flip a boolean; add 1 to an integer;
- change a string of at most 80 characters: removed<->deleted,
  unavailable->deleted, ascending<->descending, cursor<->pageToken,
  pageSize->limit, nextPageToken->nextCursor, otherwise append "Mut".

`description`, `summary` and `title` values are never changed, and neither
is an action's `target` (a missing target fails composition, which says
nothing about the test).

Usage, from the repository root:

    python3 overlays/scripts/mutate_overlays.py --list test_discord_pagination_v3
    python3 overlays/scripts/mutate_overlays.py test_discord_pagination_v3 \\
        --overlay APIs/discord.com/10/pagination-v3-9d0d73c6b23cb07ca2d225fb8b3848fede322b21-overlay.yaml

`--list` runs the test once and prints every overlay it opens. Without
`--overlay`, every overlay the test opens is mutated; that includes the
catalog overlays a test composes for context, whose survivors are usually
not the test's concern, so name the overlays under test. `--cap N` samples N
mutants per overlay (seeded by `--seed`); the default runs every mutant.
`--survivors` prints each surviving mutant.

By default it works in copies of `overlays/`, `openapi-extensions/` and
`integrations/` (without node_modules) in a temporary directory, one per
worker (`--workers`, default 4), and never touches the checkout. Tests that
read something else from the repository fail their baseline there; the tool
then says so. `--in-place` instead mutates the checkout's overlay files one
at a time with one worker, restoring each file after its run; do not edit
the checkout while it runs. Tests that call git (`origin/main`) need
`--in-place`.

Downloads of pinned OADs go through a URL cache (`--url-cache`, default
`mutate-overlays-urls` in the system temporary directory), so each pinned
document is fetched once, not once per mutant. Pinned URLs are full-SHA, so
a cached copy never goes stale.

Exit status: 0 when the baseline passes for every overlay, 1 otherwise. The
number of survivors does not change the exit status: this is a measurement,
not a gate.
"""
import argparse
import concurrent.futures
import copy
import hashlib
import io
import os
import random
import runpy
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.request
from pathlib import Path

import yaml

OVERLAYS = Path(__file__).resolve().parents[1]
REPO = OVERLAYS.parent
COPIED = ("overlays", "openapi-extensions", "integrations")
SKIP_KEYS = {"description", "summary", "title"}
SWAP = {"removed": "deleted", "deleted": "removed", "unavailable": "deleted",
        "ascending": "descending", "descending": "ascending", "cursor": "pageToken",
        "pageToken": "cursor", "pageSize": "limit", "nextPageToken": "nextCursor"}


# --- mutants -----------------------------------------------------------------

def points(node, path=()):
    """Every (path, kind) mutation point below node."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key in SKIP_KEYS:
                continue
            yield path + (key,), "drop"
            yield from points(value, path + (key,))
    elif isinstance(node, list):
        for index, value in enumerate(node):
            yield path + (index,), "drop"
            yield from points(value, path + (index,))
    elif isinstance(node, bool):
        yield path, "flip"
    elif isinstance(node, int):
        yield path, "inc"
    elif isinstance(node, str) and len(node) <= 80:
        yield path, "str"


def mutants(overlay):
    found = []
    for index, action in enumerate(overlay.get("actions") or []):
        found.append((("actions", index), "drop"))
        for key in ("update", "remove"):
            if isinstance(action, dict) and key in action:
                found += [(("actions", index, key) + p, kind) for p, kind in points(action[key])]
    extensions = {k: v for k, v in (overlay.get("info") or {}).items() if k.startswith("x-")}
    found += [(("info",) + p, kind) for p, kind in points(extensions)]
    return found


def mutate(overlay, point):
    path, kind = point
    overlay = copy.deepcopy(overlay)
    parent = overlay
    for part in path[:-1]:
        parent = parent[part]
    last = path[-1]
    if kind == "drop":
        if isinstance(parent, list):
            parent.pop(last)
        else:
            del parent[last]
    elif kind == "flip":
        parent[last] = not parent[last]
    elif kind == "inc":
        parent[last] += 1
    else:
        parent[last] = SWAP.get(parent[last], parent[last] + "Mut")
    return overlay


def label(point):
    path, kind = point
    return f"{kind} " + ".".join(str(part) for part in path)


# --- running one test (child process) -----------------------------------------

def child(args):
    """Run one test module; exit 0 when it passes. Optionally record opened overlays."""
    cache = Path(args.url_cache)
    cache.mkdir(parents=True, exist_ok=True)
    original = urllib.request.urlopen

    class Response(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def cached(url, *a, **k):
        address = url if isinstance(url, str) else url.full_url
        path = cache / hashlib.sha256(address.encode()).hexdigest()
        if not path.exists():
            data = original(url, *a, **k).read()
            temporary = path.with_suffix(f".{os.getpid()}.tmp")
            temporary.write_bytes(data)
            os.replace(temporary, path)
        return Response(path.read_bytes())

    urllib.request.urlopen = cached
    opened = set()
    if args.record:
        def hook(event, hook_args):
            if event == "open" and isinstance(hook_args[0], (str, bytes, os.PathLike)):
                name = os.fsdecode(hook_args[0])
                if name.endswith("-overlay.yaml"):
                    opened.add(os.path.realpath(name))
        sys.addaudithook(hook)
    tests = Path(args.tests)
    sys.path.insert(0, str(tests))
    os.chdir(tests)
    sys.argv = [args.child]
    module = runpy.run_path(str(tests / f"{args.child}.py"), run_name="mutate_target")
    suite = unittest.TestSuite()
    for value in module.values():
        if isinstance(value, type) and issubclass(value, unittest.TestCase):
            suite.addTests(unittest.TestLoader().loadTestsFromTestCase(value))
    stream = sys.stderr if args.verbose else io.StringIO()
    result = unittest.TextTestRunner(stream=stream, verbosity=1).run(suite)
    if args.record:
        overlays_root = os.path.realpath(tests.parent)
        Path(args.record).write_text("\n".join(sorted(
            os.path.relpath(p, overlays_root) for p in opened if p.startswith(overlays_root + os.sep))))
    sys.exit(0 if result.wasSuccessful() and result.testsRun else 1)


def run_test(root, test, url_cache, record=None, verbose=False):
    command = [sys.executable, __file__, "--child", test, "--tests", str(root / "overlays" / "tests"),
               "--url-cache", str(url_cache)]
    if record:
        command += ["--record", str(record)]
    if verbose:
        command.append("--verbose")
    return subprocess.run(command, capture_output=not verbose, timeout=1800).returncode == 0


# --- the measurement ------------------------------------------------------------

class Workspaces:
    """One repository-shaped copy per worker, or the checkout itself (--in-place)."""

    def __init__(self, in_place, workers):
        self.in_place = in_place
        self.local = threading.local()
        self.free = list(range(workers))
        self.lock = threading.Lock()
        self.base = None if in_place else Path(tempfile.mkdtemp(prefix="mutate-overlays-"))

    def root(self):
        if self.in_place:
            return REPO
        if not hasattr(self.local, "root"):
            with self.lock:
                number = self.free.pop()
            root = self.base / f"w{number}"
            for name in COPIED:
                if (REPO / name).exists():
                    shutil.copytree(REPO / name, root / name, symlinks=True, ignore=shutil.ignore_patterns(
                        "node_modules", ".cache", "__pycache__", "dist"))
            self.local.root = root
        return self.local.root

    def close(self):
        if self.base:
            shutil.rmtree(self.base, ignore_errors=True)


def measure(args):
    test = args.test.removesuffix(".py")
    if not (OVERLAYS / "tests" / f"{test}.py").exists():
        sys.exit(f"no such test: overlays/tests/{test}.py")
    url_cache = Path(args.url_cache).resolve()
    with tempfile.TemporaryDirectory() as scratch:
        record = Path(scratch) / "opened.txt"
        passed = run_test(REPO, test, url_cache, record=record, verbose=args.verbose)
        opened = [line for line in record.read_text().splitlines() if line] if record.exists() else []
    if not passed:
        sys.exit(f"{test} fails in the checkout; fix it before measuring it")
    if args.list:
        print("\n".join(opened))
        return 0
    overlays = args.overlay or opened
    for name in overlays:
        if not (OVERLAYS / name).exists():
            sys.exit(f"no such overlay: overlays/{name}")
    rng = random.Random(args.seed)
    jobs = []
    for name in overlays:
        document = yaml.safe_load((OVERLAYS / name).read_text(encoding="utf-8"))
        found = mutants(document)
        if args.cap and len(found) > args.cap:
            found = rng.sample(found, args.cap)
        jobs.append((name, None))
        jobs += [(name, point) for point in found]
    print(f"{test}: {len(overlays)} overlay(s), {len(jobs) - len(overlays)} mutants", flush=True)

    spaces = Workspaces(args.in_place, 1 if args.in_place else args.workers)
    file_locks = {name: threading.Lock() for name in overlays}

    def job(item):
        name, point = item
        root = spaces.root()
        target = root / "overlays" / name
        with file_locks[name] if args.in_place else _nothing():
            original = target.read_text(encoding="utf-8")
            try:
                if point is not None:
                    document = yaml.safe_load(original)
                    target.write_text(yaml.safe_dump(mutate(document, point), sort_keys=False), encoding="utf-8")
                return name, point, run_test(root, test, url_cache)
            finally:
                target.write_text(original, encoding="utf-8")

    results = {name: {"baseline": None, "total": 0, "survived": []} for name in overlays}
    try:
        with concurrent.futures.ThreadPoolExecutor(1 if args.in_place else args.workers) as pool:
            for name, point, passed in pool.map(job, jobs):
                entry = results[name]
                if point is None:
                    entry["baseline"] = passed
                else:
                    entry["total"] += 1
                    if passed:
                        entry["survived"].append(label(point))
    finally:
        spaces.close()

    status = 0
    for name, entry in results.items():
        if not entry["baseline"]:
            status = 1
            where = "in place" if args.in_place else "in the copies (try --in-place)"
            print(f"BASELINE FAILS {where}: {name}")
            continue
        print(f"{len(entry['survived'])}/{entry['total']} survived  {name}")
        if args.survivors:
            for survivor in entry["survived"]:
                print(f"    {survivor}")
    return status


class _nothing:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("test", nargs="?", help="test module under overlays/tests/, e.g. test_discord_pagination_v3")
    parser.add_argument("--overlay", action="append",
                        help="overlay path relative to overlays/ to mutate (repeatable); default: every overlay the test opens")
    parser.add_argument("--list", action="store_true", help="print the overlays the test opens and stop")
    parser.add_argument("--cap", type=int, default=0, help="sample at most N mutants per overlay (default: all)")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--in-place", action="store_true",
                        help="mutate the checkout's files, one worker (tests that read git or other repo files)")
    parser.add_argument("--survivors", action="store_true", help="print each surviving mutant")
    parser.add_argument("--url-cache", default=os.path.join(tempfile.gettempdir(), "mutate-overlays-urls"),
                        help="directory caching downloaded pinned OADs (default: in the system temp directory)")
    parser.add_argument("--verbose", action="store_true", help="show the test runner's output")
    parser.add_argument("--child", help=argparse.SUPPRESS)
    parser.add_argument("--tests", help=argparse.SUPPRESS)
    parser.add_argument("--record", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.child:
        child(args)
    if not args.test:
        parser.error("name a test module")
    sys.exit(measure(args))


if __name__ == "__main__":
    main()
