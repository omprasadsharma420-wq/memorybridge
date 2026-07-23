# Status

Updated 2026-07-23.

## Shipped on the production-pivot branch

- Existing native-chat MVP preserved.
- Vault v2, derived index v6, registered-vault identity, migration backup, lock/heartbeat, read-only conflict, single instance, incremental startup, linear streaming, incremental transcript access, and affected-only memory writes.
- Canonical conversation/message metadata and connector capability registry.
- ChatGPT ZIP and generic file imports, preview, malformed handling, archive/conversation/message hashes, changed-only re-import, watched inbox, records, and provider-memory review.
- Deterministic topics, conservative project classification, and persistent segment/chat/project/vault reprocessing with progress, cancellation, resume, and failed-segment retry.
- Expanded memory taxonomy, explicit scope, role-labelled first-class multi-chat evidence with safe missing-source handling, trusted confirmation sources, relationship validation, temporal/entity indexes, and embedding invalidation/regeneration.
- Unicode/diacritic FTS5 and hybrid retrieval with strict scope, lifecycle eligibility, evidence quality, and separate context budgets.
- Separate provider-memory review actions/search and conservative provider capabilities with local fake-server contract tests, including non-stream fallback and unsupported capabilities.
- Ten-tool local stdio MCP server and configuration UI.
- Product navigation and UI refresh/error/source/filter repairs.

## Verification at handoff

The 2026-07-23 local release gate passed: Prettier, ESLint, TypeScript, 61 unit/integration tests across 15 files, production build, one Electron Playwright critical-path test, npm audit with zero vulnerabilities, and Windows x64 NSIS packaging. The generated installer was `MemoryBridge-0.2.0-x64-Setup.exe` (102,077,714 bytes; SHA-256 `223811187E1D4312157E5CF1D78DD126CFB07332EDE62BEC776D08A1AE724B29`) and remains excluded from Git.

The suite includes original core flows plus project isolation, unassigned isolation, confirmed-global behavior, cross-project relationship rejection, same-chat and multi-chat evidence, missing-source safety, Unicode/Nepali/mixed/diacritic/product-code retrieval, 200-chat/2,000-message startup and search, linear stream storage, incremental import/startup, resumable extraction, provider-memory actions, migrations/locks, real MCP protocol validation, and provider HTTP contracts. Hosted CI status is reported from the pull request rather than hard-coded here.

## Explicitly not claimed

Provider website scraping, undocumented consumer APIs, live provider API sync, automatic provider-memory promotion, rich attachment-body extraction, signed installers, or cloud sync.
