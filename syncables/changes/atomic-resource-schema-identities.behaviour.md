Experimental Atomic table schema keys now follow the pinned OAD's declared
CRUD resource, so several collections or operations can share one Class.
Existing row and table keys remain stable. Consumers that saved references
to the earlier operation-scoped experimental Classes should migrate those
references explicitly; relation Properties use new identities when their
datatype changes from JSON to a resource link.
