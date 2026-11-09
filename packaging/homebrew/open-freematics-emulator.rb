# Template for the cask in the Homebrew tap. The Release workflow fills in the version and
# checksums and pushes it to the tap; don't install it from here.
cask "open-freematics-emulator" do
  arch arm: "arm64", intel: "x64"

  version "@VERSION@"
  sha256 arm:   "@SHA256_ARM64@",
         intel: "@SHA256_X64@"

  url "https://github.com/ETSoftwareStudio/open-freematics-emulator/releases/download/v#{version}/open-freematics-emulator-#{version}-mac-#{arch}.dmg"
  name "Open Freematics Emulator"
  desc "Open-source app for the Freematics OBD-II Emulator MK2 (unofficial)"
  homepage "https://github.com/ETSoftwareStudio/open-freematics-emulator"

  depends_on macos: ">= :monterey"

  app "Open Freematics Emulator.app"

  zap trash: [
    "~/Library/Application Support/Open Freematics Emulator",
    "~/Library/Caches/studio.etsoftware.open-freematics-emulator",
    "~/Library/Preferences/studio.etsoftware.open-freematics-emulator.plist",
    "~/Library/Saved Application State/studio.etsoftware.open-freematics-emulator.savedState",
    "~/Library/WebKit/studio.etsoftware.open-freematics-emulator",
  ]
end
