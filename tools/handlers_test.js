// Inline event handler test.
//
// Run: node tools/handlers_test.js
//
// main.go sends script-src-attr 'none', so an onclick=/oninput=/... attribute
// in index.html does not run: the control it sits on silently stops working.
// Handlers are wired through data-action / data-input / data-keydown and the
// delegated listeners instead. This fails on any on<event>= attribute, both in
// the markup (preceded by whitespace) and inside JS-built HTML strings
// (preceded by a quote). It also fails on any <script> tag in index.html that
// has no src attribute or carries an inline body.
"use strict";
const fs = require("fs");
const path = require("path");

function read(name) {
  return fs.readFileSync(path.join(__dirname, "..", name), "utf8").replace(/\r\n/g, "\n");
}

const html = read("index.html");
if (!/data-action=/.test(html)) {
  console.error("FAIL: no data-action= found in index.html - refusing to pass silently");
  process.exit(1);
}

// The JS-built HTML strings live in app.js and app-module.js now, so they are
// scanned too. A missing file fails rather than being skipped.
const sources = { "index.html": html };
for (const name of ["app.js", "app-module.js"]) {
  try {
    sources[name] = read(name);
  } catch (e) {
    console.error("FAIL: cannot read " + name + " - " + e.message);
    process.exit(1);
  }
}

const re = /\son[a-z]+=|['"]on[a-z]+=/g;
let failed = 0;
for (const [name, text] of Object.entries(sources)) {
  text.split("\n").forEach((line, i) => {
    for (const m of line.matchAll(re)) {
      failed++;
      console.log("FAIL  " + name + ":" + (i + 1) + " inline handler " + JSON.stringify(m[0].trim()) + ": " + line.trim());
    }
  });
}

if (failed) {
  console.log("\n" + failed + " inline handler(s) found");
  process.exit(1);
}
console.log("PASS  index.html, app.js and app-module.js have no inline on<event>= handler attribute");

// main.go sends script-src 'self' https://cdn.jsdelivr.net without
// 'unsafe-inline', so an inline <script> block does not run. Every <script>
// tag must load a file and carry no body.
const tagRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let tags = 0;
let bad = 0;
for (const m of html.matchAll(tagRe)) {
  tags++;
  const line = html.slice(0, m.index).split("\n").length;
  if (!/\ssrc\s*=/i.test(m[1])) {
    bad++;
    console.log("FAIL  index.html:" + line + " <script> without a src attribute: " + m[0].split("\n")[0].trim());
  } else if (m[2].trim() !== "") {
    bad++;
    console.log("FAIL  index.html:" + line + " <script src> with an inline body: " + m[0].split("\n")[0].trim());
  }
}
if (tags === 0) {
  console.error("FAIL: no <script> tag found in index.html - refusing to pass silently");
  process.exit(1);
}
if (bad) {
  console.log("\n" + bad + " inline <script> block(s) found");
  process.exit(1);
}
console.log("PASS  every <script> tag in index.html (" + tags + ") has a src attribute and no body");
