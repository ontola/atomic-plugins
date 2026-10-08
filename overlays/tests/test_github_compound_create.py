"""GitHub issue creates with labels as a CRUD Causality 0.5.0 compound create.

Composes the pinned GitHub issues slice with the published overlays in the
order the dated catalogs list them, then the unpublished compound-create
overlay. Checks that the result is valid OpenAPI, that the CRUD Causality
validator accepts its followUps (rules 20-24), and runs the reference
compound_create against synthetic answers in GitHub's documented shapes:
labels applied by the create, labels silently dropped and added by the
follow-up, and the follow-up refused after the issue exists. No provider
requests are made.

Use --directory for an openapi-directory checkout that has the pinned
commit (a blobless clone is enough); otherwise the pinned raw URL is
downloaded.
"""
import argparse
import copy
from pathlib import Path
import subprocess
import sys
import unittest
import urllib.request

import yaml
from openapi_spec_validator import validate as validate_openapi

ROOT = Path(__file__).resolve().parents[1]
PIN = "9c5cfb87b3f8b64e11069373a73e3fc85de0de5e"
SOURCE_PATH = "APIs/github.com/github-issues/1.1.4/openapi.yaml"
OAD = f"https://raw.githubusercontent.com/ontola/openapi-directory/{PIN}/{SOURCE_PATH}"
FOLDER = ROOT / "APIs/github.com/github-issues/1.1.4"
PUBLISHED = ("auth", "pagination", "repositories-read", "crud-causality", "canonical-paths", "identity")
OVERLAY = f"compound-create-{PIN}-overlay.yaml"
CREATE = "/repos/{owner}/{repo}/issues"
DIRECTORY = None

sys.path.insert(0, str(ROOT / "scripts"))
from validate_oad_pins import apply_overlay  # noqa: E402

sys.path.insert(0, str(ROOT.parent / "openapi-extensions" / "spec" / "crud-causality"))
from validate import compound_create, validate as validate_crud  # noqa: E402


def load_source():
    if DIRECTORY:
        raw = subprocess.check_output(["git", "-C", str(DIRECTORY), "show", f"{PIN}:{SOURCE_PATH}"])
    else:
        raw = urllib.request.urlopen(OAD, timeout=30).read()
    return yaml.safe_load(raw)


def compose(names):
    document = load_source()
    for name in names:
        path = FOLDER / name
        document, errors = apply_overlay(document, yaml.safe_load(path.read_text(encoding="utf-8")), str(path))
        if errors:
            raise AssertionError("\n".join(errors))
    return document


class GitHubCompoundCreateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.document = compose([f"{kind}-{PIN}-overlay.yaml" for kind in PUBLISHED] + [OVERLAY])
        cls.crud = cls.document["paths"][CREATE]["post"]["x-crud"]

    def test_composed_document_is_valid(self):
        validate_crud(self.document)
        standard = copy.deepcopy(self.document)
        for key in ("paginationSchemes", "crudResources", "x-authentication-profiles"):
            standard.get("components", {}).pop(key, None)
        validate_openapi(standard)

    def test_the_create_keeps_its_x_crud_and_gains_the_follow_up(self):
        self.assertEqual(self.crud["action"], "create")
        self.assertEqual(self.crud["resource"], "issue")
        self.assertEqual([f["operation"] for f in self.crud["followUps"]], ["issues-add-labels"])
        body = self.document["paths"][CREATE]["post"]["requestBody"]["content"]["application/json"]["schema"]
        self.assertEqual(set(body["properties"]), {"title", "body", "labels"})

    def test_overlay_resolves_on_the_bare_oad(self):
        compose([OVERLAY])

    def run_create(self, created, follow_up="ok"):
        sent = []

        def send_create(body):
            sent.append(("issues-create", body))
            return "ok", created, None

        def send_follow_up(operation, request):
            sent.append((operation, request))
            return follow_up

        planned = {"title": "Write spec", "labels": ["atomic:doing"]}
        return compound_create(self.document, self.crud, planned, send_create, send_follow_up,
                               {"owner": "ontola", "repo": "atomic-plugins"}), sent

    def test_labels_applied_by_the_create(self):
        result, sent = self.run_create({"number": 12, "labels": [{"id": 1, "name": "atomic:doing"}]})
        self.assertEqual(result["state"], "applied")
        self.assertEqual(len(sent), 1)
        self.assertEqual(sent[0][1]["labels"], ["atomic:doing"])

    def test_dropped_labels_are_added_by_the_follow_up(self):
        result, sent = self.run_create({"number": 12, "labels": []})
        self.assertEqual(result["state"], "applied")
        self.assertEqual(sent[1], ("issues-add-labels", {
            "path": {"owner": "ontola", "repo": "atomic-plugins", "issue_number": 12},
            "query": {}, "header": {}, "body": {"labels": ["atomic:doing"]}}))

    def test_refused_label_add_is_partly_applied(self):
        result, sent = self.run_create({"number": 12, "labels": []}, follow_up="refused")
        self.assertEqual(result["state"], "partlyApplied")
        self.assertEqual(result["created"]["number"], 12)
        self.assertEqual([(p["operation"], p["reason"]) for p in result["pending"]], [("issues-add-labels", "refused")])
        self.assertEqual([s[0] for s in sent].count("issues-create"), 1)

    def test_no_dated_catalog_selects_the_overlay(self):
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            with self.subTest(catalog=catalog.name):
                self.assertNotIn(OVERLAY, catalog.read_text(encoding="utf-8"))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path)
    args, remaining = parser.parse_known_args()
    DIRECTORY = args.directory
    unittest.main(argv=[sys.argv[0], *remaining])
