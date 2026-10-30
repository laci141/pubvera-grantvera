// Browser test for GRV-007 phase 1: index.html under the real CSP header.
//
// Run: cd tools/browser && npm install && npx playwright test
//
// The Go server is built from this checkout into the OS temp directory (so the
// binary never shows up in git status) and started on a free port picked at
// run time. Only /api/* is intercepted; the page itself, /config.json and the
// Content-Security-Policy header come from the real server. With
// script-src-attr 'none' an onclick= attribute does not run, so every control
// below works only if it goes through the delegated listeners.
"use strict";
const { test, expect } = require("@playwright/test");
const { execFileSync, spawn } = require("child_process");
const net = require("net");
const os = require("os");
const path = require("path");

const repo = path.join(__dirname, "..", "..");
const bin = path.join(os.tmpdir(), "grantvera-browser-test", process.platform === "win32" ? "grantvera.exe" : "grantvera");

let server;
let baseURL;

// Port 0 lets the OS choose; the listener is closed again and the port handed
// to the server. Another process could take it in between, which would make
// the health wait below fail loudly rather than test the wrong server.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

test.beforeAll(async () => {
  execFileSync("go", ["build", "-o", bin, "."], { cwd: repo, stdio: "inherit" });
  const port = await freePort();
  baseURL = "http://127.0.0.1:" + port;
  // Empty Supabase config: the page runs unauthenticated.
  server = spawn(bin, [], {
    cwd: repo,
    env: { ...process.env, PORT: String(port), SUPABASE_URL: "", SUPABASE_PUBLISHABLE_KEY: "" },
    stdio: "ignore",
  });
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const res = await fetch(baseURL + "/healthz");
      if (res.ok) break;
    } catch (_) { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error("server did not answer /healthz on " + baseURL);
    await new Promise(r => setTimeout(r, 100));
  }
});

test.afterAll(async () => {
  if (server && server.exitCode === null) {
    const exited = new Promise(r => server.once("exit", r));
    server.kill();
    await exited;
  }
});

// Every console message and page error, so each test can assert that nothing
// was refused by the CSP and that no script threw.
function watch(page) {
  const log = { console: [], pageErrors: [] };
  page.on("console", m => log.console.push(m.type() + ": " + m.text()));
  page.on("pageerror", e => log.pageErrors.push(String(e)));
  return log;
}
const CSP_RE = /Content Security Policy|script-src-attr|inline event handler|Refused to execute/i;
function expectNoCSPViolations(log) {
  expect(log.console.filter(m => CSP_RE.test(m)), "CSP messages on the console").toEqual([]);
  expect(log.pageErrors, "page errors").toEqual([]);
}

async function load(page) {
  // The xlsx bundle on the CDN is not needed for these checks; keep the run
  // offline-safe and fast.
  await page.route("https://cdn.jsdelivr.net/**", r => r.fulfill({ status: 200, contentType: "application/javascript", body: "" }));
  // Recorded in the page from the first script on, so a violation raised
  // while the page loads is not missed.
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", e => {
      window.__cspViolations.push(e.violatedDirective + " " + (e.blockedURI || ""));
    });
  });
  const log = watch(page);
  const res = await page.goto(baseURL + "/");
  expect(res.headers()["content-security-policy"]).toContain("script-src-attr 'none'");
  return log;
}

const OPEN_FIXTURE = {
  totalHits: 2,
  opportunities: [
    { id: 1, number: "OPP-1", title: "Climate resilience 1", agency: "NSF", openDate: "01/15/2026", closeDate: "12/31/2026", oppStatus: "posted" },
    { id: 2, number: "OPP-2", title: "Coastal flooding 2", agency: "DOC", openDate: "01/15/2026", closeDate: "12/31/2026", oppStatus: "posted" },
  ],
};

test("a chip opens its modal with the prefill, the close button closes it", async ({ page }) => {
  const log = await load(page);
  const modal = page.locator("#modal-open");
  await expect(modal).not.toHaveClass(/\bactive\b/);
  await page.locator(".chip", { hasText: "Climate" }).click();
  await expect(modal).toHaveClass(/\bactive\b/);
  await expect(page.locator("#open-query")).toHaveValue("climate");
  await modal.locator(".close-btn").click();
  await expect(modal).not.toHaveClass(/\bactive\b/);
  expectNoCSPViolations(log);
});

test("a bento card opens its modal without a prefill", async ({ page }) => {
  const log = await load(page);
  await page.locator(".bento-card.nsf").click();
  await expect(page.locator("#modal-nsf")).toHaveClass(/\bactive\b/);
  await expect(page.locator("#nsf-query")).toHaveValue("");
  expectNoCSPViolations(log);
});

test("Enter in the query input sends the search to /api/, filter and download work", async ({ page }) => {
  const log = await load(page);
  const bodies = [];
  await page.route("**/api/**", r => {
    bodies.push({ url: r.request().url(), body: r.request().postDataJSON() });
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(OPEN_FIXTURE) });
  });
  await page.locator(".chip", { hasText: "Climate" }).click();
  await page.locator("#open-query").press("Enter");
  await expect(page.locator("#open_tw tbody tr")).toHaveCount(2);
  expect(bodies).toHaveLength(1);
  expect(bodies[0].url).toBe(baseURL + "/api/search");
  expect(bodies[0].body.query).toBe("climate");

  // The result filter input (built as an HTML string) reaches onFilter.
  await page.locator("#open-results .qfilter").fill("Coastal");
  await expect(page.locator("#open_tw tbody tr")).toHaveCount(1);

  // A download button (also built as an HTML string) calls downloadCSV with
  // its key and filename.
  // The download buttons sit in an export menu: open it, then pick the CSV item.
  await page.locator("#open-results button.dl-trigger").click();
  const dl = page.waitForEvent("download");
  await page.locator("#open-results button.dl-item", { hasText: "CSV" }).click();
  expect((await dl).suggestedFilename()).toBe("grantvera-open-grants.csv");
  expectNoCSPViolations(log);
});

test("the search button runs the search", async ({ page }) => {
  const log = await load(page);
  let hits = 0;
  await page.route("**/api/nih", r => {
    hits++;
    return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ total: 0, projects: [] }) });
  });
  await page.locator(".chip", { hasText: "Cancer" }).click();
  await page.locator("#nih-btn").click();
  await expect(page.locator("#nih-results")).toContainText("No results found");
  expect(hits).toBe(1);
  expectNoCSPViolations(log);
});

test("moving a slider updates its label, including formatMoney", async ({ page }) => {
  const log = await load(page);
  await page.locator(".bento-card.nih").click();
  // openModal focuses the query field after 50 ms; wait for that, or it takes
  // the focus back from the slider and the arrow key lands in the text field.
  await expect(page.locator("#nih-query")).toBeFocused();
  await expect(page.locator("#nih-rows-val")).toHaveText("15");
  await page.locator("#nih-rows").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#nih-rows-val")).toHaveText("16");
  await expect(page.locator("#nih-min-val")).toHaveText("$0");
  await page.locator("#nih-min").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#nih-min-val")).toHaveText("$100K");
  expectNoCSPViolations(log);
});

test("the sign-in button in a 401 card calls pubveraSignIn", async ({ page }) => {
  const log = await load(page);
  // Stand in for the Supabase module: enabled, and record the call.
  await page.evaluate(() => {
    window.pubveraAuth = { enabled: true, signIn() { window.__signInCalls = (window.__signInCalls || 0) + 1; }, signOut() {} };
  });
  await page.route("**/api/**", r => r.fulfill({ status: 401, contentType: "application/json", body: '{"error":"missing token"}' }));
  await page.locator(".chip", { hasText: "AI" }).click();
  await page.locator("#nsf-query").press("Enter");
  await page.locator("#nsf-results .errcard button", { hasText: "Sign in with Google" }).click();
  expect(await page.evaluate(() => window.__signInCalls)).toBe(1);
  expectNoCSPViolations(log);
});

// GRV-007 phase 2: the inline <script> blocks are now app.js and app-module.js,
// and the policy carries script-src 'self' https://cdn.jsdelivr.net without
// 'unsafe-inline'.

test("the page loads under script-src with no CSP violation and no page error", async ({ page }) => {
  const log = await load(page);
  // A function from app.js and the auth stub app-module.js sets when
  // /config.json is empty: both files ran, not just loaded.
  expect(await page.evaluate(() => typeof window.openModal)).toBe("function");
  expect(await page.evaluate(() => window.pubveraAuth && window.pubveraAuth.enabled)).toBe(false);
  expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);
  expectNoCSPViolations(log);
});

test("an injected inline script does not run and raises a violation", async ({ page }) => {
  await load(page);
  await page.evaluate(() => {
    const s = document.createElement("script");
    s.textContent = "window.__pwned = 1";
    document.body.appendChild(s);
  });
  await expect.poll(() => page.evaluate(() => window.__cspViolations.filter(v => v.startsWith("script-src")).length)).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

test("app.js and app-module.js are loaded from the page origin", async ({ page }) => {
  const scripts = [];
  page.on("response", r => {
    if (r.request().resourceType() === "script") scripts.push(r.url() + " " + r.status());
  });
  await load(page);
  expect(scripts).toContain(baseURL + "/app.js 200");
  expect(scripts).toContain(baseURL + "/app-module.js 200");
});

// GRV-007 phase 2d: a per-response nonce in script-src, for Cloudflare's
// injected JS-detections script. Our own markup carries none.

test("a script with the header's nonce runs, a plain inline script does not", async ({ page }) => {
  await page.route("https://cdn.jsdelivr.net/**", r => r.fulfill({ status: 200, contentType: "application/javascript", body: "" }));
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", e => {
      window.__cspViolations.push({ directive: e.violatedDirective, line: e.lineNumber });
    });
  });
  let nonce = "";
  let plainLine = 0;
  await page.route(baseURL + "/", async route => {
    const res = await route.fetch();
    const m = /'nonce-([^']+)'/.exec(res.headers()["content-security-policy"] || "");
    nonce = m ? m[1] : "";
    // Each injected script sits on its own line, so a violation's line number
    // says which of the two it was (the CSP has no report-sample).
    const body = (await res.text()).replace("</body>",
      '\n<script nonce="' + nonce + '">window.__nonced=1</script>\n<script>window.__plain=1</script>\n</body>');
    plainLine = body.split("\n").findIndex(l => l.includes("window.__plain")) + 1;
    const headers = { ...res.headers() };
    delete headers["content-length"];
    delete headers["content-encoding"];
    await route.fulfill({ status: res.status(), headers, body });
  });
  await page.goto(baseURL + "/");
  expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}$/);
  expect(await page.evaluate(() => window.__nonced)).toBe(1);
  expect(await page.evaluate(() => window.__plain)).toBeUndefined();
  const v = await page.evaluate(() => window.__cspViolations);
  // Exactly one violation, and it is the plain script's line.
  expect(v).toHaveLength(1);
  expect(v[0].directive).toMatch(/^script-src/);
  expect(plainLine).toBeGreaterThan(0);
  expect(v[0].line).toBe(plainLine);
});

test("the nonce is not readable from the DOM", async ({ page }) => {
  await load(page);
  expect(await page.evaluate(() => document.querySelectorAll("[nonce]").length)).toBe(0);
  const nonces = await page.evaluate(() => Array.from(document.scripts, s => s.nonce));
  expect(nonces.length).toBeGreaterThan(0);
  expect(nonces.every(n => n === "")).toBe(true);
});
