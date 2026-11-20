# Releasing Archtour

Maintainer checklist. Each step names the command that proves it.

1. `main` is green in CI (Linux, macOS, Windows): `gh run list --branch main --limit 3`.
2. Locally on a clean checkout: `npm ci && npm test` passes.
3. Live test-bed run on Zune2004/archtour-gate-test passes.
4. Every row in the claims checklist in `docs/LAUNCH-KIT.md` says `yes`.
5. `npm pack --dry-run` lists only the files you expect.
6. Set `version` in `package.json` and change `Unreleased` to today's date in `CHANGELOG.md`, in one commit.
7. Tag `vX.Y.Z` and move the `v0` tag:
   ```sh
   git tag -a v0.3.0 -m "Archtour 0.3.0"
   git tag -f v0 v0.3.0
   git push origin v0.3.0
   git push -f origin v0
   ```
8. Publish to npm (owner runs it): `npm publish --access public`.
9. Create a GitHub release from the tag with the CHANGELOG section as notes: `gh release create v0.3.0 --notes-file <file>`.
