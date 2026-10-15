"""Read a pinned OAD from an openapi-directory clone, or from the network.

`read_pinned_oad(pin, path, url, default_repos)` returns the bytes of
`path` at commit `pin`:

- With `OPENAPI_DIRECTORY_REPO` set, from that clone only. A failed
  `git show` is an error naming the pin, the path, the clone and git's own
  message; there is no network fallback, so a composer pointed at a clone
  never reads something else without saying so.
- Without it, from the first of `default_repos` that exists and has the
  blob, else from `url` (raw.githubusercontent.com), as before.
"""
import os
import subprocess
import urllib.request
from pathlib import Path

ENV = "OPENAPI_DIRECTORY_REPO"


class PinnedOadError(RuntimeError):
    pass


def git_show(repo, pin, path):
    result = subprocess.run(
        ["git", "-C", str(repo), "show", f"{pin}:{path}"],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    if result.returncode != 0:
        message = result.stderr.decode("utf-8", "replace").strip()
        raise PinnedOadError(
            f"{ENV}={repo}: git show {pin}:{path} failed"
            + (f": {message}" if message else f" (exit {result.returncode})")
        )
    return result.stdout


def read_pinned_oad(pin, path, url, default_repos=()):
    configured = os.environ.get(ENV)
    if configured:
        return git_show(Path(configured), pin, path)
    for repo in default_repos:
        if Path(repo).exists():
            try:
                return git_show(Path(repo), pin, path)
            except PinnedOadError:
                pass
    return urllib.request.urlopen(url, timeout=30).read()
