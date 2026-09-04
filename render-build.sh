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

# Chromium for Playwright.
#
# The engine drives a real browser twice: to screenshot the reference site, and
# — since a bot wall started answering 403 to plain fetches from this host — to
# read its HTML at all. Render's node runtime ships the playwright PACKAGE (it
# is a dependency) but no browser binary, so both fell back to nothing here.
#
# PLAYWRIGHT_BROWSERS_PATH=0 puts the browser inside node_modules instead of
# ~/.cache, which is what makes it survive from this build step into the running
# service. It must be set at RUN time too — Playwright looks in whichever
# location that variable names, so a mismatch hides the browser we just
# installed. It is set in render.yaml for exactly that reason.
#
# Nothing here may fail the build. A browser is an upgrade, not a requirement:
# without it the tool still builds sites, it just loses screenshots and the
# bot-wall workaround. `set -e` would turn that into a dead service, so every
# step below swallows its own failure and says so instead.
echo "--- installing chromium for playwright"
export PLAYWRIGHT_BROWSERS_PATH=0
if npx --yes playwright install chromium; then
  echo "chromium installed"
else
  echo "WARNING: chromium install failed — screenshots and the browser fallback will be unavailable"
fi

# Chromium needs system libraries (libnss3, libatk, libgbm…) that this image may
# or may not carry, and `--with-deps` cannot help: it wants apt as root, which a
# Render build does not get. So actually launch it once. Better to learn here, in
# a build log, than to have it swallowed at runtime by a try/catch and show up as
# a site generated with no visual reference.
if node -e "require('playwright').chromium.launch().then(b=>b.close()).then(()=>console.log('chromium launches'),e=>{console.log('WARNING: chromium cannot launch here —',e.message.split('\n')[0]);process.exit(0)})"; then :; else
  echo "WARNING: chromium launch check could not run"
fi

echo "build done"
