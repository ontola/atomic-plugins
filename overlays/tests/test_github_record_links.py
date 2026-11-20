"""Immutable GitHub catalog declares supplied record links, not inferred addresses."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

from generate_identity_catalog_fixtures import ROOT, compose, platform_config

SPEC = ROOT.parent / 'openapi-extensions/spec/embedded-resources/validate.py'
LOADER = importlib.util.spec_from_file_location('embedded_resources_validator', SPEC)
VALIDATOR = importlib.util.module_from_spec(LOADER)
LOADER.loader.exec_module(VALIDATOR)
CATALOG = ROOT / 'catalog/2026-11-20-reference-links.json'
PREVIOUS = ROOT / 'catalog/2026-11-20-authorization-help.json'


class GithubRecordLinksTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = json.loads(CATALOG.read_text())
        cls.previous = json.loads(PREVIOUS.read_text())
        with tempfile.TemporaryDirectory() as cache:
            cls.document, _ = compose('github', Path(cache), cls.catalog)
            cls.before, _ = compose('github', Path(cache), cls.previous)

    def test_new_catalog_only_appends_immutable_github_overlay(self):
        current = copy.deepcopy(self.catalog)
        overlay = platform_config('github', current)['overlays'].pop()
        self.assertIn('/record-links-9c5cfb87b3f8b64e11069373a73e3fc85de0de5e-overlay.yaml', overlay)
        self.assertEqual(current, self.previous)
        # A reference-only target never creates an artificial provider operation.
        self.assertEqual(self.document['paths'], self.before['paths'])

    def test_repository_owner_uses_exact_discriminator_with_no_fallback(self):
        resource = self.document['components']['crudResources']['githubRepository']
        self.assertEqual(resource['x-embeddedResources'], {
            'owner': {
                'representation': 'object', 'cardinality': 'one',
                'discriminator': {'field': 'type', 'mapping': {
                    'User': 'githubUser', 'Organization': 'githubOrganization',
                }},
            },
        })
        self.assertEqual(resource['identity'], self.before['components']['crudResources']['githubRepository']['identity'])
        self.assertEqual(resource['collections'], self.before['components']['crudResources']['githubRepository']['collections'])

    def test_user_identity_is_numeric_and_reference_only(self):
        resources = self.document['components']['crudResources']
        user = resources['githubUser']
        self.assertEqual(user['identity'], {
            'urlTemplate': '/user/{account_id}', 'bindings': {'account_id': {'field': 'id'}},
        })
        self.assertNotIn('collections', user)
        schema = self.document['components']['schemas']['catalogGithubUser']
        self.assertEqual(user['schema'], {'$ref': '#/components/schemas/catalogGithubUser'})
        self.assertEqual(schema['properties']['id']['type'], 'integer')
        self.assertEqual(schema['properties']['login']['type'], 'string')
        for source in ['issue', 'issueComment']:
            self.assertEqual(resources[source]['x-embeddedResources'], {
                'user': {'representation': 'object', 'resource': 'githubUser', 'cardinality': 'one'},
            })
            self.assertEqual(resources[source]['identity'], self.before['components']['crudResources'][source]['identity'])

    def test_addresses_and_undeclared_fields_keep_their_existing_semantics(self):
        resources = self.document['components']['crudResources']
        old = self.before['components']['crudResources']
        for name in ['githubOrganizationAddress', 'githubRepositoryAddress']:
            self.assertEqual(resources[name], old[name])
            self.assertNotIn('collections', resources[name])
        self.assertEqual(resources['githubOrganization']['references']['byLogin'], old['githubOrganization']['references']['byLogin'])
        # A label's mutable name is not promoted to a canonical record identity.
        self.assertNotIn('labels', resources['issue']['x-embeddedResources'])
        self.assertNotIn('githubLabel', resources)
        self.assertEqual(self.document['components']['schemas']['issue'], self.before['components']['schemas']['issue'])

    def test_composed_extension_validates_and_unknown_fallback_is_rejected(self):
        VALIDATOR.validate(self.document)
        invalid = copy.deepcopy(self.document)
        owner = invalid['components']['crudResources']['githubRepository']['x-embeddedResources']['owner']
        owner['resource'] = 'githubUser'
        with self.assertRaisesRegex(ValueError, 'exactly one'):
            VALIDATOR.validate(invalid)


if __name__ == '__main__':
    unittest.main()
