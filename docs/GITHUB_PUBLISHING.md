# GitHub publishing

The private repository is `omprasadsharma420-wq/memorybridge` with `origin` configured over HTTPS. Production-pivot work belongs on `codex/memorybridge-production-pivot`; do not push it directly to `main`.

## Required release workflow

1. Confirm the diff contains no real vaults, exports, credentials, paths, generated release artifacts, or unrelated changes.
2. Run formatting, lint, types, unit/integration tests, build, UI test, audit, and Windows packaging.
3. Commit in logical groups with evidence in commit messages or the PR body.
4. Push the branch to `origin`.
5. Open a draft PR against `main` describing migration, scope/security invariants, test evidence, and explicit non-claims.
6. Wait for GitHub Actions; inspect logs and repair failures before marking ready.

The workflow triggers on `main` and `codex/**`, uploads the unsigned NSIS installer, and must not receive secrets or real exports. Signed distribution remains a separate release decision.

## Handoff link

Use the draft pull request <https://github.com/omprasadsharma420-wq/memorybridge/pull/2> as the link to send to ChatGPT work. A local filesystem link is not portable to another ChatGPT task. Verify its hosted checks after every pushed commit before calling it ready.
