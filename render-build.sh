#!/usr/bin/env bash
# Render build step: fetch the GitHub CLI static binary into ./bin
# (server.js prepends ./bin to PATH at startup; gh authenticates via GH_TOKEN).
set -euo pipefail
GH_VERSION="2.63.2"
mkdir -p bin
curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
  | tar -xz --strip-components=2 -C bin "gh_${GH_VERSION}_linux_amd64/bin/gh"
chmod +x bin/gh
./bin/gh --version
echo "build done"
