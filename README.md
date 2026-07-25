# MemoryBridge

MemoryBridge is a Windows-first, local-first universal AI memory layer. It ingests native and exported conversations into a user-controlled vault, reconciles durable memory with exact evidence, and exposes bounded cited retrieval to the desktop chat and local MCP clients.

## What ships

- Native streaming chat with mock/offline mode and an OpenAI-compatible provider adapter.
- Internal or external manifest-identified vaults, registered-vault reconnect, ownership lock/heartbeat, stale recovery, and read-only conflict handling.
- Canonical provider/conversation/message metadata with authoritative JSONL transcripts and rebuildable SQLite/FTS5 indexes.
- ChatGPT ZIP and generic JSON/JSONL/Markdown/text import, preview, dedupe, changed-only re-import, watched inbox, branches, and provider-memory review.
- Deterministic topic segmentation, conservative project classification, and resumable segment/chat/project/vault reprocessing with checkpoints, retry, cancellation, and progress.
- Evidence-backed memory with global/project/conversation scope, lifecycle, corrections, constraints, deadlines, people, organizations, artifacts, conflicts, temporal metadata, and embedding invalidation.
- Unicode hybrid retrieval with complete-message eligibility, project isolation, context budgets, filters, and exact citations.
- Local stdio MCP server with ten bounded retrieval tools and no filesystem-browsing surface.
- Providers, projects, topics, memory and provider-memory review, imports/sync, source-filtered search, MCP, and vault-management UI.

MemoryBridge does not scrape provider websites or use undocumented consumer APIs. Capability labels are explicit; live provider sync is not claimed.

## Develop

Requirements: Windows 10/11, Node.js 22.12+, and npm.

```powershell
npm ci
npm run dev
```

Mock mode is the default and needs no key. For a real endpoint, use Vault settings, choose `OpenAI-compatible`, configure the base URL/models, save the key through Windows secure storage, and test the connection. Structured output, embeddings, and model listing are discovered rather than assumed.

## Verify and package

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:ui
npm audit --audit-level=high
npm run package:win
```

The unsigned NSIS installer is written to `release/`. CI runs the same core checks and uploads the installer artifact.

## Import and MCP

Use **Imports & sync** to preview and import a supported file, or place it in the vault's `import-inbox` and scan. Partial imports retain per-conversation checkpoints. Provider-memory records remain separate until the user confirms, edits, rejects, deletes, or supersedes them.

Use **MCP & integrations** to copy the local stdio configuration. See [ingestion](docs/INGESTION_PIPELINE.md), [connectors](docs/CONNECTOR_ARCHITECTURE.md), and [MCP](docs/MCP.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Data model](docs/DATA_MODEL.md)
- [Memory engine](docs/MEMORY_ENGINE.md)
- [Migration and recovery](docs/MIGRATION_PLAN.md)
- [Privacy](docs/PRIVACY.md) and [security](SECURITY.md)
- [Repository audit](docs/REPOSITORY_AUDIT.md) and [production pivot plan](docs/PRODUCTION_PIVOT_PLAN.md)
- [Status](docs/STATUS.md) and [ChatGPT handoff](docs/CHATGPT_HANDOFF.md)
- [Requirements verification matrix](docs/REQUIREMENTS_MATRIX.md)
