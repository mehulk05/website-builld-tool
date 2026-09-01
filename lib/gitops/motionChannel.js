// Self-healing motion channel for GitOps sites.
//
// premium.js (the design-gen motion engine) reaches a WordPress site as the
// `g99-site-js` elementor_snippet, but that only renders if the site's g99-control
// plugin (a) imports the elementor_snippet CPT and (b) outputs it on wp_footer.
// Plugin versions differ per repo, and most don't do this yet — so before a build
// pushes, we FEATURE-DETECT the target repo's plugin and, if it can't render the
// snippet, patch that repo's plugin in the same PR (idempotent, version-bumped so
// MuPluginUpdater promotes it). When the canonical plugin gains these features the
// detection passes and this becomes a no-op — the fix retires itself.
const fs = require("fs");
const path = require("path");

const PLUGIN_REL = "web/app/mu-plugins/g99-control";

// The wp_footer emitter. Raw JS is stored in the snippet's post_content (kses
// strips a stored <script> tag when the reconcile lacks unfiltered_html); we strip
// any residual tags and wrap in a fresh <script> at output.
const FOOTER_HOOK = `
// [g99 build-tool] Emit the GitOps-managed site-wide JS snippet on the front end.
// Elementor Pro Custom Code does not render snippets created by direct DB import,
// and kses may strip a stored <script> tag, so wrap the raw JS in <script> here.
add_action('wp_footer', static function (): void {
    if (is_admin()) {
        return;
    }
    $g99_snippets = get_posts([
        'post_type'      => 'elementor_snippet',
        'post_status'    => 'publish',
        'name'           => 'g99-site-js',
        'posts_per_page' => 1,
    ]);
    foreach ($g99_snippets as $g99_snippet) {
        echo '<script>' . preg_replace('#</?script\\b[^>]*>#i', '', (string) $g99_snippet->post_content) . '</script>';
    }
}, 99);
`;

function bumpPatch(ver) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(ver);
  if (!m) return ver;
  return `${m[1]}.${m[2]}.${+m[3] + 1}`;
}

/**
 * Detect whether the cloned target repo's g99-control can render the motion
 * snippet, and patch it in place if not.
 * @param {string} repoDir  path to the cloned target repo
 * @returns {{ready:boolean, patched:boolean, changedFiles:string[], notes:string[]}}
 */
function ensureMotionChannel(repoDir) {
  const out = { ready: false, patched: false, changedFiles: [], notes: [] };
  const pluginDir = path.join(repoDir, PLUGIN_REL);
  const cfgPath = path.join(pluginDir, "gitops/src/CptSyncConfig.php");
  const mainPath = path.join(pluginDir, "g99-control.php");
  if (!fs.existsSync(cfgPath) || !fs.existsSync(mainPath)) {
    out.notes.push("g99-control plugin not found in repo — cannot ensure motion channel");
    return out;
  }
  let cfg = fs.readFileSync(cfgPath, "utf8");
  let main = fs.readFileSync(mainPath, "utf8");

  const hasSnippetType = /POST_TYPES\s*=\s*\[[^\]]*['"]elementor_snippet['"]/.test(cfg);
  const hasWpcodeType = /POST_TYPES\s*=\s*\[[^\]]*['"]wpcode['"]/.test(cfg);
  const hasFooter = /g99-site-js/.test(main) && /wp_footer/.test(main);
  if (hasSnippetType && hasWpcodeType && hasFooter) {
    out.ready = true;
    out.notes.push("plugin already renders the g99-site-js snippet — no patch needed");
    return out;
  }

  // 1) import the snippet CPTs: wpcode (primary — WPCode renders it natively)
  //    and elementor_snippet (legacy — needs the wp_footer hook below).
  const missing = [!hasSnippetType && "'elementor_snippet'", !hasWpcodeType && "'wpcode'"].filter(Boolean);
  if (missing.length) {
    const before = cfg;
    cfg = cfg.replace(/(public\s+const\s+POST_TYPES\s*=\s*\[)([^\]]*)(\]\s*;)/, (m, a, items, c) => {
      const trimmed = items.replace(/\s+$/, "").replace(/,\s*$/, "");
      return `${a}${trimmed}, ${missing.join(", ")}${c}`;
    });
    if (cfg !== before) {
      fs.writeFileSync(cfgPath, cfg);
      out.changedFiles.push(path.relative(repoDir, cfgPath).replace(/\\/g, "/"));
      out.notes.push(`added ${missing.join(" + ")} to CptSyncConfig::POST_TYPES`);
    } else {
      out.notes.push("could not locate POST_TYPES array — skipped CPT patch");
    }
  }

  // 2) output the snippet on wp_footer
  if (!hasFooter) {
    if (/Bootstrap::init\(\);/.test(main)) main = main.replace(/Bootstrap::init\(\);/, FOOTER_HOOK.trim() + "\n\nBootstrap::init();");
    else main = main.replace(/\?>\s*$/, "") + "\n" + FOOTER_HOOK.trim() + "\n";
    out.notes.push("added wp_footer output for the g99-site-js snippet");
  }

  // 3) bump the plugin version so MuPluginUpdater promotes the change
  const cur = (main.match(/G99_CONTROL_VERSION',\s*'(\d+\.\d+\.\d+)/) || main.match(/\*\s*Version:\s*(\d+\.\d+\.\d+)/) || [, "1.0.0"])[1];
  const next = bumpPatch(cur);
  main = main
    .replace(/(\*\s*Version:\s*)\d+\.\d+\.\d+/, `$1${next}`)
    .replace(/(G99_CONTROL_VERSION',\s*')\d+\.\d+\.\d+/, `$1${next}`)
    .replace(/(G99_GITOPS_VERSION',\s*')\d+\.\d+\.\d+/, `$1${next}`);
  fs.writeFileSync(mainPath, main);
  out.changedFiles.push(path.relative(repoDir, mainPath).replace(/\\/g, "/"));
  out.notes.push(`bumped g99-control ${cur} → ${next}`);

  out.patched = true;
  out.ready = true;
  return out;
}

module.exports = { ensureMotionChannel, PLUGIN_REL };
