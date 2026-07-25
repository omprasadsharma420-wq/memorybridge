# Connector architecture

Connectors describe capabilities; they do not imply account access.

| Connector           | Native capture | Live API | Incremental | Export import | Watched folder | Provider memory | Attachments | Branches |
| ------------------- | -------------: | -------: | ----------: | ------------: | -------------: | --------------: | ----------: | -------: |
| MemoryBridge chat   |            Yes |       No |         Yes |            No |             No |              No |          No |       No |
| ChatGPT data export |             No |       No |         Yes |           Yes |            Yes |             Yes |    Metadata |      Yes |
| Generic files       |             No |       No |         Yes |           Yes |            Yes |              No |          No |       No |

`src/main/ingestion/connectors.ts` is the product-visible registry. `ImportService` converts source-specific data into canonical conversations and messages before repository writes. Provider IDs, content hashes, archive hashes, timestamps, branches, attachments, citations, bounded metadata, and checkpoints support idempotent or changed-only re-import.

No connector scrapes a consumer UI, captures cookies, automates a browser, or calls undocumented endpoints. New connectors must declare every capability independently and add synthetic fixtures, malformed-input handling, incremental tests, and privacy documentation.
