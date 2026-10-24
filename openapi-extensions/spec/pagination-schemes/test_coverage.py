"""Contract validation and executable coverage examples for issue #686."""
import copy
import itertools
import pathlib
import unittest

import yaml
from jsonschema import Draft202012Validator
from validate import SCHEMA, validate, window_request
from observe import CoverageError, collect_observations, observe_page

ROOT = pathlib.Path(__file__).parent


def document():
    return yaml.safe_load((ROOT / 'examples/page-coverage.yaml').read_text())


def scheme():
    return document()['components']['paginationSchemes']['entries']


def context(n=0, **changes):
    value = {'documentRevision': 'sha256:example-document', 'overlayRevisions': [],
             'scope': {'collection': 'example:account:savings:entries',
                       'selection': 'example:effective-query-booked', 'authorization': 'example:principal-scope'},
             'read': 'example:read', 'request': f'example:request:{n}', 'response': f'example:response:{n}',
             'observed': {'startedAt': f'2026-10-24T10:00:{2*n:02}Z',
                          'endedAt': f'2026-10-24T10:00:{2*n+1:02}Z'}}
    value.update(changes)
    return value


def body(*ids, **fields):
    return {'items': [{'id': i} for i in ids], **fields}


class DeclarationTests(unittest.TestCase):
    def test_schema_is_valid_and_new_examples_validate(self):
        Draft202012Validator.check_schema(SCHEMA)
        for name in ('page-coverage.yaml', 'window-coverage.yaml'):
            validate(yaml.safe_load((ROOT / 'examples' / name).read_text()))

    def test_guarantees_require_explicit_selection(self):
        for value in (True, {}, None):
            doc = document()
            model = doc['components']['paginationSchemes']['entries']
            if value is None:
                del model['autoDetect']
            else:
                model['autoDetect'] = value
            with self.subTest(value=value), self.assertRaisesRegex(ValueError, 'rule 31'):
                validate(doc)

    def test_cursor_coverage_requires_checked_unique_field_contract(self):
        for mutate in (lambda s: s['request']['queryParameters']['after'].pop('order'),
                       lambda s: s['request']['queryParameters']['after'].pop('fromLastItem'),
                       lambda s: s.update(type='nextLink'),
                       lambda s: s['coverage'].update(unique=False),
                       lambda s: s['coverage'].update(comparison='guessed')):
            doc = document()
            mutate(doc['components']['paginationSchemes']['entries'])
            with self.subTest(mutate=mutate), self.assertRaises(ValueError):
                validate(doc)

    def test_bad_shapes_and_contradictory_modes(self):
        mutations = [lambda s: s.update(coverage={'basis': 'opaqueCursor'}),
                     lambda s: s.update(freshness={'mode': 'bounded'}),
                     lambda s: s.update(freshness={'mode': 'eventual', 'maxLagSeconds': 2}),
                     lambda s: s.update(freshness={'mode': 'bounded', 'maxLagSeconds': -1}),
                     lambda s: s.update(freshness={'mode': 'bounded', 'maxLagSeconds': float('inf')}),
                     lambda s: s.update(freshness={'mode': 'bounded', 'maxLagSeconds': float('nan')}),
                     lambda s: s.update(freshness={'mode': 'unknown', 'scope': 'snapshotStart'}),
                     lambda s: s.update(consistency={'mode': 'readSnapshot'}),
                     lambda s: s.update(consistency={'mode': 'responseSnapshot', 'snapshot': {}}),
                     lambda s: s.update(closedPrefix={'source': 'response'}),
                     lambda s: s.update(closedPrefix={'source': 'lastItem', 'value': {'location': 'headers', 'name': 'X-Closed'}}),
                     lambda s: s.update(closedPrefix={'source': 'autoIncrement'}),
                     lambda s: (s.pop('coverage'), s.update(closedPrefix={'source': 'lastItem'}))]
        for mutate in mutations:
            doc = document()
            mutate(doc['components']['paginationSchemes']['entries'])
            with self.subTest(mutate=mutate), self.assertRaises(ValueError):
                validate(doc)

    def test_snapshot_cannot_reuse_cursor_and_parameters_must_exist(self):
        doc = document()
        model = doc['components']['paginationSchemes']['events']
        model['consistency']['snapshot']['request'] = {'location': 'queryParameters', 'name': 'after'}
        with self.assertRaisesRegex(ValueError, 'pagination field'):
            validate(doc)
        doc = document()
        model = doc['components']['paginationSchemes']['events']
        model['consistency']['snapshot']['request']['name'] = 'missing'
        with self.assertRaisesRegex(ValueError, 'rule 35'):
            validate(doc)

    def test_overrides_are_checked_after_merge(self):
        doc = document()
        doc['paths']['/entries']['get']['x-pagination'][0]['overrides'] = {'coverage': {'basis': 'rangeWindow'}}
        with self.assertRaisesRegex(ValueError, 'merged'):
            validate(doc)
        doc = document()
        doc['paths']['/entries']['get']['x-pagination'][0]['overrides'] = {'autoDetect': True}
        with self.assertRaisesRegex(ValueError, 'rule 31'):
            validate(doc)

    def test_weakening_override_cannot_leave_stronger_contract_parameters(self):
        doc = document()
        doc['paths']['/events']['get']['x-pagination'][0]['overrides'] = {'consistency': {'mode': 'unknown'}}
        with self.assertRaises(ValueError):
            validate(doc)

    def test_snapshot_body_binding_cannot_overlap_a_cursor_path(self):
        doc = document()
        model = doc['components']['paginationSchemes']['events']
        cursor = model['request']['queryParameters'].pop('after')
        model['request']['bodyFields'] = {'metadata.cursor': cursor}
        model['consistency']['snapshot']['request'] = {'location': 'bodyFields', 'name': 'metadata'}
        with self.assertRaisesRegex(ValueError, 'pagination field'):
            validate(doc)

    def test_request_parameter_refs_and_header_case_are_resolved(self):
        doc = document()
        doc['components']['parameters'] = {'snapshot': {'name': 'X-Snapshot', 'in': 'header',
                                                       'schema': {'type': 'string'}}}
        doc['paths']['/events']['get']['parameters'][-1] = {'$ref': '#/components/parameters/snapshot'}
        doc['components']['paginationSchemes']['events']['consistency']['snapshot']['request'] = {
            'location': 'headerFields', 'name': 'x-snapshot'}
        validate(doc)

    def test_window_contract_requires_field_and_disallows_cursor_options_and_prefix(self):
        for mutate in (lambda s: s['window'].pop('field'),
                       lambda s: s['coverage'].update(initial='unbounded'),
                       lambda s: s.update(closedPrefix={'source': 'lastItem'})):
            doc = yaml.safe_load((ROOT / 'examples/window-coverage.yaml').read_text())
            mutate(doc['components']['paginationSchemes']['bookings'])
            with self.subTest(mutate=mutate), self.assertRaises(ValueError):
                validate(doc)


class ObservationTests(unittest.TestCase):
    def observe(self, data, model=None, request=None, **options):
        return observe_page(model or scheme(), request if request is not None else {('queryParameters', 'after'): 9},
                            data, context=options.pop('context', context()), **options)

    def test_numeric_gaps_do_not_break_exhaustive_interval(self):
        observed = self.observe(body(10, 12, 15))
        self.assertEqual(observed['coverage'], {'field': '/id', 'comparison': 'itemCursor',
                         'lower': {'value': 9, 'inclusive': False}, 'upper': {'value': 15, 'inclusive': True}})
        self.assertEqual(observed['freshness']['mode'], 'eventual')
        self.assertEqual(observed['consistency'], {'mode': 'unknown'})
        self.assertIsNone(observed['closedPrefix'])
        self.assertEqual(observed['provenance'], context())
        first = self.observe(body(10, 12, 15), request={})
        self.assertEqual(first['coverage']['lower'], {'value': 10, 'inclusive': True})
        terminal = self.observe(body(10, 12, has_more=False))
        self.assertEqual(terminal['coverage']['upper']['value'], 12)

    def test_descending_and_unknown_initial_bound(self):
        model = scheme()
        model['request']['queryParameters']['after']['order'] = 'descending'
        obs = self.observe(body(14, 12, 10), model, {('queryParameters', 'after'): 15})
        self.assertEqual(obs['coverage']['lower'], {'value': 10, 'inclusive': True})
        self.assertEqual(obs['coverage']['upper'], {'value': 15, 'inclusive': False})
        first = self.observe(body(14, 12, 10), model, {})
        self.assertEqual(first['coverage']['upper'], {'value': 14, 'inclusive': True})
        model['coverage']['initial'] = 'unbounded'
        first = self.observe(body(14, 12, 10), model, {})
        self.assertIsNone(first['coverage']['upper'])

    def test_empty_and_terminal_tail_require_explicit_contract(self):
        self.assertIsNone(self.observe(body())['coverage'])
        model = scheme()
        model['coverage']['terminal'] = 'exhaustive'
        empty = self.observe(body(), model)
        self.assertEqual(empty['coverage']['lower'], {'value': 9, 'inclusive': False})
        self.assertIsNone(empty['coverage']['upper'])
        self.assertIsNone(self.observe(body(), model, {})['coverage'])
        tail = self.observe(body(10, 12, has_more=False), model)
        self.assertIsNone(tail['coverage']['upper'])
        model['coverage']['initial'] = 'unbounded'
        whole = self.observe(body(has_more=False), model, {})
        self.assertIsNone(whole['coverage']['lower'])
        self.assertIsNone(whole['coverage']['upper'])
        model['request']['queryParameters']['after']['order'] = 'descending'
        before = self.observe(body(has_more=False), model)
        self.assertIsNone(before['coverage']['lower'])
        self.assertEqual(before['coverage']['upper'], {'value': 9, 'inclusive': False})

    def test_exact_large_numbers_text_and_pointer_escaping(self):
        huge = 10**45
        obs = self.observe(body(str(huge+1), huge+2), request={('queryParameters', 'after'): str(huge)})
        self.assertEqual(obs['coverage']['upper']['value'], huge+2)
        text = self.observe(body('bb', 'cc'), request={('queryParameters', 'after'): 'aa'})
        self.assertEqual(text['coverage']['lower']['value'], 'aa')
        model = scheme()
        model['request']['queryParameters']['after']['fromLastItem'] = 'meta.a/b~c'
        data = {'items': [{'meta': {'a/b~c': 10}}]}
        self.assertEqual(self.observe(data, model)['coverage']['field'], '/meta/a~1b~0c')

    def test_duplicates_wrong_order_wrong_bound_and_mixed_domains_refused(self):
        for ids in [(10, 10), ('010', 10), (12, 10), (9, 10), (8,), (10, 'other'), (True,), (10.0,), ('',), (None,)]:
            with self.subTest(ids=ids), self.assertRaises(CoverageError):
                self.observe(body(*ids))
        for cursor in ('', None, 9.0, True):
            with self.subTest(cursor=cursor), self.assertRaises(CoverageError):
                self.observe(body(10), request={('queryParameters', 'after'): cursor})

    def test_continuation_cursor_and_alternative_cursor_are_checked(self):
        first = self.observe(body(10, 12))
        with self.assertRaisesRegex(CoverageError, 'preceding last item'):
            self.observe(body(20), request={('queryParameters', 'after'): 15}, context=context(1), previous=first)
        with self.assertRaises(CoverageError):
            self.observe(body(20), request={}, context=context(1), previous=first)
        last = self.observe(body(10, has_more=False))
        with self.assertRaises(CoverageError):
            self.observe(body(12), request={('queryParameters', 'after'): 10}, context=context(1), previous=last)
        model = scheme()
        model['request']['queryParameters']['before'] = {'role': 'previousPageToken'}
        with self.assertRaisesRegex(CoverageError, 'another cursor'):
            self.observe(body(10), model, {('queryParameters', 'after'): 9, ('queryParameters', 'before'): 11})

    def test_incomplete_failure_and_invalid_envelope_emit_no_assertion(self):
        model = scheme()
        model['response']['incomplete'] = {'field': 'truncated', 'equals': True}
        for data, opts in [(body(10, truncated=True), {}), (body(10), {'status': 500}),
                           ({'items': None}, {}), (body(has_more=True), {}), (body(10, has_more='false'), {})]:
            with self.subTest(data=data), self.assertRaises(CoverageError):
                self.observe(data, model, **opts)

    def test_no_declaration_is_traversal_only(self):
        model = scheme()
        del model['coverage']
        obs = self.observe(body(10, 12, 15), model)
        self.assertIsNone(obs['coverage'])
        opaque = {'type': 'pageToken', 'response': {'bodyFields': {'next': {'role': 'nextPageToken'}}}}
        self.assertIsNone(self.observe([], opaque)['coverage'])

    def test_four_guarantees_stay_independent(self):
        for freshness, consistency, prefix in itertools.product(('unknown', 'eventual', 'bounded'),
                                                               ('unknown', 'responseSnapshot'), (False, True)):
            model = scheme()
            model['freshness'] = {'mode': freshness}
            if freshness == 'bounded':
                model['freshness']['maxLagSeconds'] = 5
            model['consistency'] = {'mode': consistency}
            if prefix:
                model['closedPrefix'] = {'source': 'lastItem'}
            observed = self.observe(body(10, 12), model)
            self.assertIsNotNone(observed['coverage'])
            self.assertEqual(observed['freshness'], model['freshness'])
            self.assertEqual(observed['consistency']['mode'], consistency)
            self.assertEqual(observed['closedPrefix'] is not None, prefix)
            self.assertNotIn('retire', observed)
            self.assertNotIn('complete', observed)

    def test_closed_watermark_is_not_coverage_to_watermark(self):
        model = scheme()
        model['closedPrefix'] = {'source': 'response', 'value': {'location': 'headers', 'name': 'X-Closed'}}
        obs = self.observe(body(10, 12), model, headers={'x-closed': '100'})
        self.assertEqual(obs['coverage']['upper']['value'], 12)
        self.assertEqual(obs['closedPrefix']['through'], '100')
        self.assertIsNone(self.observe(body(), model, headers={'X-Closed': '100'})['coverage'])
        for headers in ({}, {'X-Closed': 'abc'}, {'X-Closed': '100', 'x-closed': '200'}):
            with self.subTest(headers=headers), self.assertRaises(CoverageError):
                self.observe(body(10), model, headers=headers)

    def pinned(self):
        return document()['components']['paginationSchemes']['events']

    def test_later_closure_does_not_retroactively_validate_stale_coverage(self):
        model = scheme()
        model['consistency'] = {'mode': 'responseSnapshot'}
        model['closedPrefix'] = {'source': 'response', 'value': {'location': 'bodyFields', 'name': 'closed'}}
        first = self.observe(body(11, closed=9), model)
        # ID 10 has propagated by the time of this later watermark. A tail
        # read after 11 returns no items and never repairs the old gap.
        later = self.observe(body(closed=11), model, {('queryParameters', 'after'): 11},
                             context=context(1, read='later-read'))
        self.assertIsNone(later['coverage'])
        self.assertEqual(later['closedPrefix']['through'], 11)
        combined = collect_observations([first, later])
        self.assertFalse(combined['singleSnapshot'])
        self.assertNotIn('closedPrefix', combined)

    def test_read_snapshot_is_carried_and_checked(self):
        model = self.pinned()
        first = self.observe(body(10, snapshot='example-snapshot'), model)
        request = {('queryParameters', 'after'): 10, ('queryParameters', 'snapshot'): 'example-snapshot'}
        second = self.observe(body(12, snapshot='example-snapshot'), model, request, context=context(1), previous=first)
        self.assertTrue(collect_observations([first, second])['singleSnapshot'])
        self.assertEqual(second['freshness']['scope'], 'snapshotStart')
        for data, values in [(body(12, snapshot='other'), request), (body(12), request),
                             (body(12, snapshot='example-snapshot'), {('queryParameters', 'after'): 10})]:
            with self.subTest(data=data), self.assertRaises(CoverageError):
                self.observe(data, model, values, context=context(1), previous=first)
        with self.assertRaises(CoverageError):
            self.observe(body(12, snapshot='example-snapshot'), model,
                         {('queryParameters', 'snapshot'): 'other'})

    def test_collector_rejects_unbound_pages_even_without_previous(self):
        model = self.pinned()
        first = self.observe(body(10, snapshot='example-snapshot'), model)
        unbound = self.observe(body(12, snapshot='example-snapshot'), model, context=context(1))
        with self.assertRaisesRegex(CoverageError, 'did not request'):
            collect_observations([first, unbound])

    def test_snapshot_header_and_body_request_locators(self):
        model = self.pinned()
        model['consistency']['snapshot'] = {'request': {'location': 'headerFields', 'name': 'X-Snapshot'},
                                            'response': {'location': 'headers', 'name': 'X-Snapshot'}}
        first = self.observe(body(10), model, headers={'x-snapshot': 'example-snapshot'})
        second = self.observe(body(12), model, {('headerFields', 'x-snapshot'): 'example-snapshot', ('queryParameters', 'after'): 10},
                              context=context(1), headers={'X-Snapshot': 'example-snapshot'}, previous=first)
        self.assertTrue(collect_observations([first, second])['singleSnapshot'])
        model['consistency']['snapshot'] = {'request': {'location': 'bodyFields', 'name': 'view.id'},
                                            'response': {'location': 'bodyFields', 'name': 'view.id'}}
        first = self.observe(body(10, view={'id': 'example-snapshot'}), model)
        self.observe(body(12, view={'id': 'example-snapshot'}), model,
                     {('bodyFields', 'view.id'): 'example-snapshot', ('queryParameters', 'after'): 10}, context=context(1), previous=first)

    def test_unknown_or_per_response_snapshots_are_never_merged_into_one(self):
        for mode in ('unknown', 'responseSnapshot'):
            model = scheme()
            model['consistency'] = {'mode': mode}
            first = self.observe(body(10), model)
            second = self.observe(body(12), model, context=context(1))
            combined = collect_observations([first, second])
            self.assertFalse(combined['singleSnapshot'])
            self.assertEqual(len(combined['observations']), 2)
            self.assertNotIn('complete', combined)

    def test_adjacent_pages_with_concurrent_delete_insert_are_not_one_snapshot(self):
        model = scheme()
        model['consistency'] = {'mode': 'responseSnapshot'}
        # Snapshot A contains only 10. It is deleted before snapshot B,
        # which contains only 15. The union {10,15} never coexisted.
        first = self.observe(body(10), model)
        second = self.observe(body(15), model, {('queryParameters', 'after'): 10},
                              context=context(1), previous=first)
        combined = collect_observations([first, second])
        self.assertFalse(combined['singleSnapshot'])
        self.assertEqual(len(combined['observations']), 2)
        self.assertEqual(first['coverage']['upper']['value'], second['coverage']['lower']['value'])
        self.assertNotIn('coverage', combined)

    def test_snapshot_ids_are_not_global_and_scope_changes_are_refused(self):
        model = self.pinned()
        a = self.observe(body(10, snapshot='example-snapshot'), model)
        b = self.observe(body(12, snapshot='example-snapshot'), model, context=context(1, read='other-read'))
        self.assertFalse(collect_observations([a, b])['singleSnapshot'])
        b['provenance']['read'] = a['provenance']['read']
        b['consistency']['snapshot'] = 'other'
        with self.assertRaises(CoverageError):
            collect_observations([a, b])
        for key, value in [('documentRevision', 'other'), ('overlayRevisions', ['other']),
                           ('scope', {**context()['scope'], 'authorization': 'other'})]:
            bad = copy.deepcopy(a)
            bad['provenance'][key] = value
            with self.subTest(key=key), self.assertRaises(CoverageError):
                collect_observations([a, bad])

    def test_context_requires_evidence_scope_and_ordered_aware_times(self):
        for mutate in (lambda c: c.pop('scope'), lambda c: c.pop('overlayRevisions'),
                       lambda c: c['scope'].pop('selection'),
                       lambda c: c['observed'].update(startedAt='2026-10-24T10:00:05Z'),
                       lambda c: c['observed'].update(endedAt='2026-10-24T10:00:01')):
            ctx = context()
            mutate(ctx)
            with self.subTest(mutate=mutate), self.assertRaises(CoverageError):
                self.observe(body(10), context=ctx)
        with self.assertRaises(CoverageError):
            collect_observations([])

    def test_unchanged_reads_do_not_prove_no_intervening_events_or_freshness(self):
        # These observations fit all these source histories: no event, an
        # unseen persistent insert, or an insert subsequently removed. The
        # observer is not given authoritative history and must not pick one.
        first = self.observe(body(10))
        later = self.observe(body(10), context=context(1, read='later-read'))
        combined = collect_observations([first, later])
        self.assertFalse(combined['singleSnapshot'])
        self.assertEqual(later['freshness']['mode'], 'eventual')
        self.assertIsNone(later['closedPrefix'])
        self.assertNotIn('unchangedSince', combined)

    def test_late_allocated_id_and_late_booked_entry_do_not_close_old_prefix(self):
        # ID 10 was allocated first but commits/indexes after ID 11. Likewise
        # an old pending record could enter a status=booked selection later.
        first = self.observe(body(11))
        tail = self.observe(body(), request={('queryParameters', 'after'): 11}, context=context(1))
        self.assertIsNone(first['closedPrefix'])
        self.assertIsNone(tail['coverage'])
        revisited = self.observe(body(10, 11), context=context(2, read='reread'))
        self.assertEqual(revisited['coverage']['lower']['value'], 9)
        self.assertIsNone(revisited['closedPrefix'])


class WindowCoverageTests(unittest.TestCase):
    def model(self):
        return yaml.safe_load((ROOT / 'examples/window-coverage.yaml').read_text())['components']['paginationSchemes']['bookings']

    def observe(self, items, model=None, window=('10', '15'), **kw):
        model = model or self.model()
        return observe_page(model, window_request(model, *window), items, window=window, context=context(), **kw)

    def test_explicit_window_has_coverage_without_sorting_and_can_be_empty(self):
        obs = self.observe([{'id': 14}, {'id': 10}, {'id': 12}])
        self.assertEqual(obs['coverage']['lower'], {'value': '10', 'inclusive': True})
        self.assertEqual(obs['coverage']['upper'], {'value': '15', 'inclusive': False})
        self.assertIsNotNone(self.observe([])['coverage'])
        self.assertEqual(obs['consistency']['mode'], 'responseSnapshot')
        self.assertEqual(obs['freshness']['mode'], 'unknown')
        self.assertIsNone(obs['closedPrefix'])

    def test_full_or_over_cap_answer_has_no_coverage(self):
        model = self.model()
        model['window']['cap'] = 3
        for size in (3, 4):
            self.assertIsNone(self.observe([{'id': 10}] * size, model)['coverage'])

    def test_outside_window_wrong_format_or_mismatching_request_are_refused(self):
        for item in ({'id': 9}, {'id': 15}, {'id': True}, {}, {'id': 10.5}):
            with self.subTest(item=item), self.assertRaises(CoverageError):
                self.observe([item])
        model = self.model()
        with self.assertRaises(CoverageError):
            observe_page(model, window_request(model, '11', '15'), [], window=('10', '15'), context=context())
        with self.assertRaises(CoverageError):
            self.observe([], window=('15', '10'))

    def test_closed_unit_window_and_exact_date_values(self):
        model = self.model()
        model['window'].update(unit='day', format='date', bounds='closed', field='/date')
        observed = self.observe([{'date': '2026-10-24'}], model, ('2026-10-24', '2026-10-24'))
        self.assertTrue(observed['coverage']['upper']['inclusive'])
        with self.assertRaises(CoverageError):
            self.observe([{'date': '2026-10-24T12:00:00Z'}], model, ('2026-10-24', '2026-10-24'))


if __name__ == '__main__':
    unittest.main()
