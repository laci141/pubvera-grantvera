// Footer version test.
//
// Run: node tools/version_footer_test.js
//
// The footer shows "Grantvera v<version>" from GET /version. The CSP has no
// 'unsafe-inline', so the loader cannot sit in index.html like Corpova's: it is
// loadAppVersion() in app.js, started from a DOMContentLoaded listener so that
// evaluating app.js (tools/export_test.js runs it to its end in a vm sandbox)
// touches no DOM and fetches nothing. This check asserts:
//   1. index.html has exactly one id="app-version", empty, inside the <footer>;
//   2. index.html has no <script> with an inline body;
//   3. app.js fetches '/version' with cache 'no-store';
//   4. the text is written with textContent, never innerHTML;
//   5. a failed fetch leaves the element empty (no error text is shown);
//   6. the loader is started only through the DOMContentLoaded listener;
//   7. run in a sandbox, the loader writes "Grantvera v<version>" on success
//      and nothing on a rejected fetch, a non-ok response or a bad body.
//
// Every check reads one line at a time; no regex spans lines.
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const read = (name) => fs.readFileSync(path.join(__dirname, "..", name), "utf8").split(/\r?\n/);
const html = read("index.html");
const js = read("app.js");

let failed = 0;
function check(label, ok) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

// 1: the span.
const idLines = html.map((l, i) => (/\bid=["']app-version["']/.test(l) ? i : -1)).filter((i) => i >= 0);
const idCount = html.reduce((n, l) => n + (l.match(/\bid=["']app-version["']/g) || []).length, 0);
check("1 exactly one id=\"app-version\" in index.html (found " + idCount + ")", idCount === 1);
const footOpen = html.findIndex((l) => /<footer\b/i.test(l));
const footClose = html.findIndex((l, i) => i > footOpen && /<\/footer>/i.test(l));
check("1 id=\"app-version\" is inside the <footer>",
  idLines.length === 1 && footOpen >= 0 && footClose > footOpen && idLines[0] > footOpen && idLines[0] < footClose);
check("1 the span is empty in the markup",
  idLines.length === 1 && html[idLines[0]].trim() === "<span id=\"app-version\"></span>");

// 2: every <script> tag opens and closes on its own line, has a src and no body.
const scriptLines = html.filter((l) => /<script\b/i.test(l));
check("2 index.html has <script> tags (found " + scriptLines.length + ")", scriptLines.length > 0);
check("2 no <script> in index.html has an inline body",
  scriptLines.every((l) => /\ssrc=/i.test(l) && /<script\b[^>]*><\/script>/i.test(l)));

// The loader: from its "function loadAppVersion() {" line to the closing brace
// at the same indent.
const fnAt = js.findIndex((l) => l.trim() === "function loadAppVersion() {");
const indent = fnAt >= 0 ? js[fnAt].match(/^\s*/)[0] : "";
const fnEnd = fnAt >= 0 ? js.findIndex((l, i) => i > fnAt && l === indent + "}") : -1;
const fn = fnAt >= 0 && fnEnd > fnAt ? js.slice(fnAt, fnEnd + 1) : [];
check("app.js defines function loadAppVersion()", fn.length > 0);

// 3: the fetch.
const fetchLines = fn.filter((l) => l.includes("fetch("));
check("3 exactly one fetch in the loader (found " + fetchLines.length + ")", fetchLines.length === 1);
check("3 fetch('/version', { cache: 'no-store' })",
  fetchLines.length === 1 && fetchLines[0].includes("fetch('/version'") && fetchLines[0].includes("cache: 'no-store'"));

// 4: textContent only.
check("4 writes 'Grantvera v' + d.version with textContent",
  fn.some((l) => l.includes("getElementById('app-version').textContent = 'Grantvera v' + d.version")));
check("4 the loader never uses innerHTML", fn.length > 0 && !fn.some((l) => l.includes("innerHTML")));
check("4 no app.js line touches app-version through innerHTML",
  !js.some((l) => l.includes("app-version") && l.includes("innerHTML")));

// 5: the catch handler is one line and writes nothing.
const catchLines = fn.filter((l) => l.includes(".catch("));
check("5 the loader has one .catch (found " + catchLines.length + ")", catchLines.length === 1);
check("5 the .catch handler is one line and writes nothing",
  catchLines.length === 1 && catchLines[0].trim().endsWith("});") &&
  !/textContent|innerHTML|innerText|append|insertAdjacent/.test(catchLines[0]));

// 6: started only through the listener, at the top level of app.js.
const listener = "document.addEventListener('DOMContentLoaded', loadAppVersion);";
check("6 the DOMContentLoaded listener starts the loader once",
  js.filter((l) => l.trim() === listener).length === 1);
check("6 loadAppVersion appears only in its definition and the listener",
  js.filter((l) => l.includes("loadAppVersion")).length === 2);
check("6 app-version is referenced only inside the loader",
  js.every((l, i) => !l.includes("app-version") || (i > fnAt && i < fnEnd)));

// 7: behaviour, in a sandbox with a fake fetch and one element.
async function runLoader(fetchImpl) {
  const el = { textContent: "" };
  const sandbox = { fetch: fetchImpl, document: { getElementById: (id) => (id === "app-version" ? el : null) } };
  vm.createContext(sandbox);
  vm.runInContext(fn.join("\n") + "\nthis.p = loadAppVersion();", sandbox);
  await sandbox.p;
  await new Promise((r) => setTimeout(r, 0));
  return el.textContent;
}
const reply = (ok, body) => () => Promise.resolve({ ok, json: () => Promise.resolve(body) });

(async () => {
  if (fn.length > 0) {
    let seen = null;
    const ok = await runLoader((url, opts) => { seen = { url, opts }; return reply(true, { version: "2026.10.27.1" })(); });
    check("7 success writes \"Grantvera v2026.10.27.1\" (got " + JSON.stringify(ok) + ")", ok === "Grantvera v2026.10.27.1");
    check("7 requested /version with cache no-store",
      !!seen && seen.url === "/version" && !!seen.opts && seen.opts.cache === "no-store");
    check("7 rejected fetch leaves the footer empty", (await runLoader(() => Promise.reject(new Error("offline")))) === "");
    check("7 non-ok response leaves the footer empty", (await runLoader(reply(false, { error: "x" }))) === "");
    check("7 body without a string version leaves the footer empty", (await runLoader(reply(true, { version: 7 }))) === "");
  } else {
    check("7 loader behaviour (loader not found)", false);
  }
  if (failed) {
    console.error(failed + " check(s) failed");
    process.exit(1);
  }
  console.log("all footer version checks pass");
})();
