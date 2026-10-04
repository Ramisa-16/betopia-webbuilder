#!/usr/bin/env bash
set -e

REPO="betopia-ai/betopia-webbuilder-releases"
BASE="https://github.com/${REPO}/releases/latest/download"
API="https://api.github.com/repos/${REPO}/releases/latest"

detect_os() {
  case "$(uname -s)" in
    Linux*)
      if command -v dpkg &>/dev/null; then echo "deb"
      elif command -v rpm &>/dev/null; then echo "rpm"
      else echo "appimage"
      fi ;;
    Darwin*) echo "macos" ;;
    *)
      echo "Unsupported OS: $(uname -s)" >&2
      exit 1 ;;
  esac
}

get_asset_name() {
  curl -fsSL "$API" | grep -o "\"name\":\"$1\"" | head -1 | cut -d'"' -f4
}

install_linux_deb() {
  echo "Downloading .deb..."
  NAME=$(get_asset_name "Betopia Coder_[^\"]*\.deb")
  TMP=$(mktemp /tmp/betopia-XXXXXX.deb)
  curl -fsSL "${BASE}/${NAME}" -o "$TMP"
  sudo dpkg -i "$TMP"
  rm -f "$TMP"
}

install_linux_rpm() {
  echo "Downloading .rpm..."
  NAME=$(get_asset_name "Betopia Coder-[^\"]*\.rpm")
  TMP=$(mktemp /tmp/betopia-XXXXXX.rpm)
  curl -fsSL "${BASE}/${NAME}" -o "$TMP"
  sudo rpm -i "$TMP"
  rm -f "$TMP"
}

install_linux_appimage() {
  echo "Downloading AppImage..."
  NAME=$(curl -fsSL "$API" | grep -o '"name":"Betopia Coder_[^"]*\.AppImage"' | grep -v '\.tar' | head -1 | cut -d'"' -f4)
  DEST="$HOME/.local/bin/betopia-coder.AppImage"
  mkdir -p "$HOME/.local/bin"
  curl -fsSL "${BASE}/${NAME}" -o "$DEST"
  chmod +x "$DEST"
  echo "Run: $DEST"
}

install_macos() {
  echo "Downloading .dmg..."
  NAME=$(get_asset_name "Betopia Coder[^\"]*\.dmg")
  TMP=$(mktemp /tmp/betopia-XXXXXX.dmg)
  curl -fsSL "${BASE}/${NAME}" -o "$TMP"
  MOUNT=$(hdiutil attach "$TMP" -nobrowse -quiet | tail -1 | awk '{print $NF}')
  cp -r "$MOUNT/Betopia Coder.app" /Applications/
  hdiutil detach "$MOUNT" -quiet
  rm -f "$TMP"
  echo "Installed to /Applications/Betopia Coder.app"
}

OS=$(detect_os)
echo "Betopia Coder — installing for: $OS"

case "$OS" in
  deb)      install_linux_deb ;;
  rpm)      install_linux_rpm ;;
  appimage) install_linux_appimage ;;
  macos)    install_macos ;;
esac

echo "Done! Betopia Coder installed."
