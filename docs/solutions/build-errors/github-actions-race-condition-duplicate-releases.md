---
title: "GitHub Actions Race Condition — Parallel Release Creation"
category: "build-errors"
date: "2026-03-18"
tags:
  - github-actions
  - electron-builder
  - race-condition
  - ci-cd
  - release-workflow
severity: high
component: ".github/workflows/release.yml"
symptoms:
  - "422 Unprocessable Entity on parallel publish jobs"
  - "Windows build failed with 'already_exists' tag_name error"
  - "macOS assets uploaded but Windows installer missing from release"
---

## Problem

`electron-builder --publish always` in parallel GitHub Actions jobs causes a 422 "already_exists" error when the second job tries to create a GitHub release that the first job already created.

The `build-windows` and `build-macos` jobs ran in parallel. Whichever finished first successfully created the release and uploaded its assets. The second job then failed trying to create the same release, leaving one platform's assets missing.

## Root Cause

`electron-builder --publish always` performs two sequential operations: (1) creates a GitHub release if it doesn't exist, and (2) uploads assets to it. When two jobs run in parallel, both check "does release exist?" in quick succession, both see "no", both attempt to create it, and the second fails with 422.

This is a classic TOCTOU (time-of-check-to-time-of-use) race condition.

## Solution

Three-job workflow pattern — **serial creation, parallel upload**:

1. **`create-release` job (runs first):** Lightweight `ubuntu-latest` job creates a draft release using `gh release create "$TAG" --draft`. The `|| true` suffix makes it idempotent for re-runs.

2. **Parallel build jobs:** Both `build-windows` and `build-macos` declare `needs: [create-release]`, ensuring the draft exists before they start. electron-builder finds the existing release and only uploads assets.

3. **`publish-release` job (runs last):** After both builds complete, removes the draft flag with `gh release edit "$TAG" --draft=false`.

```yaml
create-release:
  runs-on: ubuntu-latest
  permissions:
    contents: write
  steps:
    - uses: actions/checkout@v4
    - name: Create GitHub release (draft)
      env:
        GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      run: |
        TAG=${GITHUB_REF#refs/tags/}
        gh release create "$TAG" --draft --title "$TAG" --notes "Release $TAG" || true

publish-release:
  needs: [build-windows, build-macos]
  runs-on: ubuntu-latest
  permissions:
    contents: write
  steps:
    - uses: actions/checkout@v4
    - name: Publish release (remove draft)
      env:
        GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      run: |
        TAG=${GITHUB_REF#refs/tags/}
        gh release edit "$TAG" --draft=false
```

## Recovery

When this error occurs before the fix, clean up and retry:

```bash
gh release delete vX.Y.Z --yes
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z
# Then re-tag and push
git tag vX.Y.Z
git push origin vX.Y.Z
```

## Prevention

- **All publish jobs must depend on `create-release`**: If adding a new platform (Linux, etc.), add `needs: [create-release]` to its job definition.
- **Don't remove `|| true` from release creation**: It makes the step idempotent for re-runs after partial failures.
- **`workflow_dispatch` edge case**: Triggering manually without a tag leaves `$GITHUB_REF` as the branch name, not a tag. The release creation may silently fail or create a branch-named release. Consider adding tag validation.

## Key Insight

The pattern is **serial creation, parallel upload**: one job creates the shared resource (the release), then parallel jobs safely add to it. This eliminates the TOCTOU race at its source. The draft mechanism also prevents partial releases from being visible to users mid-build.
