"""Static result-path and pagination-binding validation (GraphQL Integration 0.2)."""
import re
from graphql import (
    GraphQLString, is_list_type, is_non_null_type,
    is_object_type, type_from_ast,
)
from graphql.language.ast import (
    FieldNode, FragmentDefinitionNode, FragmentSpreadNode, VariableNode,
)
from validate import fields, require, text


def unwrap(value):
    return value.of_type if is_non_null_type(value) else value


def path_keys(path):
    require(isinstance(path, list) and path and all(
        text(key) and re.fullmatch(r'[_A-Za-z][_0-9A-Za-z]*', key) for key in path),
        'result path must be a nonempty array of response keys')


def selected_fields(operation, selections):
    fragments = {node.name.value: node for node in operation['document'].definitions
                 if isinstance(node, FragmentDefinitionNode)}
    result = []
    for selection in selections:
        if isinstance(selection, FieldNode):
            result.append(selection)
        elif isinstance(selection, FragmentSpreadNode):
            result.extend(selected_fields(operation, fragments[selection.name.value].selection_set.selections))
        else:  # inline fragment: polymorphic traversal is rejected separately
            result.extend(selected_fields(operation, selection.selection_set.selections))
    return result


def at_path(operation, path, start=None):
    """Resolve response aliases against the AST and return type, selections, coordinates."""
    path_keys(path)
    if start is None:
        query = next(node for node in operation['document'].definitions if node.kind == 'operation_definition')
        current, selections = operation['schema'].query_type, [query]
    else:
        current, selections, _ = start
    coordinates = []
    for key in path:
        current = unwrap(current)
        require(not is_list_type(current), 'result path crosses an intermediate list')
        require(is_object_type(current), 'collection paths require concrete object types')
        children = selected_fields(operation, [child for node in selections
                                   if node.selection_set for child in node.selection_set.selections])
        found = [node for node in children if (node.alias or node.name).value == key]
        require(found, f'result path is not selected: {key}')
        field_name = found[0].name.value
        coordinates.append(f'{current.name}.{field_name}')
        current = GraphQLString if field_name == '__typename' else current.fields[field_name].type
        selections = found
    return current, selections, coordinates


def binding(operation, target, argument, variable, scalar, nullable=False):
    require(text(argument) and text(variable), 'pagination binding must name an argument and variable')
    definitions = {node.variable.name.value: node for node in operation['definitions']}
    require(variable in definitions, 'unknown pagination variable')
    definition = definitions[variable]
    variable_type = type_from_ast(operation['schema'], definition.type)
    require(str(unwrap(variable_type)) == scalar, f'pagination variable must be {scalar}')
    if nullable:
        require(not is_non_null_type(variable_type) and definition.default_value is None,
                'cursor variable must be nullable without a default')
    require('fixed' not in operation['variables'][variable], 'pagination variable must not be fixed')
    # Every merged occurrence must use the declared binding, including fragments.
    for selection in target[1]:
        arguments = {node.name.value: node.value for node in selection.arguments}
        value = arguments.get(argument)
        require(isinstance(value, VariableNode) and value.name.value == variable,
                'pagination argument must use its declared variable')


def validate_collections(collections, operations):
    require(isinstance(collections, list) and collections, 'collections must be a nonempty array')
    identifiers = set()
    for collection in collections:
        fields(collection, ('id', 'operation', 'items', 'identity', 'pagination'))
        require(text(collection['id']) and collection['id'] not in identifiers,
                'collection IDs must be unique nonempty strings')
        identifiers.add(collection['id'])
        require(text(collection['operation']) and collection['operation'] in operations,
                'unknown collection operation')
        operation = operations[collection['operation']]
        items = at_path(operation, collection['items'])
        item_type = unwrap(items[0])
        require(is_list_type(item_type), 'items path must select a list')
        item_type = unwrap(item_type.of_type)
        require(is_object_type(item_type), 'items must have a concrete object type')
        identity = at_path(operation, collection['identity'], (item_type, items[1], []))
        require(str(unwrap(identity[0])) in ('ID', 'String'), 'identity must select ID or String')
        paging = collection['pagination']
        fields(paging, ('type', 'field', 'pageSizeArgument', 'pageSizeVariable'),
               ('cursorArgument', 'cursorVariable', 'hasNextPage', 'endCursor',
                'offsetArgument', 'offsetVariable', 'termination'))
        require(paging['type'] in ('cursor', 'offset'), 'unsupported pagination type')
        target = at_path(operation, paging['field'])
        require(collection['items'][:len(paging['field'])] == paging['field'],
                'items must descend from the paginated field')
        binding(operation, target, paging['pageSizeArgument'], paging['pageSizeVariable'], 'Int')
        policy = operation['variables'][paging['pageSizeVariable']]
        require(policy.get('min', 0) >= 1 and 'max' in policy, 'page size requires positive min and max')
        if paging['type'] == 'cursor':
            fields(paging, ('type', 'field', 'pageSizeArgument', 'pageSizeVariable',
                            'cursorArgument', 'cursorVariable', 'hasNextPage', 'endCursor'))
            require(paging['cursorVariable'] != paging['pageSizeVariable'], 'pagination variables must differ')
            binding(operation, target, paging['cursorArgument'], paging['cursorVariable'], 'String', nullable=True)
            require(not operation['variables'][paging['cursorVariable']], 'cursor policy must be empty')
            for key, scalar in [('hasNextPage', 'Boolean'), ('endCursor', 'String')]:
                require(str(unwrap(at_path(operation, paging[key])[0])) == scalar,
                        f'{key} must select {scalar}')
                require(paging[key][:len(paging['field'])] == paging['field'],
                        'cursor metadata must descend from the paginated field')
        else:
            fields(paging, ('type', 'field', 'pageSizeArgument', 'pageSizeVariable',
                            'offsetArgument', 'offsetVariable', 'termination'))
            require(paging['termination'] == 'emptyPage', 'only explicit emptyPage termination supported')
            require(paging['offsetVariable'] != paging['pageSizeVariable'], 'pagination variables must differ')
            binding(operation, target, paging['offsetArgument'], paging['offsetVariable'], 'Int')
            require(operation['variables'][paging['offsetVariable']] == {'min': 0},
                    'offset policy must be min: 0')
