#!/usr/bin/env bash
# Betopia Web Builder — one-shot setup.
# Idempotent: checks each prerequisite, installs only what's missing.
set -euo pipefail

echo "=== Betopia Web Builder Setup ==="
echo ""

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
have() { command -v "$1" &>/dev/null; }

OS="$(uname -s)"
SUDO=""
if [ "$(id -u)" -ne 0 ] && have sudo; then SUDO="sudo"; fi

note()  { printf '  \033[36m%s\033[0m\n' "$*"; }
ok()    { printf '  \033[32m✓ %s\033[0m\n' "$*"; }
warn()  { printf '  \033[33m! %s\033[0m\n' "$*"; }

# Detect Linux package manager
PM=""
if [ "$OS" = "Linux" ]; then
  for c in apt-get dnf pacman zypper apk; do
    if have "$c"; then PM="$c"; break; fi
  done
fi

pm_install() {
  # pm_install <apt pkgs...> -- maps to the active manager where names match.
  case "$PM" in
    apt-get) $SUDO apt-get update -y && $SUDO apt-get install -y "$@" ;;
    dnf)     $SUDO dnf install -y "$@" ;;
    pacman)  $SUDO pacman -Sy --noconfirm "$@" ;;
    zypper)  $SUDO zypper install -y "$@" ;;
    apk)     $SUDO apk add "$@" ;;
    *)       return 1 ;;
  esac
}

# ---------------------------------------------------------------------------
# 1. base tooling (curl/wget/file/build) — needed by later installers
# ---------------------------------------------------------------------------
echo "[1/5] Base build tools"
if [ "$OS" = "Linux" ]; then
  if [ -z "$PM" ]; then
    warn "No supported package manager found (apt/dnf/pacman/zypper/apk). Install build tools manually."
  else
    case "$PM" in
      apt-get) pm_install build-essential curl wget file ;;
      dnf)     pm_install gcc gcc-c++ make curl wget file ;;
      pacman)  pm_install base-devel curl wget file ;;
      zypper)  pm_install -t pattern devel_basis || pm_install gcc gcc-c++ make; pm_install curl wget file ;;
      apk)     pm_install build-base curl wget file ;;
    esac
    ok "base tools present"
  fi
elif [ "$OS" = "Darwin" ]; then
  if ! xcode-select -p &>/dev/null; then
    note "Installing Xcode Command Line Tools..."
    xcode-select --install || true
    warn "Finish the Xcode CLT GUI install if prompted, then re-run this script."
  else
    ok "Xcode Command Line Tools present"
  fi
fi
echo ""

# ---------------------------------------------------------------------------
# 2. Tauri system libraries (Linux only; macOS/Windows need none beyond CLT)
# ---------------------------------------------------------------------------
echo "[2/5] Tauri system libraries"
if [ "$OS" = "Linux" ] && [ -n "$PM" ]; then
  case "$PM" in
    apt-get)
      pm_install libwebkit2gtk-4.1-dev libxdo-dev libssl-dev \
                 libayatana-appindicator3-dev librsvg2-dev || \
        warn "Some apt packages failed — check names for your distro release." ;;
    dnf)
      pm_install webkit2gtk4.1-devel openssl-devel libxdo-devel \
                 libayatana-appindicator-gtk3-devel librsvg2-devel || warn "dnf deps partial." ;;
    pacman)
      pm_install webkit2gtk-4.1 openssl libxdo \
                 libayatana-appindicator librsvg || warn "pacman deps partial." ;;
    zypper)
      pm_install webkit2gtk3-soup2-devel libopenssl-devel libxdo-devel \
                 libayatana-appindicator3-1 librsvg-devel || warn "zypper deps partial." ;;
    *)  warn "No Tauri dep recipe for '$PM'. See https://tauri.app/start/prerequisites/" ;;
  esac
  ok "Tauri libraries installed"
else
  note "Skipping (not Linux, or no package manager)."
fi
echo ""

# ---------------------------------------------------------------------------
# 3. Rust toolchain
# ---------------------------------------------------------------------------
echo "[3/5] Rust toolchain"
if have rustc && have cargo; then
  ok "rust $(rustc --version | awk '{print $2}') present"
else
  note "Installing Rust via rustup..."
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
  # shellcheck disable=SC1091
  [ -f "$HOME/.cargo/env" ] && source "$HOME/.cargo/env"
  ok "rust installed"
fi
echo ""

# ---------------------------------------------------------------------------
# 4. JS runtime — prefer Bun, fall back to Node 18+
# ---------------------------------------------------------------------------
echo "[4/5] JavaScript runtime"
JS_PM=""
if have bun; then
  ok "bun $(bun --version) present"
  JS_PM="bun"
elif have node; then
  NODE_MAJOR="$(node -v | sed 's/v\([0-9]*\).*/\1/')"
  if [ "$NODE_MAJOR" -ge 18 ]; then
    ok "node $(node -v) present"
    JS_PM="npm"
  else
    warn "node $(node -v) is too old (need 18+). Installing Bun..."
  fi
fi

if [ -z "$JS_PM" ]; then
  note "Installing Bun (https://bun.sh)..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  if have bun; then ok "bun $(bun --version) installed"; JS_PM="bun"; else
    warn "Bun install did not land on PATH. Open a new shell or install Node 18+ manually."
    exit 1
  fi
fi
echo ""

# ---------------------------------------------------------------------------
# 5. Project dependencies
# ---------------------------------------------------------------------------
echo "[5/5] Project dependencies"
cd "$(dirname "$0")"
if [ "$JS_PM" = "bun" ]; then
  bun install
else
  # vite@8 outpaces some plugin peer ranges; npm's strict resolver rejects it.
  # Bun tolerates it (project is Bun-first), so mirror that for npm.
  npm install --legacy-peer-deps
fi
ok "dependencies installed"
echo ""

# ---------------------------------------------------------------------------
echo "=== Setup complete! ==="
echo ""
echo "Run in development:"
echo "  $JS_PM run tauri:dev"
echo ""
echo "Build for production:"
echo "  $JS_PM run tauri:build"
echo ""
