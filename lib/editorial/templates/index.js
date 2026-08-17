import * as editorial from "./editorial.js";
import * as bold from "./bold.js";
import * as minimal from "./minimal.js";

export const TEMPLATES = { editorial, bold, minimal };
export const TEMPLATE_IDS = Object.keys(TEMPLATES);
// vibes shown to the AI so it can pick the best-fit design for a brand
export const TEMPLATE_VIBES = TEMPLATE_IDS.map((id) => `"${id}" = ${TEMPLATES[id].meta.vibe}`).join("\n");

// render using the AI-chosen layout (kit.layout), falling back to editorial
export function render(kit) {
  const t = TEMPLATES[kit.layout] || TEMPLATES.editorial;
  return t.render(kit);
}
