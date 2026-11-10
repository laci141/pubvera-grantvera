// Bar track test (B1-B9): money bars are a fixed .bar-track with a .bar-chart
// fill inside, so the fill's CSSOM width (data-pct %) shows the value.
//
// Run: node tools/bar_track_test.js
//
// Source check: style.css and app.js are read as text. This is NOT a layout
// test: the rendered widths were measured in Chromium on skewed data (24 awards,
// $0 to $12.45M): before, every bar was the same width (16 px at 1280, 5 px at
// 768, 0 px at 390 because a bare flex:1 bar shrank to nothing); after, the
// widths follow the values at all three widths (13/11/11 distinct values) and
// every bar starts on one line.
//   B1 moneyBar puts the fill inside a .bar-track wrapper;
//   B2 .bar-track spans the cell width (width: 100%), has a fixed height and a
//      background, and has no own minimum width (no clamp());
//   B3 .bar-chart is a block with width 0 and height 100% and is NOT a flex
//      item (no flex: 1, no max-width: those made it collapse);
//   B4 the share is not rounded to a whole percent (no Math.round in moneyBar)
//      and is written with three decimals (toFixed(3));
//   B5 applyBarWidths uses max(2px, v%) and gives 0 to a zero amount;
//   B6 .bar-number has a minimum width in ch, so the tracks start on one line;
//   B7 the old tier colours are still there (green, yellow, red);
//   B8 style="..." is not used for the width (CSP style-src 'self');
//   B9 .bar-container stacks the number above the track (flex-direction:
//      column, align-items: stretch). Side by side, the track's own minimum
//      width (60-100 px) widened the Award amount column by ~70 px: the NIH
//      table (10 rows) overflowed its box at 768 px (715 > 702) and at 556 px
//      (706 > 490), the titles wrapped one word per line. Stacked, the column
//      is as wide as the number: 702 = 702 at 768 px, 626 at 556 px, the table
//      is 16 % shorter at 768 px, and the bar stays visible (43-52 px).
// A rule or function that cannot be found is a FAIL, never a silent pass.
"use strict";
const fs = require("fs");
const path = require("path");

const css = fs.readFileSync(path.join(__dirname, "..", "style.css"), "utf8").replace(/\r\n/g, "\n").replace(/\/\*[\s\S]*?\*\//g, "");
const js = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").replace(/\r\n/g, "\n");

let ran = 0, failed = 0;
function check(label, ok) { ran++; if (!ok) failed++; console.log((ok ? "PASS" : "FAIL") + "  " + label); }
function rule(sel) {
  const esc = sel.replace(/[.\-]/g, "\\$&");
  const m = css.match(new RegExp("(^|\\n)\\s*" + esc + "\\s*\\{([^}]*)\\}"));
  return m ? m[2] : null;
}
function fn(name) {
  const start = js.indexOf("function " + name + "(");
  if (start < 0) return "";
  const open = js.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < js.length; i++) {
    if (js[i] === "{") depth++;
    else if (js[i] === "}" && --depth === 0) return js.slice(start, i + 1);
  }
  return "";
}

const mb = fn("moneyBar");
const ab = fn("applyBarWidths");
check("moneyBar found", mb !== "");
check("applyBarWidths found", ab !== "");

check("B1 the fill is inside a .bar-track", /<div class="bar-track"><div class="bar-chart '/.test(mb) && /<\/div><\/div><\/div>/.test(mb));

const track = rule(".bar-track");
check("B2 .bar-track rule found", track !== null);
check("B2 width: 100%", track !== null && /(^|[;\s])width:\s*100%/.test(track));
check("B2 no own minimum width (no clamp)", track !== null && !/min-width:/.test(track) && !/clamp\(/.test(track));
check("B2 height 8px and a background", track !== null && /height:\s*8px/.test(track) && /background:/.test(track));

const chart = rule(".bar-chart");
check("B3 .bar-chart rule found", chart !== null);
check("B3 display block, width 0, height 100%", chart !== null && /display:\s*block/.test(chart) && /(^|[;\s])width:\s*0\s*;/.test(chart) && /height:\s*100%/.test(chart));
check("B3 no flex and no max-width on the fill", chart !== null && !/flex:/.test(chart) && !/max-width:/.test(chart));

check("B4 no Math.round in moneyBar", mb !== "" && !/Math\.round/.test(mb));
check("B4 three decimals (toFixed(3))", /toFixed\(3\)/.test(mb));
check("B5 width is max(2px, v%)", /'max\(2px, ' \+ v \+ '%\)'/.test(ab));
check("B5 a zero share gets width 0", /v > 0 \? .* : '0'/.test(ab));

const num = rule(".bar-number");
check("B6 .bar-number rule found", num !== null);
check("B6 min-width in ch (>= 6ch)", num !== null && /min-width:\s*([6-9]|\d\d)ch/.test(num));

check("B7 tier colours kept", ["green", "yellow", "red"].every(t => new RegExp("\\.bar-chart\\." + t + "\\s*\\{").test(css)));
check("B8 no style=\" in moneyBar", mb !== "" && !/style=/.test(mb));

const box = rule(".bar-container");
check("B9 .bar-container rule found", box !== null);
check("B9 number above the track (flex-direction: column)", box !== null && /display:\s*flex/.test(box) && /flex-direction:\s*column/.test(box));
check("B9 the track spans the column (align-items: stretch)", box !== null && /align-items:\s*stretch/.test(box));

console.log("\n" + (ran - failed) + "/" + ran + " passed");
process.exit(failed ? 1 : 0);
