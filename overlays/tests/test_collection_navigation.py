"""New immutable catalog composes standard reference/address/response Link navigation."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from generate_identity_catalog_fixtures import ROOT, compose, platform_config
from test_crud_reads_in_catalogs import KNOWN, findings

CATALOG = ROOT / 'catalog/2026-11-19-collection-navigation.json'
PREVIOUS = ROOT / 'catalog/2026-11-18-syncables-apps.json'

class CollectionNavigationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = json.loads(CATALOG.read_text())
        with tempfile.TemporaryDirectory() as cache:
            cls.doc, _ = compose('github-issues', Path(cache), cls.catalog)

    def test_new_profile_replaces_legacy_mutation_discovery_and_keeps_other_platforms(self):
        old = json.loads(PREVIOUS.read_text())
        actual = copy.deepcopy(self.catalog)
        github = platform_config('github-issues', actual)
        self.assertIn('/collection-navigation-', github['overlays'].pop())
        self.assertEqual(github['selection']['query_overrides'].pop(), {'path':'/orgs/{org}/repos','values':{'per_page':100}})
        old_github = platform_config('github-issues', old)
        old_github['overlays'] = [url for url in old_github['overlays'] if '/crud-causality-v2-' not in url]
        self.assertEqual(actual, old)

    def test_canonical_numeric_identities_are_preserved(self):
        resources = self.doc['components']['crudResources']
        for resource, template, variable in [('githubOrganization','/organizations/{organization_id}','organization_id'), ('githubRepository','/repositories/{repository_id}','repository_id')]:
            self.assertEqual(resources[resource]['identity'], {'urlTemplate':template,'bindings':{variable:{'field':'id'}}})
        address = resources['githubOrganizationAddress']
        self.assertNotIn('collections', address)
        self.assertEqual(address['identity'], {'urlTemplate':'/orgs/{org}','bindings':{'org':{'field':'login'}}})
        self.assertEqual(resources['githubOrganization']['references']['byLogin'], {'resource':'githubOrganizationAddress','bindings':{'org':{'field':'login'}}})

    def test_only_documented_public_reads_add_anonymous_alternatives(self):
        for path in ['/orgs/{org}', '/orgs/{org}/repos', '/repos/{owner}/{repo}', '/repos/{owner}/{repo}/issues', '/repos/{owner}/{repo}/issues/{issue_number}', '/repos/{owner}/{repo}/issues/{issue_number}/comments', '/repos/{owner}/{repo}/issues/comments/{comment_id}', '/repositories/{repository_id}/issues', '/repositories/{repository_id}/issues/{issue_number}', '/repositories/{repository_id}/issues/{issue_number}/comments', '/repositories/{repository_id}/issues/comments/{comment_id}']:
            self.assertIn({}, self.doc['paths'][path]['get']['security'])
        for path in ['/user', '/user/orgs', '/user/repos']:
            self.assertNotIn({}, self.doc['paths'][path]['get']['security'])

    def test_active_organization_schema_has_factual_labels_without_personal_owner_grouping(self):
        schema = self.doc['components']['schemas']['catalogGithubOrganization']
        self.assertEqual(schema['title'], 'Organizations')
        self.assertEqual(schema['properties']['login']['title'], 'Organization')
        self.assertNotIn('type', schema['properties'])
        ref = {'$ref':'#/components/schemas/catalogGithubOrganization'}
        self.assertEqual(self.doc['components']['crudResources']['githubOrganization']['schema'], ref)
        self.assertEqual(self.doc['paths']['/user/orgs']['get']['responses']['200']['content']['application/json']['schema']['items']['$ref'], ref['$ref'])
        self.assertEqual(self.doc['paths']['/orgs/{org}']['get']['responses']['200']['content']['application/json']['schema'], ref)

    def test_read_profile_has_one_issues_child_and_one_comments_child(self):
        resources = self.doc['components']['crudResources']
        self.assertEqual(list(resources['issue']['collections']), ['repositoryIssues'])
        self.assertEqual(list(resources['issueComment']['collections']), ['issueComments'])
        self.assertEqual(resources['issueComment']['collections']['issueComments']['urlTemplate'], '/repositories/{repository_id}/issues/{issue_number}/comments')
        for path in ['/repos/{owner}/{repo}/issues', '/repos/{owner}/{repo}/issues/{issue_number}/comments']:
            self.assertNotIn('x-crud', self.doc['paths'][path]['get'])
        detail = self.doc['paths']['/repos/{owner}/{repo}']['get']
        self.assertEqual(detail['responses']['200']['links']['issues']['parameters'], {'repository_id':'$response.body#/id'})
        self.assertNotIn('collections', resources['githubRepositoryAddress'])

    def test_issue_collection_truthfully_preserves_pull_request_rows(self):
        schema = self.doc['components']['schemas']['issue']
        self.assertEqual(schema['title'], 'Issues and pull requests')
        self.assertIn('both', schema['description'])
        self.assertEqual(schema['properties']['pull_request']['type'], 'object')
        self.assertNotIn('pull_request', schema.get('required', []))
        self.assertIn('pull_request', self.doc['components']['crudResources']['issue']['description'])
        listing = self.doc['paths']['/repositories/{repository_id}/issues']['get']
        self.assertEqual(listing['summary'], 'List issues and pull requests for a repository')

    def test_documented_detail_response_binds_child_via_a_standard_link(self):
        detail = self.doc['paths']['/orgs/{org}']['get']
        self.assertEqual(detail['x-crud'], {'action':'read','resource':'githubOrganizationAddress'})
        link = detail['responses']['200']['links']['repositories']
        operation = self.doc['paths']['/orgs/{org}/repos']['get']
        self.assertEqual(link['operationId'], operation['operationId'])
        self.assertEqual(link['parameters'], {'org':'$response.body#/login'})
        self.assertEqual(operation['x-crud'], {'action':'list','resource':'githubRepository','collection':'organizationRepositories'})
        collection = self.doc['components']['crudResources']['githubRepository']['collections']['organizationRepositories']
        self.assertEqual(collection, {'urlTemplate':'/orgs/{org}/repos','listQuery':{'type':'all'},'envelope':{'itemsField':''}})
        self.assertEqual(operation['x-pagination'], [{'scheme':'builtinGithubNextLink'}])
        self.assertEqual(sorted(findings('github-issues', self.doc) - KNOWN), [])

if __name__ == '__main__':
    unittest.main()
