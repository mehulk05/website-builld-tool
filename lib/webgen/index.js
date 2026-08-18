// webgen — in-house design engine (replaces Stitch). Two modes:
//  • default: composeBrandKit (onboarding content) + real scraped images (vision + relevance)
//  • pure URL scrape: scrape() + extractBrandKit() — full 1:1 clone like the standalone demo
// renderPages: BrandKit -> { home, services, about, team } full HTML docs, 3 designs, AI-picked.
const { composeBrandKit, fallbackKit, themeTokens } = require("./compose.js");
const { renderPages, renderHome, renderServices, renderAbout, renderTeam, DESIGN_IDS } = require("./render.js");
const { scrape, scrapeLite } = require("./scrape.js");
const { extractBrandKit, classifyImages, sanitizeImages, classifyPool, enrichKitImages } = require("./extract.js");
module.exports = {
  composeBrandKit, fallbackKit, themeTokens, renderPages, renderHome, renderServices, renderAbout, renderTeam, DESIGN_IDS,
  scrape, scrapeLite, extractBrandKit, classifyImages, sanitizeImages, classifyPool, enrichKitImages,
};
