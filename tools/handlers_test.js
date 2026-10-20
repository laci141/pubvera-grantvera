// Inline event handler test.
//
// Run: node tools/handlers_test.js
//
// main.go sends script-src-attr 'none', so an onclick=/oninput=/... attribute
// in index.html does not run: the control it sits on silently stops working.
// Handlers are wired through data-action / data-input / data-keydown and the
// delegated listeners instead. This fails on any on<event>= attribute, both in
// the markup (preceded by whitespace) and inside JS-built HTML strings
// (preceded by a quote).
"use strict";
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
if (!/data-action=/.test(html)) {
  console.error("FAIL: no data-action= found in index.html - refusing to pass silently");
  process.exit(1);
}

const re = /\son[a-z]+=|['"]on[a-z]+=/g;
const lines = html.split("\n");
let failed = 0;
lines.forEach((line, i) => {
  for (const m of line.matchAll(re)) {
    failed++;
    console.log("FAIL  index.html:" + (i + 1) + " inline handler " + JSON.stringify(m[0].trim()) + ": " + line.trim());
  }
});

if (failed) {
  console.log("\n" + failed + " inline handler(s) found");
  process.exit(1);
}
console.log("PASS  index.html has no inline on<event>= handler attribute");
