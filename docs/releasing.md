# Releasing Polymux

Releases are tag-driven and publish through npm trusted publishing. The
workflow does not accept a long-lived npm token.

Before the first release, configure a trusted GitHub Actions publisher for
each package below in npm:

- `polymux`
- `@polymux/protocol`
- `@polymux/core`
- `@polymux/test-gates`
- `@polymux/adapter-web`
- `@polymux/adapter-linux`
- `@polymux/adapter-appium`
- `@polymux/runner`

Use organization `PolymuxOrg`, repository `polymux`, workflow
`release.yml`, and GitHub environment `npm` for every publisher. Protect that
environment and release tags, require review for production publishing, keep
npm account 2FA enabled, and do not add `NPM_TOKEN` to repository or
environment secrets.

For a release:

1. Run `npm ci`, `npm audit --audit-level=moderate`, `npm test`,
   `npm run test:e2e`, `npm run release:check`, and dry-run every package.
2. Update the changelog and choose one version for the entire package graph.
3. Create an annotated `vX.Y.Z` tag from a reviewed commit.
4. Approve the protected `npm` environment and verify provenance on every
   published package before announcing the release.

If any package lacks its trusted-publisher entry, the dependency-ordered
release will stop. Configure all eight entries before creating the tag.
