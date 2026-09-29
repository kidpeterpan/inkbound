// The pure core of the Obsidian drift canary (scripts/check-obsidian-drift.ts).
//
// WHY THIS EXISTS: the tests in tests/real-render.test.ts run the export's DOM
// passes over markup captured from a real Obsidian. That markup is a snapshot
// of ONE Obsidian version (each fixture records it as `obsidianVersion`).
// Obsidian ships a release every couple of weeks and CI cannot run Obsidian,
// so nothing tells the maintainer that the snapshot has gone stale — the first
// sign would be a reader's broken book. This module decides "is the snapshot
// older than the newest Obsidian release?" and words the GitHub issue that
// asks for a re-capture.
//
// No fs, no network, no clock: the script hands everything in. That is what
// lets every rule below be tested with plain data.

export const RELEASES_URL = "https://api.github.com/repos/obsidianmd/obsidian-releases/releases/latest";

// The issue title always starts with this, and findOpenDriftIssue finds an
// open one by it. Changing it orphans any issue already open under the old one.
export const ISSUE_TITLE_PREFIX = "[obsidian-drift]";

// ── versions ────────────────────────────────────────────────────────────────

export type Version = readonly [number, number, number];

// Strict on purpose: "1.13", "1.13.8-beta" and "unknown" (what
// capture-real-render records when it cannot ask Obsidian) are all rejected,
// so a malformed value fails the run instead of being compared as something else.
export function parseVersion(text: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function mustParse(text: string): Version {
  const v = parseVersion(text);
  if (!v) throw new Error(`not a version: ${JSON.stringify(text)}`);
  return v;
}

const format = (v: Version): string => v.join(".");

export function compareVersions(a: string, b: string): number {
  const [pa, pb] = [mustParse(a), mustParse(b)];
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  }
  return 0;
}

// ── the policy ──────────────────────────────────────────────────────────────

// THE ONE DECISION in this file: when does a fixture count as stale?
//
// Today: whenever a NEWER Obsidian release exists, patch releases included.
// That is the most sensitive setting — Obsidian has shipped four patch
// releases in a month — but the issue is opened once at a time (see
// findOpenDriftIssue), so it costs one issue per re-capture, not one per
// release. A fixture NEWER than the latest release (captured on an
// early-access build) is not stale.
//
// The quieter alternative is to ignore patch-only differences, i.e. compare
// just the major and minor parts. Change it here and nowhere else; the tests
// in the "isDrifted" block say what the current rule is.
export function isDrifted(latest: string, captured: string): boolean {
  return compareVersions(latest, captured) > 0;
}

// ── reading the inputs ──────────────────────────────────────────────────────

export interface FixtureVersion {
  name: string;
  version: string;
}

export interface DriftResult {
  latest: string;
  drifted: boolean;
  // The oldest version any fixture was captured on.
  oldest: string;
  // The fixtures that are behind `latest`, in the order they were given.
  stale: FixtureVersion[];
  fixtures: FixtureVersion[];
}

// The GitHub "latest release" payload -> "1.13.8". Drafts and prereleases are
// refused rather than skipped: the endpoint never returns them, so seeing one
// means the API changed shape, and a canary must fail loudly when that happens.
export function latestFromRelease(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("unexpected release payload: expected an object");
  }
  const p = payload as Record<string, unknown>;
  if (p.draft === true) throw new Error("the latest release is a draft");
  if (p.prerelease === true) throw new Error("the latest release is a prerelease");
  if (typeof p.tag_name !== "string" || p.tag_name === "") throw new Error("release has no tag_name");
  const v = parseVersion(p.tag_name);
  if (!v) throw new Error(`release tag is not a version: ${JSON.stringify(p.tag_name)}`);
  return format(v);
}

// Every captured fixture's recorded Obsidian version. Throws when there is
// nothing to check or a fixture cannot be trusted, because an empty or
// unreadable set would make the canary report "up to date" while checking nothing.
export function fixtureVersionsFrom(files: { name: string; text: string }[]): FixtureVersion[] {
  if (files.length === 0) throw new Error("no fixtures found: nothing to compare against the latest release");
  return files.map(({ name, text }) => {
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`${name}: not valid JSON`);
    }
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new Error(`${name}: expected a JSON object`);
    }
    const raw = (data as Record<string, unknown>).obsidianVersion;
    const v = typeof raw === "string" ? parseVersion(raw) : null;
    if (!v) {
      throw new Error(
        `${name}: obsidianVersion ${JSON.stringify(raw)} is not a version — re-run "npm run capture-real-render"`
      );
    }
    return { name, version: format(v) };
  });
}

export function checkDrift(latest: string, fixtures: FixtureVersion[]): DriftResult {
  if (fixtures.length === 0)
    throw new Error("no fixtures found: nothing to compare against the latest release");
  const normalized = format(mustParse(latest));
  const oldest = fixtures.reduce(
    (min, f) => (compareVersions(f.version, min) < 0 ? f.version : min),
    fixtures[0]!.version
  );
  const stale = fixtures.filter((f) => isDrifted(normalized, f.version));
  return { latest: normalized, drifted: stale.length > 0, oldest, stale, fixtures };
}

// ── the issue ───────────────────────────────────────────────────────────────

export function buildIssue(result: DriftResult): { title: string; body: string } {
  if (!result.drifted) throw new Error("cannot build an issue for a result that is not drifted");
  const rows = result.stale.map((f) => `- \`${f.name}\` — captured on ${f.version}`).join("\n");
  const body = [
    `Obsidian **${result.latest}** is out, and these fixtures in \`tests/fixtures/real-render/\` were captured on an older version:`,
    "",
    rows,
    "",
    "Obsidian's reader-view HTML is what `cleanupDom`, the footnote code and the link and image rewriting depend on, and CI cannot run Obsidian. Until the fixtures are re-captured, `tests/real-render.test.ts` is checking last release's markup.",
    "",
    "**To close this:**",
    "",
    "1. Update Obsidian to the latest version and open the vault the capture script expects (see the header of `scripts/capture-real-render.ts`; it needs the `obsidian` CLI and Dataview).",
    "2. Run `npm run capture-real-render`.",
    "3. Run `npm test`. Read any failure in `tests/real-render.test.ts` as the new manual checklist for what Obsidian changed.",
    "4. Commit the fixture diff, then close this issue.",
    "",
    `Release notes: https://github.com/obsidianmd/obsidian-releases/releases/tag/v${result.latest}`,
    "",
    "_Opened by the weekly `Obsidian drift` workflow. It opens no second issue while this one is open._",
  ].join("\n");
  return {
    title: `${ISSUE_TITLE_PREFIX} Obsidian ${result.latest} is out — re-capture the real-render fixtures`,
    body,
  };
}

// Is a drift issue already open? Takes the GitHub "list issues" payload.
// Pull requests come back from that endpoint too and are ignored. Malformed
// entries are skipped, but a payload that is not a list at all (GitHub's error
// object, say) throws: it must not read as "no open issue" and cause a duplicate.
export function findOpenDriftIssue(payload: unknown): { number: number; url: string } | null {
  if (!Array.isArray(payload)) throw new Error("unexpected issues payload: expected a list");
  for (const item of payload as unknown[]) {
    if (typeof item !== "object" || item === null) continue;
    const i = item as Record<string, unknown>;
    if ("pull_request" in i) continue;
    if (typeof i.title !== "string" || !i.title.startsWith(ISSUE_TITLE_PREFIX)) continue;
    if (typeof i.number !== "number" || typeof i.html_url !== "string") continue;
    return { number: i.number, url: i.html_url };
  }
  return null;
}

// ── GitHub access ───────────────────────────────────────────────────────────

// The slice of `fetch` this needs. The global fetch satisfies it; a test passes
// a fake, so no test in this repo can reach GitHub.
export interface FetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string }
) => Promise<FetchResponse>;

export interface GitHubClient {
  getJson(url: string): Promise<unknown>;
  postJson(url: string, body: unknown): Promise<unknown>;
}

export function makeGitHubClient(fetchImpl: FetchLike, token: string | null): GitHubClient {
  async function request(method: string, url: string, body?: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      // GitHub rejects API requests that carry no User-Agent.
      "User-Agent": "inkbound-obsidian-drift",
    };
    // A token is optional for reads of a public repo; it only lifts the rate limit.
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }
    const res = await fetchImpl(url, init);
    const text = await res.text();
    if (!res.ok) {
      let detail = text.slice(0, 200);
      try {
        const m = (JSON.parse(text) as { message?: unknown }).message;
        if (typeof m === "string") detail = m;
      } catch {
        // Not JSON (a proxy's HTML error page): the raw text is the best detail there is.
      }
      throw new Error(`GitHub ${method} ${url} failed: ${res.status} ${detail}`);
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`GitHub ${method} ${url} returned a body that is not JSON`);
    }
  }
  return {
    getJson: (url) => request("GET", url),
    postJson: (url, body) => request("POST", url, body),
  };
}

// ── run modes ───────────────────────────────────────────────────────────────

export interface Mode {
  // true: report only, never write to GitHub.
  dryRun: boolean;
  // "owner/name" when live, else null.
  repo: string | null;
  token: string | null;
  // --latest: compare against this instead of asking GitHub (offline runs, tests).
  latest: string | null;
  // --fixtures: read from here instead of tests/fixtures/real-render.
  fixturesDir: string | null;
}

// Same stance as scripts/epubcheck.ts: on a laptop a missing token is a dry
// run, in CI it is a failure — a runner must not quietly opt out of the check
// that is its whole job.
export function resolveMode(argv: string[], env: Record<string, string | undefined>): Mode {
  let dryRunFlag = false;
  let latest: string | null = null;
  let fixturesDir: string | null = null;
  const valueOf = (flag: string, i: number): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--dry-run") dryRunFlag = true;
    else if (arg === "--latest") {
      const v = valueOf(arg, i++);
      latest = format(mustParse(v));
    } else if (arg === "--fixtures") fixturesDir = valueOf(arg, i++);
    else throw new Error(`unknown argument: ${arg}`);
  }

  const token = env.GITHUB_TOKEN || null;
  const repo = env.GITHUB_REPOSITORY || null;
  if (dryRunFlag) return { dryRun: true, repo: null, token, latest, fixturesDir };
  if (token && repo) return { dryRun: false, repo, token, latest, fixturesDir };
  if (env.CI) {
    const missing = [token ? null : "GITHUB_TOKEN", repo ? null : "GITHUB_REPOSITORY"].filter(Boolean);
    throw new Error(
      `running in CI without ${missing.join(" and ")}: cannot open an issue (use --dry-run to only report)`
    );
  }
  return { dryRun: true, repo: null, token, latest, fixturesDir };
}

// ── the run ─────────────────────────────────────────────────────────────────

export interface DriftDeps {
  readFixtures(): { name: string; text: string }[];
  getJson(url: string): Promise<unknown>;
  postJson(url: string, body: unknown): Promise<unknown>;
  // null: dry run.
  repo: string | null;
  // Overrides the GitHub lookup of the latest release when set.
  latest: string | null;
  log(message: string): void;
}

export type DriftOutcome = "up-to-date" | "issue-created" | "issue-already-open" | "drifted-dry-run";

export async function runDriftCheck(
  deps: DriftDeps
): Promise<{ outcome: DriftOutcome; result: DriftResult; issueUrl?: string }> {
  const fixtures = fixtureVersionsFrom(deps.readFixtures());
  const latest = deps.latest ?? latestFromRelease(await deps.getJson(RELEASES_URL));
  const result = checkDrift(latest, fixtures);
  deps.log(
    `Obsidian latest release: ${result.latest}; oldest fixture: ${result.oldest} (${fixtures.length} fixtures, ${result.stale.length} behind)`
  );
  if (!result.drifted) return { outcome: "up-to-date", result };

  const issue = buildIssue(result);
  if (deps.repo === null) {
    deps.log(`Dry run — would open an issue titled: ${issue.title}`);
    return { outcome: "drifted-dry-run", result };
  }

  const existing = findOpenDriftIssue(
    await deps.getJson(`https://api.github.com/repos/${deps.repo}/issues?state=open&per_page=100`)
  );
  if (existing) {
    deps.log(`A drift issue is already open (#${existing.number}); not opening another: ${existing.url}`);
    return { outcome: "issue-already-open", result, issueUrl: existing.url };
  }

  const created = await deps.postJson(`https://api.github.com/repos/${deps.repo}/issues`, issue);
  const url = (created as { html_url?: unknown } | null)?.html_url;
  if (typeof url !== "string") throw new Error("GitHub created the issue but returned no html_url for it");
  deps.log(`Opened ${url}`);
  return { outcome: "issue-created", result, issueUrl: url };
}
