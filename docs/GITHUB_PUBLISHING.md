# GitHub publishing handoff

A private repository was created successfully at:

`https://github.com/omprasadsharma420-wq/memorybridge`

The local `origin` remote points to that repository. The initial push was rejected because the authenticated GitHub CLI OAuth token has `repo` access but lacks GitHub's separate `workflow` scope. GitHub requires that scope when a commit creates `.github/workflows/ci.yml`.

The complete local `main` branch, including the CI workflow, remains intact. Do not remove the workflow to bypass the protection.

When the repository owner is present, run:

```powershell
gh auth refresh -h github.com -s workflow
git push -u origin main
```

The first command displays a one-time device code and opens GitHub's authorization page. After confirming the scope in the browser, the second command publishes the complete verified local branch. Then verify:

```powershell
gh repo view omprasadsharma420-wq/memorybridge --json name,isPrivate,url,defaultBranchRef
gh run list --repo omprasadsharma420-wq/memorybridge --limit 5
git status --short --branch
```

Expected local branch tip at this handoff is the newest commit shown by `git log -1 --oneline`. The remote must remain private.
