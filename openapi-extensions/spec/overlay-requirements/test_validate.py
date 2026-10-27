"""Overlay Requirements 0.1.0-draft: document rules and composition checks."""
import copy
import pathlib
import unittest

import yaml

from validate import check_composition, requirements, resolve, validate

ROOT = pathlib.Path(__file__).parent
BASE = "https://overlays.example.com/APIs/example/1.0/"


def example(name):
    return yaml.safe_load((ROOT / "examples" / name).read_text(encoding="utf-8"))


class DocumentTests(unittest.TestCase):
    def invalid(self, mutate, fragment, url=BASE + "requires.yaml"):
        overlay = example("requires.yaml")
        mutate(overlay["info"])
        with self.assertRaises(ValueError) as raised:
            validate(overlay, url=url)
        self.assertIn(fragment, str(raised.exception))

    def test_examples_are_valid(self):
        validate(example("requires.yaml"), url=BASE + "requires.yaml")
        validate(example("base.yaml"), url=BASE + "base.yaml")

    def test_shapes(self):
        self.invalid(lambda i: i.update({"x-requires": []}), "rule 1")
        self.invalid(lambda i: i.update({"x-requires": ["base.yaml"]}), "rule 1")
        self.invalid(lambda i: i.update({"x-requires": [[]]}), "rule 1")
        self.invalid(lambda i: i.update({"x-requires": [["base yaml"]]}), "rule 1")
        self.invalid(lambda i: i.update({"x-requires": [[7]]}), "rule 1")
        self.invalid(lambda i: i.update({"x-requires": [{"anyOf": []}]}), "rule 1")
        self.invalid(lambda i: i.update({"x-requires": [{"anyOf": [7]}]}), "rule 1")
        self.invalid(lambda i: i.update({"x-requires": [{"anyOf": ["base yaml"]}]}), "rule 1")
        self.invalid(lambda i: i.update({"x-requires": [{"anyOf": ["base.yaml"], "typo": True}]}), "rule 1")
        self.invalid(lambda i: i.update({"x-conflicts": []}), "rule 2")
        self.invalid(lambda i: i.update({"x-conflicts": "base-v1.yaml"}), "rule 2")

    def test_names(self):
        self.invalid(lambda i: i.update({"x-requires": [{"anyOf": ["base.yaml", "./base.yaml"]}]}), "named twice")
        self.invalid(lambda i: i.update({"x-conflicts": ["base-v1.yaml", "base-v1.yaml"]}), "named twice")
        self.invalid(lambda i: i.update({"x-conflicts": ["base.yaml"]}), "both required and in conflict")
        self.invalid(lambda i: i.update({"x-requires": [{"anyOf": ["requires.yaml"]}]}), "names itself")
        # Without its own URL a self reference cannot be told apart; relative names are compared as written.
        overlay = example("requires.yaml")
        overlay["info"]["x-requires"] = [{"anyOf": ["requires.yaml"]}]
        validate(overlay)

    def test_resolution(self):
        self.assertEqual(resolve("base.yaml", BASE + "requires.yaml"), BASE + "base.yaml")
        self.assertEqual(resolve("../2.0/base.yaml", BASE + "requires.yaml"),
                         "https://overlays.example.com/APIs/example/2.0/base.yaml")
        self.assertEqual(resolve("https://other.example/x.yaml", BASE + "requires.yaml"), "https://other.example/x.yaml")
        groups, conflicts = requirements(example("requires.yaml"), BASE + "requires.yaml")
        self.assertEqual(groups, [[BASE + "base.yaml", BASE + "base-v3.yaml"]])
        self.assertEqual(conflicts, [BASE + "base-v1.yaml"])

    def test_no_fields_no_requirements(self):
        self.assertEqual(requirements(example("base.yaml")), ([], []))


class CompositionTests(unittest.TestCase):
    def setUp(self):
        self.requires = example("requires.yaml")
        self.base = example("base.yaml")
        self.v1 = copy.deepcopy(self.base)
        self.v1["info"]["title"] = "Illustrative collections (revision 1)"

    def test_met_group_is_accepted(self):
        self.assertEqual(check_composition({BASE + "base.yaml": self.base, BASE + "requires.yaml": self.requires}), [])
        # Any one of a group's alternatives meets it.
        self.assertEqual(check_composition({BASE + "base-v3.yaml": self.base, BASE + "requires.yaml": self.requires}),
                         [])

    def test_unmet_group_and_conflict_are_reported(self):
        problems = check_composition({BASE + "requires.yaml": self.requires})
        self.assertEqual(len(problems), 1)
        self.assertIn("requires one of", problems[0])
        problems = check_composition({BASE + "base.yaml": self.base, BASE + "base-v1.yaml": self.v1,
                                      BASE + "requires.yaml": self.requires})
        self.assertEqual(len(problems), 1)
        self.assertIn("conflicts with " + BASE + "base-v1.yaml", problems[0])

    def test_every_overlay_is_checked(self):
        # base requires a third overlay: adding requires last does not hide base's unmet group.
        base = copy.deepcopy(self.base)
        base["info"]["x-requires"] = [{"anyOf": ["auth.yaml"]}]
        problems = check_composition({BASE + "base.yaml": base, BASE + "requires.yaml": self.requires})
        self.assertEqual(problems, [f"{BASE}base.yaml: requires one of ['{BASE}auth.yaml'], none applied"])


if __name__ == "__main__":
    unittest.main()
