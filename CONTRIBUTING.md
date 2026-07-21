# Contributing

## Setup

Install Node.js 24 and npm 11, then run:

```powershell
npm ci
npm run dev
```

Use mock mode and a disposable vault for development. Never test with production credentials or personal transcripts.

## Code conventions

- Use strict TypeScript and Zod at IPC, provider, and persistence boundaries.
- Keep renderer, preload, main-process, and shared responsibilities separate.
- Prefer immutable IDs and typed domain errors. Never use a title, slug, or drive letter as identity.
- Keep raw transcripts append-only and derived indexes rebuildable.
- Do not log or fixture real transcript content, complete memories, credentials, or private files.
- A stored memory must cite existing source message IDs.
- Schema changes require a numbered migration and documentation update.
- Transcript changes must remain backwards-compatible or ship an explicit tested migration.

## Test expectations

Storage, retrieval, extraction, reconciliation, security, or schema changes need focused unit tests and every affected integration flow. UI behavior on the critical vault/chat/memory/search path needs Playwright coverage where practical.

Before a commit, run:

```powershell
npm run lint
npm run typecheck
npm test
npm run test:ui
npm run build
```

Run `npm run package:win` for release-related changes.

## Commits

Use small, imperative commits that describe a cohesive behavior (for example, `Add append-only transcript recovery`). Never bypass tests, commit generated vaults/build output, or include secrets. Update `docs/STATUS.md` with material verification or limitation changes.
