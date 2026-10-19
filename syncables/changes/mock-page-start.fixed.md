The mock server's next link and `currentPage` count page numbers from
the scheme's `start` (Pagination Schemes §4.3.1, default 1). Before,
they used `+ 1` whatever the start: with `start: 0` the next link
skipped a page, and with `start: 2` it pointed back at the first page.
