# Status

Updated 2026-07-25 for MemoryBridge 0.2.1 internal testing.

## Current MVP

- Non-technical first-run setup for a user-selected internal or external vault, offline/API/demo
  processing choice, first import, and review summary.
- Manifest v2 vaults, registered identity, automatic missing-drive recovery, an ownership-token
  heartbeat, honest locked-instance state, and no fallback transcript storage.
- Asynchronous capacity inventory with device/free/vault/category sizes, counts, cancellation,
  caching/refresh, symlink containment, and a small write/remove verification.
- Streaming ChatGPT ZIP parsing with compressed/per-entry/cumulative/count/ratio bounds, traversal
  rejection, cancellation, progress, coherent active-branch reconstruction, separately reviewable
  unresolved branches, stable IDs, incremental re-import, and visible post-import validation.
- Real legacy-memory provenance migration with pre-change backups, evidence conversion, source
  validation, explicit scope, confirmation/history preservation, review fallback, an idempotent
  report, and a forced derived-index refresh when migration runs.
- Separate resume, forced-chat, project, and vault-derived rebuild semantics. Rebuild preserves
  manual and explicitly confirmed memory.
- Evidence-backed memory, multi-chat sources, Unicode/Nepali retrieval, complete search filters,
  exact source navigation, source-aware provider-memory review, and independent provider
  capability probes.
- Ten-tool local stdio MCP with current-truth defaults, historical/review/disputed opt-ins, strict
  direct-ID scope, bounded evidence, query-only SQLite, and a self-contained smoke command.
- Derived SQLite schema v8 with transactional bulk FTS rebuilds. Normal startup remains
  incremental and does not rebuild a healthy index.

## Local verification

The final release gate is recorded in [smoke test results](SMOKE_TEST_RESULTS.md) and
[performance results](PERFORMANCE_RESULTS.md). The current measured checks include 69
unit/integration tests across 17 files, one Electron end-to-end workflow, the 1,000-conversation
benchmark, production build, packaged-app workflow, zero-vulnerability npm audit, and Windows x64
NSIS packaging.

The final unsigned installer is `MemoryBridge-0.2.1-x64-Setup.exe`, 110,286,365 bytes
(105.18 MiB), with SHA-256
`F2B499CD6BE9C0F0AE6DA5921DAB0070AE7AD896E5BC04E549AF7B0A2B4280B1`. The same checksum is
published beside the installer in `SHA256SUMS.txt`.

## Explicitly not claimed

Provider website scraping, undocumented consumer APIs, silent/live ChatGPT sidebar sync, live
Claude/Gemini sync, automatic provider-memory trust, rich attachment-body extraction, cloud
accounts/sync, collaboration, mobile apps, public MCP hosting, code signing, or production
readiness. See [known limitations](KNOWN_LIMITATIONS.md).
