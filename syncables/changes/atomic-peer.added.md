Experimental `atomic-peer` serves one accepted PostgreSQL collection as a
read-only native Atomic drive through an optional Rust companion. Persistent
signed Loro documents retain record/schema identities across updates,
absence/reappearance and restart; a durable projection journal gates
publication and recovery. Source JSON and numbers remain lossless text.
Explicit owner signing authority and reader agents are required; see
`docs/atomic-peer.md`. Replication destination definitions remain configuration
only, and no provider writes, service installation or public listener is added.
