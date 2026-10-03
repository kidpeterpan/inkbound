// Pre-tag release check: will pushing the tag actually publish a release?
//
// The release workflow answers that only AFTER the tag is public — it compares
// the tag with manifest.json and reads the matching CHANGELOG.md section as
// the release description, failing the run when either is wrong. That is a
// public failure on the shared branch for something knowable beforehand, so
// this checks the parts that can be checked locally and in CI.
//
// The decision logic (and its awk-parity test) lives in
// scripts/lib/release-notes.ts; this file only reads files and reports.
//
// Deliberately not checked here: whether the tag already exists (git refuses a
// duplicate tag, and so does the push) and whether the tag matches
// manifest.json (at this point the tag does not exist yet).
import { readFileSync } from "node:fs";
import { releaseProblems } from "./lib/release-notes";

const files = {
  packageJson: readFileSync("package.json", "utf8"),
  manifestJson: readFileSync("manifest.json", "utf8"),
  changelog: readFileSync("CHANGELOG.md", "utf8"),
};

const problems = releaseProblems(files);
if (problems.length > 0) {
  console.error("release:check: FAILED — tagging now would not publish a release:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const version = (JSON.parse(files.manifestJson) as { version: string }).version;
console.log(
  `release:check: PASS — ${version} is ready to tag ` +
    `(CHANGELOG.md has a '## ${version}' section to use as the release notes)`
);
