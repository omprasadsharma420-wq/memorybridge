# MemoryBridge repository instructions

## Purpose and operating model

MemoryBridge is a Windows-first, local-first AI chat workspace and project-aware external memory system. It stores only conversations created through this app; it does not scrape or copy consumer ChatGPT/Claude interfaces. The user-selected vault is authoritative. A user message must be durably persisted before a provider is called; assistant output is checkpointed while streaming; completed turns may produce evidence-backed memories and cited retrieval context.

## Architecture and layout

- `src/main/`: Electron lifecycle, narrow IPC, vault/storage/provider/memory/retrieval services.
- `src/preload/`: frozen renderer bridge; no raw filesystem or unrestricted IPC.
- `src/renderer/`: React UI and styles.
- `src/shared/`: validated contracts, schemas, deterministic utilities, and brand configuration.
- `tests/unit/`, `tests/integration/`, `tests/ui/`, `tests/fixtures/`: test suites and explicit extraction cases.
- `docs/`: architecture, decisions, data model, privacy, memory engine, status, and publishing guidance.

## Conventions

- TypeScript is strict. Prefer small domain modules, explicit result types, and Zod validation at persistence/network/IPC boundaries.
- Immutable IDs, not display names or paths, are identity. Sanitize every filesystem slug and resolve every content path beneath the connected vault root.
- Use append-only transcript snapshots and atomic same-directory replacement for JSON metadata. Never destructively rewrite raw transcript history.
- Persist and flush the user message before provider invocation. Preserve partial assistant content with an explicit terminal state.
- SQLite is a disposable index. Schema changes require a numbered migration and rebuild compatibility.
- Transcript format changes must be backwards-compatible or include an explicit migration and fixture.
- Every stored extracted memory must cite existing source message IDs. Never silently overwrite a user-confirmed memory.
- Storage, retrieval, extraction, or schema changes require focused unit tests and affected integration-flow tests.
- Do not hide errors with broad catches; translate expected boundary failures into typed domain errors and log only safe metadata.

## Data protection

- Never log transcript text, prompt/response bodies, complete memories, credentials, authorization headers, or personal file content.
- Never store an API key in the vault, source tree, `.env` committed to Git, diagnostics, or renderer state after saving.
- Credentials use Electron `safeStorage` outside the vault. Redact secret-like values from errors.
- Never silently fall back to another location if a vault is disconnected. Disable content writes/provider calls until reconnection.
- Derived AI operations send only the text needed for that enabled operation; mock mode must require no network or credentials.

## Storage compatibility

- Assume vaults may be on NTFS or exFAT removable media and drive letters may change.
- Identify vaults by manifest ID. Use conservative SQLite rollback journaling, full synchronization, busy timeouts, short transactions, and rebuild from authoritative files.
- Critical transcript writes must flush before network calls. Physical chat directories remain stable when display titles change.

## Commands

- Install: `npm ci`
- Development: `npm run dev`
- Lint: `npm run lint`
- Type check: `npm run typecheck`
- Unit tests: `npm run test:unit`
- Integration tests: `npm run test:integration`
- All non-UI tests: `npm test`
- UI test: `npm run test:ui`
- Production build: `npm run build`
- Windows package: `npm run package:win`

Run lint, type checking, unit/integration tests, and production build before committing. Run UI and Windows package validation whenever the host supports them. Do not weaken or skip tests to make verification green.
