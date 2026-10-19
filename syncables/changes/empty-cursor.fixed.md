A read by the last item's cursor (Pagination Schemes `fromLastItem`)
ends with a `PageReadError`, not complete, when that item's cursor value
is an empty string. Before, the client sent `?starting_after=`, and a
provider that answered it with an empty page made the read end as
complete after the items before it.
