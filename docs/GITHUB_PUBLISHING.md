# GitHub publishing

Repository: `omprasadsharma420-wq/memorybridge`.

The 0.2.1 MVP-test work belongs on `codex/memorybridge-mvp-stabilization`, based on rebuilt `main`.
PR #2 is already merged; do not reuse or merge it.

## Required release workflow

1. Confirm the diff contains no real vaults, exports, credentials, generated release binaries,
   temporary logs, absolute user paths, or unrelated changes.
2. Run formatting, lint, types, unit/integration tests, build, Electron UI test, full benchmark,
   MCP smoke, zero-vulnerability audit, Windows packaging, packaged executable workflow, signature
   check, and SHA-256 generation.
3. Commit intentionally and push the current branch.
4. Open a new review PR against `main` with migration/scope/security invariants, exact test counts,
   performance measurements, installer link, and explicit limitations.
5. Wait for the Windows GitHub Actions job and repair any failure.
6. Publish `v0.2.1-mvp-test.1` as a pre-release for internal testing. Upload the unsigned x64
   installer and `SHA256SUMS.txt`; recommend a new disposable vault.
7. Keep the PR unmerged until independent human review.

The CI workflow runs on `main`, `codex/**`, and pull requests. It must receive no signing keys, API
keys, or real exports. Signed distribution remains a later release decision.
