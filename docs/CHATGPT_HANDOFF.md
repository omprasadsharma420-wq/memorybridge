# ChatGPT work handoff

This repository is ready to be opened by ChatGPT/Codex as a complete local project. Start with `README.md`, `AGENTS.md`, `docs/REPOSITORY_AUDIT.md`, and `docs/PRODUCTION_PIVOT_PLAN.md`.

## Repository

- Product: MemoryBridge local-first universal AI memory layer.
- Primary branch for this work: `codex/memorybridge-production-pivot`.
- Runtime: Electron, React, TypeScript, Zod, Node SQLite, fflate, MCP TypeScript SDK.
- Raw vault data is authoritative; SQLite/FTS and embeddings are rebuildable.

## Useful commands

```powershell
npm ci
npm run dev
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:ui
npm audit --audit-level=high
npm run package:win
```

Use generated fixtures only. Never request or commit a real ChatGPT export or API key. Mock mode is sufficient for core development.

## Architecture invariants

1. Complete messages only are authoritative by default.
2. Unassigned never means every project or every unassigned chat.
3. All-project retrieval is explicit.
4. A model cannot confirm memory or create unchecked relationships.
5. Every durable memory has exact evidence and scope.
6. Provider memories remain separate for review.
7. Transcript/import files are authoritative; indexes are disposable.
8. Streaming storage must stay linear and normal startup incremental.
9. Connector and provider capabilities are never inferred from branding.
10. MCP stays local, bounded, cited, scoped, and filesystem-blind.

## Review focus

Run the full release gate, inspect migrations against a copied synthetic v1 vault, exercise import preview/re-import/inbox UI, validate the MCP config in a compatible host, and review the PR for any accidental broad scope or real-user data. See `docs/MIGRATION_PLAN.md`, `docs/INGESTION_PIPELINE.md`, and `docs/MCP.md`.
