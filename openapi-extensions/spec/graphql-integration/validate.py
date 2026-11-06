"""Offline validator for GraphQL Integration 0.1.0-draft operation bundles.

No network requests or provider execution. Paths resolve within the manifest's
bundle directory. This is an authoring reference, not proxy authorization.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import urlsplit

from graphql import (
    GraphQLError, OperationType, build_schema, get_variable_values,
    is_non_null_type, parse, type_from_ast, validate as validate_document,
    validate_schema,
)
from graphql.language import Visitor, visit
from graphql.language.ast import OperationDefinitionNode, FragmentDefinitionNode


class InvalidManifest(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise InvalidManifest(message)


def fields(value, required, optional=()):
    require(isinstance(value, dict), 'expected an object')
    require(set(required) <= value.keys(), f'missing fields: {set(required) - value.keys()}')
    require(value.keys() <= set(required) | set(optional),
            f'unknown fields: {value.keys() - set(required) - set(optional)}')


def text(value):
    return isinstance(value, str) and bool(value.strip())


def artifact(root, descriptor):
    fields(descriptor, ('path', 'sha256'))
    require(text(descriptor['path']), 'artifact path must be a string')
    relative = Path(descriptor['path'])
    require(not relative.is_absolute(), 'artifact path must be relative')
    path = (root / relative).resolve()
    require(path.is_relative_to(root.resolve()), 'artifact path escapes bundle')
    require(isinstance(descriptor['sha256'], str) and
            re.fullmatch(r'[0-9a-f]{64}', descriptor['sha256']), 'invalid SHA-256')
    try:
        raw = path.read_bytes()
    except OSError as error:
        raise InvalidManifest(f'cannot read artifact: {relative}') from error
    require(hashlib.sha256(raw).hexdigest() == descriptor['sha256'],
            f'artifact digest mismatch: {relative}')
    return raw.decode('utf-8')


class NoDirectives(Visitor):
    def enter_directive(self, node, *_):
        raise InvalidManifest(f'directives unsupported in version 0.1: @{node.name.value}')


def validate_manifest(manifest, root):
    """Validate pinned SDL and executable query ASTs; return operation descriptors.

    A descriptor contains the parsed document, variable definitions and policy,
    suitable for the variable-policy reference below. Nothing is executed.
    """
    fields(manifest, ('version', 'endpoint', 'schema', 'operations'))
    require(manifest['version'] == '0.1.0-draft', 'unsupported manifest version')
    require(text(manifest['endpoint']), 'endpoint must be a string')
    endpoint = urlsplit(manifest['endpoint'])
    require(endpoint.scheme == 'https' and endpoint.hostname and not endpoint.username
            and not endpoint.password and not endpoint.fragment and not endpoint.query,
            'endpoint must be an HTTPS URL without credentials, query or fragment')
    try:
        schema = build_schema(artifact(root, manifest['schema']))
    except (TypeError, GraphQLError) as error:
        raise InvalidManifest(f'invalid schema: {error}') from error
    errors = validate_schema(schema)
    require(not errors, '; '.join(str(error) for error in errors))
    operations = manifest['operations']
    require(isinstance(operations, list) and operations, 'operations must be a nonempty array')
    loaded = {}
    for operation in operations:
        fields(operation, ('id', 'document', 'variables'))
        require(text(operation['id']) and re.fullmatch(r'[_A-Za-z][_0-9A-Za-z]*', operation['id']),
                'operation ID must be a GraphQL name')
        require(operation['id'] not in loaded, 'duplicate operation ID')
        source = artifact(root, operation['document'])
        document = parse(source)
        require(all(isinstance(node, (OperationDefinitionNode, FragmentDefinitionNode))
                    for node in document.definitions), 'only executable definitions allowed')
        queries = [node for node in document.definitions if isinstance(node, OperationDefinitionNode)]
        require(len(queries) == 1, 'document must contain exactly one operation')
        query = queries[0]
        require(query.operation == OperationType.QUERY, 'only queries allowed')
        require(query.name and query.name.value == operation['id'], 'query name must equal operation ID')
        visit(document, NoDirectives())
        errors = validate_document(schema, document)
        require(not errors, '; '.join(str(error) for error in errors))
        definitions = {node.variable.name.value: node for node in query.variable_definitions}
        policies = operation['variables']
        require(isinstance(policies, dict) and policies.keys() == definitions.keys(),
                'variable policy must name every declared variable exactly once')
        for name, policy in policies.items():
            fields(policy, (), ('fixed', 'min', 'max'))
            require(not ('fixed' in policy and ('min' in policy or 'max' in policy)),
                    'fixed variable cannot have bounds')
            variable_type = type_from_ast(schema, definitions[name].type)
            if 'min' in policy or 'max' in policy:
                underlying = variable_type.of_type if is_non_null_type(variable_type) else variable_type
                require(str(underlying) == 'Int', 'bounds require an Int variable')
                for bound in ('min', 'max'):
                    if bound in policy:
                        require(type(policy[bound]) is int and -(2**31) <= policy[bound] < 2**31,
                                'bounds must be GraphQL Int values')
                require(policy.get('min', -(2**31)) <= policy.get('max', 2**31 - 1),
                        'min exceeds max')
            # Defaults must not bypass policy, nor conflict with a fixed value.
            require(not ('fixed' in policy and definitions[name].default_value is not None),
                    'fixed variable must not have a document default')
            if 'fixed' in policy:
                result = get_variable_values(schema, [definitions[name]], {name: policy['fixed']})
                require(not isinstance(result, list), f'invalid fixed value for {name}')
            if definitions[name].default_value is not None:
                result = get_variable_values(schema, [definitions[name]], {})
                require(not isinstance(result, list), f'invalid default for {name}')
                check_bounds(name, result.get(name), policy)
        loaded[operation['id']] = {
            'schema': schema, 'document': document, 'source': source,
            'definitions': list(definitions.values()), 'variables': policies,
        }
    return loaded


def check_bounds(name, value, policy):
    if 'min' not in policy and 'max' not in policy:
        return
    # Null must not let a provider default defeat a mandatory page-size cap.
    require(type(value) is int, f'{name} must supply an integer for its bounds')
    require('min' not in policy or value >= policy['min'], f'{name} below min')
    require('max' not in policy or value <= policy['max'], f'{name} above max')


def bind_variables(operation, supplied):
    """Reference policy: reject unknown/fixed overrides, inject fixed values, coerce.

    Supplied values are untrusted caller variables; fixed values come from the
    trusted bundle. Bounds are enforced after GraphQL coercion/defaults.
    """
    require(isinstance(supplied, dict), 'variables must be an object')
    policies = operation['variables']
    require(supplied.keys() <= policies.keys(), 'unknown caller variable')
    values = dict(supplied)
    for name, policy in policies.items():
        if 'fixed' in policy:
            require(name not in supplied, f'caller cannot supply fixed variable {name}')
            values[name] = policy['fixed']
    coerced = get_variable_values(operation['schema'], operation['definitions'], values)
    require(not isinstance(coerced, list), 'invalid GraphQL variable values')
    for name, policy in policies.items():
        check_bounds(name, coerced.get(name), policy)
    return coerced


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifests', nargs='+', type=Path)
    args = parser.parse_args()
    for path in args.manifests:
        try:
            operations = validate_manifest(json.loads(path.read_text()), path.parent)
        except (InvalidManifest, GraphQLError, ValueError, OSError) as error:
            parser.exit(1, f'{path}: {error}\n')
        print(f'{path}: valid ({len(operations)} pinned queries)')


if __name__ == '__main__':
    main()
