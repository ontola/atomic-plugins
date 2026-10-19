The mock server deduplicates creates on a declared `Idempotency-Key`
header parameter: a POST sent again with a key it has seen gets the
record made the first time, and the same key with another body gets a
`422`. A test runs the client's retry of a create whose response was
lost against it over HTTP, and finds one record at the server.
