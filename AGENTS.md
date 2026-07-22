# MemoryBridge agent guide

## Product contract

MemoryBridge is a local-first universal AI memory layer. Native chat is one ingestion source, not the product boundary. Preserve canonical ingestion, trustworthy reconciliation, hybrid cited retrieval, provider-memory review, and local MCP.

## Non-negotiable invariants

- Strict TypeScript and Zod at external, IPC, provider, import, and persistence boundaries.
- Raw transcripts and canonical vault files are authoritative. SQLite/FTS, projections, and embeddings are rebuildable.
- Only complete messages are authoritative by default.
- Scope is explicit global/project/conversation. Project context may use that project, confirmed global, and optionally current conversation. Unassigned may use confirmed global and the same conversation only. All-project access must be explicit.
- Models provide candidate hints, never confirmation or unchecked relationship authority. Validate source IDs, target existence/status/scope/type, negation, uncertainty, completion evidence, and confirmation source.
- Never relate or merge memories across projects. Edits and merges invalidate embeddings.
- Every durable memory retains exact evidence; multi-message and multi-chat evidence is supported.
- Normal startup is incremental. Streaming transcript growth must remain linear.
- Do not scrape provider websites, automate consumer sessions, use undocumented APIs, or overstate connector/provider capabilities.
- Provider memory remains separate and labeled until user review.
- MCP is local stdio, query-only, scoped, bounded, cited, and has no arbitrary filesystem/shell/SQL/credential surface.
- Keep secrets, real exports, vault content, paths, and conversation text out of logs, diagnostics, fixtures, Git, and public issues.

## Where to work

- Shared schemas/contracts: `src/shared`.
- Main orchestration and validated IPC: `src/main/app-service.ts`, `src/main/ipc.ts`.
- Storage/migrations/locks: `src/main/storage`.
- Ingestion/connectors: `src/main/ingestion`.
- Segmentation, extraction, scope, reconciliation: `src/main/memory`.
- Hybrid retrieval: `src/main/retrieval`.
- Provider adapters/capabilities: `src/main/providers`.
- MCP: `src/main/mcp` and `src/main/mcp-server.ts`.
- Renderer/preload: `src/renderer`, `src/preload`.

## Change discipline

Use synthetic fixtures. Add tests for scope, evidence, lifecycle, malformed inputs, Unicode, migration/recovery, incremental behavior, and provider/MCP contracts whenever those paths change. Avoid broad catches unless a documented optional feature degrades safely. Do not delete or rewrite raw content to repair a derived index.

Before every commit run:

```powershell
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
```

Before release or PR readiness also run:

```powershell
npm run test:ui
npm audit --audit-level=high
npm run package:win
```

Read the repository audit, migration plan, connector architecture, ingestion pipeline, MCP guide, privacy policy, and security policy before changing those subsystems.
