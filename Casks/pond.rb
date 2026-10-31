cask "pond" do
  arch arm: "arm64", intel: "x64"

  version "2.1.0"
  sha256 arm:   "95904264467b55f79d32f3bb415cf0fbefc075972517960ce5b2af9316390229",
         intel: "cdfa481b6021c578fb6530e29ea6a56f03f38fba8741b947818319fb4fa8d90f"

  url "https://github.com/raphaelsalaja/pond/releases/download/v#{version}/Pond-#{version}-#{arch}.dmg"
  name "Pond"
  desc "Local-first archive for things you save from the web"
  homepage "https://github.com/raphaelsalaja/pond"

  livecheck do
    url :url
    strategy :github_latest
  end

  depends_on macos: :ventura

  app "Pond.app"

  zap trash: [
    "~/Library/Application Support/pond",
    "~/Library/Logs/pond",
    "~/Library/Preferences/so.pond.desktop.plist",
  ]
end
