"""The opt-in overlay-fixes catalog preserves its base and composes exact revisions."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from generate_identity_catalog_fixtures import ROOT, compose


def validator(name):
    path = ROOT.parent / 'openapi-extensions/spec' / name / 'validate.py'
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class OverlayFixesCatalogTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.base = json.loads((ROOT / 'catalog/2026-10-30-production-keep-writes.json').read_text())
        cls.candidate = json.loads((ROOT / 'catalog/2026-11-06-overlay-fixes.json').read_text())

    def test_only_declared_revisions_change(self):
        expected = copy.deepcopy(self.base)
        for platform in expected['platforms']:
            if platform['name'] == 'github-issues':
                platform['overlays'] = [u.replace('/crud-causality-', '/crud-causality-v2-')
                                        for u in platform['overlays']]
            if platform['name'] == 'notion':
                platform['overlays'] = [u.replace('/pagination-', '/pagination-v3-')
                                        for u in platform['overlays']]
                platform['overlays'].append(platform['overlays'][0].rsplit('/', 1)[0] +
                    '/completeness-0c8e229623efdcc1d4ab50111d17bcca3214a899-overlay.yaml')
        self.assertEqual(self.candidate, expected)

    def test_changed_platforms_compose_and_pass_extension_validation(self):
        with tempfile.TemporaryDirectory() as cache:
            for name in ('github-issues', 'notion'):
                with self.subTest(platform=name):
                    document, _ = compose(name, Path(cache), self.candidate)
                    validator('pagination-schemes').validate(copy.deepcopy(document))
                    validator('crud-causality').validate(copy.deepcopy(document), [])
                    if name == 'notion':
                        validator('collection-completeness').validate(copy.deepcopy(document))
                        scheme = document['components']['paginationSchemes']['bodyCursorPages']
                        self.assertTrue(validator('pagination-schemes').response_incomplete(scheme, {
                            'has_more': False, 'next_cursor': None, 'results': [],
                            'request_status': {'type': 'incomplete'}}))
                    else:
                        updates = [op['x-crud'] for item in document['paths'].values()
                                   for op in item.values() if isinstance(op, dict)
                                   and op.get('x-crud', {}).get('action') == 'update']
                        self.assertTrue(updates)
                        self.assertTrue(all(op['patchFormat'] in {'jsonMergePatch', 'custom', 'jsonPatch'}
                                            for op in updates))


if __name__ == '__main__':
    unittest.main()
