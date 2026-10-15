"""scripts/pinned_oad.py: a pinned OAD from OPENAPI_DIRECTORY_REPO, or the network.

With OPENAPI_DIRECTORY_REPO set, a failed `git show` is an error naming the
pin and the path, and nothing is fetched from the network. Without it, the
default clones are tried and then the URL, as the composers did before.
Uses a throwaway git repository; no network.
"""
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.request
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import pinned_oad  # noqa: E402

PATH = "APIs/example.com/1.0/openapi.yaml"


def git(repo, *args):
    return subprocess.run(
        ["git", "-C", str(repo), *args], check=True, capture_output=True, text=True
    ).stdout.strip()


class PinnedOadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name) / "openapi-directory"
        self.repo.mkdir()
        git(self.repo, "init", "-q")
        (self.repo / PATH).parent.mkdir(parents=True)
        (self.repo / PATH).write_text("openapi: 3.0.0\n")
        git(self.repo, "add", ".")
        git(
            self.repo,
            "-c", "user.name=t", "-c", "user.email=t@example.com",
            "commit", "-q", "-m", "oad",
        )
        self.pin = git(self.repo, "rev-parse", "HEAD")
        self.addCleanup(self.tmp.cleanup)
        # Any network read fails the test.
        patcher = mock.patch.object(
            urllib.request, "urlopen", side_effect=AssertionError("network read")
        )
        self.urlopen = patcher.start()
        self.addCleanup(patcher.stop)

    def env(self, value):
        values = dict(os.environ)
        values.pop(pinned_oad.ENV, None)
        if value is not None:
            values[pinned_oad.ENV] = str(value)
        return mock.patch.dict(os.environ, values, clear=True)

    def test_reads_the_configured_clone(self):
        with self.env(self.repo):
            self.assertEqual(
                pinned_oad.read_pinned_oad(self.pin, PATH, "https://example.invalid/x"),
                b"openapi: 3.0.0\n",
            )
        self.urlopen.assert_not_called()

    def test_a_failed_read_from_the_configured_clone_is_an_error_without_fallback(self):
        for pin, path in ((self.pin, "APIs/missing.yaml"), ("0" * 40, PATH)):
            with self.subTest(pin=pin, path=path), self.env(self.repo):
                with self.assertRaises(pinned_oad.PinnedOadError) as raised:
                    pinned_oad.read_pinned_oad(pin, path, "https://example.invalid/x")
                message = str(raised.exception)
                self.assertIn(pin, message)
                self.assertIn(path, message)
                self.assertIn(str(self.repo), message)
        # Also when the configured clone does not exist.
        with self.env(Path(self.tmp.name) / "absent"):
            with self.assertRaises(pinned_oad.PinnedOadError):
                pinned_oad.read_pinned_oad(self.pin, PATH, "https://example.invalid/x")
        self.urlopen.assert_not_called()

    def test_without_the_variable_a_default_clone_then_the_network(self):
        with self.env(None):
            self.assertEqual(
                pinned_oad.read_pinned_oad(
                    self.pin, PATH, "https://example.invalid/x", [self.repo]
                ),
                b"openapi: 3.0.0\n",
            )
            self.urlopen.assert_not_called()
            # The default clone lacks the blob, or does not exist: the URL.
            self.urlopen.side_effect = None
            self.urlopen.return_value.read.return_value = b"from the network\n"
            for repos in ([self.repo], [Path(self.tmp.name) / "absent"]):
                self.assertEqual(
                    pinned_oad.read_pinned_oad(
                        "0" * 40, PATH, "https://example.invalid/x", repos
                    ),
                    b"from the network\n",
                )
        self.assertEqual(self.urlopen.call_count, 2)


if __name__ == "__main__":
    unittest.main()
