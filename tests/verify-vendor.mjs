/**
 * Checks vendored third-party code still matches what was reviewed.
 *
 * The point of committing these files rather than fetching them at build time is
 * that what ships is what someone looked at. That only holds if the file is
 * actually unchanged, so the hash recorded in vendor/README.md is checked here and
 * in CI rather than being documentation nobody verifies.
 */
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const VENDOR = join(here, "..", "GreenMD", "web", "vendor");

const readme = readFileSync(join(VENDOR, "README.md"), "utf8");
const failures = [];

/** Every "## <file>" section with a SHA-256 row is treated as a claim to verify. */
const sections = readme.split(/^## /m).slice(1);

let checked = 0;

for (const section of sections) {
  const name = section.split(/\r?\n/)[0].trim();
  if (!name.includes(".")) continue;

  const expected = section.match(/SHA-256\s*\|\s*([0-9a-fA-F]{64})/)?.[1];
  if (!expected) {
    failures.push(`${name}: no SHA-256 recorded in vendor/README.md`);
    continue;
  }

  let actual;
  try {
    actual = createHash("sha256").update(readFileSync(join(VENDOR, name))).digest("hex");
  } catch {
    failures.push(`${name}: recorded in vendor/README.md but not present`);
    continue;
  }

  checked += 1;
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    failures.push(`${name}: hash mismatch\n    expected ${expected.toLowerCase()}\n    actual   ${actual}`);
  }
}

/*
 * The About box credits mermaid by version and cannot read it off window.mermaid,
 * because mermaid is not loaded until a document actually contains a diagram. So app.js
 * carries a copy of the version -- and a copy nothing checks is a copy that goes stale.
 * This is that check. Bump the vendored file and the two disagree here, in CI, rather
 * than shipping a confidently wrong number in a dialog people read to file bug reports.
 */
const declared = readFileSync(join(VENDOR, "..", "app.js"), "utf8")
  .match(/MERMAID_VERSION\s*=\s*"([^"]+)"/)?.[1];
const recorded = readme.match(/^\|\s*Version\s*\|\s*([^|\s]+)\s*\|/m)?.[1];

if (!declared) {
  failures.push("web/app.js: no MERMAID_VERSION constant found");
} else if (!recorded) {
  failures.push("vendor/README.md: no Version row recorded");
} else if (declared !== recorded) {
  failures.push(
    `mermaid version drift\n    vendor/README.md records ${recorded}\n    web/app.js declares  ${declared}`);
}

if (failures.length) {
  console.log("VENDOR VERIFICATION FAILED:");
  for (const failure of failures) console.log("  " + failure);
  process.exit(1);
}

console.log(`vendor: ${checked} file(s) match the recorded hashes, mermaid ${recorded} credited consistently`);
