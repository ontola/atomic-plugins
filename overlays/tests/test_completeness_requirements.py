"""A catalog that selects a completeness overlay also selects the revisions it is declared on.

A Collection Completeness overlay is a claim about a collection's read as one
crud-causality revision defines it (its fixed query, its page size) and, for
some, as one pagination revision pages it. Selected with another revision,
the same declaration can be wrong: Asana's projectTasks completeness assumes
crud-causality v2's `limit=100`, without which Asana truncates a list at
about 1,000 objects; Notion's assumes pagination-v3, which marks a read
capped at 10,000 results incomplete.

Each completeness overlay states what it needs as groups of overlay
filenames, every group satisfied by selecting any one of its files:

* a new overlay in its `info`, as `x-requires: [{anyOf: [<filename>, ...]}, ...]`;
* a published overlay, which cannot change, in REQUIRES below (also the
  overlays still in review, by filename, so they need no edit).

For every dated catalog and every completeness overlay it selects, every
group must be met, and no other revision of the same kind as a group's files
may be selected for that platform. Every completeness overlay in the
repository must state its requirements one way or the other. No provider
is called and nothing is downloaded.
"""
import json
import re
import unittest

import yaml

from generate_identity_catalog_fixtures import ROOT

# Published (or in-review) completeness overlays: groups of acceptable files.
REQUIRES = {
    "APIs/airtable.com/1.0-readonly/completeness-1f5368e0251bfbaa233860dc8131507c38a4f8b3-overlay.yaml": [
        ["crud-causality-1f5368e0251bfbaa233860dc8131507c38a4f8b3-overlay.yaml"]],
    "APIs/gitlab.com/v4-readonly/completeness-f6d7940e9865903b9c99c5c1fc2d57d92811eef4-overlay.yaml": [
        ["crud-causality-f6d7940e9865903b9c99c5c1fc2d57d92811eef4-overlay.yaml"]],
    "APIs/notion.com/2026-03-11/completeness-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml": [
        ["crud-causality-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml"],
        ["pagination-v3-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml"]],
    "APIs/spotify.com/1.0.0-readonly/completeness-2914e6bed4db4389921b36e4ed79e645c2085668-overlay.yaml": [
        ["crud-causality-2914e6bed4db4389921b36e4ed79e645c2085668-overlay.yaml"]],
    "APIs/todoist.com/1/completeness-ac07532b0a0ac101cf8bae2a54177fb1d8ea3779-overlay.yaml": [
        ["crud-causality-ac07532b0a0ac101cf8bae2a54177fb1d8ea3779-overlay.yaml"]],
    # Its header names only crud-causality v1; v2 is allowed too, since v2 keeps v1's
    # collections and also fixes the issues read's `state: all` the declaration relies on.
    "APIs/github.com/github-issues/1.1.4/completeness-9c5cfb87b3f8b64e11069373a73e3fc85de0de5e-overlay.yaml": [
        ["crud-causality-9c5cfb87b3f8b64e11069373a73e3fc85de0de5e-overlay.yaml",
         "crud-causality-v2-9c5cfb87b3f8b64e11069373a73e3fc85de0de5e-overlay.yaml"]],
    "APIs/googleapis.com/tasks/v1/completeness-7ca47c73cf2308c9812692b482b3713b397bc88c-overlay.yaml": [
        ["crud-causality-v2-7ca47c73cf2308c9812692b482b3713b397bc88c-overlay.yaml"]],
    # In review when this was written (#579, #585, #586, #604). Moneybird's v1 names only
    # crud-causality v1; a later revision states its own info.x-requires.
    "APIs/asana.com/1.0/completeness-b58c91d9f59c6a10178916e7948793809edae46d-overlay.yaml": [
        ["crud-causality-v2-b58c91d9f59c6a10178916e7948793809edae46d-overlay.yaml"]],
    "APIs/moneybird.com/v2-readonly/completeness-85a6105220036a98ef0d7cd6f228d4aae0036508-overlay.yaml": [
        ["crud-causality-85a6105220036a98ef0d7cd6f228d4aae0036508-overlay.yaml"]],
    "APIs/googleapis.com/calendar/v3/completeness-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml": [
        ["app-crud-causality-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml",
         "app-crud-causality-v2-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml",
         "crud-causality-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml"]],
    "APIs/github.com/api.github.com/1.1.4/completeness-920631db31e628be547e9366821d3ebc7fa0ead5-overlay.yaml": [
        ["crud-causality-920631db31e628be547e9366821d3ebc7fa0ead5-overlay.yaml",
         "crud-causality-v2-920631db31e628be547e9366821d3ebc7fa0ead5-overlay.yaml"]],
}

REVISION = re.compile(r"^(?P<kind>.+?)(?:-v\d+)?-(?P<pin>[0-9a-f]{40})-overlay\.yaml$")


def kind(filename):
    """The overlay kind of a revision filename: `crud-causality` for crud-causality-v2-<pin>-overlay.yaml."""
    match = REVISION.match(filename)
    return match.group("kind") if match else filename


def groups_of(overlay, path):
    """The requirement groups of a completeness overlay: its info.x-requires, else REQUIRES[path], else None."""
    stated = (overlay.get("info") or {}).get("x-requires")
    if stated is not None:
        return [list(group["anyOf"]) for group in stated]
    return REQUIRES.get(path)


def requirements(path):
    """The requirement groups of the completeness overlay at `path` (relative to overlays/), or None."""
    return groups_of(yaml.safe_load((ROOT / path).read_text(encoding="utf-8")), path)


def violations(catalog, requires_of):
    """Every unmet requirement of the completeness overlays `catalog` (parsed JSON) selects.

    `requires_of(path)` gives a completeness overlay's groups. A group is met
    when one of its files is selected for the platform and no other revision
    of the same kind is.
    """
    found = []
    for platform in catalog["platforms"]:
        selected = [url.split("/overlays/", 1)[1] for url in platform.get("overlays", []) if "/overlays/" in url]
        names = [path.rsplit("/", 1)[1] for path in selected]
        for path in selected:
            if not path.rsplit("/", 1)[1].startswith("completeness-"):
                continue
            for group in requires_of(path) or []:
                kinds = {kind(f) for f in group}
                same_kind = [n for n in names if kind(n) in kinds]
                if not set(group) & set(names):
                    found.append(f"{platform['name']}: {path} needs one of {group}")
                for other in same_kind:
                    if other not in group:
                        found.append(f"{platform['name']}: {path} is not declared on {other}")
    return found


class CompletenessRequirementTests(unittest.TestCase):
    def test_every_dated_catalog_meets_its_completeness_overlays_requirements(self):
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            with self.subTest(catalog=catalog.name):
                self.assertEqual(violations(json.loads(catalog.read_text(encoding="utf-8")), requirements), [])

    def test_every_completeness_overlay_states_its_requirements(self):
        for path in sorted(ROOT.glob("APIs/**/completeness-*-overlay.yaml")):
            relative = str(path.relative_to(ROOT))
            with self.subTest(overlay=relative):
                groups = requirements(relative)
                self.assertTrue(groups, "state info.x-requires, or list a published overlay in REQUIRES")
                pin = REVISION.match(path.name).group("pin")
                for group in groups:
                    # Every file of a group is a revision on the overlay's own pin, and
                    # at least one of them exists next to it.
                    self.assertTrue(all(REVISION.match(f) and REVISION.match(f).group("pin") == pin for f in group),
                                    group)
                    self.assertTrue(any((path.parent / f).exists() for f in group), group)

    def test_x_requires_wins_over_the_table(self):
        path = "APIs/asana.com/1.0/completeness-b58c91d9f59c6a10178916e7948793809edae46d-overlay.yaml"
        stated = {"info": {"x-requires": [{"anyOf": ["crud-causality-v3-" + "a" * 40 + "-overlay.yaml"]}]}}
        self.assertEqual(groups_of(stated, path), [["crud-causality-v3-" + "a" * 40 + "-overlay.yaml"]])
        self.assertEqual(groups_of({"info": {}}, path), REQUIRES[path])
        self.assertIsNone(groups_of({"info": {}}, "APIs/example/completeness-" + "a" * 40 + "-overlay.yaml"))
        self.assertEqual(kind("crud-causality-v2-" + "a" * 40 + "-overlay.yaml"), "crud-causality")
        self.assertEqual(kind("app-crud-causality-" + "a" * 40 + "-overlay.yaml"), "app-crud-causality")
        self.assertEqual(kind("pagination-v3-" + "a" * 40 + "-overlay.yaml"), "pagination")

    def test_a_catalog_with_an_older_revision_is_refused(self):
        pin = "b58c91d9f59c6a10178916e7948793809edae46d"
        base = "https://ontola.github.io/atomic-plugins/overlays/APIs/asana.com/1.0/"
        completeness = f"APIs/asana.com/1.0/completeness-{pin}-overlay.yaml"
        requires = {completeness: [[f"crud-causality-v2-{pin}-overlay.yaml"]]}.get

        def catalog(*overlays):
            return {"platforms": [{"name": "asana", "overlays": [base + o for o in overlays]}]}

        good = catalog(f"pagination-{pin}-overlay.yaml", f"crud-causality-v2-{pin}-overlay.yaml",
                       f"completeness-{pin}-overlay.yaml")
        self.assertEqual(violations(good, requires), [])
        older = catalog(f"pagination-{pin}-overlay.yaml", f"crud-causality-{pin}-overlay.yaml",
                        f"completeness-{pin}-overlay.yaml")
        self.assertEqual(violations(older, requires), [
            f"asana: {completeness} needs one of ['crud-causality-v2-{pin}-overlay.yaml']",
            f"asana: {completeness} is not declared on crud-causality-{pin}-overlay.yaml"])
        both = catalog(f"crud-causality-{pin}-overlay.yaml", f"crud-causality-v2-{pin}-overlay.yaml",
                       f"completeness-{pin}-overlay.yaml")
        self.assertEqual(violations(both, requires),
                         [f"asana: {completeness} is not declared on crud-causality-{pin}-overlay.yaml"])
        # Notion: the pagination group too.
        npin = "0c8e229623efdcc1d4ab50111d17bcca3214a899"
        notion = {"platforms": [{"name": "notion", "overlays": [
            f"https://ontola.github.io/atomic-plugins/overlays/APIs/notion.com/2026-03-11/{o}" for o in (
                f"pagination-{npin}-overlay.yaml", f"crud-causality-{npin}-overlay.yaml",
                f"completeness-{npin}-overlay.yaml")]}]}
        found = violations(notion, requirements)
        self.assertIn(f"notion: APIs/notion.com/2026-03-11/completeness-{npin}-overlay.yaml is not declared on "
                      f"pagination-{npin}-overlay.yaml", found)


if __name__ == "__main__":
    unittest.main()
