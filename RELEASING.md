# Releasing

Merging the release PR publishes a GitHub Release with the changelog and the desktop installers,
the npm packages behind `npx open-freematics-emulator`, and the Homebrew cask. The
[Release workflow](.github/workflows/release.yml) does the work; it builds the installers by
calling the [Desktop (Tauri) workflow](.github/workflows/desktop-tauri.yml) with signing on. CI
runs on every push and pull request.

## Every release

Versions come from [Conventional Commits](https://www.conventionalcommits.org/) on `main`:
`fix:` and `perf:` make a patch release, `feat:` a minor one, and a `!` (`feat!:`) a major one.
Other types (`docs:`, `ci:`, `chore:`, …) don't release on their own. Squash-merged PRs take the
PR title as the commit, so the **PR title** check holds titles to the same format.

1. Merge work into `main` as usual. release-please keeps one PR open,
   `chore(main): release X.Y.Z`, with the next version in `apps/desktop-tauri/package.json` (it
   versions the desktop app, through `tauri.conf.json`, the npm packages and the About popover)
   and the new `CHANGELOG.md` entry. CI runs on it too.
2. When you want to ship, merge that PR.
3. Watch **Actions → Release**. release-please creates the tag and a draft GitHub Release with the
   changelog as notes. The workflow then runs the checks and, in parallel:
   - builds, signs (macOS) and smoke-tests the desktop app on the six targets, and
   - builds the `fme` server for the six npm platforms and smoke-tests the npm packages.

   Once both are done it uploads the installers with a `SHA256SUMS.txt` to the draft and publishes
   it, then publishes to npm and updates the Homebrew tap.

Each release carries these installers, named `open-freematics-emulator-<version>-<platform>`:

| Platform         | Files                                       |
| ---------------- | ------------------------------------------- |
| macOS arm64, x64 | `mac-arm64.dmg`, `mac-x64.dmg`              |
| Windows x64      | `win-x64-setup.exe` (NSIS), `win-x64.msi`   |
| Windows arm64    | `win-arm64-setup.exe`, `win-arm64.msi`      |
| Linux x64, arm64 | `linux-<arch>.deb`, `linux-<arch>.AppImage` |

The Desktop (Tauri) workflow renames Tauri's bundles (`Open Freematics Emulator_<version>_…`) to
these names, because GitHub turns the spaces into dots on release assets. The Homebrew cask's `url`
uses the macOS names.

To force a version, add a commit to `main` with `Release-As: 1.2.0` in its body.

If a job fails after the release PR is merged, fix the cause and use **Re-run failed jobs** on that
run. The release stays a draft until every installer and npm package is built and smoke-tested.

## One-time setup

### Repository

- The repo must be public before the first release: npm provenance needs it.
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

The Release workflow writes the cask from the template with the version and the two DMGs'
checksums and pushes it to the tap; without the `HOMEBREW_TAP` variable it skips that. Users
install with:

```sh
brew install --cask etsoftwarestudio/tap/open-freematics-emulator
```

The cask template is [packaging/homebrew](packaging/homebrew/open-freematics-emulator.rb).

### macOS signing and notarization

The Desktop (Tauri) workflow signs the Mac app with a Developer ID and notarizes it when it runs
with `sign` (the Release workflow always sets it) and these secrets exist, so it opens without a
Gatekeeper warning. Without them the app is ad-hoc signed and users must click **Open Anyway** in
System Settings → Privacy & Security. Only release and manually dispatched runs see the secrets:
push and pull request builds are never signed. Signed builds skip the Rust cache.

1. **Developer ID Application certificate.** Creating one needs the Account Holder role on the
   team whose name users should see (ET Software Studio Inc.). In Xcode → Settings → Accounts →
   Manage Certificates, click **+ → Developer ID Application**. Then in Keychain Access, export
   the certificate together with its private key as a `.p12` with a password, and store both:

   ```sh
   base64 -i DeveloperID.p12 | gh secret set MAC_CERTIFICATE
   gh secret set MAC_CERTIFICATE_PASSWORD
   gh secret set MAC_SIGNING_IDENTITY   # "Developer ID Application: <team name> (<team id>)"
   ```

2. **App Store Connect API key** for notarization. In App Store Connect → Users and Access →
   Integrations → App Store Connect API, generate a team key with the **Developer** role. Download
   the `.p8` (only possible once) and note the Key ID and the Issuer ID above the list:

   ```sh
   gh secret set APPLE_API_KEY_P8 < AuthKey_XXXXXXXXXX.p8
   gh secret set APPLE_API_KEY_ID
   gh secret set APPLE_API_ISSUER
   ```

3. **Try it:** `gh workflow run desktop-tauri.yml -f sign=true`, download the
   `desktop-tauri-aarch64-apple-darwin` artifact, mount the `.dmg` and run
   `spctl -a -vv "/Volumes/…/Open Freematics Emulator.app"`. It should say
   `accepted` and `source=Notarized Developer ID`.

Delete the `.p12` and `.p8` from your disk once they are stored as secrets.

## Later

- **Windows signing.** The installer is unsigned, so SmartScreen warns on first launch. Azure
  Trusted Signing works through Tauri's `signCommand`.
- **Official `homebrew/cask`.** Needs the notarized app; then the tap is optional.
- **winget.** Submit the first version by hand with
  `wingetcreate new <url of the .exe from the release>`, which opens a pull request on
  `microsoft/winget-pkgs`. Later versions can be automated with `wingetcreate update`.
- **AUR.** An `open-freematics-emulator-bin` PKGBUILD that repackages the `.deb` or AppImage.
- **Chocolatey and an apt repository** after those.
