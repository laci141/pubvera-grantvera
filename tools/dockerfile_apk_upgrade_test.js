// Dockerfile apk upgrade test (U1-U6): the runtime stage upgrades zlib and
// OpenSSL (libcrypto3, libssl3) by name, never with a bare "apk upgrade".
//
// Run: node tools/dockerfile_apk_upgrade_test.js [path/to/Dockerfile]
//
// grype (--only-fixed --fail-on high) found zlib 1.3.2-r1 (CVE-2026-4738,
// fixed in 1.4-r0) and libcrypto3/libssl3 3.5.9-r0 (fixed in 3.5.9-r1).
//   U1 exactly one "apk upgrade" line in the final stage (after the last FROM);
//   U2 it has --no-cache;
//   U3 it names zlib, libcrypto3 and libssl3;
//   U4 no "apk upgrade" without a package name;
//   U5 the upgrade comes before the USER line;
//   U6 a USER line exists in the final stage.
// Comment lines (#) are skipped. A missing line is a FAIL, never a silent pass.
"use strict";
const fs = require("fs");
const path = require("path");

const file = process.argv[2] || path.join(__dirname, "..", "Dockerfile");
let text = fs.readFileSync(file, "utf8");
if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
const all = text.split(String.fromCharCode(13)).join("").split(String.fromCharCode(10));

let ran = 0, failed = 0;
function check(label, ok) { ran++; if (!ok) failed++; console.log((ok ? "PASS" : "FAIL") + "  " + label); }

let last = -1;
all.forEach((l, i) => { if (l.trim().toUpperCase().startsWith("FROM ")) last = i; });
const stage = (last < 0 ? [] : all.slice(last + 1))
  .map((l) => l.trim())
  .filter((l) => l !== "" && !l.startsWith("#"));

const ups = stage.filter((l) => l.includes("apk upgrade"));
check("U1 exactly one apk upgrade line in the final stage (found " + ups.length + ")", ups.length === 1);
const up = ups[0] || "";
check("U2 the apk upgrade line has --no-cache", up.includes("--no-cache"));
check("U3 the apk upgrade line names zlib, libcrypto3 and libssl3",
  up.includes(" zlib") && up.includes(" libcrypto3") && up.includes(" libssl3"));

// Every "apk upgrade" segment must name at least one package (a word not
// starting with "-") before the next "&&" or ";".
let bare = 0;
ups.forEach((l) => {
  l.split("apk upgrade").slice(1).forEach((seg) => {
    const words = seg.split("&&")[0].split(";")[0].split(" ").filter((w) => w !== "");
    if (!words.some((w) => !w.startsWith("-"))) bare++;
  });
});
check("U4 no bare apk upgrade (found " + bare + ")", ups.length > 0 && bare === 0);

const userIdx = stage.findIndex((l) => l.toUpperCase().startsWith("USER "));
const upIdx = stage.findIndex((l) => l.includes("apk upgrade"));
check("U5 the apk upgrade line comes before USER", upIdx >= 0 && userIdx >= 0 && upIdx < userIdx);
check("U6 the final stage has a USER line", userIdx >= 0);

console.log(ran + " checks, " + failed + " failed");
process.exit(failed ? 1 : 0);
