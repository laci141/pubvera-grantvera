// GRV-004: CSV formula injection. A string cell starting with = + - @ TAB CR
// LF (or their full-width forms) must be prefixed with ' so a spreadsheet
// reads it as text; plain numbers ("-5", -5) stay numeric; RFC 4180 quoting
// still applies.
//
// Run: node tools/csv_formula_test.js
//
// The real toCSV() (and csvCell() when present) is sliced out of index.html
// and run in node:vm with stubbed exportRows()/exportHeader(); nothing is copied.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const html = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8").replace(/\r\n/g, "\n");

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

if (!extract("toCSV")) { console.error("FAIL: could not locate toCSV() in index.html"); process.exit(1); }
const ctx = { rows: [] };
vm.createContext(ctx);
vm.runInContext(["csvCell", "toCSV"].map(extract).filter(Boolean).join("\n") +
  "\nfunction exportRows() { return { rows: rows }; }\nfunction exportHeader() { return 'header'; }\nthis.toCSV = toCSV;", ctx);

// Minimal RFC 4180 parser for one line set.
function parseCSV(text) {
  const recs = []; let rec = [], f = "", q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { f += '"'; i++; }
      else if (c === '"') q = false;
      else f += c;
    } else if (c === '"') q = true;
    else if (c === ",") { rec.push(f); f = ""; }
    else if (c === "\r" && text[i + 1] === "\n") { rec.push(f); recs.push(rec); rec = []; f = ""; i++; }
    else f += c;
  }
  rec.push(f); recs.push(rec);
  return recs;
}

const cases = [
  ["=1+1", true], ["+SUM(1,1)", true], ["-1+2", true], ["@SUM(A1:A2)", true],
  ["\t=1", true], ["\r=1", true], ["\n=1", true], ["＝1+1", true], ["＋1", true], ["－1", true], ["＠x", true],
  ['=HYPERLINK("x","y"),z', true],
  ["-5", false], ["-1.5", false], [-5, false], ["Cancer research", false],
];
const row = {};
cases.forEach(([v], i) => { row["c" + i] = v; });
ctx.rows = [row];
const csv = ctx.toCSV("open").replace(/^﻿/, "");
const recs = parseCSV(csv);
const data = recs[3];
check("data row parses back to " + cases.length + " fields (got " + (data ? data.length : 0) + ")", data && data.length === cases.length);
cases.forEach(([v, formula], i) => {
  const got = data ? data[i] : undefined;
  const want = formula ? "'" + v : String(v);
  check(JSON.stringify(v) + " -> " + JSON.stringify(want) + " (got " + JSON.stringify(got) + ")", got === want);
});
console.log(failed ? "\n" + failed + " check(s) FAILED" : "\nall checks passed");
process.exit(failed ? 1 : 0);
