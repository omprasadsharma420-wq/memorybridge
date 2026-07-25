# Architecture

MemoryBridge is an Electron/React desktop app with privileged operations isolated in the main process.

```text
React renderer
  -> frozen typed preload API
  -> Zod-validated IPC
  -> AppService orchestration
     -> native chat + provider capabilities
     -> canonical ingestion connectors
     -> segmentation + memory reconciliation
     -> hybrid retrieval
     -> vault repository
        -> authoritative JSON/JSONL files
        -> rebuildable SQLite/FTS5 index

External AI client -> local stdio MCP server -> query-only SQLite index
```

## Trust boundaries

- Renderer: sandboxed, context-isolated, no Node integration, navigation blocked, permissions denied.
- Preload: only named typed operations; no generic filesystem or IPC passthrough.
- Main: validates every payload, owns dialogs, credentials, providers, imports, vault writes, and diagnostics.
- MCP: separate stdio entry, validated vault, query-only index, bounded tools, no arbitrary filesystem/SQL access.
- Provider/import input: untrusted until bounded parsing, Zod validation, scope validation, and evidence checks succeed.

## Storage lifecycle

The app requests an Electron single-instance lock. A writable vault also owns
`.memorybridge.lock.json` with vault ID, PID, machine, app version, acquisition time, ownership
token, and a serialized 15-second heartbeat. Live conflicts show a locked screen; no readable
repository is claimed. Heartbeat failure is contained and visible, shutdown stops/flushes the
heartbeat before removing only the matching owned lock, and stale locks recover conservatively.

Normal startup opens and migrates the index, validates its vault identity, and recovers indexed nonterminal messages. It rebuilds only for a new, corrupt, mismatched, or upgraded derived index. Raw transcripts, memories, evidence, topics, import records, and provider memories remain authoritative.

A performed v0.1 provenance migration also forces one derived rebuild. Full rebuilds insert raw
rows in one transaction and populate FTS tables in bulk; ordinary edits continue to update FTS
incrementally. A registered missing external vault stays visibly disconnected, and the poller
reopens it only when the manifest returns with the registered vault ID.

Capacity scanning uses metadata only, skips symbolic links, checks every candidate remains inside
the vault, yields periodically, supports cancellation, and caches only a completed snapshot until
refresh.

Streaming writes one complete initial message followed by content deltas/status patches. Reads replay the latest state. Memory writes touch only affected chat files and project projections.

## Processing and retrieval

Only complete messages are authoritative by default. Full-chat processing deterministically segments by size, time gap, and topic shift. Stable content hashes and disk checkpoints skip complete work and retry failed or cancelled segments. One segment, chat, project, or vault can be reprocessed with progress and cancellation. Unassigned segments use a conservative deterministic classifier and remain unassigned when project evidence is ambiguous. Extraction output is treated as a hint, then checked for source IDs, scope, target lifecycle, negation, uncertainty, completion evidence, and confirmation source.

Retrieval combines Unicode lexical match, optional semantic vectors, exact phrase, scope, entity signals, lifecycle, confirmation, pin, recency, type, and evidence quality. Separate budgets constrain recent chat, structured memory, transcript excerpts, extraction, segmentation, embeddings, and output.
