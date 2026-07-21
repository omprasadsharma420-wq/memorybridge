# GitHub publication

A private repository was created successfully at:

`https://github.com/omprasadsharma420-wq/memorybridge`

The local `origin` remote points to that repository, `main` tracks `origin/main`, and the complete verified history is published. The repository owner approved GitHub CLI's separate `workflow` scope before the CI workflow was pushed.

Hosted runs are available at:

`https://github.com/omprasadsharma420-wq/memorybridge/actions`

To verify publication and the latest CI result:

```powershell
gh repo view omprasadsharma420-wq/memorybridge --json name,isPrivate,url,defaultBranchRef
gh run list --repo omprasadsharma420-wq/memorybridge --limit 5
git status --short --branch
```

The local and remote branch tips must match, the default branch must be `main`, and the repository must remain private. `.gitattributes` enforces LF checkout for deterministic Prettier checks on Windows runners.
