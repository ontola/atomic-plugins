"""CRUD Causality 0.6.0: every rule of §8, collection reads (listMethod, listQuery, listBody) and compound creates."""
import copy
import pathlib
import unittest

import yaml
from openapi_spec_validator import validate as validate_openapi

from validate import (compound_create, continue_compound_create, created_identity, path_template_problem,
                      read_request, validate)

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
        self.invalid(lambda d: collections(d)[0].pop("urlTemplate"), "needs a urlTemplate")

    def test_a_ref_collection_path_item_is_resolved(self):
        def via_ref(d):
            d["components"]["pathItems"] = {"tasks": d["paths"]["/lists/{listId}/tasks"]}
            d["paths"]["/lists/{listId}/tasks"] = {"$ref": "#/components/pathItems/tasks"}
        document = example()
        via_ref(document)
        validate(document)
        self.invalid(lambda d: (via_ref(d), collections(d)[0]["listQuery"].update(nope="x")),
                     "listQuery.nope: not a query parameter of GET /lists/{listId}/tasks")

    def test_list_body_needs_post_and_a_request_body(self):
        self.invalid(lambda d: collections(d)[0].update(listBody={"a": 1}), "only with listMethod POST")
        self.invalid(lambda d: d["paths"]["/search"]["post"].pop("requestBody"), "declares no JSON request body")
        self.invalid(lambda d: collections(d)[1].update(listBody=[1]), "expected an object")

    def test_x_crud_list_operation_must_be_where_the_collection_is_read(self):
        def move(document):
            document["paths"]["/other"] = {"get": document["paths"]["/lists/{listId}/tasks"]["get"]}
            document["paths"]["/lists/{listId}/tasks"]["get"] = {"responses": {"200": {"description": "ok"}}}
        self.invalid(move, "collection allTasks is read at GET /lists/{listId}/tasks")
        self.invalid(lambda d: d["paths"]["/search"]["post"]["x-crud"].update(resource="nope"), "is not a crudResources key")
        self.invalid(lambda d: d["paths"]["/search"]["post"]["x-crud"].update(collection="nope"), "is not a collection of page")


class LegacyAndEdgeCaseTests(unittest.TestCase):
    def test_x_list_forms_define_a_read_and_combine_field_by_field(self):
        document = example()
        tasks, pages = collections(document)
        tasks["x-list-query"] = tasks.pop("listQuery")
        pages["x-list-method"] = "post"  # syncables accepts any case
        del pages["listMethod"]
        validate(document)
        self.assertEqual(read_request(document, "page", "searchedPages", {})[0], "POST")
        self.assertEqual(read_request(document, "task", "allTasks", {"listId": "L1"})[1],
                         "/lists/L1/tasks?showCompleted=true&showHidden=true")
        # A non-string x-list-query value is sent as its text, as syncables does.
        tasks["x-list-query"]["maxResults"] = 200
        self.assertIn("maxResults=200", read_request(document, "task", "allTasks", {"listId": "L1"})[1])

    def test_a_published_notion_style_post_collection_is_read_at_post(self):
        document = example()
        pages = collections(document)[1]
        pages["x-list-method"] = "POST"
        pages["x-list-body"] = pages.pop("listBody")
        del pages["listMethod"]
        validate(document)
        self.assertEqual(read_request(document, "page", "searchedPages", {})[0], "POST")

    def test_both_forms_of_one_field_are_a_warning(self):
        document = example()
        collections(document)[0]["x-list-query"] = {"showHidden": "true"}
        warnings = []
        validate(document, warnings)
        self.assertEqual(len(warnings), 1)
        self.assertIn("rule 19", warnings[0])

    def test_x_list_forms_alone_are_not_checked(self):
        # A published 0.3.0 overlay may fix a parameter its subset OAD does not declare (GitHub's state=all).
        document = example()
        tasks, pages = collections(document)
        tasks.pop("listQuery")
        tasks["x-list-query"] = {"state": "all", "limit": 200, "flag": True, "none": None}
        pages.pop("listMethod")
        pages["x-list-method"] = "post"
        pages["x-list-body"] = pages.pop("listBody")
        pages["x-list-body"]["start_cursor"] = "x"
        validate(document)
        path = read_request(document, "task", "allTasks", {"listId": "L"})[1]
        self.assertEqual(path, "/lists/L/tasks?state=all&limit=200&flag=true&none=")  # syncables' asText

    def test_list_body_paging_conflicts_follow_dot_paths_and_escapes(self):
        document = example()
        scheme = document["components"]["paginationSchemes"]["bodyCursor"]["request"]["bodyFields"]
        scheme['cursor.["a.b"]'] = scheme.pop("start_cursor")
        validate(document)
        pages = collections(document)[1]
        pages["listBody"]["cursor"] = {"a.b": "x"}
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn("listBody.cursor.a.b: owned", str(raised.exception))
        pages["listBody"]["cursor"] = 5  # a scalar where the paging field's parent object goes
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn("listBody.cursor: owned", str(raised.exception))
        pages["listBody"]["cursor"] = {"other": 1}  # a sibling is fine
        validate(document)

    def test_list_body_needs_a_json_request_body(self):
        document = example()
        content = document["paths"]["/search"]["post"]["requestBody"]["content"]
        content["application/x-www-form-urlencoded"] = content.pop("application/json")
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn("declares no JSON request body", str(raised.exception))
        content["application/vnd.api+json"] = content.pop("application/x-www-form-urlencoded")
        validate(document)


class ReadRequestTests(unittest.TestCase):
    def test_get_read_sends_exactly_the_fixed_query(self):
        method, path, body = read_request(example(), "task", "allTasks", {"listId": "L 1/2"})
        self.assertEqual((method, path, body), ("GET", "/lists/L%201%2F2/tasks?showCompleted=true&showHidden=true", None))

    def test_post_read_sends_the_fixed_body(self):
        method, path, body = read_request(example(), "page", "searchedPages", {})
        self.assertEqual((method, path), ("POST", "/search"))
        self.assertEqual(body, {"filter": {"property": "object", "value": "page"}, "page_size": 100})


def compound():
    return yaml.safe_load((ROOT / "examples" / "compound-create.yaml").read_text(encoding="utf-8"))


TICKETS = "/projects/{project}/tickets"


class CompoundCreateValidationTests(unittest.TestCase):
    def follow_ups(self, document):
        return document["paths"][TICKETS]["post"]["x-crud"]["followUps"]

    def invalid(self, mutate, fragment):
        document = compound()
        mutate(document)
        with self.assertRaises(ValueError) as raised:
            validate(document)
        self.assertIn(fragment, str(raised.exception))

    def test_example_is_valid(self):
        validate(compound())

    def test_example_is_valid_openapi_without_the_extension_members(self):
        document = compound()
        document["components"].pop("crudResources")
        validate_openapi(document)

    def test_only_on_create_and_nonempty(self):
        def on_update(d):
            d["paths"][TICKETS + "/{number}/labels"]["post"]["x-crud"]["followUps"] = self.follow_ups(d)
        self.invalid(on_update, "allowed only on action create")
        self.invalid(lambda d: d["paths"][TICKETS]["post"]["x-crud"].update(followUps=[]), "nonempty array")

    def test_follow_up_fields(self):
        for mutate, fragment in (
                (lambda f: f.pop("operation"), "operation is required"),
                (lambda f: f.update(create="sometimes"), "expected include or omit"),
                (lambda f: f.update(field="labels."), "field: expected a dot-path"),
                (lambda f: f.update(itemKey=""), "itemKey: expected a dot-path"),
                (lambda f: f.update(retries=2), "unknown member")):
            with self.subTest(fragment=fragment):
                self.invalid(lambda d: mutate(self.follow_ups(d)[0]), fragment)

    def test_operation_is_one_update_of_the_same_resource(self):
        self.invalid(lambda d: self.follow_ups(d)[0].update(operation="missing"), "names 0 operations")
        self.invalid(lambda d: self.follow_ups(d)[0].update(operation="createTicket"), "is not an update of 'ticket'")

    def test_bind_keys_and_sources(self):
        for bind, fragment in (
                ({"path.number": {"from": "created", "field": "number"}, "query.x": {"from": "planned", "field": "title"},
                  "body.labels": {"from": "missing", "field": "labels"}}, "no query parameter 'x'"),
                ({"path.number": {"from": "created", "field": "number"}, "cookie.x": {"from": "planned", "field": "x"}},
                 "expected body, body.<dot-path>"),
                ({"path.number": {"from": "response", "field": "number"}}, "expected {from"),
                ({"path.number": {"from": "created", "field": "number"}, "body.labels": {"from": "missing", "field": "title"}},
                 "from missing needs the follow-up's own field"),
                ({"path.number": {"from": "created", "field": "number"}, "body": {"from": "planned", "field": "labels"},
                  "body.labels": {"from": "missing", "field": "labels"}}, "body excludes")):
            with self.subTest(fragment=fragment):
                self.invalid(lambda d: self.follow_ups(d)[0].update(bind=bind), fragment)

    def test_body_needs_a_json_request_body(self):
        def no_body(d):
            del d["paths"][TICKETS + "/{number}/labels"]["post"]["requestBody"]
        self.invalid(no_body, "declares no JSON request body")

    def test_required_path_parameters_are_bound_or_carried(self):
        def unbound(d):
            del self.follow_ups(d)[0]["bind"]["path.number"]
        self.invalid(unbound, "path parameter 'number' is neither bound nor carried")

    def test_0_4_documents_stay_valid(self):
        validate(example())


class CompoundCreateRuleTests(unittest.TestCase):
    """Review of #413: rule 24 for query and header parameters, header case, $ref path items."""

    LABELS = TICKETS + "/{number}/labels"

    def follow_up(self, document):
        return document["paths"][TICKETS]["post"]["x-crud"]["followUps"][0]

    def test_required_query_and_header_parameters_must_be_bound(self):
        for kind in ("query", "header"):
            document = compound()
            document["paths"][self.LABELS]["post"]["parameters"] = [
                {"name": "X-Token" if kind == "header" else "token", "in": kind, "required": True,
                 "schema": {"type": "string"}}]
            with self.subTest(kind=kind), self.assertRaises(ValueError) as raised:
                validate(document)
            self.assertIn(f"required {kind} parameter", str(raised.exception))

    def test_header_bind_names_compare_case_insensitively(self):
        document = compound()
        document["paths"][self.LABELS]["post"]["parameters"] = [
            {"name": "X-Token", "in": "header", "required": True, "schema": {"type": "string"}}]
        self.follow_up(document)["bind"]["header.x-token"] = {"from": "planned", "field": "title"}
        validate(document)

    def test_path_item_ref_is_resolved(self):
        document = compound()
        document.setdefault("components", {})["pathItems"] = {"labels": document["paths"].pop(self.LABELS)}
        document["paths"][self.LABELS] = {"$ref": "#/components/pathItems/labels"}
        validate(document)


class CompoundCreateTests(unittest.TestCase):
    PLANNED = {"title": "Fix", "labels": ["doing", "bug"], "watchers": ["ada"]}

    def setUp(self):
        self.document = compound()
        self.crud = self.document["paths"][TICKETS]["post"]["x-crud"]
        self.sent = []
        self.bound = []

    def run_create(self, created, follow_up_outcomes=(), outcome="ok", location=None, planned=None):
        outcomes = list(follow_up_outcomes)

        def send_create(body):
            self.sent.append(("create", body))
            return outcome, created, location

        def send_follow_up(operation, request):
            self.sent.append((operation, request))
            result = outcomes.pop(0) if outcomes else "ok"
            if isinstance(result, Exception):
                raise result
            return result

        return compound_create(self.document, self.crud, planned or self.PLANNED, send_create, send_follow_up,
                               {"project": "p1"}, on_created=self.bound.append)

    def test_include_field_applied_by_the_create_needs_no_follow_up(self):
        created = {"number": 7, "title": "Fix", "labels": [{"name": "doing"}, {"name": "bug"}]}
        result = self.run_create(created)
        self.assertEqual(result["state"], "applied")
        self.assertEqual(self.sent[0], ("create", {"title": "Fix", "labels": ["doing", "bug"]}))  # watchers omitted
        self.assertEqual([s[0] for s in self.sent], ["create", "setTicketWatchers"])
        self.assertEqual(self.sent[1][1], {"path": {"project": "p1", "number": 7}, "query": {}, "header": {}, "body": ["ada"]})

    def test_silently_dropped_labels_are_added_by_the_follow_up(self):
        result = self.run_create({"number": 7, "title": "Fix", "labels": [{"name": "bug"}]})
        self.assertEqual(result["state"], "applied")
        operation, request = self.sent[1]
        self.assertEqual(operation, "addTicketLabels")
        self.assertEqual(request["body"], {"labels": ["doing"]})
        self.assertEqual(request["path"], {"project": "p1", "number": 7})

    def test_refused_follow_up_stops_there_and_marks_the_rest_not_sent(self):
        result = self.run_create({"number": 7, "title": "Fix", "labels": []}, ["refused"])
        self.assertEqual(result["state"], "partlyApplied")
        self.assertEqual(result["created"]["number"], 7)
        self.assertEqual([s[0] for s in self.sent], ["create", "addTicketLabels"])
        self.assertEqual([(p["operation"], p["reason"]) for p in result["pending"]],
                         [("addTicketLabels", "refused"), ("setTicketWatchers", "notSent")])

    def test_unknown_follow_up_outcome_is_reported_as_unknown(self):
        result = self.run_create({"number": 7, "labels": [{"name": "doing"}, {"name": "bug"}]}, ["unknown"])
        self.assertEqual(result["state"], "partlyApplied")
        self.assertEqual([(p["operation"], p["reason"]) for p in result["pending"]], [("setTicketWatchers", "unknown")])

    def test_refused_create_sends_no_follow_up(self):
        result = self.run_create(None, outcome="refused")
        self.assertEqual(result, {"state": "refused", "created": None, "pending": []})
        self.assertEqual(len(self.sent), 1)

    def test_uncertain_create_keeps_the_planned_follow_ups_and_can_resume(self):
        result = self.run_create(None, outcome="unknown")
        self.assertEqual(result["state"], "uncertain")
        self.assertEqual(result["planned"], ["labels", "watchers"])
        self.assertEqual(len(self.sent), 1)
        # The object is found by a read: continue from step 3 with it, never sending the create again.
        found = {"number": 9, "title": "Fix", "labels": [{"name": "doing"}]}
        resumed = continue_compound_create(self.crud, self.PLANNED, found,
                                           lambda op, req: self.sent.append((op, req)) or "ok", {"project": "p1"})
        self.assertEqual(resumed["state"], "applied")
        self.assertEqual([s[0] for s in self.sent], ["create", "addTicketLabels", "setTicketWatchers"])
        self.assertEqual(self.sent[1][1]["body"], {"labels": ["bug"]})

    def test_identity_from_location_when_the_body_lacks_it(self):
        self.crud["url"] = {"source": "header", "name": "Location"}
        result = self.run_create({"title": "Fix", "labels": []}, location="https://api.example.com/v1/projects/p1/tickets/12")
        self.assertEqual(result["state"], "applied")
        self.assertEqual(self.sent[1][1]["path"]["number"], "12")

    def test_no_identity_leaves_the_object_unbound_and_sends_nothing_more(self):
        for crud_url, created, location in (({"source": "template"}, {}, None),
                                            ({"source": "header", "name": "Location"}, {"number": 7}, None),
                                            ({"source": "header", "name": "Location"}, {}, "https://api.example.com/other/1")):
            self.sent, self.bound = [], []
            self.crud["url"] = crud_url
            with self.subTest(url=crud_url, location=location):
                result = self.run_create(created, location=location)
                self.assertEqual(result["state"], "unbound")
                self.assertEqual([s[0] for s in self.sent], ["create"])
                self.assertEqual(self.bound, [])

    def test_binding_is_recorded_before_a_follow_up_that_raises(self):
        with self.assertRaises(ConnectionError):
            self.run_create({"number": 7, "labels": []}, [ConnectionError("network")])
        self.assertEqual([b["number"] for b in self.bound], [7])  # a retry resumes; it never creates again
        self.assertEqual([s[0] for s in self.sent].count("create"), 1)

    def test_unresolved_bind_is_never_sent(self):
        # A planned object without watchers skips that follow-up; one whose created field is absent cannot be sent.
        self.crud["followUps"][1]["bind"]["path.number"] = {"from": "created", "field": "missingField"}
        result = self.run_create({"number": 7, "labels": [{"name": "doing"}, {"name": "bug"}]})
        self.assertEqual(result["state"], "partlyApplied")
        self.assertEqual(result["pending"], [{"operation": "setTicketWatchers", "request": None, "reason": "notSent"}])
        self.assertEqual([s[0] for s in self.sent], ["create"])
        self.sent = []
        result = self.run_create({"number": 7, "labels": []}, planned={"title": "Fix", "labels": ["doing"]})
        self.assertEqual(result["state"], "applied")
        self.assertEqual([s[0] for s in self.sent], ["create", "addTicketLabels"])


class CompoundCreateSecondReviewTests(unittest.TestCase):
    """Second review of #413: duplicate-write paths and identity edge cases."""

    PLANNED = {"title": "Fix", "labels": ["doing"], "watchers": ["ada"]}

    def setUp(self):
        self.document = compound()
        self.crud = self.document["paths"][TICKETS]["post"]["x-crud"]

    def test_resuming_does_not_resend_an_applied_omit_follow_up(self):
        sent = []
        # Read back after a partly applied create: watchers (omit) already set, labels not.
        found = {"number": 7, "title": "Fix", "labels": [], "watchers": ["ada"]}
        result = continue_compound_create(self.crud, self.PLANNED, found,
                                          lambda op, req: sent.append(op) or "ok", {"project": "p1"})
        self.assertEqual(result["state"], "applied")
        self.assertEqual(sent, ["addTicketLabels"])

    def test_a_binding_without_its_template_variable_is_unbound_not_an_error(self):
        resource = self.document["components"]["crudResources"]["ticket"]
        resource["identity"]["bindings"]["ticketId"] = {"field": "id"}
        bound, sent = [], []
        result = compound_create(self.document, self.crud, self.PLANNED,
                                 lambda body: ("ok", {"number": 7}, None),
                                 lambda op, req: sent.append(op) or "ok", {"project": "p1"},
                                 on_created=bound.append)
        self.assertEqual(result["state"], "unbound")
        self.assertEqual((bound, sent), ([], []))
        with self.assertRaises(ValueError) as raised:
            validate(self.document)
        self.assertIn("not a variable of urlTemplate", str(raised.exception))

    def test_template_identity_falls_back_to_the_request_body(self):
        resource = self.document["components"]["crudResources"]["ticket"]
        resource["identity"]["bindings"] = {"number": {"field": "number"}}
        planned = dict(self.PLANNED, number=12)  # a client-supplied identity
        result = compound_create(self.document, self.crud, planned,
                                 lambda body: ("ok", {}, None), lambda op, req: "ok", {"project": "p1"})
        self.assertEqual(result["created"]["number"], 12)

    def test_header_named_by_url_name_case_insensitively(self):
        self.crud["url"] = {"source": "header", "name": "Content-Location"}
        result = compound_create(
            self.document, self.crud, self.PLANNED,
            lambda body: ("ok", {}, {"content-location": "/v1/projects/p1/tickets/9"}),
            lambda op, req: "ok", {"project": "p1"})
        self.assertEqual(result["created"]["number"], "9")
        result = compound_create(
            self.document, self.crud, self.PLANNED,
            lambda body: ("ok", {}, {"Location": "/v1/projects/p1/tickets/9"}),
            lambda op, req: "ok", {"project": "p1"})
        self.assertEqual(result["state"], "unbound")

    def test_variables_whose_names_clash_once_sanitised(self):
        resource = self.document["components"]["crudResources"]["ticket"]
        resource["identity"] = {"urlTemplate": "/projects/{a-b}/tickets/{a_b}",
                                "bindings": {"a-b": {"field": "project"}, "a_b": {"field": "number"}}}
        self.crud["url"] = {"source": "header"}
        identity = created_identity(self.document, self.crud, {}, "/projects/p1/tickets/3")
        self.assertEqual(identity, {"project": "p1", "number": "3"})

    def test_duplicate_follow_up_fields(self):
        self.crud["followUps"].append(copy.deepcopy(self.crud["followUps"][0]))
        with self.assertRaises(ValueError) as raised:
            validate(self.document)
        self.assertIn("field 'labels' has more than one follow-up", str(raised.exception))


def lifecycle():
    return yaml.safe_load((ROOT / "examples" / "widget-lifecycle.yaml").read_text(encoding="utf-8"))


class StructureRuleTests(unittest.TestCase):
    """Rules 1, 3, 5-8, 10-13 and 25, and the value sets of §4.3.2 and §4.6, on examples/widget-lifecycle.yaml."""

    def outcome(self, mutate):
        document = lifecycle()
        mutate(document)
        warnings = []
        try:
            validate(document, warnings)
        except ValueError as raised:
            return str(raised), warnings
        return "", warnings

    def invalid(self, mutate, fragment):
        errors, _ = self.outcome(mutate)
        self.assertIn(fragment, errors)

    def warns(self, mutate, fragment):
        errors, warnings = self.outcome(mutate)
        self.assertEqual(errors, "")
        self.assertTrue(any(fragment in w for w in warnings), warnings)

    @staticmethod
    def crud(document, path, method):
        return document["paths"][path][method]["x-crud"]

    @staticmethod
    def resource(document, name):
        return document["components"]["crudResources"][name]

    def test_example_is_valid_without_warnings(self):
        warnings = []
        validate(lifecycle(), warnings)
        self.assertEqual(warnings, [])

    def test_example_is_valid_openapi_without_the_extension_members(self):
        document = lifecycle()
        document["components"].pop("crudResources")
        for item in document["paths"].values():
            for operation in item.values():
                if isinstance(operation, dict):
                    operation.pop("x-crud", None)
        validate_openapi(document)

    def test_rule_1_action(self):
        self.invalid(lambda d: self.crud(d, "/widgets", "get").update(action="search"),
                     "paths./widgets.get.x-crud.action: 'search' is not one of create, list, read, update, delete (rule 1)")
        self.invalid(lambda d: self.crud(d, "/widgets", "get").pop("action"), "None is not one of")

    def test_rule_2_resource(self):
        self.invalid(lambda d: self.crud(d, "/widgets/{widgetId}", "get").update(resource="gadget"),
                     "paths./widgets/{widgetId}.get.x-crud.resource: 'gadget' is not a crudResources key (rule 2)")

    def test_rule_3_create_url(self):
        self.invalid(lambda d: self.crud(d, "/widgets", "post").pop("url"),
                     "paths./widgets.post.x-crud.url: required for action create (rule 3)")
        self.invalid(lambda d: self.crud(d, "/widgets", "post").update(url={"source": "location"}),
                     "url.source: expected one of header, bodyField, template (§4.3.2)")
        self.invalid(lambda d: self.crud(d, "/widgets", "post").update(url={"source": "bodyField"}),
                     "url.name: source bodyField needs a dot-path name (rule 26)")
        self.invalid(lambda d: self.crud(d, "/widgets", "post").update(url={"source": "header"}),
                     "url.name: source header needs a header name (rule 26)")
        for url in ({"source": "template"}, {"source": "header", "name": "Location"},
                    {"source": "bodyField", "name": "self.href"}):
            with self.subTest(url=url):
                self.assertEqual(self.outcome(lambda d: self.crud(d, "/widgets", "post").update(url=url))[0], "")

    def test_rule_4_list_collection(self):
        self.invalid(lambda d: self.crud(d, "/widgets", "get").update(collection="gadgets"),
                     "x-crud.collection: 'gadgets' is not a collection of widget (rule 4)")

    def test_rule_5_update_mode(self):
        self.invalid(lambda d: self.crud(d, "/widgets/{widgetId}", "patch").pop("mode"),
                     "paths./widgets/{widgetId}.patch.x-crud.mode: required for action update (rule 5)")
        self.invalid(lambda d: self.crud(d, "/widgets/{widgetId}", "put").update(mode="merge"),
                     "x-crud.mode: 'merge' is not replace or patch (rule 5)")

    def test_rule_6_patch_format_is_a_should(self):
        self.warns(lambda d: self.crud(d, "/widgets/{widgetId}", "patch").pop("patchFormat"),
                   "mode patch without patchFormat (rule 6, SHOULD)")

    def test_patch_format_values(self):
        self.invalid(lambda d: self.crud(d, "/widgets/{widgetId}", "patch").update(patchFormat="merge"),
                     "x-crud.patchFormat: 'merge' is not one of jsonPatch, jsonMergePatch, custom (§4.6)")

    def test_rule_7_member_of_and_removes_from(self):
        self.invalid(lambda d: self.crud(d, "/widgets", "post").update(memberOf=["widgets", "favourites"]),
                     "x-crud.memberOf: 'favourites' is not a collection of widget (rule 7)")
        self.invalid(lambda d: self.crud(d, "/widgets/{widgetId}/recent", "delete").update(removesFrom=["gone"]),
                     "x-crud.removesFrom: 'gone' is not a collection of widget (rule 7)")
        self.invalid(lambda d: self.crud(d, "/widgets", "post").update(memberOf="widgets"),
                     "x-crud.memberOf: expected an array of collection names (rule 7)")
        self.assertEqual(self.outcome(lambda d: self.crud(d, "/widgets/{widgetId}/recent", "delete")
                                      .update(removesFrom=["*"]))[0], "")

    def test_rule_8_path_templates(self):
        self.invalid(lambda d: self.resource(d, "widget")["identity"].update(urlTemplate="widgets/{widgetId}"),
                     "crudResources.widget.identity.urlTemplate: 'widgets/{widgetId}' must begin with / (rule 8)")
        self.invalid(lambda d: self.resource(d, "widget")["collections"]["widgets"].update(urlTemplate="/widgets?all=1"),
                     "crudResources.widget.collections.widgets.urlTemplate: '/widgets?all=1' has a query or fragment (rule 8)")
        for template, problem in [("/w/{a", "has an unclosed {"), ("/w/a}", "has a } without {"),
                                  ("/w/{{a}}", "has a nested {"), ("/w/{}", "has an empty {}"),
                                  ("/w/{a}/{a}", "names 'a' twice"), (7, "expected a string")]:
            with self.subTest(template=template):
                self.assertEqual(path_template_problem(template), problem)
        for template in ["/widgets", "/reports/{id}.json", "/a/{b}/c/{d}"]:
            self.assertIsNone(path_template_problem(template))

    def test_rule_25_identity_when_an_object_is_addressed(self):
        self.invalid(lambda d: self.resource(d, "widget").pop("identity"),
                     "crudResources.widget.identity: required, since POST /widgets (create) addresses one object of it (rule 25)")
        # project is only listed, but timeEntry's reference targets it.
        self.invalid(lambda d: self.resource(d, "project").pop("identity"),
                     "crudResources.project.identity: required, since the reference timeEntry.references.project "
                     "addresses one object of it (rule 25)")
        self.invalid(lambda d: self.resource(d, "project")["identity"].pop("urlTemplate"),
                     "crudResources.project.identity: an Identity Object needs a urlTemplate (rule 25, §4.1.1)")

    def test_rule_25_reports_a_reference_target_without_identity_once(self):
        errors, _ = self.outcome(lambda d: self.resource(d, "project").pop("identity"))
        self.assertIn("(rule 25)", errors)
        self.assertNotIn("(rule 12)", errors)

    def test_a_ref_path_item_is_checked_too(self):
        def via_ref(d):
            d["components"]["pathItems"] = {"widget": d["paths"]["/widgets/{widgetId}"]}
            d["paths"]["/widgets/{widgetId}"] = {"$ref": "#/components/pathItems/widget"}
            d["components"]["pathItems"]["widget"]["patch"]["x-crud"].pop("mode")
        self.invalid(via_ref, "paths./widgets/{widgetId}.patch.x-crud.mode: required for action update (rule 5)")

    def test_rule_25_a_list_only_resource_may_omit_identity(self):
        def list_only(d):
            self.resource(d, "timeEntry").pop("references")
            self.resource(d, "project").pop("identity")
        errors, warnings = self.outcome(list_only)
        self.assertEqual(errors, "")
        self.assertEqual(warnings, [])
        # A read of one object needs it again.
        def read_one(d):
            list_only(d)
            d["paths"]["/workspaces/{workspaceId}/projects/{projectId}"] = {
                "get": {"x-crud": {"action": "read", "resource": "project"}, "responses": {"200": {"description": "One"}}}
            }
        self.assertIn("GET /workspaces/{workspaceId}/projects/{projectId} (read) addresses one object of it (rule 25)",
                      self.outcome(read_one)[0])

    def test_rule_9_identity_bindings(self):
        self.invalid(lambda d: self.resource(d, "widget")["identity"]["bindings"].update(gadgetId={"field": "id"}),
                     "crudResources.widget.identity.bindings.gadgetId: not a variable of urlTemplate")

    def test_rule_10_unbound_identity_variables_come_from_a_collection(self):
        self.warns(lambda d: self.resource(d, "project")["collections"]["projects"].update(urlTemplate="/projects"),
                   "crudResources.project.identity.urlTemplate: {workspaceId} is neither bound nor in a collection's urlTemplate (rule 10, SHOULD)")

    def test_rule_11_reference_resource(self):
        self.invalid(lambda d: self.resource(d, "timeEntry")["references"]["project"].update(resource="client"),
                     "crudResources.timeEntry.references.project.resource: 'client' is not a crudResources key (rule 11)")

    def test_rule_12_reference_bindings_name_target_variables(self):
        self.invalid(lambda d: self.resource(d, "timeEntry")["references"]["project"]["bindings"]
                     .update(timeEntryId={"field": "id"}),
                     "crudResources.timeEntry.references.project.bindings.timeEntryId: not a variable of project's urlTemplate")
        self.invalid(lambda d: self.resource(d, "timeEntry")["references"]["project"].pop("bindings"),
                     "references.project.bindings: required, an object (§4.1.3)")

    def test_rule_13_unbound_target_variables_come_from_the_referring_collections(self):
        def move(d):
            self.resource(d, "timeEntry")["collections"]["timeEntries"]["urlTemplate"] = "/time-entries"
            self.resource(d, "timeEntry")["identity"]["urlTemplate"] = "/time-entries/{timeEntryId}"
        self.warns(move, "references.project: {workspaceId} of project's urlTemplate is neither bound nor in a "
                         "collection's urlTemplate of timeEntry (rule 13, SHOULD)")

    def test_every_violation_is_reported(self):
        def break_three(d):
            self.crud(d, "/widgets/{widgetId}", "patch").pop("mode")
            self.crud(d, "/widgets", "get").update(action="search")
            self.resource(d, "widget")["identity"]["urlTemplate"] = "/widgets/{widgetId"
        errors, _ = self.outcome(break_three)
        self.assertIn("(rule 1)", errors)
        self.assertIn("(rule 5)", errors)
        self.assertIn("(rule 8)", errors)


if __name__ == "__main__":
    unittest.main()
