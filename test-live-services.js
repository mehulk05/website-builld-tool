// node test-live-services.js — the service-page plan uses the live site too, not only onboarding answers.
const assert = require("assert");
process.env.WBT_NO_LISTEN = "1";
const { selectServices, liveServiceName } = require("./server.js");

// dripdocx.com (TED client 2330): its real onboarding answers and live treatment pages.
const A = {
  revenue_services: ["IV Hydration Therapy", "Botox & Dysport", "Medical Weight Loss"],
  growth_services: ["IV Hydration Therapy", "Botox & Dysport"],
  services_offered: ["Botox", "Dermal Fillers", "IV Hydration Therapy", "Medical Weight Loss", "Microneedling", "Laser Hair Removal",
    "NAD+ Injections", "Wellness Shots", "Sculptra", "PRF EZ Gel", "The Perfect Derma Peel", "Lip Enhancement", "Chemical peels",
    "Botox & Dysport", "PRF Hair Restoration"],
};
const live = ["/iv-therapy-1", "/itreatment-1", "/nad-injections", "/glp-1-weight-loss", "/botox/dysport", "/laser-hair-removal",
  "/dermal-fillers", "/services-2", "/semaglutide", "/prf-ez-gel", "/prf-hair-restoration", "/chemical-peels", "/prf-ez-gel2",
  "/sculptra1", "/nad-treatments-2", "/the-perfect-derma-peel", "/microneedling", "/skin-services", "/laser-services"];

const r = selectServices(A, undefined, live);
const names = r.services.map((s) => s.name);
console.log(names.length + " pages:", names.join(" | "));
console.log("from the live site only:", r.liveOnly.join(" | "));
assert(names.includes("The Perfect Derma Peel"), "derma peel planned (was cut by the cap of 10)");
assert(names.includes("GLP-1 Weight Loss"), "GLP-1 planned (live site only)");
assert(names.includes("Semaglutide") && names.includes("Itreatment"), "other live-only treatments planned");
assert(!r.truncated, "nothing capped");
// no duplicate of a service the answers already list
for (const dup of ["Iv Therapy", "Nad Injections", "Nad Treatments", "Botox Dysport", "Sculptra", "Prf Ez Gel", "Skin Services", "Laser Services"])
  assert(!r.liveOnly.includes(dup), "no duplicate page for " + dup);
assert.strictEqual(liveServiceName("/the-perfect-derma-peel"), "The Perfect Derma Peel");
assert.strictEqual(liveServiceName("/iv-therapy-1"), "Iv Therapy");
// without live pages it behaves as before (onboarding only)
assert.strictEqual(selectServices(A).liveOnly.length, 0);
console.log("PASS");
process.exit(0);
