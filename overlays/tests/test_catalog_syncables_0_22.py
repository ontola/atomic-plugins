"""The dated catalog for syncables 0.22.0 (catalog/2026-10-12-syncables-0.22.json).

It is catalog/2026-10-12-tasks-box-pages.json, the newest dated catalog
before it and a superset of the others (it already has Google Tasks
pagination v2 and Box pagination v3, Pagination Schemes 0.7.0), with the
overlays that a syncables 0.22.0 reader uses:

* Moneybird: financial mutations as a Pagination Schemes 0.5.0 rangeWindow
  (after the pagination overlay), and throttling v2 (Throttling 0.2.0-draft
  signals) in place of v1;
* Clockify: the time-entry list bounds as wall-clock time (Filtering
  0.2.0-draft x-time-zone), after the other Clockify overlays;
* Notion: page properties as a Runtime Schemas 0.1.0-draft x-runtime-schema,
  after crud-causality;
* GitHub Issues and Google Tasks: Throttling 0.2.0-draft signals, last;
* Google Tasks and Google Calendar: crud-causality v2 (CRUD Causality 0.4.0
  listQuery) in place of v1; Google Tasks' v2 envelopes declare
  emptyWhenAbsent, as its pagination v2 does;
* Google Calendar: cancelled events as read tombstones (Deletion Feeds
  0.2.0-draft x-read-tombstone) and Throttling 0.2.0-draft limits and
  signals, last;
* Notion (after its runtime schema), Spotify, Airtable and Asana:
  Throttling, last.

Every update in every composition must also name a CRUD Causality rule-5
`mode`, and a §4.6 `patchFormat` when the mode is `patch`.

The tests check the catalog against its base entry by entry, compose every
platform of both catalogs (the pinned OADs are downloaded by their full-SHA
URLs, the overlays read from the checkout), run every extension's reference
validator on each changed composition, check that no composition fails a
validator its base composition passes, and check that the compositions
differ from the base ones only by the declared additions. No provider is
called.
"""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

import yaml

from generate_identity_catalog_fixtures import PAGES_BASE, ROOT, apply, fetch

CATALOG = "2026-10-12-syncables-0.22.json"
BASE = "2026-10-12-tasks-box-pages.json"
APIS = PAGES_BASE + "APIs/"

GITHUB = "github.com/github-issues/1.1.4/{}-9c5cfb87b3f8b64e11069373a73e3fc85de0de5e-overlay.yaml"
CALENDAR = "googleapis.com/calendar/v3/{}-32237fa5d14aa887dc9f3923395dac971e00a36c-overlay.yaml"
MONEYBIRD = "moneybird.com/v2-readonly/{}-85a6105220036a98ef0d7cd6f228d4aae0036508-overlay.yaml"
NOTION = "notion.com/2026-03-11/{}-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml"
CLOCKIFY = "clockify.me/1.0.0-readonly/{}-dd34a70a45c5109479068b4b5d91337baf8822cd-overlay.yaml"
TASKS = "googleapis.com/tasks/v1/{}-7ca47c73cf2308c9812692b482b3713b397bc88c-overlay.yaml"
SPOTIFY = "spotify.com/1.0.0-readonly/{}-2914e6bed4db4389921b36e4ed79e645c2085668-overlay.yaml"
AIRTABLE = "airtable.com/1.0-readonly/{}-1f5368e0251bfbaa233860dc8131507c38a4f8b3-overlay.yaml"
ASANA = "asana.com/1.0/{}-b58c91d9f59c6a10178916e7948793809edae46d-overlay.yaml"


def url(template, kind):
    return APIS + template.format(kind)


# Each change to the base's overlay list: ("replace", old, new),
# ("after", anchor, new) or ("append", new), applied in this order.
CHANGES = {
    "github-issues": [("append", url(GITHUB, "throttling"))],
    "google-calendar": [
        ("replace", url(CALENDAR, "app-crud-causality"), url(CALENDAR, "app-crud-causality-v2")),
        ("append", url(CALENDAR, "read-tombstone")),
        ("append", url(CALENDAR, "throttling")),
    ],
    "moneybird": [
        ("after", url(MONEYBIRD, "pagination"), url(MONEYBIRD, "pagination-range-window")),
        ("replace", url(MONEYBIRD, "throttling"), url(MONEYBIRD, "throttling-v2")),
    ],
    "notion": [
        ("after", url(NOTION, "crud-causality"), url(NOTION, "runtime-schema")),
        ("append", url(NOTION, "throttling")),
    ],
    "clockify": [("append", url(CLOCKIFY, "time-zone"))],
    "spotify": [("append", url(SPOTIFY, "throttling"))],
    "airtable": [("append", url(AIRTABLE, "throttling"))],
    "asana": [("append", url(ASANA, "throttling"))],
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
        ("paths", "/calendars/{calendarId}/events/{eventId}", "get", "x-read-tombstone"),
        ("x-throttling",),
    },
    "moneybird": {
        ("components", "paginationSchemes", "periodWindows"),
        ("paths", "/{administration_id}/financial_mutations.json", "get", "x-pagination"),
        ("x-throttling", "headers"),
        ("x-throttling", "signals"),
    },
    "spotify": {("x-throttling",)},
    "asana": {
        ("x-throttling",),
        ("paths", "/workspaces/{workspace_gid}/tasks/search", "get", "x-throttling"),
    },
    "airtable": {
        ("x-throttling",),
        ("paths", "/v0/meta/bases/{baseId}/tables", "get", "x-throttling"),
        ("paths", "/v0/{baseId}/{tableIdOrName}", "get", "x-throttling"),
        ("paths", "/v0/{baseId}/{tableIdOrName}/{recordId}", "get", "x-throttling"),
    },
    "notion": {
        ("x-throttling",),
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

# Updates with mode patch whose patchFormat is missing (rule 6 SHOULD) or
# not a §4.6 value, per platform. github-issues' crud-causality v1 declares
# `merge` for its two PATCHes and nothing for its two label writes; its v2
# fixes both and replaces this entry once it is selected here.
KNOWN_PATCH_FORMAT_GAPS = {
    "github-issues": [
        ("/repos/{owner}/{repo}/issues/comments/{comment_id}", "patch", "merge"),
        ("/repos/{owner}/{repo}/issues/{issue_number}", "patch", "merge"),
        ("/repos/{owner}/{repo}/issues/{issue_number}/labels", "post", None),
        ("/repos/{owner}/{repo}/issues/{issue_number}/labels/{name}", "delete", None),
    ],
}


def validator(spec):
    loaded = importlib.util.spec_from_file_location(f"{spec.replace('-', '_')}_validate", SPECS / spec / "validate.py")
    module = importlib.util.module_from_spec(loaded)
    loaded.loader.exec_module(module)
    return module


VALIDATORS = {spec: validator(spec) for spec in (
    "pagination-schemes", "crud-causality", "throttling", "filtering", "runtime-schemas")}


def problems(spec, document):
    """The validator's errors (and CRUD Causality warnings) for one composition."""
    found = []
    try:
        if spec in ("crud-causality", "runtime-schemas"):
            warnings = []
            VALIDATORS[spec].validate(copy.deepcopy(document), warnings)
            if spec == "crud-causality":
                found.extend(warnings)
        else:
            VALIDATORS[spec].validate(copy.deepcopy(document))
    except ValueError as error:
        found.append(str(error))
    return found


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

    def test_every_changed_composition_passes_every_extension_validator(self):
        for name in CHANGES:
            for spec in VALIDATORS:
                with self.subTest(platform=name, spec=spec):
                    self.assertEqual(problems(spec, self.composed[name]), [])

    def test_no_composition_fails_a_validator_its_base_composition_passes(self):
        # Every platform this catalog does not change must fail no validator
        # it did not fail in the base catalog (Box, with pagination v3 since
        # 2026-10-12-box-pagination-v2, now passes them all).
        for name, document in self.composed.items():
            for spec in VALIDATORS:
                with self.subTest(platform=name, spec=spec):
                    self.assertEqual(problems(spec, document), problems(spec, self.base[name]))

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

    def test_google_tasks_collection_envelopes_keep_empty_when_absent(self):
        # The Collection Object's envelope wins over the scheme's in a reader,
        # so crud-causality v2 must say what pagination v2 says.
        collections = self.composed["google-tasks"]["components"]["crudResources"]
        for resource, collection in (("taskList", "taskLists"), ("task", "tasks")):
            with self.subTest(collection=collection):
                self.assertEqual(collections[resource]["collections"][collection]["envelope"],
                                 {"itemsField": "items", "emptyWhenAbsent": True})

    def test_every_update_names_a_mode_and_a_patch_format(self):
        # CRUD Causality §9 rule 5 (mode replace or patch), and a §4.6
        # patchFormat for a patch (rule 6 says SHOULD; this catalog has one
        # everywhere it can, so a missing one is reported).
        missing = {}
        for name, document in self.composed.items():
            for path, item in document.get("paths", {}).items():
                for method, operation in item.items():
                    x_crud = operation.get("x-crud") if isinstance(operation, dict) else None
                    if not isinstance(x_crud, dict) or x_crud.get("action") != "update":
                        continue
                    with self.subTest(platform=name, operation=(path, method)):
                        self.assertIn(x_crud.get("mode"), ("replace", "patch"))
                    if x_crud.get("mode") == "patch" and \
                            x_crud.get("patchFormat") not in ("jsonPatch", "jsonMergePatch", "custom"):
                        missing.setdefault(name, []).append((path, method, x_crud.get("patchFormat")))
        self.assertEqual({name: sorted(gaps) for name, gaps in missing.items()}, KNOWN_PATCH_FORMAT_GAPS)

    def test_the_fixed_reads_are_standard_list_queries(self):
        tasks = self.composed["google-tasks"]["components"]["crudResources"]["task"]["collections"]["tasks"]
        self.assertEqual(tasks["listQuery"], {"showCompleted": "true", "showHidden": "true"})
        events = self.composed["google-calendar"]["components"]["crudResources"]["event"]["collections"]["events"]
        self.assertEqual(events["listQuery"], {"showDeleted": "true", "singleEvents": "false"})


if __name__ == "__main__":
    unittest.main()
