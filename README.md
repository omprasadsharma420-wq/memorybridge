# MemoryBridge

MemoryBridge is a Windows-first, local-first AI chat workspace and project-aware external memory system. It preserves conversations created inside the desktop app, extracts durable evidence-backed memory, and retrieves only relevant cited context for later turns. The user-selected vault—not a hosted MemoryBridge backend—is the source of truth.

## MVP status

The internal MVP implements the complete local workflow:

- Create, open, disconnect, and reconnect a user-controlled vault on a local folder or removable drive.
- Create/rename projects; create/rename/reassign chats; persist chat history across restarts.
- Save and flush the user message before invoking either provider.
- Stream/checkpoint assistant responses; stop, preserve partial output, recover interrupted messages, and retry without duplicating user input.
- Use deterministic mock chat, extraction, and embeddings without a credential or network.
- Configure an OpenAI-compatible endpoint for streaming chat, JSON-schema extraction, and embeddings.
- Extract validated decisions, agreements, completed items, facts, preferences, instructions, commitments, open questions, project states, and rejected options with exact message provenance.
- Reconcile duplicates, supersession, completion, rejection, and disputed changes without destroying history or silently replacing confirmed memory.
- Search chats/messages/memories offline with SQLite FTS5; optionally add embeddings and hybrid ranking.
- Review, confirm, correct, reject, pin, merge, delete, or supersede memories and open the source chat.
- Rebuild derived indexes and export diagnostics that exclude transcripts, memory statements, vault paths, and credentials.

MemoryBridge does not scrape ChatGPT or Claude, read browser storage, use consumer-service internals, provide cloud sync, or treat a ChatGPT subscription as API access.

## Architecture

Electron 43 hosts a sandboxed React 19 renderer and a narrow validated preload bridge. TypeScript main-process services own the vault, append-only JSONL transcript, atomic metadata, Node 24 built-in SQLite/FTS5 index, providers, memory engine, retrieval, credentials, and safe diagnostics. Zod validates IPC, persisted data, and model output. See [Architecture](docs/ARCHITECTURE.md), [Data model](docs/DATA_MODEL.md), and [Decisions](docs/DECISIONS.md).

## Requirements

- Windows 10/11 for the intended desktop target.
- Node.js 24.x and npm 11.x for development.
- No API key for mock mode.
- A writable local or removable-drive folder for the vault.

## Setup

```powershell
npm ci
npm run dev
```

The first launch offers **Create a new vault** and **Open an existing vault**. A vault shows writability and free space after connection. Mock mode is enabled by default.

## Commands

```powershell
npm run dev                 # Electron + renderer development mode
npm run typecheck           # strict TypeScript
npm run lint                # ESLint
npm run test:unit           # unit suite
npm run test:integration    # five required end-to-end service flows
npm test                    # unit + integration
npm run test:ui             # build and Playwright Electron critical path
npm run build               # production main/preload/renderer output
npm run package:win         # x64 NSIS installer in release/
```

## Provider configuration

Mock mode streams deterministic responses and supports deterministic extraction, vectors, failures, timeouts, invalid output, and interrupted streams. It requires no key.

For a real endpoint, open **Settings**, choose **OpenAI-compatible**, enter the API base URL and model names, then save an API key. The key is encrypted with Electron `safeStorage` in application user data, outside the vault, and never returned to the renderer after saving. A development `.env.example` documents conventional values but production settings use the UI.

The adapter uses the documented Chat Completions streaming/JSON-schema shapes and embeddings endpoint so compatible providers can be substituted. Compatibility depends on the selected endpoint and model supporting those features.

## Vault behavior

The vault manifest has an immutable ID, so a removable vault can be relocated even if its drive letter changes. Raw transcript snapshots are append-only and flushed before network use. SQLite uses conservative rollback journaling and is always rebuildable from vault files. If the vault disappears, content actions are blocked and MemoryBridge never writes a hidden fallback transcript elsewhere.

To delete all MemoryBridge content, close the app and delete the vault folder you selected. This does not remove the separately encrypted provider key; clear it in Settings first when required.

## Security and privacy

There is no MemoryBridge account, analytics, advertising, telemetry, cloud database, or silent upload. Only explicitly enabled chat/extraction/embedding operations send bounded text to the configured provider. The renderer has no Node or raw filesystem access; IPC inputs, identifiers, and paths are validated; arbitrary navigation and permissions are denied. See [Privacy](docs/PRIVACY.md) and [Security](SECURITY.md).

## Known limitations

- The deterministic extractor is deliberately conservative and English-oriented; real-model extraction quality depends on the configured compatible model.
- Semantic embeddings require the enabled provider; FTS5 remains fully functional offline.
- Automatic project detection, imports, browser capture, cloud sync, mobile apps, and multi-user collaboration are intentionally deferred.
- Windows is the supported package target. Source-level tests are cross-platform where Node 24 provides `node:sqlite`.
