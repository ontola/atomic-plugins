`TransportRequest.purpose` (`list`, `feed`, `item`,
  `describer`, `zone`, `precondition`, `write`, `inbox`) on every request
  syncables makes, and `TransportResponse.fromCache`, which gives back the
  request's pacing count and does not count against `maxRequests`. Both
  optional; the `PurposedRequest` and `RequestPurpose` types are exported.
  #566's "smallest backward-compatible extension" for a caching transport.
