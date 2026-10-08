"""CRUD Causality 0.4.0: collection reads (listMethod, listQuery, listBody)."""
import pathlib
import unittest

import yaml
from openapi_spec_validator import validate as validate_openapi

from validate import read_request, validate

ROOT = pathlib.Path(__file__).parent


def example():
    return yaml.safe_load((ROOT / "examples" / "fixed-query.yaml").read_text(encoding="utf-8"))


def collections(document):
    resources = document["components"]["crudResources"]
    return resources["task"]["collections"]["allTasks"], resources["page"]["collections"]["searchedPages"]


class ValidationTests(unittest.TestCase):
    def invalid(self, mutate, fragment):
        document = example()
        mutate(document)
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn(fragment, str(raised.exception))

    def test_example_is_valid(self):
        validate(example())

    def test_example_is_valid_openapi_without_the_extension_members(self):
        document = example()
        document["components"].pop("crudResources")
        document["components"].pop("paginationSchemes")
        document.pop("components")
        validate_openapi(document)

    def test_0_3_documents_stay_valid(self):
        document = example()
        tasks, pages = collections(document)
        del tasks["listQuery"], pages["listMethod"], pages["listBody"]
        # A POST list operation without listMethod is not checked by rule 15 (0.3.0 had no way to say POST).
        validate(document)

    def test_list_query_keys_must_be_declared_query_parameters_with_string_values(self):
        self.invalid(lambda d: collections(d)[0]["listQuery"].update(state="all"), "listQuery.state: not a query parameter")
        self.invalid(lambda d: collections(d)[0]["listQuery"].update(listId="x"), "listQuery.listId: is a path parameter")
        self.invalid(lambda d: collections(d)[0]["listQuery"].update(showCompleted=True), "value must be a string")
        self.invalid(lambda d: collections(d)[0].update(listQuery={}), "nonempty object")
        self.invalid(lambda d: collections(d)[0].update(listQuery=["showCompleted"]), "nonempty object")

    def test_path_item_query_parameters_count(self):
        document = example()
        item = document["paths"]["/lists/{listId}/tasks"]
        item["parameters"].append({"name": "fields", "in": "query", "schema": {"type": "string"}})
        collections(document)[0]["listQuery"]["fields"] = "items(id)"
        validate(document)

    def test_paging_fields_are_owned_by_the_pagination_scheme(self):
        self.invalid(lambda d: collections(d)[0]["listQuery"].update(pageToken="x"), "listQuery.pageToken: owned")
        self.invalid(lambda d: collections(d)[1]["listBody"].update(start_cursor="x"), "listBody.start_cursor: owned")
        document = example()
        collections(document)[0]["listQuery"]["maxResults"] = "100"  # pageSize is allowed
        validate(document)

    def test_list_method_and_operation_must_exist_and_match(self):
        self.invalid(lambda d: collections(d)[1].update(listMethod="PUT"), "expected GET or POST")
        self.invalid(lambda d: collections(d)[1].update(listMethod="post"), "expected GET or POST")
        self.invalid(lambda d: collections(d)[0].update(listMethod="POST"), "no operation at paths['/lists/{listId}/tasks'].post")
        self.invalid(lambda d: collections(d)[0].update(urlTemplate="/tasks"), "no operation")
        self.invalid(lambda d: collections(d)[0].pop("urlTemplate"), "need a urlTemplate")

    def test_list_body_needs_post_and_a_request_body(self):
        self.invalid(lambda d: collections(d)[0].update(listBody={"a": 1}), "only with listMethod POST")
        self.invalid(lambda d: d["paths"]["/search"]["post"].pop("requestBody"), "declares no request body")
        self.invalid(lambda d: collections(d)[1].update(listBody=[1]), "expected an object")

    def test_x_crud_list_operation_must_be_where_the_collection_is_read(self):
        def move(document):
            document["paths"]["/other"] = {"get": document["paths"]["/lists/{listId}/tasks"]["get"]}
            document["paths"]["/lists/{listId}/tasks"]["get"] = {"responses": {"200": {"description": "ok"}}}
        self.invalid(move, "collection allTasks is read at GET /lists/{listId}/tasks")
        self.invalid(lambda d: d["paths"]["/search"]["post"]["x-crud"].update(resource="nope"), "is not a crudResources key")
        self.invalid(lambda d: d["paths"]["/search"]["post"]["x-crud"].update(collection="nope"), "is not a collection of page")


class ReadRequestTests(unittest.TestCase):
    def test_get_read_sends_exactly_the_fixed_query(self):
        method, path, body = read_request(example(), "task", "allTasks", {"listId": "L 1/2"})
        self.assertEqual((method, path, body), ("GET", "/lists/L%201%2F2/tasks?showCompleted=true&showHidden=true", None))

    def test_post_read_sends_the_fixed_body(self):
        method, path, body = read_request(example(), "page", "searchedPages", {})
        self.assertEqual((method, path), ("POST", "/search"))
        self.assertEqual(body, {"filter": {"property": "object", "value": "page"}, "page_size": 100})


if __name__ == "__main__":
    unittest.main()
