"""Synthetic operation bundles: static validation and caller-variable policy."""
import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from graphql import GraphQLError
from validate import InvalidManifest, bind_variables, validate_manifest

ROOT = Path(__file__).parent / 'examples'


class ManifestTests(unittest.TestCase):
    def setUp(self):
        self.bundle = json.loads((ROOT / 'relay.json').read_text())

    def load(self, bundle=None):
        return validate_manifest(bundle or self.bundle, ROOT)

    def reject(self, bundle):
        with self.assertRaises((InvalidManifest, GraphQLError)):
            self.load(bundle)

    def query(self, source, schema=None):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            bundle = copy.deepcopy(self.bundle)
            for key, name, data in [('schema', 'schema.graphql', schema or (ROOT / 'relay.graphql').read_text()),
                                    ('document', 'query.graphql', source)]:
                (root / name).write_text(data)
                descriptor = {'path': name, 'sha256': hashlib.sha256(data.encode()).hexdigest()}
                if key == 'schema':
                    bundle[key] = descriptor
                else:
                    bundle['operations'][0][key] = descriptor
            return validate_manifest(bundle, root)

    def test_both_schema_shapes_and_fragments_aliases(self):
        self.assertIn('RepositoryIssues', self.load())
        bundle = json.loads((ROOT / 'offset.json').read_text())
        operations = validate_manifest(bundle, ROOT)
        self.assertEqual(bind_variables(operations['Tasks'], {'offset': 0, 'limit': 50}),
                         {'offset': 0, 'limit': 50})

    def test_digest_and_path_validation(self):
        for key in ('schema', 'document'):
            bundle = copy.deepcopy(self.bundle)
            target = bundle[key] if key == 'schema' else bundle['operations'][0][key]
            target['sha256'] = '0' * 64
            self.reject(bundle)
        for name in ('../outside.graphql', '/etc/passwd'):
            bundle = copy.deepcopy(self.bundle)
            bundle['schema']['path'] = name
            self.reject(bundle)

    def test_symlink_cannot_escape_bundle(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'bundle'
            root.mkdir()
            outside = Path(directory) / 'outside.graphql'
            outside.write_text((ROOT / 'relay.graphql').read_text())
            (root / 'linked.graphql').symlink_to(outside)
            bundle = copy.deepcopy(self.bundle)
            bundle['schema']['path'] = 'linked.graphql'
            with self.assertRaisesRegex(InvalidManifest, 'escapes'):
                validate_manifest(bundle, root)

    def test_invalid_query_shapes_and_types(self):
        source = (ROOT / 'relay-query.graphql').read_text()
        invalid = [
            source.replace('id title', 'id missing'),
            source.replace('$first: Int!', '$first: String!'),
            source.replace('query RepositoryIssues', 'query DifferentName'),
            source + '\nquery Second { __typename }',
            source.replace('query RepositoryIssues', 'mutation RepositoryIssues'),
            source.replace('query RepositoryIssues', 'subscription RepositoryIssues'),
            source.replace('nodes {', 'nodes @skip(if: true) {'),
            source + '\ntype Added { id: ID! }',
        ]
        for document in invalid:
            with self.subTest(document=document), self.assertRaises((InvalidManifest, GraphQLError)):
                self.query(document)

    def test_invalid_schema_and_empty_operations(self):
        source = (ROOT / 'relay-query.graphql').read_text()
        with self.assertRaises((InvalidManifest, GraphQLError)):
            self.query(source, 'type Query { invalid: MissingType }')
        bundle = copy.deepcopy(self.bundle)
        bundle['operations'] = []
        self.reject(bundle)

    def test_duplicate_ids_unknown_fields_and_policy_mismatch(self):
        bundle = copy.deepcopy(self.bundle)
        bundle['operations'].append(copy.deepcopy(bundle['operations'][0]))
        self.reject(bundle)
        bundle = copy.deepcopy(self.bundle)
        bundle['operations'][0]['variables']['unknown'] = {}
        self.reject(bundle)
        bundle = copy.deepcopy(self.bundle)
        del bundle['operations'][0]['variables']['first']
        self.reject(bundle)
        bundle = copy.deepcopy(self.bundle)
        bundle['allowMutations'] = True
        self.reject(bundle)

    def test_invalid_endpoints_and_versions(self):
        for endpoint in ('http://api.example.com/graphql', 'https://u:p@api.example.com/graphql',
                         'https://api.example.com/graphql#x', 'https://api.example.com/graphql?query=x'):
            bundle = copy.deepcopy(self.bundle)
            bundle['endpoint'] = endpoint
            self.reject(bundle)
        bundle = copy.deepcopy(self.bundle)
        bundle['version'] = 'next'
        self.reject(bundle)

    def test_fixed_injection_unknown_overrides_and_coercion(self):
        operation = self.load()['RepositoryIssues']
        valid = {'name': 'demo', 'first': 10, 'after': None}
        self.assertEqual(bind_variables(operation, valid), {**valid, 'owner': 'example'})
        for supplied in ({**valid, 'owner': 'example'}, {**valid, 'extra': 1},
                         {**valid, 'first': True}, {**valid, 'first': '10'},
                         {**valid, 'first': 101}, {**valid, 'first': 0},
                         {**valid, 'first': None}, {'first': 10}):
            with self.subTest(supplied=supplied), self.assertRaises(InvalidManifest):
                bind_variables(operation, supplied)

    def test_bound_defaults_cannot_bypass_cap(self):
        source = (ROOT / 'relay-query.graphql').read_text()
        for default in ('101', 'null'):
            with self.subTest(default=default), self.assertRaises((InvalidManifest, GraphQLError)):
                self.query(source.replace('$first: Int!', f'$first: Int = {default}'))
        operation = self.query(source.replace('$first: Int!', '$first: Int = 10'))['RepositoryIssues']
        self.assertEqual(bind_variables(operation, {'name': 'demo'})['first'], 10)
        operation = self.query(source.replace('$first: Int!', '$first: Int = 10'))['RepositoryIssues']
        with self.assertRaises(InvalidManifest):
            bind_variables(operation, {'name': 'demo', 'first': None})

    def test_invalid_fixed_and_bound_policies(self):
        for policy in ({'min': True}, {'min': 100, 'max': 1}, {'max': 2**31},
                       {'fixed': 'bad'}, {'fixed': 10, 'max': 100}):
            bundle = copy.deepcopy(self.bundle)
            bundle['operations'][0]['variables']['first'] = policy
            self.reject(bundle)
        bundle = copy.deepcopy(self.bundle)
        bundle['operations'][0]['variables']['name'] = {'max': 10}
        self.reject(bundle)


if __name__ == '__main__':
    unittest.main()
