The browser-safe `syncables/graphql` subpath reads a validated GraphQL
collection description through an injected operation-ID executor. Cursor
and explicit empty-page offset traversals enforce identity, progress and
read limits; partial GraphQL errors leave the read incomplete. A finished
traversal supplies no absence/deletion evidence. This does not add GraphQL
support to the REST replica or integration-proxy authorization routes.
