# Known limitations — 0.2.1 MVP test

- The Windows installer is unsigned because no code-signing certificate was available. SmartScreen
  may warn. Verify the GitHub source and checksum.
- This is an internal-test pre-release, not production-ready.
- ChatGPT support is an official export ZIP importer and watched local inbox. There is no silent
  sidebar/live synchronization, browser scraping, cookie capture, or undocumented consumer API.
- Claude and Gemini live synchronization are not implemented.
- The importer resolves known ChatGPT mapping/current-node forms. When it cannot establish one
  active path, it creates separately reviewable branch conversations; it does not promise support
  for every future export variation.
- A selected conversations/memories JSON entry is bounded at 100 MB and retained in memory after
  streaming decompression for JSON parsing. Archive, cumulative, count, and compression-ratio
  bounds prevent unbounded expansion.
- Windows does not expose reliable removable-media classification for every USB/SATA/encrypted
  volume. MemoryBridge shows **unknown** rather than guessing; path, volume, free space, and vault
  identity remain visible.
- Automatic external-drive reopening assumes the registered path returns. If Windows assigns a new
  drive letter, use **Locate vault**.
- Offline storage/import/keyword search need no API key. Genuine AI extraction and embeddings need
  a configured compatible endpoint and the corresponding detected capabilities. A ChatGPT
  subscription does not include API access.
- Provider memory with ambiguous project/workspace/conversation authority remains `needs_review`
  until the user selects a MemoryBridge scope.
- Attachments and citations preserve available metadata; rich attachment-body extraction is not
  included.
- Semantic vectors are optional. Without them, retrieval uses Unicode FTS and deterministic
  ranking.
- MCP is local child-process stdio only. There is no public/remote MCP server.
- Diagnostic reports intentionally omit vault paths and content, which can limit diagnosis of
  path-specific failures.
- Capacity and RSS numbers are point-in-time measurements. Active SQLite metadata and drive
  availability can change immediately after calculation.
