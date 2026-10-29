The Google Keep daemon example now uses the full pinned Keep v1 OAD and the
proxy catalog's auth, pagination and CRUD overlays. It remains read-only at
runtime. Replacing an existing private example changes its document hash
and starts a new collection scope; previous snapshot history is retained
under the old scope rather than migrated automatically.
