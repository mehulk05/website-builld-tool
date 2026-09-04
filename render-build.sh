#!/usr/bin/env bash
# Render build step.
set -euo pipefail

# Dependencies FIRST, and explicitly.
#
# Naming a buildCommand REPLACES Render's default `npm install` — it does not run
# alongside it. This script never installed anything, so for as long as it has
# existed the service has been running on whatever node_modules survived in
# Render's build cache from before it. Everything already in the cache kept
# working, which is why nobody noticed; but a dependency ADDED after that point
# could never arrive, however many times the service was redeployed. `pg` was
# added for the generation-history database and the deployed tool answered
# "Cannot find module 'pg'" through deploy after deploy, on both hosts, because
# no install step existed to fetch it.
#
# `npm ci` because a lockfile is committed: it installs exactly what the lock
# pins and refuses to drift. It also wipes node_modules first, so a stale cached
# tree cannot mask a missing dependency ever again.
echo "--- installing node dependencies"
npm ci --omit=dev --no-audit --no-fund
# Prove the two lazily-required modules resolve. Both are required from INSIDE a
# function (pg in lib/history/db.js, cheerio in lib/designgen/index.js), so
# neither one missing stops the server from booting — pg turns history silently
# off, and cheerio waits to throw until a build has already generated its pages.
# A missing dependency has to fail here, in a build log, not there.
node -e "for (const m of ['pg','cheerio','playwright']) { require.resolve(m); console.log('  ok', m); }"

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
