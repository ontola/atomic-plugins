The mock server answers a paginated list's page size, offset, page
number or page token with a `400` when it is not a whole number in range
(a page size of at least 1, a page at least the scheme's `start`).
Before, `limit=0` answered `hasMore` with the same next offset forever,
and a value that is not a number (`limit=abc`, `cursor=abc`) an empty
page that ended a read as if it were complete.
