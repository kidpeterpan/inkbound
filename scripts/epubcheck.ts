// Validates finished books against the EPUB 3 specification with the W3C's
// epubcheck, and is the rung of the realism ladder that no amount of vitest
// coverage can replace: every other gate asserts what THIS code believes a
// book should contain, while epubcheck asserts what the format actually
// requires. A malformed OPF manifest, an unresolvable nav fragment, a wrong
// media type — all of those produce a zip that passes check-export-works and
// then fails to open on a reader.
//
// WHY A SCRIPT AND NOT A SHELL ONE-LINER: this used to be
// `if command -v epubcheck; then ...; else echo 'not installed'; fi`, which
// silently exited 0 whenever the tool was missing — fine on a laptop, useless
// as a CI gate, because a runner without epubcheck would have reported a pass.
// The rule here is the inverse in the two places: a laptop without epubcheck
// gets a skip and an install hint, CI gets a hard failure.
//
// Usage:
//   tsx scripts/epubcheck.ts <file.epub> [more.epub ...]
//   tsx scripts/epubcheck.ts --require <file.epub>   (fail if epubcheck is absent)
//
// Finds epubcheck either on PATH (`brew install epubcheck`) or through
// EPUBCHECK_JAR, an absolute path to epubcheck.jar. CI uses the jar so the
// version is pinned; see .github/workflows/ci.yml.

import { existsSync } from "fs";
import { spawnSync } from "child_process";

// GitHub Actions (and every other CI) sets CI=true. A missing epubcheck is a
// skip on a laptop and a failure here — the whole point of the gate is that a
// runner cannot quietly opt out of it.
const REQUIRED = Boolean(process.env.CI) || process.argv.includes("--require");

const files = process.argv.slice(2).filter((a) => !a.startsWith("--"));

function fail(message: string, detail: string[] = []): never {
  console.error(`\nepubcheck: FAIL — ${message}`);
  for (const line of detail) console.error(`  ${line}`);
  process.exit(1);
}

// The command that runs epubcheck, or null when it is not installed. The jar
// wins over PATH so CI's pinned version is used even on a machine that also
// has a brew-installed one.
function resolveRunner(): { command: string; baseArgs: string[]; source: string } | null {
  const jar = process.env.EPUBCHECK_JAR;
  if (jar) {
    if (!existsSync(jar)) fail(`EPUBCHECK_JAR points at a file that does not exist: ${jar}`);
    // The jar loads its dependencies from a sibling lib/ via its manifest
    // classpath, so it must be run where it was unpacked, not copied out.
    return { command: "java", baseArgs: ["-jar", jar], source: `EPUBCHECK_JAR=${jar}` };
  }
  const probe = spawnSync("epubcheck", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) return null;
  return { command: "epubcheck", baseArgs: [], source: "epubcheck on PATH" };
}

const runner = resolveRunner();
if (!runner) {
  if (REQUIRED) {
    fail("epubcheck is not installed, and this run requires it.", [
      "Install it with `brew install epubcheck`, or set EPUBCHECK_JAR to an",
      "unpacked epubcheck.jar (https://github.com/w3c/epubcheck/releases).",
    ]);
  }
  console.log("epubcheck: SKIPPED — not installed (brew install epubcheck to run it locally).");
  process.exit(0);
}

if (files.length === 0) fail("no .epub files given.", ["Usage: tsx scripts/epubcheck.ts <file.epub> ..."]);

// Printed so a local log and a CI log can be compared version to version —
// a rule that changed between epubcheck releases is otherwise invisible.
const version = spawnSync(runner.command, [...runner.baseArgs, "--version"], { encoding: "utf8" });
console.log(`epubcheck: using ${runner.source}`);
console.log((version.stdout || version.stderr || "").trim());

const failed: string[] = [];
for (const file of files) {
  if (!existsSync(file)) fail(`no such file: ${file}`);
  console.log(`\nepubcheck: validating ${file}`);
  // --failonwarnings because both books this gate validates are at zero
  // warnings today (the hand-built sample.epub and the real export from the
  // shipped bundle), and the epubcheck version is pinned in CI — so a new
  // warning can only come from a change in this repo, which is exactly what
  // a gate exists to catch. Drop the flag, and the first warning to appear
  // would be one nobody reads.
  const run = spawnSync(runner.command, [...runner.baseArgs, "--failonwarnings", file], { stdio: "inherit" });
  if (run.error) fail(`could not run ${runner.command}.`, [String(run.error)]);
  if (run.status !== 0) failed.push(file);
}

if (failed.length > 0) {
  fail(`${failed.length} of ${files.length} book(s) are not valid EPUB 3.`, failed);
}

console.log(`\nepubcheck: PASS — ${files.length} book(s) valid EPUB 3, no errors and no warnings.`);
