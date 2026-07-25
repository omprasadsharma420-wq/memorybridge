# Data model

All identifiers are immutable prefixed UUIDs. Zod schemas in `src/shared/schemas.ts` are authoritative.

## Vault layout

```text
memorybridge.vault.json
.memorybridge.lock.json                 # runtime only
projects/<project-id>--<slug>/
chats/<chat-id>--<readable-slug>/
  metadata.json
  transcript.jsonl
  memories.json
  extractions.jsonl
evidence/<memory-id>.jsonl
topics/<chat-id>.json
provider-memories/<provider-memory-id>.json
processing/<chat-id>.json                # resumable segment checkpoint
import-inbox/ imported/ failed-imports/ import-records/
connector-state/ attachments/ prompts/ migrations/ backups/ logs/
indexes/memorybridge.sqlite
```

Chat folders are ID-stable and safely renamed once the title becomes useful. Project memory files are optional summary projections.

## Canonical conversation and message

A conversation records source provider/conversation ID, current/original title, primary project, workspace, models, timestamps, branch/attachment/citation counts, sync/processing states, import origin, content hash, and bounded raw metadata.

A message records the immutable MemoryBridge ID, provider message/parent/branch IDs, role, plain text, structured content blocks, status, model/provider, timestamps/sequence, attachments, tool events, citations, bounded metadata, content hash, and retrieval provenance. Transcript records are either a complete message or a linear `message_patch` delta. Only `complete` is authoritative by default.

## Memory, scope, and evidence

Memory types include decisions, agreements, completed items, facts, preferences, instructions, commitments, open questions, project state, rejected options, corrections, constraints, deadlines, people, organizations, artifacts, and unresolved conflicts.

States include candidate, active, confirmed, completed, needs review, superseded, rejected, disputed, and deleted. Confirmation source is one of none, explicit user action, deterministic user acceptance, or imported provider memory.

Scope is a discriminated union:

- global — usable only when confirmed by a legitimate user confirmation source;
- project — one exact project ID;
- conversation — one exact chat ID.

`MemoryEvidence` is first-class: evidence ID, memory ID, chat ID, message ID, segment ID, provider, evidence role, exact bounded excerpt, offsets, availability, and time. Roles distinguish support, confirmation, contradiction, supersession, and completion. A memory can therefore cite multiple messages across multiple chats; a missing indexed source is reported without discarding the retained citation.

Temporal fields record validity bounds and precision. Embedding fields record missing/current/stale/failed state plus the statement hash used for the vector.

## Derived index

SQLite contains projects, canonical chats/messages, memories, explicit and co-occurrence entity relationships, evidence, classified topics, import records, connector state, provider memories and their FTS index, temporal entries, embeddings, migrations, vault identity, and Unicode61 FTS tables. It uses DELETE journaling, FULL synchronous mode, foreign keys, a five-second busy timeout, and query-only mode in MCP. It is disposable and rebuildable.
