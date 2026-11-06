"""Executable synthetic GraphQL schemas exercise pinned queries and traversal policy."""
from copy import deepcopy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest

from graphql import graphql_sync
from collection_contract import at_path
from reader import execute, load_bundle, read_collection
from validate import InvalidManifest, validate_manifest

ROOT = Path(__file__).parent / 'examples'


def manifest(kind='relay'):
    return json.loads((ROOT / f'{kind}-collections.json').read_text())


def body(data):
    return json.dumps(data).encode()


def envelope(nodes=None, more=False, cursor=None):
    return {'data': {'repository': {'issues': {
        'nodes': nodes or [], 'pageInfo': {'hasNextPage': more, 'endCursor': cursor}}}}}


class CollectionValidationTests(unittest.TestCase):
    def test_paths_resolve_fragments_and_schema_coordinates(self):
        operations = validate_manifest(manifest(), ROOT)
        operation = operations['RepositoryIssues']
        nodes = at_path(operation, ['repository', 'issues', 'nodes'])
        self.assertEqual(nodes[2], ['Query.repository', 'Repository.issues', 'IssueConnection.nodes'])
        identity = at_path(operation, ['repository', 'issues', 'nodes'])
        self.assertEqual(str(identity[0]), '[Issue!]!')

    def test_invalid_paths_identity_and_bindings(self):
        base = manifest()
        mutations = [
            lambda c: c.update(items=['repository', 'issues']),
            lambda c: c.update(items=['repository', 'issues', 'nodes', 'id']),
            lambda c: c.update(identity=['missing']),
            lambda c: c.update(operation='missing'),
            lambda c: c['pagination'].update(field=['repository']),
            lambda c: c['pagination'].update(cursorArgument='before'),
            lambda c: c['pagination'].update(cursorVariable='name'),
            lambda c: c['pagination'].update(hasNextPage=['repository', 'issues', 'pageInfo', 'endCursor']),
            lambda c: c['pagination'].update(endCursor=['repository', 'issues', 'pageInfo', 'missing']),
            lambda c: c['pagination'].update(type='unknown'),
            lambda c: c['pagination'].update(termination='shortPage'),
        ]
        for mutate in mutations:
            candidate = deepcopy(base)
            mutate(candidate['collections'][0])
            with self.subTest(candidate=candidate), self.assertRaises(InvalidManifest):
                validate_manifest(candidate, ROOT)

    def test_version_page_size_caps_and_duplicate_ids(self):
        candidates = []
        candidate = manifest(); candidate['version'] = '0.1.0-draft'; candidates.append(candidate)
        candidate = manifest(); candidate['collections'] = []; candidates.append(candidate)
        candidate = manifest(); candidate['collections'] *= 2; candidates.append(candidate)
        candidate = manifest(); del candidate['operations'][0]['variables']['first']['max']; candidates.append(candidate)
        candidate = manifest(); candidate['operations'][0]['variables']['first']['min'] = 0; candidates.append(candidate)
        for candidate in candidates:
            with self.subTest(candidate=candidate), self.assertRaises(InvalidManifest):
                validate_manifest(candidate, ROOT)

    def test_polymorphic_items_fail_instead_of_guessing_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = manifest('offset')
            source = (ROOT / 'offset.graphql').read_text().replace(
                'type Task {', 'interface Task {') + '\ntype PersonalTask implements Task { id: ID!, title: String! }\n'
            (root / 'offset.graphql').write_text(source)
            (root / 'offset-query.graphql').write_bytes((ROOT / 'offset-query.graphql').read_bytes())
            candidate['schema']['sha256'] = hashlib.sha256(source.encode()).hexdigest()
            with self.assertRaisesRegex(InvalidManifest, 'concrete object'):
                validate_manifest(candidate, root)

    def test_alias_path_uses_response_key(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            candidate = manifest('offset')
            for key in ('schema', 'document'):
                source = candidate[key] if key == 'schema' else candidate['operations'][0][key]
                (root / source['path']).write_bytes((ROOT / source['path']).read_bytes())
            validate_manifest(candidate, root)
            candidate['collections'][0]['items'] = ['tasks']
            with self.assertRaises(InvalidManifest):
                validate_manifest(candidate, root)


class ExecutionTests(unittest.TestCase):
    def setUp(self):
        self.bundle = load_bundle(manifest(), ROOT)
        self.values = {'name': 'demo', 'first': 2}

    def test_executes_real_graphql_with_pinned_source_and_fixed_values(self):
        calls = []
        schema = self.bundle.operations['RepositoryIssues']['schema']
        def repository(_, info, owner, name):
            self.assertEqual((owner, name), ('example', 'demo'))
            return {'issues': {'nodes': [{'id': '1', 'title': 'one'}],
                               'pageInfo': {'hasNextPage': False, 'endCursor': None}}}
        schema.query_type.fields['repository'].resolve = repository
        def transport(endpoint, payload):
            calls.append(payload)
            self.assertEqual(endpoint, 'https://api.example.com/graphql')
            result = graphql_sync(schema, payload['query'], variable_values=payload['variables'],
                                  operation_name=payload['operationName'])
            return 200, body(result.formatted)
        result = read_collection(self.bundle, 'issues', self.values, transport)
        self.assertTrue(result.traversal_complete, result.error)
        self.assertFalse(result.absence_evidence)
        self.assertEqual(result.items, [{'id': '1', 'title': 'one'}])
        self.assertEqual(calls[0]['query'], self.bundle.operations['RepositoryIssues']['source'])
        self.assertEqual(calls[0]['variables']['owner'], 'example')

    def test_unknown_operation_and_injection_fail_before_transport(self):
        def forbidden(*_):
            self.fail('transport must not be called')
        for operation, variables in [('Unknown', self.values), ('RepositoryIssues', {**self.values, 'query': 'mutation Evil {x}'}),
                                     ('RepositoryIssues', {**self.values, 'owner': 'attacker'}),
                                     ('RepositoryIssues', {**self.values, 'first': 101}),
                                     ('RepositoryIssues', {**self.values, 'endpoint': 'https://other.example'})]:
            with self.subTest(variables=variables), self.assertRaises(InvalidManifest):
                execute(self.bundle, operation, variables, forbidden)

    def test_two_pages_preserve_filters_and_advance_cursor(self):
        calls = []
        def transport(_, payload):
            calls.append(deepcopy(payload))
            second = payload['variables']['after'] == 'next'
            return 200, body(envelope([{'id': '2' if second else '1'}], not second, None if second else 'next'))
        result = read_collection(self.bundle, 'issues', self.values, transport)
        self.assertTrue(result.traversal_complete, result.error)
        self.assertEqual([row['id'] for row in result.items], ['1', '2'])
        self.assertEqual([call['variables']['after'] for call in calls], [None, 'next'])
        self.assertTrue(all(call['variables']['owner'] == 'example' and call['variables']['first'] == 2
                            and call['variables']['name'] == 'demo' for call in calls))
        self.assertNotIn('after', self.values)

    def test_graphql_errors_http_failures_and_invalid_json_never_complete(self):
        responses = [(200, body({**envelope([{'id': '1'}]), 'errors': [{'message': 'denied', 'path': ['repository']}]})),
                     (429, body(envelope())), (403, b'denied'), (200, b'not json'),
                     (200, body({'data': None})), (200, body([envelope()])),
                     (200, body({'data': {'repository': None}})), (200, body({'data': {}})),
                     (200, body({'data': {}, 'errors': None})), (200, b'x' * 1_048_577)]
        for response in responses:
            with self.subTest(status=response[0]):
                result = read_collection(self.bundle, 'issues', self.values, lambda *_: response)
                self.assertFalse(result.traversal_complete)
                self.assertFalse(result.absence_evidence)
                self.assertTrue(result.error)
                self.assertEqual(result.items, [])

    def test_later_failure_retains_only_prior_accepted_pages(self):
        replies = iter([(200, body(envelope([{'id': '1'}], True, 'next'))),
                        (200, body({'data': None, 'errors': [{'message': 'rate exhausted'}]}))])
        result = read_collection(self.bundle, 'issues', self.values, lambda *_: next(replies))
        self.assertEqual(result.items, [{'id': '1'}])
        self.assertFalse(result.traversal_complete)
        self.assertEqual(result.error, 'GraphQL response contains errors')

    def test_bad_cursor_types_missing_fields_and_repeats_fail(self):
        responses = [envelope([{'id': '2'}], True, 'next'), envelope([], True, None),
                     envelope([], True, ''), envelope([], True, 3), envelope([], 'false', None),
                     {'data': {'repository': {'issues': {'nodes': []}}}}]
        for response in responses:
            replies = iter([envelope([{'id': '1'}], True, 'next'), response])
            result = read_collection(self.bundle, 'issues', self.values, lambda *_: (200, body(next(replies))))
            with self.subTest(response=response):
                self.assertFalse(result.traversal_complete)
                self.assertTrue(result.error)
                self.assertEqual(result.items, [{'id': '1'}])

    def test_duplicate_missing_identity_and_oversized_pages_fail(self):
        for rows in ([{'id': '1'}, {'id': '1'}], [{'title': 'no id'}], [{'id': None}],
                     [{'id': '1'}, {'id': '2'}, {'id': '3'}]):
            result = read_collection(self.bundle, 'issues', self.values,
                                     lambda *_: (200, body(envelope(rows))))
            with self.subTest(rows=rows):
                self.assertFalse(result.traversal_complete)
                self.assertTrue(result.error)
        replies = iter([envelope([{'id': '1'}], True, 'next'), envelope([{'id': '1'}])])
        result = read_collection(self.bundle, 'issues', self.values, lambda *_: (200, body(next(replies))))
        self.assertEqual(result.error, 'duplicate collection identity')

    def test_budgets_and_caller_position_cannot_claim_completion(self):
        for limits in ({'max_pages': 1}, {'max_items': 1}):
            counter = iter(range(10))
            result = read_collection(self.bundle, 'issues', self.values, lambda *_:
                (200, body(envelope([{'id': str(next(counter))}], True, str(next(counter))))), **limits)
            self.assertFalse(result.traversal_complete)
            self.assertTrue(result.error)
        result = read_collection(self.bundle, 'issues', {**self.values, 'after': None},
                                 lambda *_: self.fail('caller position must fail before request'))
        self.assertFalse(result.traversal_complete)
        self.assertIn('traversal position', result.error)

    def test_offset_short_pages_continue_until_explicit_empty_page(self):
        bundle = load_bundle(manifest('offset'), ROOT)
        calls = []
        schema = bundle.operations['Tasks']['schema']
        schema.query_type.fields['tasks'].resolve = lambda _, info, offset, limit: (
            [{'id': str(offset), 'title': 'task'}] if offset < 4 else [])
        def transport(endpoint, payload):
            calls.append(payload['variables']['offset'])
            return 200, body(graphql_sync(schema, payload['query'], variable_values=payload['variables'],
                                         operation_name=payload['operationName']).formatted)
        result = read_collection(bundle, 'tasks', {'limit': 2}, transport)
        self.assertTrue(result.traversal_complete, result.error)
        self.assertEqual(calls, [0, 2, 4])
        self.assertEqual([row['id'] for row in result.items], ['0', '2'])
        self.assertFalse(result.absence_evidence)

    def test_transport_exception_is_sanitized(self):
        def broken(*_):
            raise RuntimeError('credential-bearing diagnostic')
        result = read_collection(self.bundle, 'issues', self.values, broken)
        self.assertEqual(result.error, 'GraphQL transport failed')


if __name__ == '__main__':
    unittest.main()
