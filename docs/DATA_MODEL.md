# Data model

## Vault structure

```text
MemoryBridge-Vault/
├── memorybridge.vault.json
├── projects/
│   └── project_<immutable-id>--<initial-slug>/
│       ├── project.json
│       └── project-memory.json
├── chats/
│   └── chat_<immutable-id>--<initial-slug>/
│       ├── metadata.json
│       ├── transcript.jsonl
│       ├── memories.json
│       └── extractions.jsonl
├── attachments/
├── indexes/memorybridge.sqlite
├── prompts/
├── migrations/
├── backups/
└── logs/
```

Chats live in one stable physical collection rather than moving between project folders. `metadata.json.project_id` expresses assignment, so project moves require one atomic metadata update and cannot break a source citation. Display title changes never rename the physical chat directory. The initial slug is human-readable but identity always comes from immutable IDs.

## Vault manifest

`memorybridge.vault.json` contains `vault_id`, `schema_version`, `created_at`, `application`, and `application_version`. The app opens/reconnects a vault by validating this manifest, not by trusting a drive letter or remembered path alone.

## Transcript schema and replay

Each JSONL line is a complete validated message snapshot:

```json
{
  "message_id": "msg_<uuid>",
  "chat_id": "chat_<uuid>",
  "role": "assistant",
  "content": "A checkpoint or complete response",
  "created_at": "ISO-8601",
  "updated_at": "ISO-8601",
  "provider": "mock",
  "model": "model-id",
  "status": "streaming",
  "sequence": 1,
  "retrieved_memory_ids": []
}
```

Allowed states are `pending`, `streaming`, `complete`, `interrupted`, `failed`, and `cancelled`. Streaming appends periodic snapshots with the same message ID. Replay selects the last valid snapshot for each ID and orders by sequence. On startup, abandoned `pending`/`streaming` messages receive an appended `interrupted` snapshot. Malformed lines are retained and skipped for projection rather than modifying the authoritative file.

## Project and chat metadata

Projects have an immutable ID, name, optional description, stable initial slug, and timestamps. Chats have an immutable ID, nullable project ID, editable title, stable initial slug, and timestamps. The deterministic first-message title is display metadata only.

## Memory schema

A memory separates taxonomy (`type`) from lifecycle (`state`) and includes:

- immutable memory/project/chat IDs;
- durable statement and confidence;
- one or more exact source message IDs;
- created, updated, and effective timestamps;
- `supersedes` and `superseded_by` links;
- entities and tags;
- user-confirmed and pinned flags.

Types are `decision`, `agreement`, `completed_item`, `fact`, `preference`, `instruction`, `commitment`, `open_question`, `project_state`, and `rejected_option`. States are `candidate`, `active`, `confirmed`, `completed`, `superseded`, `rejected`, `disputed`, and `deleted`. Delete is a lifecycle tombstone so provenance/history is not silently destroyed.

## SQLite projection

The rebuildable index contains `vault_metadata`, `projects`, `chats`, `messages`, `memories`, `memory_relationships`, `extraction_runs`, `embeddings`, `index_versions`, and `migration_state`, plus `chats_fts`, `messages_fts`, and `memories_fts` FTS5 tables. Vectors are JSON numeric arrays keyed by memory/model and cosine-ranked in application code.

SQLite uses `journal_mode=DELETE`, `synchronous=FULL`, foreign keys, a 5-second busy timeout, and short `BEGIN IMMEDIATE` transactions. This prioritizes removable-drive predictability over WAL throughput.

## Migration strategy

The current file and index schema version is 1. Index migrations are recorded in `migration_state`; derived indexes can be cleared and rebuilt. Future authoritative schema changes must add backwards-compatible parsing or a numbered, tested vault migration that preserves originals and records completion in the vault `migrations/` area. Never reinterpret or destructively rewrite a transcript without an explicit migration.
