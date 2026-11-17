"""Bounded synchronous GraphQL execution/collection reference with injected transport.

No credential handling, network client, catalog route or authorization grant.
The trusted transport receives only the validated endpoint and pinned payload.
"""
from copy import deepcopy
from dataclasses import dataclass, field
import json

from validate import InvalidManifest, bind_variables, require, validate_manifest


@dataclass
class Bundle:
    endpoint: str
    operations: dict
    collections: dict


def load_bundle(manifest, root):
    manifest = deepcopy(manifest)
    operations = validate_manifest(manifest, root)
    return Bundle(manifest['endpoint'], operations,
                  {item['id']: item for item in manifest.get('collections', [])})


def execute(bundle, operation_id, variables, transport, max_response_bytes=1_048_576):
    """Execute a pinned operation by ID; transport returns (HTTP status, JSON bytes).

    Transport exceptions are deliberately replaced with a generic failure, so
    URLs, response bodies and credential-bearing exception text cannot escape.
    """
    require(type(max_response_bytes) is int and max_response_bytes > 0, 'invalid response limit')
    require(isinstance(operation_id, str) and operation_id in bundle.operations, 'unknown operation ID')
    operation = bundle.operations[operation_id]
    payload = {'query': operation['source'], 'operationName': operation_id,
               'variables': bind_variables(operation, variables)}
    try:
        status, raw = transport(bundle.endpoint, payload)
    except Exception:
        raise InvalidManifest('GraphQL transport failed') from None
    require(type(status) is int and 200 <= status < 300, 'GraphQL HTTP request failed')
    require(isinstance(raw, bytes) and len(raw) <= max_response_bytes, 'invalid or oversized GraphQL body')
    try:
        response = json.loads(raw)
    except (ValueError, UnicodeError):
        raise InvalidManifest('invalid GraphQL JSON response') from None
    require(isinstance(response, dict), 'GraphQL response must be an object')
    require('errors' not in response or response['errors'] == [], 'GraphQL response contains errors')
    require(isinstance(response.get('data'), dict), 'GraphQL data must be an object')
    return response['data']


def value_at(value, path):
    for key in path:
        require(isinstance(value, dict) and key in value, 'missing or null collection response path')
        value = value[key]
    return value


@dataclass
class ReadResult:
    items: list = field(default_factory=list)
    traversal_complete: bool = False
    error: str | None = None
    # Traversal termination alone supplies no absence/deletion evidence.
    absence_evidence: bool = False


def read_collection(bundle, collection_id, variables, transport, *, max_pages=100, max_items=10_000):
    """Read one explicit collection, preserving prior pages on a later failure.

    Traversals always start at cursor null/offset zero; callers cannot supply
    that variable. Checkpoints and nested parent traversals are not supported.
    """
    result = ReadResult()
    try:
        require(type(max_pages) is int and max_pages > 0 and type(max_items) is int and max_items > 0,
                'read limits must be positive integers')
        require(isinstance(collection_id, str) and collection_id in bundle.collections, 'unknown collection ID')
        require(isinstance(variables, dict), 'variables must be an object')
        collection = bundle.collections[collection_id]
        operation = bundle.operations[collection['operation']]
        paging = collection['pagination']
        cursor = paging['cursorVariable'] if paging['type'] == 'cursor' else paging['offsetVariable']
        require(cursor not in variables, 'caller cannot supply traversal position')
        values = deepcopy(variables)
        values[cursor] = None if paging['type'] == 'cursor' else 0
        seen_cursors, seen_ids = set(), set()
        for _ in range(max_pages):
            # Binding here obtains the actual page size after operation defaults;
            # execute binds again from the untrusted/fixed-separated values.
            bound = bind_variables(operation, values)
            data = execute(bundle, collection['operation'], values, transport)
            items = value_at(data, collection['items'])
            require(isinstance(items, list), 'collection items must be an array')
            require(len(items) <= bound[paging['pageSizeVariable']], 'response exceeds requested page size')
            require(len(result.items) + len(items) <= max_items, 'collection item limit exceeded')
            page_ids = set()
            for item in items:
                identity = value_at(item, collection['identity'])
                require(isinstance(identity, str) and bool(identity), 'collection identity must be a nonempty string')
                require(identity not in seen_ids and identity not in page_ids, 'duplicate collection identity')
                page_ids.add(identity)
            if paging['type'] == 'cursor':
                more = value_at(data, paging['hasNextPage'])
                next_cursor = value_at(data, paging['endCursor'])
                require(type(more) is bool, 'hasNextPage must be Boolean')
                require(next_cursor is None or isinstance(next_cursor, str), 'endCursor must be String or null')
                if more:
                    require(bool(next_cursor) and next_cursor not in seen_cursors, 'missing or repeated cursor')
                    seen_cursors.add(next_cursor)
                    values[cursor] = next_cursor
                finished = not more
            else:
                finished = not items
                values[cursor] += bound[paging['pageSizeVariable']]
            result.items.extend(deepcopy(items))
            seen_ids.update(page_ids)
            if finished:
                result.traversal_complete = True
                return result
        raise InvalidManifest('collection page limit exceeded')
    except InvalidManifest as error:
        result.error = str(error)
    return result
