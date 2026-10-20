# Syncables daemon design documentation

- Session: codex://threads/01a13516-270d-7604-a37e-cc81237fe040
- Assistant: OpenAI Codex; exact model version not exposed to this session.
- Date: 2026-10-16

## Human request

The user asked whether the product/architecture ideas discussed in this chat
had been documented and requested something in the atomic-plugins repository.
Earlier decisions included a CLI inside the existing Syncables npm package,
local PostgreSQL compressed API archive, in-memory hydration with compact
range coverage, a durable PostgreSQL outbox, macOS daemon management, device
authorization and Atomic/NextGraph/remoteStorage replication. The user also
explored adding a new UI before eventually retiring the original platform.

## Assistant output

Checked #565, #566 and draft #567, including the resumed CLI work and published
device-auth contract. Added a standalone architecture document, linked from
the package README, preserving the decisions and distinguishing merged library
features, draft CLI/cache implementation and planned daemon/migration work.
Explained the missing production browser approval integration: an owner hub is
a trusted application using the existing Atomic identity, and a proposed
localthought.io approval URL is not evidence that such a page exists.

Kept this change documentation-only and separate from the active CLI branch.
Reviewed relative links and diff whitespace; no provider records, credentials,
test configuration or private data were added.
