Standalone sync and daemon commands accept `--message` to record intent in
local Git snapshot commits alongside generated run provenance. History now
returns messages, timestamps and parents, supports a pinned `--at` revision,
and accepts `--subject` for resource or schema history while preserving the
existing revision-ID list. Explicit storage-layer messages retain intent-only
commits even when their trees are unchanged.
