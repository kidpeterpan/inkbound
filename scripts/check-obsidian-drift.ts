// The Obsidian drift canary: compares the Obsidian version the captured
// fixtures in tests/fixtures/real-render/ came from against the newest
// Obsidian release, and opens ONE GitHub issue asking for a re-capture when
// the fixtures are behind. Run weekly by .github/workflows/obsidian-drift.yml.
//
// Every decision lives in scripts/lib/obsidian-drift.ts (pure, unit-tested);
// this file only wires in the filesystem, `fetch` and the environment.
//
// Usage:
//   tsx scripts/check-obsidian-drift.ts               dry run on a laptop (no GITHUB_TOKEN)
//   tsx scripts/check-obsidian-drift.ts --dry-run     never write to GitHub, even with a token
//   tsx scripts/check-obsidian-drift.ts --latest 1.14.0   compare against this, no lookup
//   tsx scripts/check-obsidian-drift.ts --fixtures <dir>  read fixtures from another folder
//
// In CI (CI=true) a missing GITHUB_TOKEN or GITHUB_REPOSITORY is a failure, and
// so is any error talking to GitHub: a red weekly run is how a broken canary
// gets noticed, where a quiet one would just stop protecting anything.

import { readdirSync, readFileSync } from "fs";
import * as path from "path";
import { makeGitHubClient, resolveMode, runDriftCheck, type FetchLike } from "./lib/obsidian-drift";

const DEFAULT_FIXTURES = path.resolve(__dirname, "..", "tests", "fixtures", "real-render");

async function main(): Promise<void> {
  const mode = resolveMode(process.argv.slice(2), process.env);
  const dir = path.resolve(mode.fixturesDir ?? DEFAULT_FIXTURES);
  const github = makeGitHubClient(fetch as FetchLike, mode.token);

  const { outcome } = await runDriftCheck({
    readFixtures: () =>
      readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((name) => ({ name, text: readFileSync(path.join(dir, name), "utf8") })),
    getJson: github.getJson,
    postJson: github.postJson,
    repo: mode.repo,
    latest: mode.latest,
    log: (m) => console.log(`obsidian-drift: ${m}`),
  });
  console.log(`obsidian-drift: ${outcome}`);
}

main().catch((e: unknown) => {
  console.error(`\nobsidian-drift: FAIL — ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
