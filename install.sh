#!/usr/bin/env sh
set -e

# safescript installer — installs Deno (if needed) then the safescript CLI.
# Works on macOS (arm64/x86_64) and Ubuntu/Debian (x86_64/arm64).

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

info() { printf "${GREEN}%s${NC}\n" "$*"; }
err() { printf "${RED}%s${NC}\n" "$*" >&2; exit 1; }

if command -v deno >/dev/null 2>&1; then
    info "Deno found: $(deno --version | head -1)"
else
    info "Installing Deno..."
    if command -v brew >/dev/null 2>&1; then
        brew install deno
    else
        curl -fsSL https://deno.land/install.sh | sh
        export PATH="$HOME/.deno/bin:$PATH"
    fi
    info "Deno installed: $(deno --version | head -1)"
fi

info "Installing safescript CLI..."
deno install --allow-read --allow-net --global --force --name safescript jsr:@uri/safescript/cli

info "safescript installed!"
printf "Run: ${GREEN}safescript --help${NC}\n"
