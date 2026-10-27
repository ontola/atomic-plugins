Device login now prints the server's complete verification link with the
matching user code prefilled, and explains continuing to owner approval.
Previously it printed the bare instruction page, which has no code-entry
field. Complete links are checked against the verification endpoint and user
code; servers without a complete link retain the manual-entry flow. The mock
approval page also supports a prefilled code.
