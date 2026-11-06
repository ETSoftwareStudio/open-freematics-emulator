# Releasing

One tag releases everything: installers for macOS, Windows and Linux on GitHub Releases, the npm
package behind `npx open-freematics-emulator`, and the Homebrew cask. The
[Release workflow](.github/workflows/release.yml) does the work; CI runs on every push and pull
request.

## Every release

1. Set `version` in `apps/desktop/package.json`. It versions the desktop app and the npm package.
2. Commit it (`chore: release 0.2.0`), push `main`, and wait for CI to pass.
3. Tag and push the tag:

   ```sh
   git tag v0.2.0
   git push origin v0.2.0
   ```

4. Watch **Actions → Release**. It runs the checks, builds and smoke-tests the installers on all
   three OSes, smoke-tests the npm package, publishes the GitHub Release with a `SHA256SUMS.txt`,
   publishes to npm, and updates the Homebrew tap.

A version with a suffix (`0.2.0-beta.1`) is a prerelease: a GitHub prerelease, the `next` tag on
npm, and no Homebrew update.

If a job fails after the GitHub Release exists, fix the cause and use **Re-run failed jobs**. To
start over, delete the release and the tag on GitHub, then tag again.

## One-time setup

### Repository

- The repo must be public before the first release: npm provenance and the download links in the
  Homebrew cask need it.
- Optional: add a tag ruleset for `v*` so only maintainers can create release tags.

### npm

npm's trusted publishing lets the Release workflow publish without a stored token, but it can only
be turned on for a package that already exists. So the first version goes out with a token:

1. Sign in to [npmjs.com](https://www.npmjs.com) with two-factor authentication on.
2. Create a granular access token with read and write access to packages, and add it to the repo
   as the Actions secret `NPM_TOKEN` (Settings → Secrets and variables → Actions).
3. Release the first version as above.
4. On npmjs.com, open the `open-freematics-emulator` package → Settings → Trusted publishing, and
   add GitHub Actions with organization `ETSoftwareStudio`, repository
   `open-freematics-emulator` and workflow `release.yml`.
5. Delete the `NPM_TOKEN` secret and the token. Optionally set the package to require two-factor
   authentication and disallow tokens.

Check a staged package locally with `vp run npm:stage` and `vp run npm:smoke`.

### Homebrew tap

1. Create a public repo `ETSoftwareStudio/homebrew-tap` (the `homebrew-` prefix is required).
2. Create a fine-grained personal access token with resource owner `ETSoftwareStudio`, access to
   `homebrew-tap` only, and **Contents: Read and write**. The organization may need to allow
   fine-grained tokens first (Organization settings → Personal access tokens).
3. In this repo, add the Actions secret `HOMEBREW_TAP_TOKEN` with that token and the Actions
   variable `HOMEBREW_TAP` set to `ETSoftwareStudio/homebrew-tap`.

The Release workflow skips the tap while `HOMEBREW_TAP` is unset. Users install with:

```sh
brew install --cask etsoftwarestudio/tap/open-freematics-emulator
```

The cask template is [packaging/homebrew](packaging/homebrew/open-freematics-emulator.rb).

## Later

- **Code signing.** The apps are unsigned, so macOS Gatekeeper and Windows SmartScreen warn on
  first launch. An Apple Developer ID (99 USD a year) with notarization removes the macOS warning
  and is required for the official `homebrew/cask`; electron-builder signs when `CSC_LINK`,
  `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` are set and
  `identity: null` is removed from `apps/desktop/scripts/dist.ts`.
- **winget.** Submit the first version by hand with
  `wingetcreate new <url of the .exe from the release>`, which opens a pull request on
  `microsoft/winget-pkgs`. Later versions can be automated with `wingetcreate update`.
- **AUR.** An `open-freematics-emulator-bin` PKGBUILD that repackages the `.deb` or AppImage.
- **Chocolatey and an apt repository** after those.
