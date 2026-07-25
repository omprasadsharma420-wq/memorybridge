# Migration and recovery plan

## Versions

- Vault manifest v1: original MVP layout.
- Vault manifest v2: production-pivot directories and semantics.
- Derived SQLite schema v6: canonical metadata, explicit scopes, evidence, topics, imports, connector state, provider memories, temporal index, and embedding lifecycle.

Opening v1 creates a timestamped manifest backup in `backups` before writing v2. Directory creation and additive SQLite column/table migrations are idempotent. A derived-schema upgrade marks content for one rebuild from authoritative files; normal later opens do not rebuild.

## Recovery

- Invalid SQLite files and sidecars are moved to timestamped `backups` and rebuilt.
- Atomic JSON writes keep `.bak` recovery copies where replacement semantics require them.
- Malformed JSONL lines are isolated and reported rather than making the complete stream unreadable.
- Pending/streaming messages are recovered from indexed nonterminal rows only and receive an `interrupted` delta record.
- Stale vault locks are recoverable after heartbeat timeout or a dead same-machine PID; live conflicts open read-only.
- Imported files are never the only authoritative copy: successful canonical content is committed before the inbox source moves.

## Rollback

Close MemoryBridge, copy the vault, restore the desired manifest backup if necessary, and delete only the derived `indexes/memorybridge.sqlite*` files. Reopening rebuilds the index from projects, chat metadata, transcripts, memory files, evidence, topics, import records, and provider-memory files. Never delete raw transcript or metadata files as an index repair step.

Tests cover v1 migration backup, corrupt-index parking/rebuild, malformed JSONL recovery, lock conflict/release, disconnect/reconnect, and incremental startup.
