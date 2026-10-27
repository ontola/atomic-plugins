`apiKeyAuth(name)` and `apiKeyAuth(name, 'header')` refuse a header name
that is not an RFC 7230 token (a space, a colon, CR or LF, a non-ASCII
letter) when the adapter is made, as `cookie` placement already refused
such a cookie name. A query parameter name is not restricted.
