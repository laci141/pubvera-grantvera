// Browser test for GRV-AUTH-001: the three sign-in states of app-module.js.
//
// Run: cd tools/browser && npm install && npx playwright test auth.spec.js
//
//   disabled     /config.json answers 200 with an empty pair: no sign-in UI.
//   ready        the Supabase client started.
//   unavailable  anything else that should have worked: the page says so and the
//                console gets one short code, never a key, a token or the config.
//
// The real Go server (built from this checkout) runs with a Supabase config and
// serves the real page; what the page sees at /config.json is changed per test
// by intercepting that one request. supabase-js comes from the CDN (its SRI hash
// rules out a stub), which is why a test that needs it makes a real request.
"use strict";
const { test, expect } = require("@playwright/test");
const { execFileSync, spawn } = require("child_process");
const net = require("net");
const os = require("os");
const path = require("path");

const repo = path.join(__dirname, "..", "..");
const bin = path.join(os.tmpdir(), "grantvera-auth-test", process.platform === "win32" ? "grantvera.exe" : "grantvera");
const KEY = "sb_publishable_test";
const SUPA_ORIGIN = "https://example.supabase.co";
const SUPABASE_JS_ROUTE = r => r.continue();

let proc;
let baseURL;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

test.beforeAll(async () => {
  execFileSync("go", ["build", "-o", bin, "."], { cwd: repo, stdio: "inherit" });
  const port = await freePort();
  baseURL = "http://127.0.0.1:" + port;
  proc = spawn(bin, [], { cwd: repo, env: { ...process.env, PORT: String(port), SUPABASE_URL: SUPA_ORIGIN, SUPABASE_PUBLISHABLE_KEY: KEY }, stdio: "ignore" });
  const deadline = Date.now() + 15000;
  for (;;) {
    try { if ((await fetch(baseURL + "/healthz")).ok) break; } catch (_) { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error("server did not answer /healthz on " + baseURL);
    await new Promise(r => setTimeout(r, 100));
  }
});

test.afterAll(async () => {
  if (proc && proc.exitCode === null) {
    const exited = new Promise(r => proc.once("exit", r));
    proc.kill();
    await exited;
  }
});

// Opens the page. config: a route handler for /config.json (omit for the real
// answer). supabase: "real" fetches supabase-js, "abort" makes its load fail.
async function boot(page, { config, supabase = "real" } = {}) {
  await page.route("https://cdn.jsdelivr.net/**", r => {
    if (r.request().url().includes("/@supabase/supabase-js@")) return supabase === "abort" ? r.abort() : SUPABASE_JS_ROUTE(r);
    return r.fulfill({ status: 200, contentType: "application/javascript", body: "" });
  });
  if (config) await page.route("**/config.json", config);
  const log = { console: [], pageErrors: [] };
  page.on("console", m => log.console.push(m.text()));
  page.on("pageerror", e => log.pageErrors.push(String(e)));
  await page.goto(baseURL + "/");
  return log;
}

const json = (status, body) => r => r.fulfill({ status, contentType: "application/json", body: typeof body === "string" ? body : JSON.stringify(body) });
const authMessages = log => log.console.filter(m => m.startsWith("[auth]"));

// What a failure must look like, whatever caused it.
async function expectUnavailable(page, log, code, text) {
  await expect(page.locator("#authBar")).toBeVisible();
  await expect(page.locator("#authUnavailable")).toBeVisible();
  await expect(page.locator("#authUnavailable")).toHaveText(text);
  await expect(page.locator("#authSignInBtn")).toBeHidden();
  await expect(page.locator("#authSignOutBtn")).toBeHidden();
  await expect(page.locator("#authEmail")).toBeHidden();
  const st = await page.evaluate(() => ({ enabled: window.pubveraAuth.enabled, unavailable: window.pubveraAuth.unavailable, text: window.pubveraAuth.unavailableText, sb: typeof window.sb }));
  expect(st).toEqual({ enabled: false, unavailable: true, text, sb: "undefined" });
  // One short code on the console; no key, no config, no token in it.
  expect(authMessages(log)).toEqual(["[auth] sign-in unavailable: " + code]);
  for (const m of log.console) {
    expect(m, "console message").not.toContain(KEY);
    expect(m, "console message").not.toContain("supabase_anon_key");
  }
  expect(log.pageErrors, "page errors").toEqual([]);
}

const TEXT_CONFIG = "Sign-in is unavailable: its configuration could not be loaded.";
const TEXT_SCRIPT = "Sign-in is unavailable: a required script did not load.";
const TEXT_START = "Sign-in is unavailable: it could not be started.";

test("an empty config pair is the disabled state: no sign-in UI, nothing logged", async ({ page }) => {
  const log = await boot(page, { config: json(200, { supabase_url: "", supabase_anon_key: "" }) });
  // Nothing visible happens in this state, so give the module time to finish.
  // (Not waitForResponse: goto already waited for the config request, so that
  // call would wait for a response that has come and gone.)
  await page.waitForTimeout(300);
  await expect(page.locator("#authBar")).toBeHidden();
  expect(await page.evaluate(() => ({ enabled: window.pubveraAuth.enabled, unavailable: window.pubveraAuth.unavailable, sb: typeof window.sb })))
    .toEqual({ enabled: false, unavailable: undefined, sb: "undefined" });
  expect(authMessages(log)).toEqual([]);
  expect(log.pageErrors).toEqual([]);
});

for (const status of [500, 404]) {
  test("/config.json answering " + status + " is unavailable, not disabled", async ({ page }) => {
    const log = await boot(page, { config: json(status, "nope") });
    await expectUnavailable(page, log, "config-http-" + status, TEXT_CONFIG);
  });
}

test("a /config.json body that is not JSON is unavailable", async ({ page }) => {
  const log = await boot(page, { config: json(200, "{not json") });
  await expectUnavailable(page, log, "config-unreadable", TEXT_CONFIG);
});

test("a /config.json request that fails on the network is unavailable", async ({ page }) => {
  const log = await boot(page, { config: r => r.abort() });
  await expectUnavailable(page, log, "config-unreadable", TEXT_CONFIG);
});

test("a /config.json body that is JSON but not an object is unavailable", async ({ page }) => {
  const log = await boot(page, { config: json(200, "null") });
  await expectUnavailable(page, log, "config-shape", TEXT_CONFIG);
});

test("a supabase-js script that does not load keeps its own message", async ({ page }) => {
  const log = await boot(page, { supabase: "abort" });
  await expectUnavailable(page, log, "script", TEXT_SCRIPT);
});

test("a createClient that throws (config URL is not http or https) is unavailable", async ({ page }) => {
  const log = await boot(page, { config: json(200, { supabase_url: "ftp://example.invalid", supabase_anon_key: KEY }) });
  await expectUnavailable(page, log, "client-init", TEXT_START);
});

test("a getSession that rejects is unavailable", async ({ page }) => {
  // The UMD build fills the object it assigns to window.supabase after the
  // assignment, so wrap that object (a Proxy) instead of copying it.
  await page.addInitScript(() => {
    let real;
    Object.defineProperty(window, "supabase", {
      configurable: true,
      get() { return real; },
      set(v) {
        real = new Proxy(v, {
          get(t, k) {
            if (k !== "createClient") return t[k];
            return (...a) => { const c = t.createClient(...a); c.auth.getSession = () => Promise.reject(new Error("boom")); return c; };
          },
        });
      },
    });
  });
  const log = await boot(page);
  await expectUnavailable(page, log, "session", TEXT_START);
});

test("a 401 error card repeats the reason sign-in is unavailable", async ({ page }) => {
  const log = await boot(page, { config: json(500, "nope") });
  await page.route("**/api/**", r => r.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "missing token" }) }));
  await expect(page.locator("#authUnavailable")).toBeVisible();
  await page.locator(".chip", { hasText: "Climate" }).click();
  await page.locator("#open-query").press("Enter");
  await expect(page.locator("#open-results .errcard")).toContainText(TEXT_CONFIG);
  expect(log.pageErrors).toEqual([]);
});

test("a working config is ready: the sign-in button shows and starts the Google flow", async ({ page }) => {
  const authorize = [];
  await page.route(SUPA_ORIGIN + "/auth/v1/authorize**", r => { authorize.push(r.request().url()); return r.fulfill({ status: 200, contentType: "text/html", body: "<p>stub</p>" }); });
  const log = await boot(page);
  await expect(page.locator("#authSignInBtn")).toBeVisible();
  await expect(page.locator("#authUnavailable")).toBeHidden();
  await expect(page.locator("#authSignOutBtn")).toBeHidden();
  expect(await page.evaluate(() => window.pubveraAuth.enabled)).toBe(true);
  expect(authMessages(log)).toEqual([]);
  await page.locator("#authSignInBtn").click();
  await expect.poll(() => authorize.length).toBe(1);
  const u = new URL(authorize[0]);
  expect(u.searchParams.get("provider")).toBe("google");
  expect(u.searchParams.get("redirect_to")).toBe(baseURL);
});
