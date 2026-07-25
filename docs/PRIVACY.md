# Privacy

MemoryBridge is local-first. It has no account, telemetry, analytics, advertising identifier, crash upload, hosted sync, or background provider account access.

## Stored locally

The selected vault contains conversations, canonical metadata, extracted memory, evidence excerpts, topics, provider-memory records, imports, attachments metadata, prompts, logs, backups, and derived indexes. App-local data is limited to settings, registered vault IDs/paths, encrypted provider credentials, and content-free operational logs.

Internal default locations and user-selected external folders use the same vault abstraction. Reconnect occurs only when a registered path still has the registered vault ID. A path alone is not trusted.

## Network use

- Mock mode performs no provider request.
- In configured provider mode, the app sends the current bounded chat context and, when enabled, bounded extraction or embedding inputs to the chosen endpoint.
- Imports never upload. ChatGPT ZIP and generic files are parsed locally.
- MCP uses local child-process stdio and query-only local storage.

MemoryBridge does not scrape provider pages, reuse browser sessions, capture cookies, or call undocumented consumer APIs. Live sync is not claimed.

## Provider memory and diagnostics

Imported provider memory is labeled, scoped, and stored separately for review; it is not silently treated as confirmed MemoryBridge memory. Diagnostic exports exclude vault paths, transcripts, message content, memory statements, evidence, credentials, and API keys.

## Deletion and portability

The vault is ordinary user-controlled data. Memory actions retain lifecycle provenance unless the user deletes records; raw imported source files move only within the vault inbox workflow. To remove all content, close MemoryBridge and delete the chosen vault through the operating system. Keep a copy if recovery is desired.
