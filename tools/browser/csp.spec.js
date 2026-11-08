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
// A second server with a Supabase config, for the connect-src checks. Its host
// is example.supabase.co, and every request to it is stubbed in the test.
let supaServer;
let supaURL;
// The servers' log output (the standard log package writes to stderr).
let serverLog = "";
const SUPA_ORIGIN = "https://example.supabase.co";
// The end of the enforcing policy on the server without a Supabase config.
const SELF_TAIL = "; connect-src 'self'; report-to csp; report-uri /csp-report";

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

async function startServer(env) {
  const port = await freePort();
  const url = "http://127.0.0.1:" + port;
  const proc = spawn(bin, [], {
    cwd: repo,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ["ignore", "ignore", "pipe"],
  });
  proc.stderr.on("data", d => { serverLog += d; });
  const deadline = Date.now() + 15000;
  for (;;) {
    try {
      const res = await fetch(url + "/healthz");
      if (res.ok) break;
    } catch (_) { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error("server did not answer /healthz on " + url);
    await new Promise(r => setTimeout(r, 100));
  }
  return { proc, url };
}

async function stopServer(proc) {
  if (proc && proc.exitCode === null) {
    const exited = new Promise(r => proc.once("exit", r));
    proc.kill();
    await exited;
  }
}

test.beforeAll(async () => {
  execFileSync("go", ["build", "-o", bin, "."], { cwd: repo, stdio: "inherit" });
  // Empty Supabase config: the page runs unauthenticated.
  ({ proc: server, url: baseURL } = await startServer({ SUPABASE_URL: "", SUPABASE_PUBLISHABLE_KEY: "" }));
  ({ proc: supaServer, url: supaURL } = await startServer({ SUPABASE_URL: SUPA_ORIGIN, SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test" }));
});

test.afterAll(async () => {
  await stopServer(server);
  await stopServer(supaServer);
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

async function load(page, { origin = baseURL, realSupabaseJS = false } = {}) {
  // The xlsx bundle on the CDN is not needed for these checks; keep the run
  // offline-safe and fast. supabase-js is loaded for real only where a test
  // signs out through it (its SRI hash rules out a stub).
  await page.route("https://cdn.jsdelivr.net/**", r => (realSupabaseJS && r.request().url().includes("/@supabase/supabase-js@"))
    ? r.continue()
    : r.fulfill({ status: 200, contentType: "application/javascript", body: "" }));
  // Recorded in the page from the first script on, so a violation raised
  // while the page loads is not missed.
  await page.addInitScript(() => {
    window.__cspViolations = [];
    document.addEventListener("securitypolicyviolation", e => {
      window.__cspViolations.push(e.violatedDirective + " " + (e.blockedURI || ""));
    });
  });
  const log = watch(page);
  const res = await page.goto(origin + "/");
  expect(res.headers()["content-security-policy"]).toContain("script-src-attr 'none'");
  log.headers = res.headers();
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

// GRV-007 style-src phase 2: the CSS is style.css and the page has no style=
// attribute, so the enforcing policy carries style-src 'self'. No Report-Only
// policy is sent (connect-src is enforced too, below). A refused style reaches the console
// ("... Content Security Policy") and fires securitypolicyviolation, so both are
// checked.

const NIH_FIXTURE = {
  total: 2,
  projects: [
    { project_num: "R01-1", project_title: "Tumour biology", contact_pi_name: "A, B", organization: { org_name: "U1" }, award_amount: 1000000, fiscal_year: 2026 },
    { project_num: "R01-2", project_title: "Tumour biology", contact_pi_name: "C, D", organization: { org_name: "U2" }, award_amount: 250000, fiscal_year: 2026 },
  ],
};

test("style.css is loaded and style-src 'self' is enforced without a violation", async ({ page }) => {
  const sheets = [];
  page.on("response", r => {
    if (r.request().resourceType() === "stylesheet") sheets.push(r.url() + " " + r.status());
  });
  let ro = "", csp = "";
  page.on("response", r => {
    if (r.url() === baseURL + "/") {
      csp = r.headers()["content-security-policy"] || "";
      ro = r.headers()["content-security-policy-report-only"] || "";
    }
  });
  const log = await load(page);
  expect(sheets).toContain(baseURL + "/style.css 200");
  expect(csp).toContain("script-src-attr 'none'");
  expect(csp.endsWith("; style-src 'self'" + SELF_TAIL)).toBe(true);
  expect(ro).toBe("");
  expect(await page.evaluate(() => document.querySelectorAll("[style]").length)).toBe(0);
  expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);
  expectNoCSPViolations(log);
});

test("each modal gets its colour from style.css", async ({ page }) => {
  const log = await load(page);
  const colours = await page.evaluate(() => ["open", "nih", "nsf"].map(k => {
    const m = document.getElementById("modal-" + k);
    return getComputedStyle(m).getPropertyValue("--color").trim() + " " + getComputedStyle(m.querySelector(".modal-header h2")).color;
  }));
  expect(colours).toEqual([
    "#00d4ff rgb(0, 212, 255)",
    "#7c3aed rgb(124, 58, 237)",
    "#22c55e rgb(34, 197, 94)",
  ]);
  expectNoCSPViolations(log);
});

test("money bars get their width through the CSSOM", async ({ page }) => {
  const log = await load(page);
  await page.route("**/api/nih", r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(NIH_FIXTURE) }));
  await page.locator(".chip", { hasText: "Cancer" }).click();
  await page.locator("#nih-btn").click();
  await expect(page.locator("#nih_tw .bar-chart")).toHaveCount(2);
  const bars = () => page.evaluate(() => Array.from(document.querySelectorAll("#nih_tw .bar-chart"), b =>
    b.dataset.pct + " " + b.style.width + " " + (parseFloat(getComputedStyle(b).width) > 0)));
  // Unsorted, so in fixture order: 100 % and 25 % of the largest award.
  expect(await bars()).toEqual(["100 100% true", "25 25% true"]);
  // A re-render (the result filter) sets the width again; the maximum is now
  // the one remaining row.
  await page.locator("#nih-results .qfilter").fill("R01-2");
  await expect(page.locator("#nih_tw .bar-chart")).toHaveCount(1);
  expect(await bars()).toEqual(["100 100% true"]);
  expect(await page.evaluate(() => window.__cspViolations)).toEqual([]);
  expectNoCSPViolations(log);
});

// connect-src phase 2: the enforcing Content-Security-Policy ends with
// connect-src 'self', plus the Supabase origin when /config.json has a Supabase
// config, and the report directives. There is no Report-Only header. A refused
// connection prints a connect-src message on the console and fires
// securitypolicyviolation, so both are checked.

const CONNECT_RE = /connect-src|Refused to connect/i;
function expectNoConnectSrc(log, violations) {
  expect(log.console.filter(m => CONNECT_RE.test(m)), "connect-src console messages").toEqual([]);
  expect(violations.filter(v => v.startsWith("connect-src")), "connect-src violations").toEqual([]);
}

test("the unauthenticated page raises no connect-src report", async ({ page }) => {
  const log = await load(page);
  expect(log.headers["content-security-policy"].endsWith(SELF_TAIL)).toBe(true);
  expect(log.headers["content-security-policy-report-only"] || "").toBe("");
  expect(log.headers["reporting-endpoints"]).toBe('csp="/csp-report"');
  await page.route("**/api/**", r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(OPEN_FIXTURE) }));
  await page.locator(".chip", { hasText: "Climate" }).click();
  await page.locator("#open-query").press("Enter");
  await expect(page.locator("#open_tw tbody tr")).toHaveCount(2);
  expectNoConnectSrc(log, await page.evaluate(() => window.__cspViolations));
  expectNoCSPViolations(log);
});

test("a fetch to a host outside connect-src is refused and never leaves the page", async ({ page }) => {
  let blocked = 0;
  await page.route("https://blocked.invalid/**", r => {
    blocked++;
    return r.fulfill({ status: 200, headers: { "Access-Control-Allow-Origin": "*" }, body: "ok" });
  });
  const log = await load(page);
  expect(log.headers["content-security-policy"].endsWith(SELF_TAIL)).toBe(true);
  const result = await page.evaluate(() => fetch("https://blocked.invalid/x").then(r => "resolved " + r.status, e => "rejected " + e.name));
  expect(result).toBe("rejected TypeError");
  await expect.poll(() => log.console.filter(m => /Refused to connect/.test(m)).length).toBe(1);
  await expect.poll(() => page.evaluate(() => window.__cspViolations.filter(v => v.startsWith("connect-src")).length)).toBe(1);
  expect(blocked).toBe(0);
});

// The fake session is the one the connect-src measurement used: an unexpired
// JWT-shaped token in supabase-js's storage key for project "example". Every
// request to example.supabase.co is stubbed; no real Supabase host is contacted.
function fakeSession() {
  const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
  const exp = Math.floor(Date.now() / 1000) + 7200;
  const user = { id: "00000000-0000-4000-8000-000000000001", aud: "authenticated", role: "authenticated", email: "pw@example.invalid" };
  return {
    access_token: b64({ alg: "HS256", typ: "JWT" }) + "." + b64({ sub: user.id, aud: "authenticated", role: "authenticated", email: user.email, exp }) + ".sig",
    token_type: "bearer", expires_in: 7200, expires_at: exp, refresh_token: "fake-refresh-token", user,
  };
}

test("signed in with Supabase, Sign out raises no connect-src report", async ({ page }) => {
  const supa = [];
  await page.route(SUPA_ORIGIN + "/**", r => {
    supa.push(r.request().method() + " " + new URL(r.request().url()).pathname);
    return r.fulfill({
      status: 204,
      headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" },
    });
  });
  await page.addInitScript(s => localStorage.setItem("sb-example-auth-token", JSON.stringify(s)), fakeSession());
  const log = await load(page, { origin: supaURL, realSupabaseJS: true });
  await expect(page.locator("#authEmail")).toHaveText("pw@example.invalid");
  await page.locator("#authSignOutBtn").click();
  await expect(page.locator("#authSignInBtn")).toBeVisible();
  expect(supa.filter(s => s.startsWith("POST /auth/v1/logout"))).toHaveLength(1);
  expectNoConnectSrc(log, await page.evaluate(() => window.__cspViolations));
  expectNoCSPViolations(log);
  // Last, so a missing origin shows up as the refused logout first.
  expect(log.headers["content-security-policy"].endsWith("; connect-src 'self' " + SUPA_ORIGIN + "; report-to csp; report-uri /csp-report")).toBe(true);
  expect(log.headers["content-security-policy-report-only"] || "").toBe("");
});

// The endpoint on the real server and mux, posted to directly: Chromium does
// not deliver report-to reports to this http://127.0.0.1 origin (measured; see
// the PR notes), so browser delivery is not asserted here.
test("POST /csp-report on the real server answers 204 and logs one line without the query", async () => {
  const marker = "pw-" + Date.now() + "-" + Math.random().toString(36).slice(2);
  const res = await fetch(baseURL + "/csp-report", {
    method: "POST",
    headers: { "Content-Type": "application/csp-report" },
    body: JSON.stringify({ "csp-report": {
      "document-uri": baseURL + "/" + marker + "?q=1", "effective-directive": "connect-src", "disposition": "report",
      "blocked-uri": "https://blocked.example/collect?code=SECRET&x=1",
    } }),
  });
  expect(res.status).toBe(204);
  expect(await res.text()).toBe("");
  expect(res.headers.get("reporting-endpoints")).toBe('csp="/csp-report"');
  expect(res.headers.get("content-security-policy").endsWith(SELF_TAIL)).toBe(true);
  expect(res.headers.get("content-security-policy-report-only")).toBeNull();
  const want = "csp-violation disposition=report directive=connect-src blocked=https://blocked.example page=/" + marker;
  await expect.poll(() => serverLog.split(/\r?\n/).filter(l => l.endsWith(" " + want)).length).toBe(1);
  expect(serverLog).not.toContain("SECRET");

  const get = await fetch(baseURL + "/csp-report");
  expect(get.status).toBe(405);
  expect(get.headers.get("allow")).toBe("POST");
});

// ── Keyboard and screen-reader access (audit GRV-A11Y-001 … 005) ─────────────

test("the bento cards are native buttons reached by Tab; Enter and Space open their modal and Escape gives the focus back", async ({ page }) => {
  const log = await load(page);
  for (const name of ["open", "nih", "nsf"]) {
    expect(await page.locator(".bento-card." + name).evaluate(el => el.tagName), name + " card element").toBe("BUTTON");
  }
  // Tab alone reaches all three, in document order.
  const reached = [];
  for (let i = 0; i < 12 && reached.length < 3; i++) {
    await page.keyboard.press("Tab");
    const m = await page.evaluate(() => { const a = document.activeElement; return a.matches("button.bento-card") ? a.dataset.modal : null; });
    if (m) reached.push(m);
  }
  expect(reached).toEqual(["open", "nih", "nsf"]);
  // Enter opens one, Space another; Escape closes and the card has the focus again.
  for (const [name, key] of [["open", "Enter"], ["nih", "Space"], ["nsf", "Enter"]]) {
    const card = page.locator("button.bento-card." + name);
    await card.focus();
    await page.keyboard.press(key);
    await expect(page.locator("#modal-" + name)).toHaveClass(/\bactive\b/);
    await expect(page.locator("#" + name + "-query")).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(page.locator("#modal-" + name)).not.toHaveClass(/\bactive\b/);
    await expect(card).toBeFocused();
  }
  // The close button hands the focus back to the control that opened the dialog.
  const chip = page.locator(".chip", { hasText: "Climate" });
  await chip.click();
  await expect(page.locator("#modal-open")).toHaveClass(/\bactive\b/);
  await page.locator("#modal-open .close-btn").click();
  await expect(chip).toBeFocused();
  expectNoCSPViolations(log);
});

test("each modal is a named dialog with a named close button, and Tab and Shift+Tab never leave it", async ({ page }) => {
  const log = await load(page);
  for (const [name, title] of [["open", "Open Grants"], ["nih", "Awarded NIH Grants"], ["nsf", "Awarded NSF Grants"]]) {
    await page.locator("button.bento-card." + name).click();
    const dlg = page.getByRole("dialog", { name: title });
    await expect(dlg).toBeVisible();
    await expect(dlg).toHaveAttribute("aria-modal", "true");
    await expect(dlg.getByRole("button", { name: "Close " + title + " dialog", exact: true })).toBeVisible();
    await expect(page.locator("#" + name + "-query")).toBeFocused();
    // More presses than the dialog has controls, in both directions.
    for (const key of ["Tab", "Shift+Tab"]) {
      for (let i = 0; i < 25; i++) {
        await page.keyboard.press(key);
        const inside = await page.evaluate(n => !!document.activeElement.closest("#modal-" + n + " .modal-content"), name);
        expect(inside, name + ": focus after " + key + " press " + (i + 1) + " is inside the dialog").toBe(true);
      }
    }
    await page.keyboard.press("Escape");
    await expect(page.locator("#modal-" + name)).not.toHaveClass(/\bactive\b/);
  }
  expectNoCSPViolations(log);
});

test("the five range sliders are named by their labels, and a label focuses its slider", async ({ page }) => {
  const log = await load(page);
  const sliders = [["open", "open-rows", "Rows"], ["nih", "nih-min", "Min amount"], ["nih", "nih-rows", "Rows"],
                   ["nsf", "nsf-min", "Min amount"], ["nsf", "nsf-rows", "Rows"]];
  for (const [card, id, text] of sliders) {
    await page.locator("button.bento-card." + card).click();
    await expect(page.locator("#" + card + "-query")).toBeFocused();
    await expect(page.locator("#" + id)).toHaveAccessibleName(new RegExp("^" + text + ":"));
    await page.locator('label[for="' + id + '"]').click();
    await expect(page.locator("#" + id)).toBeFocused();
    // The open dialog covers the cards: close it before the next one is clicked.
    await page.keyboard.press("Escape");
    await expect(page.locator("#modal-" + card)).not.toHaveClass(/\bactive\b/);
  }
  expectNoCSPViolations(log);
});

test("sortable headers are buttons: Enter and Space sort, aria-sort follows, the focus stays, the quick filter has a name", async ({ page }) => {
  const log = await load(page);
  await page.route("**/api/**", r => r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(OPEN_FIXTURE) }));
  await page.locator(".chip", { hasText: "Climate" }).click();
  await page.locator("#open-query").press("Enter");
  await expect(page.locator("#open_tw tbody tr")).toHaveCount(2);

  await expect(page.getByRole("textbox", { name: "Filter open grant results", exact: true })).toBeVisible();
  // Every header cell says which axis it heads.
  expect(await page.locator("#open_tw thead th:not([scope=col])").count(), "header cells without scope=col").toBe(0);

  const th = page.locator('#open_tw th.sortable[data-col="1"]');
  const btn = th.locator(".sort-btn");
  const firstTitle = page.locator("#open_tw tbody tr:first-child td:nth-child(3)");
  expect(await th.getAttribute("aria-sort"), "unsorted column carries no aria-sort").toBeNull();
  await expect(page.getByRole("columnheader", { name: "Title", exact: true })).toBeVisible();

  await btn.focus();
  await page.keyboard.press("Enter");
  await expect(th).toHaveAttribute("aria-sort", "ascending");
  await expect(firstTitle).toHaveText("Climate resilience 1");
  await expect(btn).toBeFocused();

  await page.keyboard.press("Space");
  await expect(th).toHaveAttribute("aria-sort", "descending");
  await expect(firstTitle).toHaveText("Coastal flooding 2");
  await expect(btn).toBeFocused();

  // A mouse click keeps working, and sorting another column clears this one.
  await btn.click();
  await expect(th).toHaveAttribute("aria-sort", "ascending");
  await page.locator('#open_tw th.sortable[data-col="0"] .sort-btn').click();
  expect(await th.getAttribute("aria-sort"), "the previously sorted column loses aria-sort").toBeNull();
  await expect(page.locator('#open_tw th.sortable[data-col="0"]')).toHaveAttribute("aria-sort", "ascending");
  expectNoCSPViolations(log);
});
