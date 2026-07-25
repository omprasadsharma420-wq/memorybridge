# Migration and recovery plan

## Versions

- Vault manifest v1: original MVP layout.
- Vault manifest v2: current directories, registered identity, and lock semantics.
- Derived SQLite schema v8: canonical metadata, explicit scopes, first-class evidence, topics,
  enriched import/validation records, connector state, provider memory, temporal/entity data,
  embedding lifecycle, and Unicode FTS.
- Legacy-memory provenance migration:
  `migrations/v0.1-memory-evidence-to-v0.2.1.json`.

The authoritative data remains JSON/JSONL in the vault. SQLite is derived.

## Legacy memory migration

Before modifying a legacy `memories.json`, MemoryBridge copies it to a timestamped directory under
`backups/v0.1-memory-evidence-*`. Existing evidence files are backed up too.

The migration:

1. Discovers source messages across all conversations.
2. Converts each resolvable `source_message_id` into a stable evidence record with its actual chat,
   provider, exact bounded excerpt, and evidence role.
3. Assigns the existing explicit scope, otherwise a valid project scope when the source chat owns
   that project, otherwise conversation scope.
4. Preserves confirmed/completed user-confirmed records and all historical states.
5. Marks an unconfirmed memory `needs_review` when any source is missing and adds
   `migration-evidence-needs-review`.
6. Writes a durable `started` report before content changes and a `complete` report with counts and
   bounded issue categories afterward.
7. Rebuilds the derived index after a performed migration so new scope/evidence is immediately
   queryable.

Evidence IDs are deterministic by memory/message pair. A complete report makes later runs a no-op.
An interrupted `started` report is retried; stable IDs prevent duplicate evidence.

## Other recovery

- Opening manifest v1 creates a timestamped manifest backup before writing v2.
- Additive SQLite schema migrations are idempotent. A derived-schema upgrade causes one rebuild;
  normal later opens do not rebuild.
- Invalid SQLite files and sidecars are moved to timestamped `backups` and rebuilt.
- Atomic JSON writes retain `.bak` recovery where replacement semantics require it.
- Malformed JSONL lines are isolated rather than making a whole stream unreadable.
- Indexed pending/streaming messages recover to `interrupted` without duplicating the user turn.
- Live lock conflicts are labeled **Locked by another MemoryBridge instance** and do not claim
  readable access. Stale/dead locks recover conservatively.
- Watched-inbox imports move only after canonical content is committed. Partial import checkpoints
  retain completed conversations and permit retry.

## Derived-intelligence rebuild policy

**Rebuild vault-derived intelligence** removes auto-extracted derived memory, evidence, topics, and
processing checkpoints, then reprocesses every eligible chat. It preserves manual memory,
user-confirmed memory, and memory whose confirmation source is `explicit_user_action`.

## Rollback

Close MemoryBridge and copy the vault first. Restore the desired backup if necessary. For an index
repair, delete only `indexes/memorybridge.sqlite*`; reopening reconstructs it from authoritative
files. Never delete transcripts or metadata to repair a derived index.
