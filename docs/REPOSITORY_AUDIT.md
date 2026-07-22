# Repository audit

Audit date: 2026-07-22. Branch: `codex/memorybridge-production-pivot`.

## Baseline verification

Before application code changed, the worktree was clean and the following passed on `main`: dependency installation, zero-vulnerability audit, formatting, lint, TypeScript, 25 unit tests, 5 integration tests, production build, Playwright critical-path test, and unsigned Windows NSIS packaging.

## Preserved strengths

- Strict TypeScript and Zod validation at persistence and IPC boundaries.
- Raw JSONL transcripts as authoritative data and SQLite as a rebuildable index.
- Atomic JSON writes, backup reads, path-containment checks, encrypted credential storage, redacted logs, sandboxed renderer, and no telemetry.
- Recoverable interrupted streams, mock-provider offline mode, cited retrieval, and user memory controls.
- Existing MVP chat, project assignment, search, settings, diagnostics, CI, UI test, and packaging flows.

## Critical findings repaired

| Finding                   | Pre-change behavior                                                                  | Repair                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unassigned memory leakage | A null project query selected every project's active memories.                       | One shared global/project/conversation scope policy now gates extraction, relationships, retrieval, search, MCP, and UI actions.                        |
| Model trust               | Relationship and confirmation fields from structured output were applied directly.   | References, status, scope, user-source evidence, completion, negation, and uncertainty are validated; provider output cannot confirm memory.            |
| Evidence model            | A memory had one chat ID plus message IDs.                                           | First-class evidence records support exact excerpts from multiple messages and conversations.                                                           |
| Search normalization      | Comparison stripped all non-ASCII characters.                                        | Unicode-aware normalization, Latin accent folding, Unicode61 FTS, and Nepali/mixed/product-code tests.                                                  |
| Startup cost              | Every open cleared and rebuilt the complete index and scanned every transcript.      | Index schema/vault identity determines rebuild need; normal startup is incremental and only indexed nonterminal messages are recovered.                 |
| Stream growth             | Each checkpoint appended the full accumulated answer.                                | Initial message plus delta patches produces linear transcript growth.                                                                                   |
| Memory writes             | Every extraction rewrote every chat's memory file and every project projection.      | Only changed chats and affected project projections are written.                                                                                        |
| Vault ownership           | Multiple writable instances could open one vault.                                    | App single-instance lock plus vault lock, heartbeat, stale recovery, read-only conflict state, and release behavior.                                    |
| Connector/MCP gaps        | Native chat was the only ingestion path; MCP was deferred.                           | Canonical import pipeline, ChatGPT ZIP and generic imports, watched inbox, provider-memory review, and ten bounded stdio MCP tools.                     |
| Provider assumptions      | One interface implied structured output, embeddings, models, and SSE were universal. | Conservative capability discovery and fake HTTP contract coverage for stream, errors, retries, cancellation, structured output, embeddings, and models. |
| Stale UI                  | Key state and extraction results could remain stale.                                 | Bootstrap/key refresh, post-processing memory refresh, progress events, richer metadata, evidence navigation, and import statuses.                      |

## Remaining non-blocking boundaries

- No provider account scraping, browser automation, or undocumented consumer API access exists.
- `openai-compatible` capabilities are discovered conservatively; endpoint branding does not imply feature support.
- Provider memories stay separate until reviewed.
- Attachment payload copying is represented in canonical metadata but rich attachment extraction/preview is future work.
- Live provider sync is not claimed; export import and watched-folder ingestion are the supported connector modes.
