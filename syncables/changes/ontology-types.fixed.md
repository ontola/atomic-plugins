`deriveOntology`, and so `readPlatform`, reads an
  OpenAPI 3.1 type list: a field typed `['string', 'null']` with format
  `date-time` was given the `json` datatype and its values were not
  converted to timestamps; it is now a timestamp, and a list with one
  other non-null type takes that type. A title without a letter or digit
  (`日本語`) gives the default base `ontology` instead of term paths
  starting with `/`; a field name without one (`_`) gets no term instead
  of a path ending in `/`; and such a resource name throws.
