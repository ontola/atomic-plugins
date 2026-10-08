# Know-how for agent sessions

Michiel works with short-lived sessions, one per feature or PR, instead of
long-lived per-repo workers. What those workers knew is written down here, so
every new session can start from it. [`AGENTS.md`](../../AGENTS.md) comes
first; these pages add the operational side. They were written on 2026-09-30
from the hand-over notes on
[#227](https://github.com/ontola/atomic-plugins/issues/227) and checked against
the code on `main` that day. Anything not checked is marked "not verified".

| Page | Covers |
| --- | --- |
| [working-model.md](working-model.md) | the board rules of #227, temporary sessions, the worker checks, gotchas |
| [pins.md](pins.md) | `.atomic-server-ref`, candidates, `claude/atomic-plugins-pin`, the pin-PR recipe |
| [ci-and-merging.md](ci-and-merging.md) | the `CI` gate, reading check runs by head SHA, rule 12, stacked PRs, flaky tests, `build-sidecars` |
| [catalog-and-pages.md](catalog-and-pages.md) | Pages is production, `enabled: false`, app versions, the byte-for-byte checks |
| [build-vps.md](build-vps.md) | the build VPS `claude-build`: how to tell you are on it, paths, Docker, the heavy-run lock, the shared server, briefing a worker |
| [usertest-droplet.md](usertest-droplet.md) | running the user-testing droplet: scripts, workflow, what needs Michiel's OK |
| [proxy-release.md](proxy-release.md) | releasing `atomic-integration-proxy` and deploying localthought.io |

State that changes daily (which candidate is green, which PR is open) belongs
on #227, not here. Where a page names a current value (the pin, the droplet's
candidate, the proxy version) it gives the date it was true.

## Dated handovers

These are archival completion records requested by Michiel. Their PR and issue
states describe the recorded date; check #227 and the linked issues for updates.

- [2026-10-08: Devonian, ontology lenses and Atomic drive skill](handovers/2026-10-08-devonian.md)
