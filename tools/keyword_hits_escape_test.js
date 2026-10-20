// GRV-003: keyword_hits words from the API reach out.innerHTML via
// insightRow(). Every dynamic value must be escaped, and a field that should
// be a number must not leak a non-number into the HTML.
//
// Run: node tools/keyword_hits_escape_test.js
//
// The real esc(), usd(), safeNum() (when present) and insightRow() are sliced
// out of index.html at test time and run in node:vm; nothing is copied here.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").replace(/\r\n/g, "\n");

// Returns the source of `function name(...) { ... }`, matching braces while
// skipping string literals and comments.
function extract(name) {
  const start = html.indexOf("function " + name + "(");
  if (start < 0) return null;
  let i = html.indexOf("{", start), depth = 0;
  for (; i < html.length; i++) {
    const c = html[i];
    if (c === "'" || c === '"' || c === "`") {
      for (i++; i < html.length && html[i] !== c; i++) if (html[i] === "\\") i++;
    } else if (c === "/" && html[i + 1] === "/") {
      i = html.indexOf("\n", i);
    } else if (c === "/" && html[i + 1] === "*") {
      i = html.indexOf("*/", i) + 1;
    } else if (c === "/" && /[(,=:[!&|?{};]/.test(html.slice(0, i).trimEnd().slice(-1))) {
      // regex literal: skip to its closing slash, honouring escapes and [...]
      let cls = false;
      for (i++; i < html.length; i++) {
        if (html[i] === "\\") i++;
        else if (html[i] === "[") cls = true;
        else if (html[i] === "]") cls = false;
        else if (html[i] === "/" && !cls) break;
      }
    } else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return html.slice(start, i + 1);
  }
  return null;
}

let failed = 0;
function check(label, ok) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

const src = ["esc", "usd", "safeNum", "insightRow"].map(extract).filter(Boolean);
if (!extract("esc") || !extract("insightRow")) {
  console.error("FAIL: could not locate esc() or insightRow() in index.html");
  process.exit(1);
}
const ctx = { lastMeta: {} };
vm.createContext(ctx);
vm.runInContext(src.join("\n") + "\n;this.insightRow = insightRow;", ctx);

function render(meta) {
  ctx.lastMeta = { open: meta };
  return ctx.insightRow("open");
}

const words = [
  { word: "<b>GRANTVERA_TEST</b>", hits: 0 },
  { word: "say \"hi\" it's", hits: 3 },
  { word: "R&D", hits: 5 },
  { word: "<script>alert(1)</script>", hits: 0 },
  { word: "Ünïcödé 研究 <i>", hits: 2 },
  { word: "", hits: 0 },
  { hits: 0 },
];
const out = render({ source: "open", keywordHits: words });
check("tag word is escaped (&lt;b&gt;GRANTVERA_TEST&lt;/b&gt;)", out.includes("&lt;b&gt;GRANTVERA_TEST&lt;/b&gt;"));
check("no raw <b>GRANTVERA_TEST", !out.includes("<b>GRANTVERA_TEST"));
check("no raw <script", !out.toLowerCase().includes("<script"));
check("quotes are escaped", out.includes("say &quot;hi&quot; it&#39;s"));
check("ampersand is escaped", out.includes("R&amp;D") && !out.includes("R&D"));
check("unicode text survives, its tag does not", out.includes("Ünïcödé 研究 &lt;i&gt;") && !out.includes("<i>"));
check("missing word renders as empty, not 'undefined'", !out.includes("undefined"));

// Non-number fields must render a safe default, never the raw value.
const evil = "<img src=x onerror=alert(1)>";
const out2 = render({
  source: "open",
  keywordHits: [{ word: "a", hits: evil }, { word: "b", hits: 0 }],
  relevance: { examined: evil, matched: evil, title_matched: evil, pool_error: true, pages_fetched: evil, pages_planned: evil },
  typical: { population: evil, estimate: evil, bracket_high: evil, bracket_low: evil },
});
check("non-number fields never reach the HTML raw", !out2.includes("<img"));

// Existing behaviour for well-formed numbers is unchanged.
const out3 = render({ source: "open", keywordHits: [{ word: "climate", hits: 1234 }, { word: "zzz", hits: 0 }],
  relevance: { examined: 500, matched: 12, title_matched: 3 } });
check("numbers still render ('\"climate\" 1,234')", out3.includes("&quot;climate&quot; 1,234") || out3.includes('"climate" 1,234'));
check("relevance counts still render", out3.includes("Searched 500 recent NSF awards; 12 mention every word of the query, 3 in the title."));

console.log(failed ? "\n" + failed + " check(s) FAILED" : "\nall checks passed");
process.exit(failed ? 1 : 0);
