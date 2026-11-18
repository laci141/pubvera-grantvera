// Home-page polish test (P1-P11): SVG icons instead of emoji, contrast,
// chip touch target, hero gap, desktop blur 15px, head order, no inline style.
//
// Run: node tools/home_polish_test.js
//
// Source check only, not a browser measurement.
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

const root = path.join(__dirname, "..");
const htmlPath = process.env.HOME_POLISH_HTML || path.join(root, "index.html");
const cssPath = process.env.HOME_POLISH_CSS || path.join(root, "style.css");
if (!fs.existsSync(htmlPath)) refuse("index.html");
if (!fs.existsSync(cssPath)) refuse("style.css");
const html = fs.readFileSync(htmlPath, "utf8").replace(/\r\n/g, "\n");
const style = fs.readFileSync(cssPath, "utf8").replace(/\r\n/g, "\n").replace(/\/\*[^]*?\*\//g, "");
const count = (hay, needle) => hay.split(needle).length - 1;

if (!/<head>/.test(html)) refuse("<head>");
if (!/class="bento-icon"/.test(html)) refuse(".bento-icon");
if (!/\.chip\s*\{/.test(style)) refuse("a .chip rule");
if (!/\.hero\s*\{/.test(style)) refuse("a .hero rule");

// Top-level (not inside @media) rule bodies for a selector list, whitespace-normalised.
function topRules(css) {
  const out = [];
  let depth = 0, start = 0;
  for (let i = 0; i < css.length; i++) {
    if (css[i] === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (css[i] === "}") {
      depth--;
      if (depth === 0) {
        const sel = css.slice(css.lastIndexOf("}", start) + 1, start).trim();
        out.push({ sel: sel.replace(/\s+/g, " "), body: css.slice(start + 1, i).replace(/\s+/g, "") });
      }
    }
  }
  return out;
}
const rules = topRules(style);
const body = sel => rules.filter(r => r.sel === sel).map(r => r.body).join("");

// P1
check("P1 no 💼 📊 🔍 in index.html", !/[💼📊🔍]/u.test(html));

// P2: 3 bento icons + 3 modal h2 titles each hold one decorative svg.
const iconSpans = [...html.matchAll(/<span class="bento-icon"[^>]*>([^]*?)<\/span>/g)].map(m => m[1]);
const h2s = [...html.matchAll(/<h2 id="modal-(?:open|nih|nsf)-title">([^]*?)<\/h2>/g)].map(m => m[1]);
const svgOk = s => count(s, "<svg") === 1 && /<svg\b(?=[^>]*\baria-hidden="true")(?=[^>]*\bfocusable="false")[^>]*>/.test(s);
const svgIn = [...iconSpans, ...h2s].filter(svgOk).length;
check("P2 exactly 6 decorative <svg> (aria-hidden, focusable=false) in .bento-icon x3 + modal h2 x3 (" +
  iconSpans.length + " icons, " + h2s.length + " h2, " + svgIn + " ok)",
  iconSpans.length === 3 && h2s.length === 3 && svgIn === 6);

// P3
check("P3 footer and td.n, th.n colour #9aa5b1; no color: #666 left",
  /(^|;)color:#9aa5b1(;|$)/.test(body("footer")) && /(^|;)color:#9aa5b1(;|$)/.test(body("td.n, th.n")) &&
  !/color:\s*#666\b/.test(style));

// P4
check("P4 NIH colour #a78bfa twice (card + modal), #7c3aed 0 times (" +
  count(style, "#a78bfa") + " / " + count(style, "#7c3aed") + ")",
  count(style, "#a78bfa") === 2 && count(style, "#7c3aed") === 0 &&
  /--color:#a78bfa/.test(body(".bento-card.nih")) && /--color:#a78bfa/.test(body("#modal-nih")));

// P5
const blur15 = sel => body(sel).includes("backdrop-filter:blur(15px)") && body(sel).includes("-webkit-backdrop-filter:blur(15px)") &&
  !/(^|;)backdrop-filter:blur\((?!15px)/.test(body(sel));
const p5sels = [".glass-panel", ".chip", ".modal-content", ".errcard"];
check("P5 desktop blur 15px on " + p5sels.join(" ") + "; blur(18px) count 0 (" + count(style, "blur(18px)") + ")",
  p5sels.every(blur15) && count(style, "blur(18px)") === 0);

// P6
const wk = [...style.matchAll(/-webkit-backdrop-filter:\s*([^;]+);/g)].map(m => m[1].trim()).sort();
const plain = [...style.matchAll(/(?:^|[^-])backdrop-filter:\s*([^;]+);/g)].map(m => m[1].trim()).sort();
check("P6 -webkit-backdrop-filter count equals backdrop-filter count, same values (" + wk.length + " / " + plain.length + ")",
  wk.length > 0 && JSON.stringify(wk) === JSON.stringify(plain));

// P7
check("P7 .chip min-height: 44px; display: inline-flex; align-items: center",
  /(^|;)min-height:44px(;|$)/.test(body(".chip")) && /(^|;)display:inline-flex(;|$)/.test(body(".chip")) &&
  /(^|;)align-items:center(;|$)/.test(body(".chip")));

// P8
check("P8 .hero min-height: 0", /(^|;)min-height:0(;|$)/.test(body(".hero")) && !/min-height:50vh/.test(body(".hero")));

// P9
const head = (html.match(/<head>([^]*?)<\/head>/) || ["", ""])[1].replace(/<!--[^]*?-->/g, "");
const firstTags = [...head.matchAll(/<(\w+)[^>]*>/g)].slice(0, 3).map(m => m[0]);
check("P9 <meta charset> is the first element of head, then viewport meta, then <title>",
  /^<meta charset="UTF-8">$/i.test(firstTags[0] || "") && /name="viewport"/.test(firstTags[1] || "") &&
  /^<title>$/.test(firstTags[2] || ""));

// P10
check("P10 \"RIGHT NOW\" absent from index.html", !html.includes("RIGHT NOW"));

// P11
check("P11 0 style= attributes and 0 <style blocks (" + count(html, "style=") + " / " + count(html, "<style") + ")",
  count(html, "style=") === 0 && count(html, "<style") === 0);

if (ran === 0) {
  console.error("FAIL: zero checks ran - refusing to pass silently");
  process.exit(1);
}
console.log((ran - failed) + "/" + ran + " passed, " + failed + " failed (" + ran + " checks ran)");
process.exit(failed ? 1 : 0);
