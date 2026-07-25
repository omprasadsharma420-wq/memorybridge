# MCP integration

MemoryBridge builds a separate local stdio entry at `out/main/mcp-server.js`. The app's **MCP & integrations** panel provides the exact command, arguments, vault, and `ELECTRON_RUN_AS_NODE=1` environment configuration for the current installation.

## Tools

- `search_memory`
- `get_current_project_state`
- `get_decisions`
- `get_open_questions`
- `get_completed_items`
- `find_related_conversations`
- `get_chat_excerpt`
- `get_memory_evidence`
- `list_projects`
- `get_provider_memories`

Results are capped at 50, excerpts are bounded, lifecycle defaults exclude rejected/superseded/deleted data, and memory results embed bounded exact evidence with its role, availability, source IDs, timestamp, and `memorybridge://` citation. Results also carry type, scope, lifecycle, project, source provider/chat, and supersession fields. Project, conversation, confirmed-global, and explicit all-project scope use the same isolation rules as the desktop app. Unscoped calls can see only confirmed global memory. Provider memories remain labeled review records.

The server opens only the validated vault manifest and its derived SQLite index in query-only mode. It exposes no path argument, file read, directory list, shell, write, credential, transcript dump, or arbitrary SQL tool. Transport is local child-process stdio, not a listening network port.

Development command after `npm run build`:

```powershell
node out/main/mcp-server.js --vault "C:\path\to\vault"
```

The implementation follows the stable TypeScript SDK stdio server pattern documented by the [Model Context Protocol SDK](https://ts.sdk.modelcontextprotocol.io/server).
