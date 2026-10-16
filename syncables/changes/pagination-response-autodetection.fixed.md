Pagination Schemes §6.3 `matchHeaders` and
  `matchResponseFields` are read: a scheme auto-detected by its response
  headers (a `Link` header, as in the spec's example and GitHub's and
  GitLab's overlays) or response fields now matches an operation whose
  description declares them, and the read pages instead of taking its
  first response as the whole list. An operation whose description does
  not declare them is read as before. In this repository's catalogs no
  operation changes (GitLab's `Link` scheme is applied explicitly).
