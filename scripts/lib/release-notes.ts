// The release path's decision logic: which part of CHANGELOG.md becomes the
// GitHub release body, and whether the repo is in a state where tagging will
// publish successfully.
//
// This mirrors the awk in .github/workflows/release.yml EXACTLY:
//
//   awk -v v="$TAG" '
//     $0 == "## " v { inside = 1; next }
//     inside && /^## / { exit }
//     inside { print }
//   ' CHANGELOG.md
//
// The parity test (tests/release-notes.test.ts) runs that awk against the real
// CHANGELOG.md and asserts both produce the same bytes, so the local check and
// the workflow cannot drift. Without that, `npm run release:check` could pass
// and the release could still fail — after the tag is already public.
//
// PURE MODULE: no fs, no process, no network — it takes file CONTENTS, so the
// tests need no fixtures and no temp directory.

/** The heading that opens a version's section, e.g. "## 1.10.4". */
const headingFor = (version: string): string => `## ${version}`;

/** Any line that closes a section: "## " at the start of a line. */
const CLOSES_SECTION = /^## /;

/**
 * The notes for one version: every line after its `## <version>` heading and
 * before the next `## ` heading. Returns "" when there is no such section (or
 * it is empty), which is what the workflow treats as a failure.
 *
 * The return value matches awk byte for byte, including the trailing newline
 * each `print` adds — the parity test is what guarantees that.
 */
export function extractReleaseNotes(changelog: string, version: string): string {
  const heading = headingFor(version);
  // awk splits records on "\n", and a final newline terminates the last record
  // rather than adding an empty one — so drop the empty tail a trailing
  // newline leaves behind, or the result gains a spurious blank line.
  const lines = changelog.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  const body: string[] = [];
  let inside = false;
  for (const line of lines) {
    if (line === heading) {
      inside = true;
      continue;
    }
    if (inside && CLOSES_SECTION.test(line)) break;
    if (inside) body.push(line);
  }

  return body.length === 0 ? "" : `${body.join("\n")}\n`;
}

export interface ReleaseFiles {
  /** Contents of package.json. */
  packageJson: string;
  /** Contents of manifest.json. */
  manifestJson: string;
  /** Contents of CHANGELOG.md. */
  changelog: string;
}

function versionIn(json: string): string {
  return (JSON.parse(json) as { version?: string }).version ?? "";
}

/**
 * Everything that would make a tag push fail to publish a release, as
 * human-readable problems. Empty means "tagging now will work".
 *
 * Deliberately NOT checked here: whether the tag already exists (git refuses a
 * duplicate tag, and so does the push) and whether the tag matches
 * manifest.json (that tag does not exist yet). Both are enforced by the tools
 * that create them; this covers the two failures that are silent until the
 * workflow runs.
 */
export function releaseProblems(files: ReleaseFiles): string[] {
  const problems: string[] = [];
  const pkgVersion = versionIn(files.packageJson);
  const manifestVersion = versionIn(files.manifestJson);

  // A manifest with no version at all is the more fundamental problem, and it
  // would make the mismatch message read "… != ", which helps nobody.
  if (manifestVersion === "") {
    return ["manifest.json has no version field"];
  }
  if (pkgVersion !== manifestVersion) {
    problems.push(`version mismatch: package.json ${pkgVersion} != manifest.json ${manifestVersion}`);
  }
  // Stricter than the workflow on purpose: the workflow only checks that the
  // extracted file is non-empty, so a section of blank lines would publish a
  // release with effectively no description.
  if (extractReleaseNotes(files.changelog, manifestVersion).trim() === "") {
    problems.push(
      `CHANGELOG.md has no '## ${manifestVersion}' section with notes — the release workflow ` +
        `reads that section as the release description and fails without it`
    );
  }
  return problems;
}
