// Toolbar wrap test (W1-W5): the result toolbar (.meta-row) wraps instead of
// pushing the page sideways, and long text may break anywhere.
//
// Run: node tools/toolbar_wrap_test.js
//
// CSS-source check: index.html's <style> block is read as text, comments are
// dropped and the @media blocks are split off by brace matching. This is NOT a
// layout test: scrollWidth and the open-menu position at 343-1366 px are
// verified with the Playwright script.
"use strict";
const fs = require("fs");
const path = require("path");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");

let ran = 0;
let failed = 0;
function check(label, ok) {
  ran++;
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}
function refuse(what) {
  console.error("FAIL: " + what + " not found in index.html - refusing to pass silently");
  process.exit(1);
}

const styleStart = html.indexOf("<style>");
const styleEnd = html.indexOf("</style>");
if (styleStart < 0 || styleEnd < styleStart) refuse("the <style> block");
const style = html.slice(styleStart + "<style>".length, styleEnd).replace(/\/\*[^]*?\*\//g, "");

// Bodies of every @media block whose head matches headRe (brace-matched), plus
// the CSS left without them.
function mediaSplit(css, headRe) {
  const re = new RegExp(headRe.source, "g");
  const bodies = [];
  let rest = "", last = 0, m;
  while ((m = re.exec(css))) {
    let depth = 1, i = re.lastIndex;
    for (; i < css.length && depth; i++) depth += css[i] === "{" ? 1 : css[i] === "}" ? -1 : 0;
    bodies.push(css.slice(re.lastIndex, i - 1));
    rest += css.slice(last, m.index);
    last = i;
    re.lastIndex = i;
  }
  return { bodies: bodies, rest: rest + css.slice(last) };
}
// Declarations of every rule whose selector list contains `sel`, joined with
// ";" and without whitespace.
function decls(css, sel) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
    .filter(m => m[1].split(",").map(s => s.trim().replace(/\s+/g, " ")).includes(sel))
    .map(m => m[2]).join(";").replace(/\s+/g, "");
}
const has = (d, prop) => new RegExp("(^|;)" + prop.replace(/[()%.]/g, "\\$&") + "(;|$)").test(d);

const base = mediaSplit(style, /@media[^{]*\{/).rest;
const mobileSplit = mediaSplit(style, /@media\s*\(\s*max-width:\s*768px\s*\)\s*\{/);
const mobile = mobileSplit.bodies.join("\n");
const row = decls(base, ".meta-row");
if (!row) refuse("the base .meta-row rule");
const meta = decls(base, ".meta");
if (!meta) refuse("the base .meta rule");
const group = decls(base, ".dl-group");
if (!group) refuse("the base .dl-group rule");
const qf = decls(base, ".qfilter");
if (!qf) refuse("the base .qfilter rule");
if (!mobileSplit.bodies.some(b => decls(b, ".qfilter"))) refuse("the @media (max-width: 768px) block with .qfilter");
const mobileGroup = decls(mobile, ".dl-group");
const mobileQf = decls(mobile, ".qfilter");

check("W1 .meta-row has display:flex, flex-wrap:wrap and a gap",
  has(row, "display:flex") && has(row, "flex-wrap:wrap") && /(^|;)gap:/.test(row));

check("W2 .meta and .dl-group have min-width:0; .dl-group has max-width:100% and no flex-shrink:0 (" +
  "meta \"" + meta + "\", group \"" + group + "\", mobile group \"" + mobileGroup + "\")",
  has(meta, "min-width:0") && has(group, "min-width:0") && has(group, "max-width:100%") &&
  !/flex-shrink:0/.test(group) && !/flex-shrink:0/.test(mobileGroup) &&
  !/(^|;)flex:[\d.]+\s*0(\s|;|$)/.test(group));

check("W3 .dl-group is a wrapping row (flex-wrap:wrap, not a column)",
  has(group, "flex-wrap:wrap") && !/flex-direction:column/.test(group) && !/flex-direction:column/.test(mobileGroup));

check("W4 overflow-wrap:anywhere on .meta (\"" + meta + "\")",
  has(meta, "overflow-wrap:anywhere"));

// The filter takes a full row on a phone; the Export trigger sits right-aligned
// on the next one.
check("W5 .qfilter has min-width:0 and max-width:100%; @media (max-width: 768px) makes .dl-group width:100% and " +
  "the filter a full row (qfilter \"" + qf + "\", mobile group \"" + mobileGroup + "\", mobile qfilter \"" + mobileQf + "\")",
  has(qf, "min-width:0") && has(qf, "max-width:100%") && has(mobileGroup, "width:100%") &&
  (has(mobileQf, "flex:11100%") || has(mobileQf, "flex-basis:100%")) && has(mobileQf, "width:auto"));

if (ran === 0) {
  console.error("FAIL: zero checks ran - refusing to pass silently");
  process.exit(1);
}
console.log((ran - failed) + "/" + ran + " passed, " + failed + " failed (" + ran + " checks ran)");
process.exit(failed ? 1 : 0);
