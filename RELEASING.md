# Releasing

Releases are built from an annotated tag that already belongs to `main`. The release workflow rebuilds the package on a GitHub hosted Node 24 runner, runs the full offline suite, audits production dependencies, verifies dependency signatures and attestations, creates a checksum, and attaches the tarball and checksum to a GitHub release.

Publishing to npm is a separate, explicit choice in the same workflow. A pushed tag creates or refreshes the GitHub release but does not publish to npm. This keeps an accidental tag from consuming an immutable npm version.

## One time npm setup

The first publication needs an npm automation token because a package must exist before its trusted publisher can be configured.

1. Sign in to npm with two factor authentication and create a granular automation token that can publish the initial `recuse` package.
2. Store it as the `NPM_TOKEN` Actions secret:

   ```sh
   gh secret set NPM_TOKEN --repo xzycd/recuse
   ```

3. After the first version is published, configure the repository workflow as the package's trusted publisher:

   ```sh
   npm trust github recuse \
     --repository xzycd/recuse \
     --file release.yml \
     --allow-publish \
     --yes
   ```

4. Delete the long lived token from GitHub after trusted publishing works:

   ```sh
   gh secret delete NPM_TOKEN --repo xzycd/recuse
   ```

5. In the npm package settings, require two factor authentication and disallow token publishing. The trusted GitHub workflow continues to work through short lived OIDC credentials.

The workflow has `id-token: write`, uses a GitHub hosted runner, and calls `npm publish --provenance --access public`. The package metadata also requires provenance and pins the public npm registry.

## Release a version

1. Change the version and changelog in a pull request.
2. Wait for the Node 22 and Node 24 checks, then merge the pull request into `main`.
3. Update the local protected branch and create an annotated tag whose value exactly matches `package.json`:

   ```sh
   git switch main
   git pull --ff-only origin main
   git tag -a v0.7.0 -m "release 0.7.0"
   git push origin v0.7.0
   ```

4. Let the tag run finish. It verifies and attaches the package without publishing to npm.
5. Review the GitHub release artifact and checksum, then explicitly publish the same tag:

   ```sh
   gh workflow run release.yml \
     --repo xzycd/recuse \
     --ref main \
     -f tag=v0.7.0 \
     -f publish_npm=true
   ```

6. Verify both surfaces:

   ```sh
   gh run list --repo xzycd/recuse --workflow release.yml --limit 5
   gh release view v0.7.0 --repo xzycd/recuse
   npm view recuse@0.7.0 name version dist.integrity
   npm audit signatures
   ```

Replace `0.7.0` with the version being released. Never move a published tag or reuse an npm version. The workflow is safe to rerun for an existing tag: it skips an npm version that already exists and refreshes the GitHub assets from the same source tag.
