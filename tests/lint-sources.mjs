/**
 * Guards against a failure mode that has bitten this project repeatedly: a tool
 * writing these files reinterprets an escape sequence, so `"\n"` becomes a literal
 * newline inside a string literal (a syntax error), or `[\s\S]` degrades to `[sS]`
 * (silently wrong, and invisible on a casual read).
 *
 * Checks every web source parses, and that none contains a stray control character.
 */
import { readFileSync, readdirSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const here = dirname(fileURLToPath(import.meta.url));
const WEB = join(here, "..", "MarkdownViewer", "web");

const failures = [];

/** Line terminators are stripped first; the rest are genuinely stray. */
function checkControlCharacters(name, source) {
  const lines = source.split(/\r?\n/);

  lines.forEach((line, index) => {
    for (const character of line) {
      const code = character.codePointAt(0);
      if (code === 9) continue;                       // tabs are legal indentation
      if (code < 0x20 || (code >= 0x7f && code < 0xa0)) {
        failures.push(
          `${name}:${index + 1}: stray control character U+${code.toString(16).padStart(4, "0").toUpperCase()}`);
        return;
      }
    }
  });
}

for (const file of readdirSync(WEB).filter(f => f.endsWith(".js"))) {
  const source = readFileSync(join(WEB, file), "utf8");

  // A literal newline inside a quoted string is a syntax error, which is exactly
  // what a mangled "\n" produces.
  try {
    new Function(source);
  } catch (error) {
    failures.push(`${file}: does not parse -- ${error.message}`);
  }

  checkControlCharacters(file, source);
}

// The stylesheet too: a mangled CSS escape produced a tofu glyph once.
checkControlCharacters("styles.css", readFileSync(join(WEB, "styles.css"), "utf8"));

if (failures.length) {
  console.log("SOURCE LINT FAILURES:");
  for (const failure of failures.slice(0, 40)) console.log("  " + failure);
  if (failures.length > 40) console.log(`  ... and ${failures.length - 40} more`);
  process.exit(1);
}

console.log(`source lint: ${readdirSync(WEB).filter(f => f.endsWith(".js")).length} scripts parse, no stray control characters`);
