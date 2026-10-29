// CalVer release workflow test.
//
// Run: node tools/release_workflow_test.js
//
// Every non-pull_request run on main gets a version YYYY.MM.DD.N, stamped into
// the binary, an image tag, the OCI label, a git tag and a GitHub Release. This
// static check reads .github/workflows/deploy.yml and the Dockerfile and
// asserts the pieces are wired together.
//
// Grantvera has two jobs: validate (contents: read) computes the version,
// because its load: true label-check build needs APP_VERSION too, and hands it
// to publish as a job output; publish (needs validate, main only) pushes and is
// the only job that holds contents: write, for the release.
//
// The workflow is checked line by line, never with a regex that spans lines:
// one such regex hung with catastrophic backtracking in the Retractis pilot.
"use strict";
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const lines = fs.readFileSync(path.join(root, ".github", "workflows", "deploy.yml"), "utf8").split(/\r?\n/);
const docker = fs.readFileSync(path.join(root, "Dockerfile"), "utf8").split(/\r?\n/);

let failed = 0;
function check(label, ok) {
  if (!ok) failed++;
  console.log((ok ? "PASS" : "FAIL") + "  " + label);
}

// Jobs: a line with exactly two spaces of indent and a key, inside "jobs:".
const jobsAt = lines.findIndex((l) => l === "jobs:");
const jobs = [];
for (let j = jobsAt + 1; jobsAt >= 0 && j < lines.length; j++) {
  const m = lines[j].match(/^  ([\w-]+):\s*$/);
  if (m) jobs.push({ name: m[1], start: j });
}
jobs.forEach((jb, i) => { jb.end = i + 1 < jobs.length ? jobs[i + 1].start : lines.length; });
const job = (name) => jobs.find((jb) => jb.name === name) || { name: "", start: -1, end: -1 };
const jobOf = (idx) => jobs.find((jb) => idx >= jb.start && idx < jb.end) || { name: "" };
// The indented block under a job key such as "permissions:" or "outputs:".
function block(jb, key) {
  if (jb.start < 0) return [];
  const p = lines.slice(jb.start, jb.end).findIndex((l) => l === "    " + key + ":");
  if (p < 0) return [];
  const out = [];
  for (let j = jb.start + p + 1; j < jb.end && /^      \S/.test(lines[j]); j++) out.push(lines[j].trim());
  return out;
}
// A job-level key on one line, such as "    if: ...".
const jobKey = (jb, key) => (jb.start < 0 ? "" : lines.slice(jb.start, jb.end).find((l) => l.startsWith("    " + key + ":")) || "");

// The lines of one step, from its "- name:" to the next step, the next job or
// end of file. start is the index of the "- name:" line, -1 when missing.
function stepAt(start) {
  if (start < 0) return { start: -1, lines: [] };
  const out = [lines[start]];
  for (let j = start + 1; j < lines.length && !/^\s*- name:/.test(lines[j]) && !/^  [\w-]+:\s*$/.test(lines[j]); j++) out.push(lines[j]);
  return { start, lines: out };
}
const step = (name) => stepAt(lines.findIndex((l) => l.trim() === "- name: " + name));
const has = (s, text) => s.lines.some((l) => l.includes(text));
const ifLine = (s) => s.lines.find((l) => /^\s*if:/.test(l)) || "";

// Every non-pull_request event on main (push and workflow_dispatch) is
// versioned: a workflow_dispatch run on main also pushes :latest, so it must
// not ship as "dev". Both clauses, joined by && only, in either order.
const nonPRMain = (cond) =>
  cond.includes("github.event_name != 'pull_request'") && cond.includes("github.ref == 'refs/heads/main'") &&
  cond.includes("&&") && !cond.includes("||") && !/event_name\s*==\s*'push'/.test(cond);

const validate = job("validate");
const publish = job("publish");
check("jobs validate and publish exist", validate.start >= 0 && publish.start >= 0);

// concurrency: one run per ref, never cancelled, so two runs on main cannot
// both count the same tags and compute the same N.
const conc = lines.findIndex((l) => l === "concurrency:");
check("workflow-level concurrency group exists", conc >= 0 && conc < jobsAt && (lines[conc + 1] || "").trim().startsWith("group:"));
check("cancel-in-progress: false", lines.some((l) => l.trim() === "cancel-in-progress: false"));
check("cancel-in-progress is never true", !lines.some((l) => /^\s*cancel-in-progress:\s*true/.test(l)));

// Compute version: in validate, after its Checkout, before its label-check build.
const ver = step("Compute version");
const labelCheck = step("Build image for the label check");
check("version step exists", ver.start >= 0);
check("version step is in the validate job", ver.start >= 0 && jobOf(ver.start).name === "validate");
check("version step comes after Checkout in validate",
  ver.start >= 0 && lines.slice(validate.start, ver.start).some((l) => l.trim() === "- name: Checkout"));
check("version step comes before the label-check build", ver.start >= 0 && labelCheck.start > ver.start);
check("version step has id: version", has(ver, "id: version"));
check("version step if: is non-PR main and not event_name == 'push'", nonPRMain(ifLine(ver)));
check("version step uses date -u +%Y.%m.%d", has(ver, "date -u +%Y.%m.%d"));
check("version step uses git ls-remote --tags", has(ver, "git ls-remote --tags"));
check("version step writes GITHUB_OUTPUT", has(ver, "GITHUB_OUTPUT"));
check("validate exports outputs.version from the version step",
  block(validate, "outputs").includes("version: ${{ steps.version.outputs.version }}"));

// Every image build passes APP_VERSION.
const builds = lines
  .map((l, i) => (/^\s*- name:/.test(l) ? stepAt(i) : null))
  .filter((s) => s && has(s, "docker/build-push-action"));
check("two image builds exist (found " + builds.length + ")", builds.length === 2);
for (const s of builds) {
  const name = s.lines[0].trim().replace(/^- name:\s*/, "");
  const argIdx = s.lines.findIndex((l) => /^\s*build-args:/.test(l));
  check(name + ": build-args passes APP_VERSION",
    argIdx >= 0 && s.lines.slice(argIdx + 1).some((l) => l.trim().startsWith("APP_VERSION=${{ ")));
}

// The load: true label-check build: validate's version (dev off main), no push.
check("label-check build still has load: true", has(labelCheck, "load: true"));
check("label-check build never pushes", labelCheck.lines.some((l) => l.trim() === "push: false"));
check("label-check build uses APP_VERSION=${{ steps.version.outputs.version || 'dev' }}",
  labelCheck.lines.some((l) => l.trim() === "APP_VERSION=${{ steps.version.outputs.version || 'dev' }}"));
check("label-check build carries no version image tag", !has(labelCheck, "outputs.version }}:") && !has(labelCheck, ":${{ needs."));

// publish: gated on non-PR main, needs validate, takes the version from it.
check("publish needs validate", jobKey(publish, "needs").trim() === "needs: validate");
check("publish job if: is non-PR main", nonPRMain(jobKey(publish, "if")));
const push = step("Build and push");
check("Build and push is in the publish job", push.start >= 0 && jobOf(push.start).name === "publish");
const login = step("Log in to GHCR");
check("Log in to GHCR is in the publish job, before Build and push",
  login.start >= 0 && jobOf(login.start).name === "publish" && login.start < push.start);
const guard = step("Check version");
check("publish checks the CalVer version before anything is built",
  guard.start >= 0 && jobOf(guard.start).name === "publish" && guard.start < push.start &&
  has(guard, "VERSION: ${{ needs.validate.outputs.version }}") && has(guard, "exit 1"));
check("pushing build uses APP_VERSION=${{ needs.validate.outputs.version }}",
  push.lines.some((l) => l.trim() === "APP_VERSION=${{ needs.validate.outputs.version }}"));
check("pushing build tags the version",
  has(push, "${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ needs.validate.outputs.version }}"));
check("pushing build keeps :latest and :sha tags",
  has(push, "${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:latest") && has(push, "${{ env.REGISTRY }}/${{ env.IMAGE_NAME }}:${{ github.sha }}"));
check("pushing build keeps the revision label", has(push, "org.opencontainers.image.revision=${{ github.sha }}"));

// The release: after the push, in publish, gated again on its own step.
const rel = step("Create GitHub release");
check("release step exists", rel.start >= 0);
check("release step is in the publish job", rel.start >= 0 && jobOf(rel.start).name === "publish");
check("release step if: is non-PR main and not event_name == 'push'", nonPRMain(ifLine(rel)));
check("release step comes after Build and push", push.start >= 0 && rel.start > push.start);
check("release step uses GH_TOKEN: ${{ github.token }}", has(rel, "GH_TOKEN: ${{ github.token }}"));
check("release step takes VERSION from validate", has(rel, "VERSION: ${{ needs.validate.outputs.version }}"));
check("release step runs gh release create --target \"$GITHUB_SHA\"",
  rel.lines.some((l) => l.includes("gh release create") && l.includes("--target \"$GITHUB_SHA\"")));
check("release step has baseline notes and --generate-notes",
  rel.lines.some((l) => l.includes("gh release create") && l.includes("--notes ")) &&
  rel.lines.some((l) => l.includes("gh release create") && l.includes("--generate-notes")));

// contents: write only in publish, the job that creates the release.
check("publish has contents: write", block(publish, "permissions").includes("contents: write"));
check("publish keeps packages: write", block(publish, "permissions").includes("packages: write"));
for (const jb of jobs.filter((x) => x.name !== "publish")) {
  check("job " + jb.name + " has no contents: write", !block(jb, "permissions").includes("contents: write"));
}
check("validate keeps contents: read", block(validate, "permissions").includes("contents: read"));

// The default for every job is read-only: a top-level "permissions:" block
// holding exactly contents: read, before "jobs:".
const topAt = lines.findIndex((l) => l === "permissions:");
const topPerms = [];
for (let j = topAt + 1; topAt >= 0 && j < lines.length; j++) {
  const l = lines[j];
  if (l.trim() === "" || l.trim().startsWith("#")) continue;
  if (!/^ /.test(l)) break;
  topPerms.push(l.trim());
}
check("top-level permissions is contents: read (found " + JSON.stringify(topPerms) + ")",
  topAt >= 0 && topAt < jobsAt && JSON.stringify(topPerms) === JSON.stringify(["contents: read"]));
check("contents: write appears exactly once in the workflow",
  lines.filter((l) => l.trim() === "contents: write").length === 1);

// No new action: the gh CLI does the release.
const uses = lines.filter((l) => l.includes("uses:")).length;
check("uses: count is 8 (found " + uses + ")", uses === 8);

// Dockerfile: stages by FROM; one ARG APP_VERSION=dev in web-builder (before
// its go build), one in the runtime stage (before the LABEL), none elsewhere.
const froms = docker.map((l, i) => (/^FROM\s/.test(l) ? i : -1)).filter((i) => i >= 0);
const stageOf = (idx) => froms.filter((f) => f <= idx).length - 1;
const webStage = froms.findIndex((f) => /\sAS web-builder\s*$/.test(docker[f]));
const lastStage = froms.length - 1;
const argLines = docker.map((l, i) => (l.trim() === "ARG APP_VERSION=dev" ? i : -1)).filter((i) => i >= 0);
const buildRun = docker.findIndex((l) => /^RUN .*go build/.test(l));
const label = docker.findIndex((l) => l.trim() === "LABEL org.opencontainers.image.version=${APP_VERSION}");
check("Dockerfile has three stages (found " + froms.length + ")", froms.length === 3);
check("Dockerfile has ARG APP_VERSION=dev twice (found " + argLines.length + ")", argLines.length === 2);
check("Dockerfile ARG APP_VERSION=dev is in web-builder before go build",
  argLines.some((a) => stageOf(a) === webStage && a < buildRun) && stageOf(buildRun) === webStage);
check("Dockerfile ARG APP_VERSION=dev is in the runtime stage before the LABEL",
  label >= 0 && stageOf(label) === lastStage && argLines.some((a) => stageOf(a) === lastStage && a < label));
check("Dockerfile go build keeps -trimpath and sets -ldflags \"-X main.appVersion=${APP_VERSION}\"",
  buildRun >= 0 && docker[buildRun].includes(" -trimpath ") && docker[buildRun].includes("-ldflags \"-X main.appVersion=${APP_VERSION}\""));
check("Dockerfile has LABEL org.opencontainers.image.version=${APP_VERSION}", label >= 0);
check("Dockerfile keeps the global ARG PP_LIBRARY_COMMIT before the first FROM",
  froms.length > 0 && docker.slice(0, froms[0]).some((l) => /^ARG PP_LIBRARY_COMMIT=[0-9a-f]{40}$/.test(l)));
check("Dockerfile keeps LABEL org.pubvera.cli.commit", docker.some((l) => l.trim() === "LABEL org.pubvera.cli.commit=${PP_LIBRARY_COMMIT}"));

// The web-builder COPY names the Go files one by one: a root .go file missing
// from it (version.go) leaves go test green and breaks the image build.
const copyLine = docker.find((l, i) => stageOf(i) === webStage && /^COPY\s/.test(l) && l.includes("main.go")) || "";
const copied = copyLine.trim().split(/\s+/);
const goFiles = fs.readdirSync(root).filter((f) => f.endsWith(".go") && !f.endsWith("_test.go"));
check("web-builder COPY line lists Go files", copied.length > 2);
check("web-builder COPY includes version.go", copied.includes("version.go"));
for (const f of goFiles.filter((g) => g !== "version.go")) check("web-builder COPY includes " + f, copied.includes(f));

if (failed) {
  console.error(failed + " check(s) failed");
  process.exit(1);
}
console.log("all release workflow checks pass");
