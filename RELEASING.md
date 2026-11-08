# Releasing

Merging the release PR releases everything: installers for macOS, Windows and Linux on GitHub
Releases, the npm packages behind `npx open-freematics-emulator`, and the Homebrew cask. The
[Release workflow](.github/workflows/release.yml) does the work; CI runs on every push and pull
request.

## Every release

Versions come from [Conventional Commits](https://www.conventionalcommits.org/) on `main`:
`fix:` and `perf:` make a patch release, `feat:` a minor one, and a `!` (`feat!:`) a major one.
Other types (`docs:`, `ci:`, `chore:`, …) don't release on their own. Squash-merged PRs take the
PR title as the commit, so the **PR title** check holds titles to the same format.

1. Merge work into `main` as usual. release-please keeps one PR open,
   `chore(main): release X.Y.Z`, with the next version in `apps/desktop/package.json` (it versions
   the desktop app and the npm package) and the new `CHANGELOG.md` entry. CI runs on it too.
2. When you want to ship, merge that PR.
3. Watch **Actions → Release**. release-please creates the tag and a draft GitHub Release with the
   changelog as notes. The workflow then runs the checks, builds and smoke-tests the installers on
   all three OSes, builds the `fme` server for the six npm platforms and smoke-tests the npm
   packages, uploads the installers and a `SHA256SUMS.txt` and publishes the release, publishes to
   npm, and updates the Homebrew tap.

To force a version, add a commit to `main` with `Release-As: 1.2.0` in its body.

If a job fails after the release PR is merged, fix the cause and use **Re-run failed jobs** on that
run. The release stays a draft until the installers are uploaded, so nobody downloads a release
without them.

## One-time setup

### Repository

- The repo must be public before the first release: npm provenance and the download links in the
  Homebrew cask need it.
- Settings → Actions → General → **Allow GitHub Actions to create and approve pull requests** must
  be on, or release-please can't open its PR.
- Optional: add a tag ruleset for `v*` so only maintainers and the release workflow can create
  release tags.

### npm

`npx open-freematics-emulator` installs seven packages, all at the release's version:

- `open-freematics-emulator`: the launcher (`cli.mjs`) and the built web app. Its
  `optionalDependencies` list the six platform packages.
- `open-freematics-emulator-<os>-<cpu>` for `darwin-arm64`, `darwin-x64`, `linux-arm64`,
  `linux-x64`, `win32-arm64` and `win32-x64`: the Rust `fme` binary, with `os`, `cpu` and, on
  Linux, `libc: glibc`, so npm installs only the one for the user's machine.

The launcher finds the platform package, starts `fme` with the user's flags and `--web-root` set to
its web app, and opens the browser. The Release workflow builds each binary on its own runner
(macOS x64 cross-compiles on arm64), then publishes the platform packages before the main one. A
version already on npm is skipped, so **Re-run failed jobs** can finish a half-done publish.

Publishing goes through npm's trusted publishing: npmjs.com trusts
`ETSoftwareStudio/open-freematics-emulator`'s `release.yml` (with **Allow npm publish** on), so no
npm token is stored anywhere. Configure it for **each of the seven packages** under the package →
Settings → Trusted publishing.

Trusted publishing only works for a package that already exists, so before the first release that
ships them, create the six platform packages from your own npm account: for each name, publish a
placeholder `0.0.0` from an empty directory whose `package.json` holds just that `name` and
`"version": "0.0.0"` (`npm publish --access public`), then add the trusted publisher. The main
package pins exact versions, so nobody installs a placeholder. Do the same if a package is ever
recreated.

Check the packages locally with `vp run npm:stage` (main package plus this machine's platform
package; `--target <rust triple>` stages another one if its Rust target is installed) and
`vp run npm:smoke`, which installs the tarballs as npx would and runs them.

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

### macOS signing and notarization

Release builds sign the Mac app with a Developer ID and notarize it when these secrets exist, so it
opens without a Gatekeeper warning. Without them the app is ad-hoc signed and users must click
**Open Anyway** in System Settings → Privacy & Security.

1. **Developer ID Application certificate.** Creating one needs the Account Holder role on the
   team whose name users should see (ET Software Studio Inc.). In Xcode → Settings → Accounts →
   Manage Certificates, click **+ → Developer ID Application**. Then in Keychain Access, export
   the certificate together with its private key as a `.p12` with a password, and store both:

   ```sh
   base64 -i DeveloperID.p12 | gh secret set MAC_CERTIFICATE
   gh secret set MAC_CERTIFICATE_PASSWORD
   ```

2. **App Store Connect API key** for notarization. In App Store Connect → Users and Access →
   Integrations → App Store Connect API, generate a team key with the **Developer** role. Download
   the `.p8` (only possible once) and note the Key ID and the Issuer ID above the list:

   ```sh
   gh secret set APPLE_API_KEY_P8 < AuthKey_XXXXXXXXXX.p8
   gh secret set APPLE_API_KEY_ID
   gh secret set APPLE_API_ISSUER
   ```

3. **Try it without releasing:** `gh workflow run desktop.yml -f sign=true`, download the
   `desktop-macOS` artifact, mount the `.dmg` and run
   `spctl -a -vv "/Volumes/…/Open Freematics Emulator.app"`. It should say
   `accepted` and `source=Notarized Developer ID`.

Delete the `.p12` and `.p8` from your disk once they are stored as secrets.

## Later

- **Windows signing.** The installer is unsigned, so SmartScreen warns on first launch. Azure
  Trusted Signing is the cheapest option electron-builder supports.
- **Official `homebrew/cask`.** Needs the notarized app; then the tap is optional.
- **winget.** Submit the first version by hand with
  `wingetcreate new <url of the .exe from the release>`, which opens a pull request on
  `microsoft/winget-pkgs`. Later versions can be automated with `wingetcreate update`.
- **AUR.** An `open-freematics-emulator-bin` PKGBUILD that repackages the `.deb` or AppImage.
- **Chocolatey and an apt repository** after those.
