# ChatGPT project handoff

This is the single entry point for handing MemoryBridge to another ChatGPT or Codex task. The repository contains the complete application, its technical documentation, automated tests, Windows packaging configuration, and a deterministic mock provider. No API credential is required to inspect, build, or test the internal MVP.

## Repository

- GitHub: `https://github.com/omprasadsharma420-wq/memorybridge`
- Visibility: private
- Default branch: `main`
- Supported product target: Windows 10/11 x64
- Runtime for development and CI: Node.js 24.x and npm 11.x

The receiving ChatGPT session must have access to the repository through the owner's connected GitHub account. Do not paste a GitHub token, provider API key, password, or vault content into a chat. If the private repository cannot be opened, connect GitHub to that ChatGPT workspace or download the repository ZIP and attach it there.

## Instructions for the receiving ChatGPT task

1. Read `AGENTS.md` before changing files.
2. Read `README.md`, then the documents listed under **Technical source of truth** below.
3. Treat the current repository and tests as authoritative evidence; do not rely only on this summary.
4. Run the clean verification sequence before claiming the project works.
5. Use the deterministic mock provider for routine testing. It needs no network or credential.
6. Preserve the local-first guarantees: transcripts remain in the user-selected vault, SQLite remains rebuildable, and provider calls occur only after the user message is durably saved.
7. Never log, commit, or return credentials, transcript contents, memory statements, vault contents, or personal files.
8. If asked to change the implementation, update the affected tests and documentation, produce a Windows package, and verify the hosted CI result.

## Technical source of truth

Read these files rather than asking the project owner to translate software terminology:

- `README.md`: product overview, setup, commands, and limitations.
- `AGENTS.md`: persistent repository rules for AI and human contributors.
- `docs/IMPLEMENTATION_PLAN.md`: delivered phases and definition of done.
- `docs/ARCHITECTURE.md`: process boundaries, data flows, security, and failure handling.
- `docs/DECISIONS.md`: architecture decisions and rejected alternatives.
- `docs/DATA_MODEL.md`: vault layout, schemas, replay, SQLite projection, and migrations.
- `docs/MEMORY_ENGINE.md`: extraction, reconciliation, retrieval, and known limitations.
- `docs/PRIVACY.md`: local/cloud data boundaries, credentials, diagnostics, and deletion.
- `SECURITY.md`: threat model and vulnerability reporting.
- `CONTRIBUTING.md`: development and verification workflow.
- `docs/STATUS.md`: exact implementation and verification status.
- `docs/GITHUB_PUBLISHING.md`: private repository and hosted CI verification commands.

## Clean setup and verification

Run from the repository root in PowerShell:

```powershell
npm ci
npm audit --audit-level=high
npm run format:check
npm run lint
npm run typecheck
npm run test:unit
npm run test:integration
npm run build
npm run test:ui
npm run package:win
```

Expected test inventory at this handoff:

- 25 unit tests across 6 files.
- 5 integration flows covering vault/chat creation, extraction/search, supersession, drive disconnect, and interrupted-stream recovery.
- 1 Playwright Electron critical path covering project/chat creation, streamed mock response, memory extraction, filtered search, and exact source navigation.

`npm run package:win` produces `release/MemoryBridge-0.1.0-x64-Setup.exe`. Generated build output, installers, vaults, databases, logs, and credentials are intentionally Git-ignored.

## Run the application

```powershell
npm run dev
```

On first launch, create or open a vault. Mock mode is enabled by default and demonstrates chat, streaming, memory extraction, embeddings, search, retry/failure behavior, and persistence without an API key.

## Architecture snapshot

- Electron main process: persistence, providers, memory/retrieval services, credentials, diagnostics, and validated IPC handlers.
- Sandboxed React renderer: chat, projects, search, memory review, settings, citations, and source navigation.
- Authoritative storage: atomic JSON metadata plus append-only, flushed transcript/extraction JSONL in the selected vault.
- Derived storage: Node's built-in SQLite with FTS5 and optional stored vectors; safe to rebuild from authoritative files.
- Providers: deterministic offline mock and configurable OpenAI-compatible chat-completions/structured-output/embeddings adapter.
- Credential storage: Electron `safeStorage` outside the vault; saved keys are never returned to the renderer.
- CI: Windows GitHub Actions executes installation, audit, formatting, lint, types, unit/integration/UI tests, build, NSIS packaging, and artifact upload.

## Acceptance evidence

The current implementation has been verified locally and in GitHub Actions. The latest authoritative hosted result is available from the repository's **Actions** tab. A successful run must show every step green and include the `memorybridge-windows` artifact.

The repository intentionally does not include consumer ChatGPT/Claude scraping, cloud synchronization, accounts, collaboration, mobile applications, browser extensions, automatic ambient capture, or a hosted MemoryBridge backend. A live non-mock provider requires the owner's compatible endpoint and API key; those credentials are not needed for development or the complete mock-mode verification suite.

## Copy-ready instruction for ChatGPT

Send the repository link together with this text:

> Open the private MemoryBridge repository, read `AGENTS.md` and `docs/CHATGPT_HANDOFF.md`, then inspect the current branch and run the documented clean verification sequence. Use repository files and command output as evidence. Do not ask me to translate technical terminology, do not request credentials for mock-mode testing, and do not claim a check passed unless you ran it successfully.
