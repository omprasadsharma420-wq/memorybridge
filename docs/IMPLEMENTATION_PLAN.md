# MemoryBridge implementation plan

## Product interpretation

MemoryBridge is a Windows-first, local-first desktop chat workspace. It owns the messages created in the application, saves the user message before any provider call, streams and checkpoints the assistant reply, derives evidence-backed memories, and retrieves only relevant cited context for later turns. A user-selected vault is the source of truth; SQLite and all other derived artifacts are rebuildable. The MVP neither scrapes consumer chat products nor requires a MemoryBridge cloud service.

The existing workspace contains unrelated software, so this repository is intentionally isolated in the `memorybridge/` directory.

## Chosen stack

- Electron 43 with electron-vite 5 for the Windows desktop runtime and packaging entry points.
- React 19 and TypeScript for the renderer.
- Node services in the Electron main process for vault, transcript, provider, memory, and retrieval operations.
- Node 24's built-in `node:sqlite` with FTS5, rollback journaling, busy timeouts, and explicit transactions for a portable derived index without native add-on rebuilds.
- Zod for persisted-data and IPC validation.
- Electron `safeStorage` for an encrypted API-key blob outside the vault.
- Vitest for unit and integration tests; Playwright for one packaged-app critical-path UI test.
- ESLint, Prettier, electron-builder, and GitHub Actions.

## Major modules

1. **Shared contracts** — schemas, IPC channel types, IDs, titles, filenames, and lifecycle rules.
2. **Vault** — create/open/reconnect, immutable manifest identity, filesystem checks, free-space reporting, and safe paths.
3. **Storage** — append-only JSONL transcript events, atomic JSON files, project/chat metadata, recovery, migrations, and SQLite indexing.
4. **Providers** — deterministic mock provider and configurable OpenAI-compatible streaming/structured-output/embedding provider.
5. **Memory engine** — validated extraction, deterministic mock extraction, provenance checks, duplicate control, supersession, completion resolution, and review actions.
6. **Retrieval** — FTS5 search, optional embeddings, hybrid ranking, filtering, citation payloads, and context budgeting.
7. **Desktop UI** — first-launch vault flow, project/chat navigation, streaming chat, memory/search panels, citations, and transparent settings.
8. **Security and diagnostics** — narrow validated IPC, renderer isolation, CSP, safe navigation, redacted structured logs, and content-free diagnostic export.

## Ordered stages

1. Bootstrap repository, desktop shell, tooling, and persistent documentation.
2. Implement schemas, safe file utilities, vault lifecycle, and metadata storage.
3. Implement transcripts, SQLite migrations/FTS, rebuild, and recovery.
4. Implement providers and the persist-before-provider chat orchestration.
5. Implement extraction, reconciliation, review operations, and fixtures.
6. Implement hybrid retrieval, context injection, citations, and optional semantic vectors.
7. Complete secure IPC/preload/UI and disconnected/interrupted behavior.
8. Add unit, integration, and UI tests; run lint, type checking, tests, build, and packaging.
9. Audit requirements, secrets, generated files, documentation, Git history, and private GitHub delivery.

## Testing strategy

- Unit tests cover deterministic helpers, schemas, state transitions, path safety, transcript replay/recovery, reconciliation, ranking, filtering, and redaction.
- Integration tests use temporary vaults and deterministic providers for complete chat/extraction/supersession/disconnect/interruption flows.
- A Playwright Electron test exercises the user-visible vault-to-citation path when the host can launch Electron.
- Packaging and CI validate reproducible installation and Windows output without real credentials.

## Risk management

- **Removable media:** critical content is flushed before network use; SQLite uses conservative rollback journaling and can be discarded/rebuilt.
- **SQLite packaging:** Electron 43's bundled Node 24 runtime supplies `node:sqlite`, avoiding external native add-ons and toolchain drift.
- **Provider variance:** OpenAI-compatible requests are isolated behind an interface and all core behavior remains demonstrable in mock mode.
- **Model errors:** structured output is schema-checked and rejected unless every source ID exists.
- **Secrets/content leakage:** credentials live outside the vault as OS-encrypted data; logs and diagnostics contain identifiers and error categories, never transcripts.
- **Interrupted work:** assistant checkpoints are append-only events; replay converts abandoned streaming messages to interrupted state.

## Definition of done

The MVP is done when every practical acceptance criterion in the source specification has direct implementation evidence, core tests pass, type checking/lint/build pass, Windows packaging is configured and validated, documentation matches behavior, the repository has no secrets, and the verified work is committed and pushed privately when access allows.
