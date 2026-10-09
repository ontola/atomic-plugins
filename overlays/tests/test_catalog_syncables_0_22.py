"""The dated catalog for syncables 0.22.0 (catalog/2026-10-09-syncables-0.22.json).

It is catalog/2026-10-08-gitlab-tasks.json, the newest dated catalog and a
superset of the others, with the overlays that a syncables 0.22.0 reader
uses:

* Moneybird: financial mutations as a Pagination Schemes 0.5.0 rangeWindow
  (after the pagination overlay), and throttling v2 (Throttling 0.2.0-draft
  signals) in place of v1;
* Clockify: the time-entry list bounds as wall-clock time (Filtering
  0.2.0-draft x-time-zone), after the other Clockify overlays;
* Notion: page properties as a Runtime Schemas 0.1.0-draft x-runtime-schema,
  after crud-causality;
* GitHub Issues and Google Tasks: Throttling 0.2.0-draft signals, last;
* Google Tasks and Google Calendar: crud-causality v2 (CRUD Causality 0.4.0
  listQuery) in place of v1.

The tests check the catalog against its base entry by entry, compose every
platform of both catalogs (the pinned OADs are downloaded by their full-SHA
URLs, the overlays read from the checkout), run every extension's reference
validator on each composition, and check that the compositions differ from
the base ones only by the declared additions. No provider is called.
"""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import yaml

from generate_identity_catalog_fixtures import PAGES_BASE, ROOT, apply, fetch

CATALOG = "2026-10-09-syncables-0.22.json"
BASE = "2026-10-08-gitlab-tasks.json"
APIS = PAGES_BASE + "APIs/"

GITHUB = "github.com/github-issues/1.1.4/{}-9c5cfb87b3f8b64e11069373a73e3fc85de0de5e-overlay.yaml"
CALENDAR = "googleapis.com/calendar/v3/{}-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml"
MONEYBIRD = "moneybird.com/v2-readonly/{}-85a6105220036a98ef0d7cd6f228d4aae0036508-overlay.yaml"
NOTION = "notion.com/2026-03-11/{}-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml"
CLOCKIFY = "clockify.me/1.0.0-readonly/{}-dd34a70a45c5109479068b4b5d91337baf8822cd-overlay.yaml"
TASKS = "googleapis.com/tasks/v1/{}-7ca47c73cf2308c9812692b482b3713b397bc88c-overlay.yaml"


def url(template, kind):
    return APIS + template.format(kind)


# Each change to the base's overlay list: ("replace", old, new),
# ("after", anchor, new) or ("append", new), applied in this order.
CHANGES = {
    "github-issues": [("append", url(GITHUB, "throttling"))],
    "google-calendar": [("replace", url(CALENDAR, "app-crud-causality"), url(CALENDAR, "app-crud-causality-v2"))],
    "moneybird": [
        ("after", url(MONEYBIRD, "pagination"), url(MONEYBIRD, "pagination-range-window")),
        ("replace", url(MONEYBIRD, "throttling"), url(MONEYBIRD, "throttling-v2")),
    ],
    "notion": [("after", url(NOTION, "crud-causality"), url(NOTION, "runtime-schema"))],
    "clockify": [("append", url(CLOCKIFY, "time-zone"))],
    "google-tasks": [
        ("replace", url(TASKS, "crud-causality"), url(TASKS, "crud-causality-v2")),
        ("append", url(TASKS, "throttling")),
    ],
}

# Where each composition may differ from the base one: added keys only, named
# by their path cut at four keys. Platforms not listed must not differ.
ADDED = {
    "github-issues": {("x-throttling",)},
    "google-calendar": {
        ("components", "crudResources", "event", "collections"),
        ("paths", "/calendars/{calendarId}/events/{eventId}", "patch", "x-crud"),
    },
    "moneybird": {
        ("components", "paginationSchemes", "periodWindows"),
        ("paths", "/{administration_id}/financial_mutations.json", "get", "x-pagination"),
        ("x-throttling", "headers"),
        ("x-throttling", "signals"),
    },
    "notion": {
        ("components", "crudResources", "page", "references"),
        ("components", "crudResources", "page", "x-runtime-schema"),
        ("components", "schemas", "NotionRichText"),
        ("components", "schemas", "NotionSelectOption"),
    },
    "clockify": {
        ("components", "parameters", "End", "x-filter"),
        ("components", "parameters", "End", "x-time-zone"),
        ("components", "parameters", "Start", "x-filter"),
        ("components", "parameters", "Start", "x-time-zone"),
        ("components", "schemas", "CurrentUser", "properties"),
    },
    "google-tasks": {
        ("components", "crudResources", "task", "collections"),
        ("components", "crudResources", "task", "description"),
        ("components", "crudResources", "taskList", "collections"),
        ("components", "crudResources", "taskList", "description"),
        ("paths", "/tasks/v1/users/@me/lists/{tasklist}", "get", "x-crud"),
        ("x-throttling",),
    },
}

SPECS = ROOT.parent / "openapi-extensions" / "spec"


def validator(spec):
    loaded = importlib.util.spec_from_file_location(f"{spec.replace('-', '_')}_validate", SPECS / spec / "validate.py")
    module = importlib.util.module_from_spec(loaded)
    loaded.loader.exec_module(module)
    return module


VALIDATORS = {spec: validator(spec) for spec in (
    "pagination-schemes", "crud-causality", "throttling", "filtering", "runtime-schemas")}


def platforms(name):
    return json.loads((ROOT / "catalog" / name).read_text(encoding="utf-8"))["platforms"]


def expected_overlays(name, overlays):
    overlays = list(overlays)
    for change in CHANGES.get(name, []):
        if change[0] == "replace":
            _, old, new = change
            assert overlays.count(old) == 1, (name, old)
            overlays[overlays.index(old)] = new
        elif change[0] == "after":
            _, anchor, new = change
            overlays.insert(overlays.index(anchor) + 1, new)
        else:
            overlays.append(change[1])
    return overlays


def compose(name, cache):
    composed = {}
    for platform in platforms(name):
        document = yaml.safe_load(fetch(platform["openapi"], cache)[0])
        for overlay in platform.get("overlays", []):
            apply(document, yaml.safe_load(fetch(overlay, cache)[0]))
        composed[platform["name"]] = document
    return composed


def differences(before, after, path=()):
    """(kind, path) for each key added (+), removed (-) or changed (~)."""
    if isinstance(before, dict) and isinstance(after, dict):
        for key in sorted(set(before) | set(after), key=str):
            if key not in before:
                yield "+", path + (key,)
            elif key not in after:
                yield "-", path + (key,)
            else:
                yield from differences(before[key], after[key], path + (key,))
    elif before != after:
        yield "~", path


class CatalogSelectionTests(unittest.TestCase):
    def test_the_platforms_are_the_base_ones_in_the_same_order(self):
        self.assertEqual([p["name"] for p in platforms(CATALOG)], [p["name"] for p in platforms(BASE)])

    def test_each_entry_is_the_base_entry_with_the_declared_overlay_changes(self):
        base = {p["name"]: p for p in platforms(BASE)}
        for platform in platforms(CATALOG):
            with self.subTest(platform=platform["name"]):
                previous = base[platform["name"]]
                self.assertEqual({k: v for k, v in platform.items() if k != "overlays"},
                                 {k: v for k, v in previous.items() if k != "overlays"})
                self.assertEqual(platform["overlays"], expected_overlays(platform["name"], previous["overlays"]))

    def test_every_overlay_is_published_from_this_checkout(self):
        for platform in platforms(CATALOG):
            for overlay in platform["overlays"]:
                with self.subTest(platform=platform["name"], overlay=overlay):
                    self.assertTrue(overlay.startswith(PAGES_BASE))
                    self.assertTrue((ROOT / overlay[len(PAGES_BASE):]).is_file())

    def test_no_other_catalog_selects_the_new_overlays(self):
        added = {change[-1] for changes in CHANGES.values() for change in changes}
        for catalog in sorted((ROOT / "catalog").glob("*.json")):
            if catalog.name == CATALOG:
                continue
            text = catalog.read_text(encoding="utf-8")
            for overlay in added:
                with self.subTest(catalog=catalog.name, overlay=overlay):
                    self.assertNotIn(overlay, text)

    def test_a_superseded_overlay_is_not_selected_with_its_successor(self):
        for platform in platforms(CATALOG):
            for change in CHANGES.get(platform["name"], []):
                if change[0] == "replace":
                    with self.subTest(platform=platform["name"], overlay=change[1]):
                        self.assertNotIn(change[1], platform["overlays"])


class CatalogCompositionTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as cache:
            cls.base = compose(BASE, Path(cache))
            cls.composed = compose(CATALOG, Path(cache))

    def test_every_composition_passes_every_extension_validator(self):
        for name, document in self.composed.items():
            for spec, module in VALIDATORS.items():
                with self.subTest(platform=name, spec=spec):
                    if spec in ("crud-causality", "runtime-schemas"):
                        warnings = []
                        module.validate(copy.deepcopy(document), warnings)
                        if spec == "crud-causality":
                            self.assertEqual(warnings, [])
                    else:
                        module.validate(copy.deepcopy(document))

    def test_compositions_differ_from_the_base_only_by_the_declared_additions(self):
        for name, document in self.composed.items():
            with self.subTest(platform=name):
                found = list(differences(self.base[name], document))
                self.assertEqual([d for d in found if d[0] != "+"], [])
                self.assertEqual({path[:4] for _, path in found}, ADDED.get(name, set()))

    def test_moneybird_reads_financial_mutations_by_period_windows(self):
        document = self.composed["moneybird"]
        operation = document["paths"]["/{administration_id}/financial_mutations.json"]["get"]
        self.assertEqual(operation["x-pagination"], [{"scheme": "periodWindows"}])
        self.assertEqual(document["components"]["paginationSchemes"]["periodWindows"]["type"], "rangeWindow")

    def test_clockify_reads_the_list_bounds_in_the_profile_time_zone(self):
        parameters = self.composed["clockify"]["components"]["parameters"]
        for name in ("Start", "End"):
            with self.subTest(parameter=name):
                self.assertIn("x-time-zone", parameters[name])

    def test_notion_pages_carry_a_runtime_schema(self):
        self.assertIn("x-runtime-schema", self.composed["notion"]["components"]["crudResources"]["page"])

    def test_the_fixed_reads_are_standard_list_queries(self):
        tasks = self.composed["google-tasks"]["components"]["crudResources"]["task"]["collections"]["tasks"]
        self.assertEqual(tasks["listQuery"], {"showCompleted": "true", "showHidden": "true"})
        events = self.composed["google-calendar"]["components"]["crudResources"]["event"]["collections"]["events"]
        self.assertEqual(events["listQuery"], {"showDeleted": "true", "singleEvents": "false"})


if __name__ == "__main__":
    unittest.main()
