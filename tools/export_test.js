// Export test: every export carries the search inputs that were actually sent
// (server filters first, always present, then the client filters), the API
// total as rows_total, the total in the provenance line whenever it is known,
// one identical provenance line in CSV, XLSX and BibTeX, and an XLSX
// autofilter on the header row.
//
// Run: node tools/export_test.js
//
// The export suite and the run* search functions live inline in index.html;
// this test slices the classic script out and executes it in a vm sandbox with
// a minimal DOM shim, then drives the real run* -> render -> export path.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

// The worktree may hold CRLF (core.autocrlf); the index holds LF.
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8").replace(/\r\n/g, "\n");
const start = html.indexOf("    function esc(s) {");
const end = html.indexOf("  </script>", start);
if (start < 0 || end < 0) {
  console.error("FAIL: could not locate the classic script section in index.html");
  process.exit(1);
}
const section = html.slice(start, end);

let failed = 0;
function check(label, ok) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

// ── fixtures, shaped as the three /api/* endpoints return them ──
function openRows(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: 1000 + i, number: "OPP-" + i, title: (i % 5 === 0 ? "NASA climate call " : "Climate resilience ") + i,
      agency: "Agency " + i, openDate: "01/15/2026", closeDate: "12/31/2026", oppStatus: "posted" });
  }
  return out;
}
function nihRows(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ project_num: "R01CA" + i, project_title: "Cancer study " + i, contact_pi_name: "DOE, JANE",
      organization: { org_name: "Univ " + i }, award_amount: 500000 - i, fiscal_year: 2025 });
  }
  return out;
}
function nsfRows(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push({ id: "24" + i, title: "Quantum award " + i, contact_pi_name: "ROE, JOHN", awardeeName: "College " + i,
      fundsObligatedAmt: 300000 - i, startDate: "2024-09-01", expDate: "2027-08-31" });
  }
  return out;
}
let apiResponse = null;
const sentBodies = [];

// ── DOM shim ──
const escHTML = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
function makeEl() {
  const el = { value: "", disabled: false, style: {}, hidden: false, _text: "", _html: "",
    classList: { add() {}, remove() {} }, addEventListener() {}, appendChild() {}, focus() {}, click() {} };
  Object.defineProperty(el, "textContent", {
    get() { return el._text; }, set(t) { el._text = String(t); el._html = escHTML(t); } });
  Object.defineProperty(el, "innerHTML", { get() { return el._html; }, set(h) { el._html = String(h); } });
  return el;
}
const els = {};
const byId = id => (els[id] = els[id] || makeEl());
const blobs = [];
let xlsxSheet = null;
const XLSX = {
  utils: {
    encode_col: c => { let s = ""; c++; while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); } return s; },
    encode_cell: a => XLSX.utils.encode_col(a.c) + (a.r + 1),
    encode_range: r => XLSX.utils.encode_cell(r.s) + ":" + XLSX.utils.encode_cell(r.e),
    decode_range: () => ({ s: { r: 0, c: 0 }, e: { r: xlsxSheet._rows - 1, c: xlsxSheet._cols - 1 } }),
    aoa_to_sheet: aoa => {
      const ws = { _rows: aoa.length, _cols: Math.max(...aoa.map(r => r.length)) };
      aoa.forEach((row, r) => row.forEach((v, c) => { ws[XLSX.utils.encode_cell({ r, c })] = { v }; }));
      ws["!ref"] = "A1:" + XLSX.utils.encode_cell({ r: ws._rows - 1, c: ws._cols - 1 });
      xlsxSheet = ws;
      return ws;
    },
    book_new: () => ({ sheets: [] }),
    book_append_sheet: (wb, ws) => wb.sheets.push(ws),
  },
  writeFile: () => {},
};
const sandbox = {
  console, Date, Math, JSON, Number, String, Object, Array, Promise, RegExp, Error, parseInt, isNaN,
  setTimeout: () => 0,
  alert: m => { throw new Error("unexpected alert: " + m); },
  window: {},
  Blob: class { constructor(parts) { this.text = parts.join(""); blobs.push(this.text); } },
  URL: { createObjectURL: () => "blob:x", revokeObjectURL: () => {} },
  XLSX,
  fetch: async (url, opts) => {
    sentBodies.push(JSON.parse(opts.body));
    const text = JSON.stringify(apiResponse);
    return { ok: true, status: 200, text: async () => text };
  },
  document: {
    getElementById: byId,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    createElement: () => makeEl(),
    head: { appendChild() {} },
    body: { appendChild() {}, removeChild() {} },
  },
};
vm.createContext(sandbox);
vm.runInContext(section, sandbox, { filename: "index.html#classic-script" });
const run = code => vm.runInContext(code, sandbox);
const lastBlob = () => blobs[blobs.length - 1];
const csvHeader = text => text.replace(/^﻿/, "").split("\r\n")[1];
const unquoteCSV = s => (/^".*"$/.test(s) ? s.slice(1, -1).replace(/""/g, '"') : s);
const today = new Date().toISOString().slice(0, 10);

function exportsOf(key) {
  run('downloadJSON("' + key + '","x.json")');
  const json = JSON.parse(lastBlob()).export;
  run('downloadCSV("' + key + '","x.csv")');
  const csv = unquoteCSV(csvHeader(lastBlob()));
  run('downloadXLSX("' + key + '","x.xlsx")');
  const xlsx = xlsxSheet.A1.v;
  const ref = xlsxSheet["!autofilter"] && xlsxSheet["!autofilter"].ref;
  run('downloadBibTeX("' + key + '","x.bib")');
  const bib = lastBlob().split("\n")[0];
  return { json, csv, xlsx, ref, bib };
}

async function searchOpen(q, rows, before, agency, response) {
  byId("open-query").value = q;
  byId("open-rows").value = String(rows);
  byId("open-before").value = before;
  byId("open-agency").value = agency;
  apiResponse = response;
  await run("runOpen()");
  if (!/class="meta-row"/.test(byId("open-results").innerHTML)) {
    throw new Error("runOpen did not render: " + byId("open-results").innerHTML.slice(0, 200));
  }
}

(async () => {
  // ── 1. the measured live case: "climate", Rows 50, any agency, no date; 37 of 37 ──
  await searchOpen("climate", 50, "", "", { keyword: "climate", totalHits: 37, shown: 37, opportunities: openRows(37) });
  const m = exportsOf("open");
  const wantF = "posted only · no closing date · any agency · up to 50 rows";
  check("1  JSON export.filters = " + JSON.stringify(wantF) + " (got " + JSON.stringify(m.json.filters) + ")", m.json.filters === wantF);
  check('1  JSON query "climate", rows_exported 37, rows_loaded 37, rows_total 37, unit opportunities (got ' +
    JSON.stringify([m.json.query, m.json.rows_exported, m.json.rows_loaded, m.json.rows_total, m.json.rows_total_unit]) + ")",
    m.json.query === "climate" && m.json.rows_exported === 37 && m.json.rows_loaded === 37 &&
    m.json.rows_total === 37 && m.json.rows_total_unit === "opportunities");
  const wantLine = 'Grantvera export · Open grant opportunity search · query: "climate" · ' +
    "showing 37 of 37 rows loaded (37 opportunities matched in total) · " + wantF + " · source: Grants.gov · " + today;
  check("2  CSV provenance line (got " + JSON.stringify(m.csv) + ")", m.csv === wantLine);
  check("2  provenance has (37 opportunities matched in total) when total == loaded",
    m.csv.indexOf("(37 opportunities matched in total)") !== -1);
  check("3  XLSX A1 == CSV provenance (got " + JSON.stringify(m.xlsx) + ")", m.xlsx === m.csv);
  check("3  BibTeX first line == '% ' + CSV provenance (got " + JSON.stringify(m.bib) + ")", m.bib === "% " + m.csv);
  check('4  XLSX autofilter ref "A2:G39" (got ' + JSON.stringify(m.ref) + ")", m.ref === "A2:G39");

  // ── 5. the export reads what was sent, not the live form ──
  byId("open-rows").value = "5";
  byId("open-before").value = "2030-01-01";
  byId("open-agency").value = "DOD";
  byId("open-query").value = "ocean";
  const m5 = exportsOf("open");
  check("5  form edits after the search do not leak into the export (got " + JSON.stringify([m5.json.query, m5.json.filters]) + ")",
    m5.json.query === "climate" && m5.json.filters === wantF && m5.csv === wantLine);

  // ── 6. date + agency set, total above loaded ──
  await searchOpen("climate", 50, "2026-12-31", "NSF", { keyword: "climate", totalHits: 61, shown: 50, opportunities: openRows(50) });
  check("6  request sent rows 50, closing_before, agency (got " + JSON.stringify(sentBodies[sentBodies.length - 1]) + ")",
    JSON.stringify(sentBodies[sentBodies.length - 1]) === JSON.stringify({ query: "climate", rows: 50, closing_before: "2026-12-31", agency: "NSF" }));
  const m6 = exportsOf("open");
  const wantF6 = "posted only · closing before 2026-12-31 · agency: NSF · up to 50 rows";
  check("6  JSON export.filters = " + JSON.stringify(wantF6) + " (got " + JSON.stringify(m6.json.filters) + ")", m6.json.filters === wantF6);
  check("6  rows_total 61 = API total, rows_loaded 50 (got " + JSON.stringify([m6.json.rows_total, m6.json.rows_loaded]) + ")",
    m6.json.rows_total === 61 && m6.json.rows_loaded === 50);
  check("6  provenance: showing 50 of 50 rows loaded (61 opportunities matched in total)",
    m6.csv.indexOf("showing 50 of 50 rows loaded (61 opportunities matched in total) · " + wantF6 + " · source:") !== -1);

  // ── 7. client filters follow the server ones ──
  run('onFilter("open", "nasa")');
  run("view.open.sort = 1; view.open.dir = -1");
  const m7 = exportsOf("open");
  const wantF7 = wantF6 + ' · filter: "nasa" · sorted by Title, descending';
  check("7  client filters appended (got " + JSON.stringify(m7.json.filters) + ")", m7.json.filters === wantF7);
  check("7  rows_exported 10, rows_loaded 50, rows_total 61 (got " +
    JSON.stringify([m7.json.rows_exported, m7.json.rows_loaded, m7.json.rows_total]) + ")",
    m7.json.rows_exported === 10 && m7.json.rows_loaded === 50 && m7.json.rows_total === 61);
  check("7  provenance carries the same filter string",
    m7.csv.indexOf("showing 10 of 50 rows loaded (61 opportunities matched in total) · " + wantF7 + " · source:") !== -1);
  check("7  XLSX and BibTeX provenance identical to CSV", m7.xlsx === m7.csv && m7.bib === "% " + m7.csv);
  run("view.open.sort = 1; view.open.dir = 1");
  check("7  ascending sort is named", JSON.parse((run('downloadJSON("open","x.json")'), lastBlob())).export.filters
    .endsWith('sorted by Title, ascending'));

  // ── 8. NIH: empty and set ──
  byId("nih-query").value = "cancer"; byId("nih-rows").value = "50"; byId("nih-min").value = "0"; byId("nih-year").value = "";
  apiResponse = { total: 195078, projects: nihRows(50) };
  await run("runNIH()");
  const n1 = exportsOf("nih");
  const wantN1 = "no minimum amount · all fiscal years · up to 50 rows";
  check("8  NIH empty filters = " + JSON.stringify(wantN1) + " (got " + JSON.stringify(n1.json.filters) + ")", n1.json.filters === wantN1);
  check("8  NIH provenance (195,078 award records matched in total) + filters",
    n1.csv.indexOf("showing 50 of 50 rows loaded (195,078 award records matched in total) · " + wantN1 + " · source: NIH RePORTER") !== -1);
  byId("nih-min").value = "100000"; byId("nih-year").value = "2025";
  await run("runNIH()");
  const n2 = exportsOf("nih");
  const wantN2 = "min amount USD 100,000 · FY2025 · up to 50 rows";
  check("8  NIH set filters = " + JSON.stringify(wantN2) + " (got " + JSON.stringify(n2.json.filters) + ")", n2.json.filters === wantN2);

  // ── 9. NSF: no API total, so no "matched in total" and rows_total null ──
  byId("nsf-query").value = "quantum"; byId("nsf-rows").value = "50"; byId("nsf-min").value = "0";
  apiResponse = { awards: nsfRows(50), relevance: { examined: 500, matched: 80, title_matched: 40 } };
  await run("runNSF()");
  const s1 = exportsOf("nsf");
  const wantS1 = "no minimum amount · up to 50 rows";
  check("9  NSF empty filters = " + JSON.stringify(wantS1) + " (got " + JSON.stringify(s1.json.filters) + ")", s1.json.filters === wantS1);
  check("9  NSF rows_total null, no matched-in-total claim (got " + JSON.stringify(s1.json.rows_total) + ")",
    s1.json.rows_total === null && s1.csv.indexOf("matched in total") === -1);
  check("9  NSF provenance carries the filters", s1.csv.indexOf("· " + wantS1 + " · source: NSF Awards") !== -1);

  if (failed) {
    console.error("\n" + failed + " check(s) FAILED");
    process.exit(1);
  }
  console.log("\nall export checks passed");
})().catch(e => {
  console.error("FAIL: " + (e && e.stack || e));
  process.exit(1);
});
