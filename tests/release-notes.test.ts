// The CHANGELOG section the release workflow turns into a GitHub release
// description (scripts/lib/release-notes.ts), plus a parity check against the
// awk that workflow actually runs.
//
// Why a parity test: if the local extractor and the workflow's awk disagree,
// `npm run release:check` can pass while the release still fails — and by then
// the tag is public. The parity test compares against the real awk on the real
// CHANGELOG.md, so the two implementations cannot drift apart unnoticed.
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractReleaseNotes, releaseProblems } from "../scripts/lib/release-notes";

const CHANGELOG = readFileSync(join(__dirname, "..", "CHANGELOG.md"), "utf8");
const MANIFEST = JSON.parse(readFileSync(join(__dirname, "..", "manifest.json"), "utf8")) as {
  version: string;
};

/** The workflow's own extractor, run for real. */
function awkReleaseNotes(version: string): string {
  const program = `
    $0 == "## " v { inside = 1; next }
    inside && /^## / { exit }
    inside { print }
  `;
  return execFileSync("awk", ["-v", `v=${version}`, program, join(__dirname, "..", "CHANGELOG.md")], {
    encoding: "utf8",
  });
}

const hasAwk = (() => {
  try {
    execFileSync("sh", ["-c", "command -v awk"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("extractReleaseNotes", () => {
  const CHANGELOG_SAMPLE = [
    "# Changelog",
    "",
    "## 1.2.0",
    "",
    "The body of 1.2.0.",
    "",
    "### A sub-heading stays inside",
    "",
    "- a bullet",
    "",
    "## 1.1.0",
    "",
    "The body of 1.1.0.",
    "",
  ].join("\n");

  it("returns the section body, stopping before the next version", () => {
    // Note the trailing blank line: the empty line before "## 1.1.0" is still
    // INSIDE this section, and awk prints it too.
    expect(extractReleaseNotes(CHANGELOG_SAMPLE, "1.2.0")).toBe(
      "\nThe body of 1.2.0.\n\n### A sub-heading stays inside\n\n- a bullet\n\n"
    );
  });

  it("does not let a sub-heading end the section", () => {
    // "### …" is not "## " — a release with grouped notes must survive.
    expect(extractReleaseNotes(CHANGELOG_SAMPLE, "1.2.0")).toContain("### A sub-heading stays inside");
  });

  it("reads a section that runs to the end of the file", () => {
    expect(extractReleaseNotes(CHANGELOG_SAMPLE, "1.1.0")).toBe("\nThe body of 1.1.0.\n");
  });

  it("matches the version exactly, never as a prefix", () => {
    // The workflow compares whole lines: "1.1.0" must not match "1.1.0-rc1"
    // and "1.1.0" must not match inside "11.1.0".
    expect(extractReleaseNotes(CHANGELOG_SAMPLE, "1.1")).toBe("");
    expect(extractReleaseNotes(CHANGELOG_SAMPLE, "1.1.0-rc1")).toBe("");
  });

  it("returns an empty string when there is no such section", () => {
    expect(extractReleaseNotes(CHANGELOG_SAMPLE, "9.9.9")).toBe("");
  });

  it("returns just the blank line for a section with no notes — which awk also does", () => {
    // Faithful to the workflow, which only asks whether the extracted file is
    // non-empty: a single blank line passes there. releaseProblems is
    // deliberately stricter (see its own test below) so the release does not
    // go out with an empty description.
    const empty = "# Changelog\n\n## 2.0.0\n\n## 1.9.0\n\nnotes\n";
    expect(extractReleaseNotes(empty, "2.0.0")).toBe("\n");
  });

  it("keeps a blank line at the very end of the file from adding a spurious one", () => {
    // A final newline terminates the last record for awk; the split would
    // otherwise leave an empty string behind and add a blank line.
    expect(extractReleaseNotes("## 3.0.0\nonly line\n", "3.0.0")).toBe("only line\n");
    expect(extractReleaseNotes("## 3.0.0\nonly line", "3.0.0")).toBe("only line\n");
  });

  it("starts no section when the heading has trailing text", () => {
    expect(extractReleaseNotes("## 4.0.0 (unreleased)\nnotes\n", "4.0.0")).toBe("");
  });
});

describe("extractReleaseNotes matches the release workflow's awk", () => {
  it.skipIf(!hasAwk)("agrees with awk on the real CHANGELOG.md", () => {
    // The version under development, plus the neighbours a boundary bug would
    // confuse it with — and the notes for a version that does not exist.
    for (const version of [MANIFEST.version, "1.10.3", "1.10.0", "1.0.0", "9.9.9"]) {
      expect(extractReleaseNotes(CHANGELOG, version), `version ${version}`).toBe(awkReleaseNotes(version));
    }
  });

  it.skipIf(!hasAwk)("agrees with awk on a section ending at EOF", () => {
    // The interesting boundary: awk's last record has no trailing newline.
    expect(extractReleaseNotes(CHANGELOG, "1.0.0")).toBe(awkReleaseNotes("1.0.0"));
  });

  it("has a real CHANGELOG to compare against", () => {
    // Guards the parity test itself: if the file were missing or empty, the
    // comparison above would pass vacuously.
    expect(CHANGELOG.length).toBeGreaterThan(1000);
    expect(MANIFEST.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("releaseProblems", () => {
  const files = (over: Partial<{ pkg: string; manifest: string; changelog: string }> = {}) => ({
    packageJson: over.pkg ?? JSON.stringify({ version: "1.0.0" }),
    manifestJson: over.manifest ?? JSON.stringify({ version: "1.0.0" }),
    changelog: over.changelog ?? "# Changelog\n\n## 1.0.0\n\nnotes here\n",
  });

  it("reports nothing when the repo is ready to tag", () => {
    expect(releaseProblems(files())).toEqual([]);
  });

  it("reports a version mismatch between the two manifests", () => {
    const problems = releaseProblems(
      files({
        manifest: JSON.stringify({ version: "1.0.1" }),
        changelog: "# Changelog\n\n## 1.0.1\n\nnotes\n",
      })
    );

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("version mismatch");
  });

  it("reports a missing changelog section, naming the version", () => {
    const problems = releaseProblems(files({ changelog: "# Changelog\n\n## 0.9.0\n\nold\n" }));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("## 1.0.0");
  });

  it("reports a section that exists but has no notes", () => {
    const problems = releaseProblems(files({ changelog: "# Changelog\n\n## 1.0.0\n\n## 0.9.0\n\nold\n" }));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("## 1.0.0");
  });

  it("reports both problems at once, so one run shows everything to fix", () => {
    const problems = releaseProblems(
      files({ manifest: JSON.stringify({ version: "1.0.1" }), changelog: "# Changelog\n" })
    );

    expect(problems).toHaveLength(2);
  });

  it("reports a manifest with no version field", () => {
    expect(releaseProblems(files({ manifest: "{}" }))[0]).toContain("no version field");
  });

  it("passes on the repo's own files as they stand", () => {
    // The check that runs in CI must be green on the committed tree.
    expect(
      releaseProblems({
        packageJson: readFileSync(join(__dirname, "..", "package.json"), "utf8"),
        manifestJson: readFileSync(join(__dirname, "..", "manifest.json"), "utf8"),
        changelog: CHANGELOG,
      })
    ).toEqual([]);
  });
});
