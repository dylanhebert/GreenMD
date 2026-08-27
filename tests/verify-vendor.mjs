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

if (failures.length) {
  console.log("VENDOR VERIFICATION FAILED:");
  for (const failure of failures) console.log("  " + failure);
  process.exit(1);
}

console.log(`vendor: ${checked} file(s) match the recorded hashes`);
