// Pictures a reviewer attached, on their way to the page.
//
// The widget sends the image inline in the feedback batch (base64, downscaled
// in the browser first) because it cannot talk to this tool directly — it lives
// on the client's WordPress site and everything goes through that site's REST
// proxy. So the bytes arrive with the note, and this is where they land.
//
// Where they land MATTERS and is worth being honest about: the file is written
// here and served from this tool's own public URL, which the patched page then
// hotlinks. That is the same arrangement the generated sites already use for
// every photo taken from the reference site, so it is not a new kind of
// dependency — but it does mean the tool has to stay reachable for the picture
// to keep loading. Putting it in the site's own media library instead would be
// better, and cannot be done from here: the reconciler only resolves
// "media:<ref>" in structured image fields, never inside an html widget's
// markup, which is exactly where these pictures live.
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DIR = path.join(__dirname, "..", "..", "generated", "feedback-uploads");
const MAX_BYTES = 6 * 1024 * 1024;

// Magic numbers, not the declared mime: the browser's label is a claim, the
// first bytes are evidence. A file that says png and is not one would end up
// on a client's live site.
function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: "png", mime: "image/png" };
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: "jpg", mime: "image/jpeg" };
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return { ext: "gif", mime: "image/gif" };
  if (buf.slice(0, 4).toString("ascii") === "RIFF" && buf.slice(8, 12).toString("ascii") === "WEBP") return { ext: "webp", mime: "image/webp" };
  return null;
}

/**
 * Write one attached picture and return the URL the page should point at.
 *
 * @param {{dataUrl: string, filename: string}} image
 * @param {string} publicBase  this tool's public origin
 * @returns {{url: string, file: string, bytes: number}|null}
 */
function store(image, publicBase) {
  if (!image || !image.dataUrl) return null;
  let buf;
  try { buf = Buffer.from(String(image.dataUrl).replace(/^data:[^;]+;base64,/, ""), "base64"); }
  catch (e) { return null; }
  if (!buf.length || buf.length > MAX_BYTES) return null;
  const kind = sniff(buf);
  if (!kind) return null;

  fs.mkdirSync(DIR, { recursive: true });
  const base = String(image.filename || "image").replace(/\.[A-Za-z0-9]+$/, "")
    .replace(/[^A-Za-z0-9_-]/g, "").slice(0, 40) || "image";
  const name = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}-${base}.${kind.ext}`;
  const file = path.join(DIR, name);
  fs.writeFileSync(file, buf);
  const origin = String(publicBase || "").replace(/\/$/, "");
  return { url: `${origin}/feedback-uploads/${name}`, file, name, bytes: buf.length, mime: kind.mime };
}

/** Serve one back. Name is validated against the same shape store() writes. */
function read(name) {
  if (!/^[A-Za-z0-9_-]+\.(png|jpg|gif|webp)$/.test(String(name))) return null;
  const f = path.join(DIR, name);
  if (!fs.existsSync(f)) return null;
  const ext = name.split(".").pop().toLowerCase();
  const mime = ext === "png" ? "image/png" : ext === "gif" ? "image/gif" : ext === "webp" ? "image/webp" : "image/jpeg";
  return { buf: fs.readFileSync(f), mime };
}

module.exports = { store, read, sniff, DIR, MAX_BYTES };
