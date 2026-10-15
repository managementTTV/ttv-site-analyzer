GitHub Actions workflows for this repo.

**Currently none.** `codex-review.yml` (a per-push Codex review) was removed on 2026-09-22:
it required an `OPENAI_API_KEY` repo secret that was never added, so it failed on every run
from August onward and showed a permanently red check on each PR.

Code review is meant to be handled by the **Codex cloud integration** (comment `@codex review` on a PR). It has
never reviewed a PR on this repo: it answers "usage limits" (the P1 catches once credited to it on #17 were on the
archived repo, not this one). Until that is fixed, the **Claude stopgap review** is the review step; see AGENTS.md,
PR protocol.

If you ever want per-push reviews back, restore the workflow from git history
(`git log --diff-filter=D -- .github/workflows/codex-review.yml`) and add the secret first:
Repo → Settings → Secrets and variables → Actions → New repository secret → `OPENAI_API_KEY`.
