# ChatGPT work handoff

This repository is a complete MemoryBridge 0.2.1 MVP-test project. Start with `README.md`,
`AGENTS.md`, `docs/MVP_STABILIZATION_PLAN.md`, `docs/REQUIREMENTS_MATRIX.md`, and
`docs/USER_TEST_GUIDE.md`.

## Repository

- Product: MemoryBridge local-first universal AI memory layer.
- Current review branch: `codex/memorybridge-mvp-stabilization`.
- Base: `main`, after the production-pivot implementation was merged.
- Runtime: Electron, React, TypeScript, Zod, Node SQLite, fflate, MCP TypeScript SDK.
- Raw vault files are authoritative; SQLite/FTS and embeddings are rebuildable.
- Review/publish the current branch. PR #2 is historical and already merged.

## Useful commands

```powershell
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run test:ui
npm run benchmark:large
npm run mcp:smoke -- --self-test
npm audit --audit-level=high
npm run package:win
```

Use generated fixtures only. Never request or commit a real ChatGPT export, vault, or API key.

## Architecture invariants

1. Complete user messages are authoritative claims; assistant suggestions do not become accepted
   user memory by themselves.
2. Unassigned never means every project; cross-project retrieval is explicit.
3. Every durable memory has explicit lifecycle/scope and separate exact evidence.
4. Provider memory remains separately reviewable until a user resolves its MemoryBridge scope and
   authority.
5. Transcript/import files are authoritative; derived indexes are disposable.
6. Streaming storage and full import are bounded; normal startup remains incremental.
7. Imported tree branches must be coherent and never silently flattened together.
8. Connector/provider capabilities are independent and never inferred from branding.
9. Locked/missing vaults never redirect writes to app storage.
10. MCP remains local, query-only, bounded, cited, lifecycle-safe, scope-safe, and
    filesystem-blind.

## Review focus

Review the migration and ZIP bounds, adversarial MCP scopes, provider capability contracts,
external-drive recovery, exact evidence navigation, benchmark measurements, dependency overrides,
and final GitHub Actions result. Local evidence is in `docs/SMOKE_TEST_RESULTS.md` and
`docs/PERFORMANCE_RESULTS.md`; unsupported claims are in `docs/KNOWN_LIMITATIONS.md`.
