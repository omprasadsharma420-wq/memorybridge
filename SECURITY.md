# Security policy

## Threat model and trust boundary

MemoryBridge protects local conversation content and provider credentials from accidental disclosure, renderer compromise, path traversal, unsafe navigation, and diagnostic/log leakage. The user controls the vault and the configured remote provider. The MVP does not claim full-disk encryption, protection from a compromised Windows account/administrator, hostile firmware, or a provider that retains submitted data.

## Electron boundary

- `contextIsolation` is enabled; renderer `nodeIntegration` is disabled; the renderer is sandboxed.
- The preload exposes a frozen, domain-specific API. It does not expose raw IPC, shell, process, or filesystem operations.
- IPC channels are allowlisted and every payload is Zod-validated in the main process.
- A restrictive Content Security Policy permits packaged self assets and configured HTTPS provider connections, but no objects or base URL changes.
- Browser permissions are denied. Unexpected navigation/new windows are denied; explicitly clicked HTTPS links may open in the system browser.
- Model output renders as React text, not HTML or unsanitized Markdown.

## Credentials

Provider keys use Electron `safeStorage`, backed by Windows OS encryption, in application user data outside the vault. If encryption is unavailable, MemoryBridge refuses persistent storage. Keys are never committed, included in diagnostics, written to vaults, logged, or returned to the renderer after save. Error messages pass through secret redaction.

## Filesystem and database safety

All content paths are resolved beneath the validated connected vault root. Inputs use immutable schema-checked IDs, and human-readable slugs are sanitized for Windows/cross-platform reserved characters and names. Path traversal is rejected. Critical transcript appends explicitly flush before returning. Metadata uses same-directory temporary writes with recovery backups. SQLite uses full synchronization, conservative rollback journaling, foreign keys, busy timeouts, and rebuildability.

## Sensitive-log prevention

Safe logs accept a narrow metadata structure only. Never add prompt, response, memory statement, file content, API key, authorization header, or raw provider body logging. Diagnostic changes require a test or manual audit proving content and secrets are absent.

## Dependency policy

CI installs from `package-lock.json`, runs `npm audit`, lint, strict type checking, tests, production build, UI automation, and Windows packaging. Review lockfile changes, prioritize supported releases, and avoid native add-ons unless their packaging/security value is proven. Do not suppress a vulnerability without documenting reachability and compensating controls.

## Reporting a vulnerability

This is a private internal repository. Report vulnerabilities privately to the repository owner through the private GitHub security channel or another agreed confidential channel. Do not open a public issue containing credentials, transcripts, vault paths, exploit payloads with personal data, or other sensitive evidence.
