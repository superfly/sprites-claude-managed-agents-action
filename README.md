# Sprites Claude Managed Agents Action

Runs a Claude Managed Agents session in a Sprite.

This action demonstrates running [Claude Managed Agents on Sprites](https://docs.fly.io/sprites/integrations/claude-managed-agents) in GitHub Actions. The action creates a session, uploads files to the Sprite, sends the prompt or outcome, streams the agent's progress, pulls requested files back, and returns a session transcript. To run, you need a configured instance of the [reference control plane](https://github.com/fly-apps/sprites-claude-managed-agents). Follow its [README](https://github.com/fly-apps/sprites-claude-managed-agents/blob/main/README.md) to get it set up.

See [`action.yml`](./action.yml) for all inputs and outputs.

## Sample workflows

### Weekly bug summary

Create a weekly summary of GitHub issues.

```yaml
name: Weekly bug summary

on:
  schedule:
    - cron: "0 9 * * 1"

permissions: {}

jobs:
  summarize:
    runs-on: ubuntu-latest
    steps:
      - id: summarize
        uses: superfly/sprites-claude-managed-agents-action@v1
        with:
          api-key: ${{ secrets.CMA_ANTHROPIC_API_KEY }}
          agent-id: ${{ vars.CMA_ANTHROPIC_AGENT_ID }}
          environment-id: ${{ vars.CMA_ANTHROPIC_ENVIRONMENT_ID }}
          labels: github-read-only
          prompt: |
            Use the GitHub API connector to summarize all open issues labeled
            "bug" in ${{ github.repository }}.
          archive-session: "true"

      - env:
          TRANSCRIPT: ${{ steps.summarize.outputs.transcript }}
        run: echo "$TRANSCRIPT" >> "$GITHUB_STEP_SUMMARY"
```

- `labels: github-read-only` applies a label to the created Sprite. Paired with an [API connector](https://docs.fly.io/sprites/concepts/connectors) for GitHub, the Sprite can access the issues through its API gateway without exposing credentials.
- `archive-session` archives the Claude session when the action succeeds. By default, the Sprite is kept. To clean up the Sprite, provide a `sprite-token` and set `delete-sprite: "true"`.

### Fix a script and open a pull request

Fix the `scripts/update.sh` script using an outcome and a rubric, then open a pull request with the updated file.

```yaml
name: Fix the updater

on:
  workflow_dispatch:

permissions:
  contents: write
  pull-requests: write

jobs:
  fix:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7

      - uses: superfly/sprites-claude-managed-agents-action@v1
        with:
          api-key: ${{ secrets.CMA_ANTHROPIC_API_KEY }}
          agent-id: ${{ vars.CMA_ANTHROPIC_AGENT_ID }}
          environment-id: ${{ vars.CMA_ANTHROPIC_ENVIRONMENT_ID }}
          budget-cents: "300"
          bucket: ${{ vars.CMA_S3_BUCKET }}
          aws-access-key-id: ${{ secrets.CMA_BUCKET_ACCESS_KEY_ID }}
          aws-secret-access-key: ${{ secrets.CMA_BUCKET_SECRET_ACCESS_KEY }}
          files: |
            scripts/update.sh /update.sh
          outcome: |
            Fix /mnt/session/uploads/update.sh in place.
          rubric: |
            - `bash -n` accepts the script.
            - `shellcheck` reports no errors.
            - The script exits zero when run.
            - Only the broken step is changed.
          sprite-token: ${{ secrets.CMA_SPRITE_TOKEN }}
          pull-files: |
            scripts/update.sh /mnt/session/uploads/update.sh
          archive-session: "true"
          delete-sprite: "true"

      - env:
          GH_TOKEN: ${{ github.token }}
        run: |
          git switch -c fix-updater-$GITHUB_RUN_ID
          git config user.name "github-actions[bot]"
          git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
          git commit -am "Fix the updater"
          git push origin HEAD
          gh pr create --fill
```

- `files` uploads to S3 and hands the control plane a presigned URL to download to the Sprite. Uploaded files land under `/mnt/session/uploads/`, so `/update.sh` is `/mnt/session/uploads/update.sh` inside the Sprite.
- The agent keeps working until an independent grader agent agrees the rubric is satisfied (or fails after `max-iterations`).
- The final file is pulled over the Sprites API, committed, and submitted as a pull request.

## License

Copyright 2026 Fly.io, Inc. Licensed under the Apache License, Version 2.0. See the [LICENSE](./LICENSE) file.
