# Architectural decisions

## ADR-001: Isolated nested repository

**Decision:** Build in `memorybridge/` with its own Git repository.  
**Why:** The enclosing directory contains unrelated projects and sensitive-looking files. This follows the specification's Case C and prevents accidental staging or modification.  
**Alternative:** Reuse the enclosing uncommitted repository; rejected because it would mix unrelated ownership and history.

## ADR-002: Cohesive single package with module boundaries

**Decision:** Use one Electron package with `src/main`, `src/preload`, `src/renderer`, and `src/shared`, plus test and documentation directories.  
**Why:** The MVP needs one deployable application. Empty workspace packages would add configuration without isolation value. Domain modules remain independently testable.

## ADR-003: Electron, React, and TypeScript

**Decision:** Use Electron 43, electron-vite 5, React 19, and strict TypeScript.  
**Why:** This stack supports Windows packaging, native filesystem/drive behavior, secure preload IPC, accessible UI iteration, and current Node tooling.

## ADR-004: JSONL is authoritative; SQLite is derived

**Decision:** Keep append-only transcript snapshots in JSONL and atomic memory/metadata JSON in the vault. Use Node 24's built-in `node:sqlite` with FTS5 only as a rebuildable projection.  
**Why:** Human-readable authoritative files survive index loss and allow interrupted streams to be recovered. SQLite provides fast local filtering/search without becoming the only copy.

The initial dependency audit considered `better-sqlite3`, but its Node 24 installation required a local Visual Studio C++ toolchain. Electron 43 includes Node 24's stable-enough built-in SQLite API, eliminating that native rebuild and packaging dependency while preserving the required database behavior.

## ADR-005: Conservative removable-drive SQLite settings

**Decision:** Use rollback journal (`DELETE`), `synchronous=FULL`, a 5-second busy timeout, and short explicit transactions.  
**Why:** WAL creates coordinated sidecar files and locking assumptions that are less predictable on exFAT/removable media. Rollback journaling is slower but safer for the MVP.

## ADR-006: Append-only assistant checkpoints

**Decision:** Append periodic full snapshots for the same assistant message ID; do not rewrite transcript content during streaming.  
**Why:** Replay deterministically selects the latest snapshot while earlier states remain recoverable. Checkpoint frequency limits write amplification.

## ADR-007: Provider-neutral contracts with HTTP OpenAI compatibility

**Decision:** Implement a small provider interface, a deterministic mock provider, and an OpenAI-compatible HTTP provider using supported chat-completions streaming and embeddings shapes.  
**Why:** It avoids coupling domain code to one SDK and supports compatible endpoints. Provider-specific changes stay within one adapter.

## ADR-008: Deterministic memory guardrails

**Decision:** AI proposes candidates; Zod validation, source-ID validation, and deterministic reconciliation decide persistence and lifecycle transitions.  
**Why:** Provenance and stable rules are product invariants. Model output alone cannot safely enforce them.

## ADR-009: Optional semantic vectors in SQLite

**Decision:** Store JSON vectors in SQLite and calculate cosine similarity in application code for the expected internal dataset size.  
**Why:** It avoids a hosted or native vector database and packaging risk. FTS5 remains fully useful when embeddings are disabled.

## ADR-010: Electron safeStorage for credentials

**Decision:** Store only an OS-encrypted API-key blob in Electron user data, never in a vault or repository.  
**Why:** It uses Windows OS protection without adding keychain-native dependencies. If encryption is unavailable, persistent key storage is refused and mock mode remains available.
