#!/usr/bin/env bash
# Render build step. A custom buildCommand REPLACES Render's default `npm install`,
# so we MUST install dependencies here — otherwise newly-added deps (playwright,
# @google/generative-ai) never land in node_modules and the server crashes at
# runtime with "Cannot find module". PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD avoids the
# ~150MB chromium download failing the build on the free tier; the code lazy-loads
# playwright and falls back to fetch-based scraping when the browser is absent.
set -euo pipefail

echo "▶ installing npm dependencies…"
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund
echo "✓ dependencies installed"

GH_VERSION="2.63.2"
mkdir -p bin
curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_amd64.tar.gz" \
  | tar -xz --strip-components=2 -C bin "gh_${GH_VERSION}_linux_amd64/bin/gh"
chmod +x bin/gh
./bin/gh --version
echo "build done"
