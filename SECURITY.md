# Security

Report vulnerabilities privately through GitHub Security Advisories for this repository. Do not include real exports, credentials, conversation text, or vault files in public issues.

## Security posture

- Electron renderer sandbox, context isolation, no Node integration, denied permissions, blocked navigation, and HTTPS-only external opening.
- Frozen narrow preload API and Zod validation for every IPC payload.
- Windows secure credential storage; secrets are excluded from settings, logs, errors, diagnostics, repository fixtures, and MCP.
- Path containment, safe filenames, manifest/vault identity, atomic writes, backup recovery, and bounded parsers.
- App single-instance lock plus serialized ownership-token vault heartbeat, foreign-lock protection,
  stale recovery, shutdown-race coverage, and an honest non-browsable locked state.
- Authoritative append-only transcript semantics; indexes are query-limited and rebuildable.
- Streaming import limits: 512 MB archive, 100 MB entry, 1 GB cumulative expansion, 50,000 entries,
  maximum 250:1 compression ratio, traversal rejection, cancellation, bounded raw metadata, and
  synthetic fixtures only.
- Provider error redaction, timeouts, bounded retries, cancellation, strict structured parsing, SSE termination checks, and conservative capabilities.
- Local MCP stdio, validated manifest, query-only SQLite, strict scope, result limits, citations, and no generic file, shell, write, credential, or SQL tool.
- Dependency versions are locked; CI runs audit, lint, types, tests, build, UI test, and packaging.

## Threat boundaries

The selected provider receives only explicitly configured requests. The selected vault location and user-selected import files are trusted user choices but their contents remain untrusted input. A compromised local account can access that account's vault and credentials; MemoryBridge is not a multi-user access-control system. Unsigned development installers should be distributed only through controlled channels.

## Release response

For a security issue: reproduce with synthetic data, add a regression test, rotate affected credentials, publish a patched release, and document whether vault migration or index rebuild is required. Never ask a reporter for their real archive.
