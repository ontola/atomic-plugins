# Typed owned list components

Session: codex://threads/01a16c93-853b-7362-94e6-c7287ee8a15e
Model/tool: GPT-6 via Codex, with bounded coding and Astra architecture review.

## Human prompts

- Model a Keep note with a body link to a List, and one typed resource per item.
- Implement that model, import the selected shopping list into the existing
  team drive, and keep the original body too.

Private titles, item text, account details and Atomic identifiers are [redacted].

## Substantive outputs

Added a provider-neutral owned-list projector and a separate declarative Keep
consumer profile. OpenAPI references remain shape declarations; this feature
does not invent API-addressable list components or change the API extension
contract. The Note's new Body Property links to a typed List, which doubles as a
standard Atomic Table. All typed ListItems have that List as their Atomic parent;
ordered Items and Child items plus an optional Parent item relation preserve
logical nesting. Original body retains the exact native JSON and schema metadata.

Absent text and false booleans remain distinct. Duplicate and blank entries are
retained. Snapshot item keys include the body hash and exact source path, rather
than claiming provider item IDs or continuity across changed snapshots. The
profile, selected source schema and accepted snapshot provenance are retained.
Added a bounded preparation example, documentation and synthetic tests.

The authorized local import uses the accepted snapshot, not a provider refresh.
Its signed publisher explicitly binds the intended team drive and keeps a
private allocation checkpoint with public genesis certificates. It allocates
IDs before populating cyclic references, checks existing values before replay,
and fresh-reads stored fields before recording completion. It does not install
continuous synchronization or provider write-back.

Private plans, publication state and verification artifacts remain outside Git.
Validation: all 23 synthetic projector tests pass with no skips, including a
regression for mandatory Class/Property schema fields caught by the signed
publication. Full package lint, TypeScript checking, release emit and formatting
checks pass. The local import fresh-read all 337 resources successfully: one
Note, one List, 305 ListItems (including four absent-text entries), and required
folders/schema/view resources. Exact original body, typed values, order,
parents, classes, destination drive and provenance match the accepted plan.
No existing destination resources were overwritten.

Browser validation caught the first-Class view dispatch requirement. The List
now declares Table first and retains its typed List Class, with a regression
test. An acknowledged class-order-only update preserved all allocated IDs.
Fresh replay verified all 337 resources and created or changed zero resources.
The data browser shows the ordered item table in the destination drive with
Name, Checked and Position columns. No browser renderer code was modified.
Astra's final review found no blockers for the nonempty snapshot import; signed
empty-list persistence remains unverified, although graph generation is tested.

CI found a formatting-only issue in the new presentation regression after its
provider-neutral fixture label was corrected during integration. Applied
Prettier and reran the full package formatting check, lint, typecheck and the
23 focused tests. The consolidated base adds a Braid dependency; local
validation uses isolated task dependencies rather than modifying the shared
worktree dependency installation.
