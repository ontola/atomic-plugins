"""Executable examples and invalid declarations for the draft."""
import unittest
from validate import validate

class ValidationTests(unittest.TestCase):
    def document(self):
        return {"x-throttling": {"limits": {
            "ip": {"requests": 150, "window": {"seconds": 300, "kind": "unspecified"}, "partitionBy": ["sourceIp"]},
            "user": {"window": {"seconds": 30, "kind": "sliding"}}},
            "applies": ["ip", "user"]}, "paths": {"/status": {"get": {"x-throttling": []}}}}

    def test_valid_unknown_amount_and_partition_and_empty_selection(self):
        validate(self.document())

    def test_joint_and_independent_partitions(self):
        d = self.document()
        d["x-throttling"]["limits"]["user"]["partitionBy"] = ["sourceIp", "session"]
        validate(d)
        d["x-throttling"]["limits"]["user"]["partitionBy"] = []
        validate(d)

    def test_rejects_nonpositive_and_boolean_numbers(self):
        for value in (0, -1, True, 1.5, "150"):
            d = self.document()
            d["x-throttling"]["limits"]["ip"]["requests"] = value
            with self.assertRaises(ValueError): validate(d)

    def test_rejects_missing_duplicate_or_undefined_bucket_references(self):
        for refs in (["missing"], ["ip", "ip"], "ip"):
            d = self.document()
            d["paths"]["/status"]["get"]["x-throttling"] = refs
            with self.assertRaises(ValueError): validate(d)
        d = self.document()
        del d["x-throttling"]
        with self.assertRaises(ValueError): validate(d)

    def test_anchor_requires_fixed_and_valid_timestamp(self):
        d = self.document()
        window = d["x-throttling"]["limits"]["ip"]["window"]
        window.update(kind="fixed", anchor="2026-01-01T00:00:00Z")
        validate(d)
        for kind, anchor in (("sliding", "2026-01-01T00:00:00Z"), ("fixed", "2026-99-99T00:00:00Z"), ("fixed", "2026-01-01T00:00:00")):
            window.update(kind=kind, anchor=anchor)
            with self.assertRaises(ValueError): validate(d)

    def test_dimension_names_are_unique_and_extensible_by_uri(self):
        d = self.document()
        limit = d["x-throttling"]["limits"]["ip"]
        limit["partitionBy"] = ["urn:example:device"]
        validate(d)
        for values in (["sourceIp", "sourceIp"], ["typo"], None):
            limit["partitionBy"] = values
            with self.assertRaises(ValueError): validate(d)

if __name__ == "__main__": unittest.main()
