# MemoryBridge 0.2.1 MVP stabilization plan

Updated 2026-07-25. Working branch: `codex/memorybridge-mvp-stabilization`.

## Current implementation state

The rebuilt 0.2.0 production-pivot implementation is present in `main` through merge commit
`bb05e98`, which contains the reported rebuild commit `7511aff`. PR #2 is already merged, so this
release branches from that rebuilt `main` and will use a new review pull request.

The repository contains the Electron/React desktop app, manifest-identified vaults, canonical
transcripts, SQLite/FTS, ChatGPT and generic importers, watched inbox, evidence and scopes,
reprocessing checkpoints, provider adapters, local MCP, Windows packaging, and tests.

Pre-change verification on Windows 2026-07-25:

| Check                    | Result                                                                                  |
| ------------------------ | --------------------------------------------------------------------------------------- |
| `npm ci`                 | Passed; 560 packages installed                                                          |
| Prettier                 | Passed                                                                                  |
| ESLint                   | Passed                                                                                  |
| TypeScript               | Passed                                                                                  |
| Unit and integration     | 61/61 passed across 15 files                                                            |
| Production build         | Passed                                                                                  |
| Electron UI              | 1/1 passed                                                                              |
| Windows x64 NSIS package | Passed for 0.2.0                                                                        |
| Security audit           | Failed: newly disclosed transitive `brace-expansion` high and `tar` moderate advisories |

## Confirmed defects

- The ChatGPT importer sorts all mapping nodes by time and can mix mutually exclusive branches.
- ZIP import uses synchronous full-archive decompression on the Electron main thread and has no
  cumulative expansion limit or cancellation.
- Lock-conflict state is described as read-only even though no readable repository is initialized.
- Manifest migration does not convert legacy memory provenance into first-class evidence.
- Reprocessing labels do not fully distinguish resume, force, project, and derived-intelligence
  rebuild semantics.
- MCP current-truth filtering admits candidate and review states, and direct ID tools bypass scope.
- Provider connection health depends on model listing instead of independent capability probes.
- Imported provider memory defaults to global scope without source-aware review scope.
- The vault heartbeat is not serialized, ownership-token checked, or race-safe during shutdown.
- There is no asynchronous storage-capacity inventory, import validation report, bundled demo
  archive workflow, or complete non-technical onboarding.
- Documentation and package metadata still describe 0.2.0 and an earlier audit result.

## Chosen fixes

1. Reconstruct a coherent ChatGPT active path. Import unresolved alternatives as separately
   identified branch conversations and retain bounded branch metadata.
2. Stream ZIP entries with bounded compressed, per-entry, cumulative decompressed, compression
   ratio, entry-count, traversal, progress, cancellation, and cleanup controls.
3. Use the honest lock-conflict alternative: label the vault as locked by another instance, disable
   browsing and mutations, and provide retry/reconnect.
4. Add an idempotent, backed-up legacy-memory migration with evidence validation, explicit scope,
   preserved confirmation/history, needs-review fallback, and a durable migration report.
5. Expose separate resume, forced-chat, project, and vault-derived rebuild operations with
   cancellation and summaries. Preserve manual and explicitly confirmed memory during rebuild.
6. Make MCP current truth explicit and scope every direct lookup by active request policy.
7. Probe provider authentication, chat, streaming, structured output, embeddings, model listing,
   and cancellation independently; persist the latest successful capability summary.
8. Infer only reviewable provider-memory scope from explicit source metadata. Never silently grant
   global authority.
9. Make heartbeat writes serialized, ownership-token checked, error-contained, and shutdown-safe.
10. Add a dedicated asynchronous Vault Storage service and screen, verification action, import
    validation, safe diagnostics copy, onboarding, and a deterministic bundled demo import.
11. Upgrade to 0.2.1, repair the dependency audit without forced breaking upgrades, and reconcile
    release, schema, test, connector, installer, and CI documentation.

## User-test workflow

The release is accepted through one vertical slice:

1. Install the unsigned internal-test NSIS package.
2. Create or open an internal or external vault and verify its identity, location, writeability,
   and capacity.
3. Import a ChatGPT ZIP or the bundled synthetic demo archive.
4. Review import counts and integrity validation.
5. Search conversations and structured memory, then open exact evidence.
6. Restart, reopen the same vault without a full rebuild, and repeat the search.
7. Disconnect and reconnect an external-style vault without fallback writes.

## Release criteria

- The vertical slice works without an API key; demo intelligence is clearly synthetic.
- Import branches are coherent, ZIP resources are bounded, repeat import is idempotent, and changed
  content is incremental.
- Vault files remain at the selected path; capacity and identity are visible and refreshable.
- Memory, retrieval, evidence, project isolation, MCP lifecycle/scope, migration, provider, lock,
  recovery, Unicode/Nepali, and packaged UI checks pass.
- The benchmark uses synthetic data and records measured results without universal promises.
- A checksum-labelled unsigned x64 installer is available from GitHub as an Actions artifact or
  pre-release asset, with release notes, known limitations, and a non-technical test guide.

## Verification strategy

Use generated fixtures only. Run formatting, lint, strict types, focused unit/integration suites,
the full Vitest suite, the Electron end-to-end workflow, the synthetic benchmark, production build,
security audit, Windows packaging, checksum verification, packaged smoke-test equivalent, secret and
artifact review, and hosted Windows CI. A file existing is not verification; every reported result
must come from an executed command or observed application behavior.
