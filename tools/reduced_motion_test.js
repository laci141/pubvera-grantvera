// Reduced-motion test (R1-R8): style.css ends with one
// @media (prefers-reduced-motion: reduce) block; the spinner stays animated.
//
// Run: node tools/reduced_motion_test.js
//
// CSS-source check only, not a browser measurement.
"use strict";
const fs = require("fs");
const path = require("path");

let ran = 0;
let failed = 0;
function check(label, ok) {
  ran++;
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}
function refuse(what) {
  console.error("FAIL: " + what + " not found - refusing to pass silently");
  process.exit(1);
}

const cssPath = path.join(__dirname, "..", "style.css");
if (!fs.existsSync(cssPath)) refuse("style.css");
const style = fs.readFileSync(cssPath, "utf8").replace(/\r\n/g, "\n").replace(/\/\*[^]*?\*\//g, "");
const norm = s => s.replace(/\s+/g, "");
const count = (hay, needle) => hay.split(needle).length - 1;
const flat = norm(style);

if (!/html\s*\{/.test(style)) refuse("an html rule");
if (!/@keyframes\s+spin/.test(style)) refuse("@keyframes spin");

const heads = [...style.matchAll(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{/g)];
let body = "", after = "x";
if (heads.length) {
  const m = heads[heads.length - 1];
  let depth = 1, i = m.index + m[0].length;
  for (; i < style.length && depth; i++) depth += style[i] === "{" ? 1 : style[i] === "}" ? -1 : 0;
  body = norm(style.slice(m.index + m[0].length, i - 1));
  after = style.slice(i);
}

check("R1 exactly one @media (prefers-reduced-motion: reduce) and it is the last block (" + heads.length + " found)",
  heads.length === 1 && after.trim() === "");
check("R2 html { scroll-behavior: auto; } inside the block", body.includes("html{scroll-behavior:auto;}"));
check("R3 .modal, .modal-content, .results { animation: none; } inside the block",
  body.includes(".modal,.modal-content,.results{animation:none;}"));
check("R4 *, *::before, *::after { transition: none !important; } inside the block",
  body.includes("*,*::before,*::after{transition:none!important;}"));
check("R5 .chip:hover, .bento-card:hover, .btn:hover, .btn:active { transform: none; } inside the block",
  body.includes(".chip:hover,.bento-card:hover,.btn:hover,.btn:active{transform:none;}"));
check("R6 block has no .loading and no spin; @keyframes spin and the spin animation exist once each",
  !body.includes(".loading") && !body.includes("spin") &&
  count(style, "@keyframes spin") === 1 && count(flat, "animation:spin0.6slinearinfinite") === 1);
check("R7 html { scroll-behavior: smooth; }, @keyframes fadeIn and @keyframes slideUp exist once each",
  count(flat, "html{scroll-behavior:smooth;}") === 1 &&
  count(style, "@keyframes fadeIn") === 1 && count(style, "@keyframes slideUp") === 1);
const wk = (style.match(/-webkit-backdrop-filter:/g) || []).length;
const plain = (style.match(/(^|[^-])backdrop-filter:/g) || []).length;
check("R8 -webkit-backdrop-filter count equals backdrop-filter count (" + wk + " / " + plain + ")",
  wk === plain && wk > 0);

if (ran === 0) {
  console.error("FAIL: zero checks ran - refusing to pass silently");
  process.exit(1);
}
console.log((ran - failed) + "/" + ran + " passed, " + failed + " failed (" + ran + " checks ran)");
process.exit(failed ? 1 : 0);
