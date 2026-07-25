# Production pivot plan

This is the execution record for the repository pivot requested on 2026-07-22.

## Completed

1. Audited and verified the original MVP before changes.
2. Added versioned vault/index migrations, backups, vault registry identity, lock/heartbeat, stale recovery, read-only conflict mode, and app single-instance behavior.
3. Removed normal-startup full rebuilds; added delta transcript patches, range access, affected-only memory projection writes, and embedding invalidation.
4. Added canonical provider/conversation/message metadata and an explicit connector capability registry.
5. Added ChatGPT ZIP, JSON, JSONL, Markdown, text, preview/confirm, archive dedupe, changed-only re-import, watched inbox, import records, and provider-memory records.
6. Added topic segmentation, full-chat incremental reprocessing, progress/cancel support, expanded memory taxonomy, explicit scope, evidence, temporal fields, and relationship validation.
7. Added Unicode hybrid retrieval, complete-message eligibility, lifecycle/evidence scoring, strict scope, filters, and context budgets.
8. Added a local stdio MCP server with ten bounded, cited tools and no filesystem-browsing surface.
9. Added conservative provider capabilities and fake-server contracts.
10. Reworked navigation and review UI for conversations, providers, projects, topics, memory, imports/sync, search, MCP, and vault settings.
11. Expanded automated coverage and updated operating, privacy, security, migration, and handoff documentation.
12. Added conservative project classification, persistent per-segment checkpoints, segment/chat/project/vault reprocessing, provider-memory review actions, provider-memory FTS, evidence roles and missing-source safety, entity co-occurrence indexing, and exact embedded MCP evidence.
13. Verified a representative 200-chat/2,000-message vault, resumable failed-segment extraction, partial import recovery, real in-memory MCP transport, and the expanded local provider contract matrix.

## Release gate

The release gate is: format check, lint, typecheck, unit/integration tests, production build, Playwright UI test, zero-vulnerability audit, Windows NSIS package, then GitHub push/PR and hosted CI verification.

## Follow-on candidates

These are extensions, not falsely claimed shipped features: provider-specific live APIs where officially supported, rich attachment parsing, background worker isolation for very large archives, signed releases, and opt-in semantic models beyond configured provider embeddings.
