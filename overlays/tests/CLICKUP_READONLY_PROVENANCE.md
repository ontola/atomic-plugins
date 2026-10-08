# ClickUp read-only overlay evidence and current limit

The overlays target the read-only subset at immutable OpenAPI Directory commit
[`de95e5bf40f54e3752281a771a786854038d683b`](https://github.com/ontola/openapi-directory/tree/de95e5bf40f54e3752281a771a786854038d683b/APIs/clickup.com/v2-readonly).
The subset keeps the ClickUp source schemas and examples. Its source examples
do not consistently validate against their declared schemas, so neither the
composition test nor the Syncables fixture treats them as captured-response
validation.

Authentication metadata follows ClickUp's [authentication guide](https://developer.clickup.com/docs/authentication)
and [Get Access Token reference](https://developer.clickup.com/reference/getaccesstoken),
checked 2026-10-08. The guide documents authorization-code OAuth, the
authorization and token URLs, and says current access tokens do not expire.
The token operation requires `client_id`, `client_secret`, and `code` in the
request body. The profile therefore records `client_secret_post`, no scopes,
and `pkce.requirement: unsupported` because the provider documentation gives
no PKCE support. It defines no refresh URL or refresh-token behavior. The
profile selects three GET operations; ClickUp's user-selected Workspace grant
is broad and provides no read-only scope, so this is only a Local Thought
operation allowlist.

The [Get Authorized Teams reference](https://developer.clickup.com/reference/getauthorizedteams),
[Get Filtered Team Tasks reference](https://developer.clickup.com/reference/getfilteredteamtasks),
and [Get Task reference](https://developer.clickup.com/reference/gettask)
document the root Workspace list, task collection, and task item routes. The
filtered Workspace task reference documents a zero-based `page` parameter and
a cap of 100 tasks per response. It does not document a response continuation
field. CRUD metadata carries the Workspace ID from a root team record into the
task collection and retains `task.parent` as ordinary task data.

The pagination limitation is tracked in
[openapi-extensions issue #25](https://github.com/pondersource/openapi-extensions/issues/25).
The current Pagination Schemes page role is 1-based, while ClickUp's `page` is
0-based; it also cannot express “request another page while the prior page
contained 100 items” when the API provides no continuation field. The actual
Syncables fixture records this result: it reaches the task collection at
`page=0`, imports 100 synthetic tasks, and stops without requesting a next
page. This is evidence that the current generic consumer cannot establish a
complete task listing. It is not evidence of provider response validity or a
live ClickUp synchronization.

Run from the atomic-plugins repository root:

```sh
python3 overlays/tests/test_clickup_readonly.py
node overlays/tests/runtime_clickup_readonly.mjs
```
