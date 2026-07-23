# Production-pivot requirements matrix

This matrix maps the repair-and-pivot prompt to implementation and verification. It is a navigation aid; schemas and tests remain authoritative.

| Area                                           | Implemented evidence                                                                                        | Verification evidence                                                        |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Vault identity, migration, locking, disconnect | `src/main/storage/vault.ts`, `repository.ts`, index migrations                                              | `vault-repository.test.ts`, `production-pivot.test.ts`, `core-flows.test.ts` |
| Canonical native/imported conversations        | `src/main/chat-service.ts`, `ingestion/import-service.ts`                                                   | core, production-pivot, import resume/recovery tests                         |
| Incremental ChatGPT/generic/inbox import       | archive/conversation/message hashes and persisted checkpoints                                               | duplicate, changed, branch, malformed, unsupported, inbox and recovery tests |
| Provider-originated memory                     | separate schema/files/index/FTS and explicit review actions                                                 | `provider-memory-review.test.ts`, MCP provider-memory query coverage         |
| Topic intelligence and reprocessing            | segmentation, conservative classification, stable hashes, disk checkpoints, segment/chat/project/vault APIs | `reprocessing.test.ts`, `project-classifier.test.ts`                         |
| Memory integrity                               | deterministic validation, explicit scope/lifecycle, reconciliation, confirmation source                     | memory-engine, extraction fixtures, project-isolation tests                  |
| Evidence                                       | first-class multi-message/multi-chat records, roles, exact excerpts, missing-source flag                    | production-pivot and MCP protocol tests                                      |
| Indexing and retrieval                         | Unicode FTS5, optional vectors, structured/entity/temporal data, lifecycle/scope ranking                    | retrieval, multilingual, large-vault and production-pivot tests              |
| Provider reliability                           | explicit capability model, SSE validation, JSON fallback, safe errors/retries/cancellation                  | local fake-server provider contract tests                                    |
| MCP                                            | ten local stdio, query-only, bounded, scoped and cited tools                                                | in-memory real MCP client/server protocol tests plus query isolation tests   |
| UI                                             | provider/project/topic/import/memory/search/MCP/vault panels, source navigation and processing controls     | production build and Playwright critical-path test                           |
| Performance/integrity                          | incremental startup/import, linear patches, affected projections, resume                                    | 200-chat/2,000-message workload and production-pivot tests                   |

Unsupported claims remain explicit: there is no consumer-site scraping, undocumented API use, automatic provider-memory trust, live synchronization without an official connector, cloud sync, signed installer, or rich attachment-body extraction.
