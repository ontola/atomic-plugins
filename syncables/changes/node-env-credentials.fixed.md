The Node entry's `createApiClient` reads `SYNCABLES_*` credentials from
the environment only when an `authenticate` adapter is given; without
one they are ignored, silently. Before, a
`SYNCABLES_API_KEY` or `SYNCABLES_ACCESS_TOKEN` set for something else
made a client without an adapter (a transport that authenticates itself)
refuse to start with "Credentials require an authenticate adapter".
Explicit credentials without an adapter are still refused.
