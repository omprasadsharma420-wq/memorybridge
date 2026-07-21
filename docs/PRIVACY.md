# Privacy

## What stays local

The selected vault stores projects, chats, original transcript snapshots, memories, extraction records, indexes, vectors, migration state, attachments added later, and derived project-memory references. MemoryBridge has no hosted backend, cloud database, mandatory account, analytics, telemetry, advertising, or silent conversation upload.

Non-content application preferences and the last selected vault path live in Electron application data, outside the vault. This lets the app reconnect without creating a hidden content copy.

## What may be sent to a provider

- **Chat:** recent current-chat messages and only the retrieved cited context that fits the configured budget. Context can be a structured memory or, when none qualifies, an excerpt from a prior chat outside the current conversation.
- **Extraction:** a limited recent message window and relevant active-memory metadata when extraction is enabled.
- **Embeddings:** selected memory statements or the current retrieval query when semantic indexing is enabled.

Mock mode performs all three operations deterministically without network access. Disabling extraction or embeddings never disables transcript saving or keyword search.

## Credentials

An API key is encrypted through Electron `safeStorage` and stored in the operating-system application-data area, never in the vault. MemoryBridge never displays the complete stored key after saving. If OS encryption is unavailable, persistent key saving is refused. `.env` files and key material are Git-ignored.

## Logging and diagnostics

Structured logs contain event time/type, safe error category, provider/model identifiers, chat/message IDs, durations, and retry counts where applicable. They do not contain prompts, responses, memory statements, authorization headers, credentials, transcript contents, personal files, or vault file contents.

The diagnostic export includes application/runtime versions, provider/model names, feature toggles, vault connected/writable/schema status, whether a key exists, and a bounded list of the same safe recent event metadata. It deliberately excludes content, secrets, and the vault path.

## Deletion

To delete conversation data, close MemoryBridge and delete the user-selected vault folder. This is a user-controlled destructive action and is not performed by the app. Clear the saved API key separately in Settings if desired. Back up or securely erase removable media according to your own threat model.

## Disconnected drives

If the selected drive/folder disappears or becomes read-only, MemoryBridge shows a prominent disconnected state, blocks new messages and provider calls, and offers **Locate vault**. It does not save a fallback transcript elsewhere. Existing non-content interface settings may remain available. Reconnection validates the immutable manifest and rebuilds the derived projection when requested.
