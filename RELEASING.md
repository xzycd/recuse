# Releasing

Releases are built from an annotated tag that already belongs to `main`. The release workflow rebuilds the package on a GitHub hosted Node 24 runner, runs the full offline suite, audits production dependencies, verifies dependency signatures and attestations, creates a checksum, and attaches the tarball and checksum to a GitHub release. npm receives that same checksummed tarball, not a second pack of the workspace.

Publishing to npm is a separate, explicit choice in the same workflow. A pushed tag creates or refreshes the GitHub release but does not publish to npm. This keeps an accidental tag from consuming an immutable npm version.

## One time npm setup

The first publication needs an npm automation token because a package must exist before its trusted publisher can be configured.

1. Sign in to npm with two factor authentication and create a granular automation token that can publish the initial `recuse` package.
2. Create a GitHub Actions environment named `npm`. Require a reviewer there when the repository plan supports deployment approvals. Only the publish job receives this environment, the npm credential and the OIDC permission.

3. Store the bootstrap token as an environment secret, not a repository-wide secret:

   ```sh
   gh secret set NPM_TOKEN --repo xzycd/recuse --env npm
   ```

4. After the first version is published, configure the repository workflow as the package's trusted publisher:

   ```sh
   npm trust github recuse \
     --repository xzycd/recuse \
     --file release.yml \
     --environment npm \
     --allow-publish \
     --yes
   ```

5. Delete the long lived token from GitHub after trusted publishing works:

   ```sh
   gh secret delete NPM_TOKEN --repo xzycd/recuse --env npm
   ```

6. In the npm package settings, require two factor authentication and disallow token publishing. The trusted GitHub workflow continues to work through short lived OIDC credentials.

The workflow has `id-token: write`, uses a GitHub hosted runner, pins npm 11.12.1, and calls `npm publish --provenance --access public`. The package metadata also requires provenance and pins the public npm registry. npm 11.5.1 is the minimum version that supports trusted publishing, so the workflow does not depend on whichever older CLI a Node image happened to bundle.

## Release a version

1. Change the version and changelog in a pull request.
2. Wait for the Node 22 and Node 24 checks, then merge the pull request into `main`.
3. Update the local protected branch and create an annotated tag whose value exactly matches `package.json`:

   ```sh
   git switch main
   git pull --ff-only origin main
   git tag -a v0.8.1 -m "release 0.8.1"
   git push origin v0.8.1
   ```

4. Let the tag run finish. It verifies and attaches the package without publishing to npm.
5. Review the GitHub release artifact and checksum, then explicitly publish the same tag:

   ```sh
   gh workflow run release.yml \
     --repo xzycd/recuse \
     --ref main \
     -f tag=v0.8.1 \
     -f publish_npm=true
   ```

6. Verify both surfaces:

   ```sh
   gh run list --repo xzycd/recuse --workflow release.yml --limit 5
   gh release view v0.8.1 --repo xzycd/recuse
   npm view recuse@0.8.1 name version dist.integrity
   npm audit signatures
   ```

Replace `0.8.1` with the version being released. Never move a published tag or reuse an npm version. The workflow is safe to rerun for an existing tag: it skips an npm version that already exists and refreshes the GitHub assets from the same source tag.

## Publish the MCP listing

The MCP Registry hosts metadata, not the package. Publish `server.json` only after the matching npm version exists, because the registry verifies its `name` against `package.json#mcpName` in that published tarball.

```sh
mcp-publisher login github
mcp-publisher publish
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.xzycd/recuse"
```

`npm run check` keeps the package version, npm identifier, MCP name and both versions in `server.json` aligned.
