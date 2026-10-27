# Changelog fragments

One file per change, instead of an `**Unreleased**` bullet in
`../README.md`: `<name>.<kind>.md`, where `<name>` is the branch or PR
(lowercase letters, digits and hyphens, e.g. `syncables-item-order` or
`630`) and `<kind>` is `behaviour`, `added`, `fixed` or `other`. The text
is one Markdown paragraph, wrapped at about 76 columns as the README is,
without a leading `- `. Say what changed for a user of the package, and
for a behaviour change what to check before upgrading.

`npm run changelog -- --check` validates them; `npm run changelog` prints
the entry they make; `npm run changelog -- --release <version>` writes
it into the README's changelog and deletes them. See `../CLAUDE.md`.
