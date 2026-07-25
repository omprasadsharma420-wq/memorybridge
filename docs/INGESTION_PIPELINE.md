# Ingestion pipeline

```text
user-selected file / vault import-inbox / native chat
  -> connector detection and bounded parsing
  -> preview (counts, warnings, provider-memory count)
  -> canonical conversation + message validation
  -> archive/conversation/message hash comparison
  -> authoritative vault transcript and metadata write
  -> incremental SQLite/FTS update
  -> optional topic processing and memory extraction
  -> cited retrieval and MCP
```

## Supported inputs

- ChatGPT ZIP exports with `conversations.json`, multiple conversations, provider IDs, timestamps, message order, parent/branch data, model metadata, attachment/citation metadata, and optional `memories.json`.
- Generic JSON conversation arrays or common `{title, messages}` records.
- JSONL message or conversation records.
- Markdown and text as one source conversation.

Archives are capped at 512 MB, individual decompressed ZIP entries at 100 MB, entries at 50,000, and retained unknown metadata at 8 KB per selected field. Malformed conversations are skipped with preview warnings; malformed archives fail with safe categories. Tests use only generated synthetic fixtures.

## Inbox and re-import

Place supported files in `import-inbox`. A scan moves successful files to `imported` and failures to `failed-imports`; structured results live in `import-records`. Import records retain completed and failed conversation indexes, bounded warnings/errors, and review counts. Retrying the same partial archive skips completed conversations and retries failed ones. Exact completed archive hashes return `unchanged`. Changed archives match conversations and messages by provider ID and update only changed records. Raw transcript files remain authoritative; all indexes are rebuildable.

Imported provider memories and instructions retain provider record ID, source type, source label/reference, provider update time, scope, and content hash. They enter `needs_review` and are searchable as a separate source. Confirmation, edit, rejection, deletion, and same-scope supersession are explicit user actions; no provider record is silently promoted to trusted native memory.
