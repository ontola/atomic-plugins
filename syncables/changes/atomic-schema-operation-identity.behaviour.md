Generated Atomic schemas now use the pinned OAD and response operation,
rather than the account/collection alias. Accounts using the same operation
share declared Classes and Properties; observed records do not change the
declared Class. Tables and rows retain their account-specific identities.
Existing native peers retain superseded schema resources as previous members
when their import keys change.
