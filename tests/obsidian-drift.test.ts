import { describe, it, expect, vi } from "vitest";
import {
  ISSUE_TITLE_PREFIX,
  RELEASES_URL,
  buildIssue,
  checkDrift,
  compareVersions,
  findOpenDriftIssue,
  fixtureVersionsFrom,
  isDrifted,
  latestFromRelease,
  makeGitHubClient,
  parseVersion,
  resolveMode,
  runDriftCheck,
  type DriftDeps,
  type FetchLike,
} from "../scripts/lib/obsidian-drift";

// scripts/lib/obsidian-drift.ts is pure: no fs, no network, no clock. Every
// test hands it plain data or a fake, so nothing here can touch GitHub.

const fx = (name: string, version: string) => ({ name, version });
const file = (name: string, obsidianVersion: unknown) => ({
  name,
  text: JSON.stringify({ name, obsidianVersion, html: "<p>x</p>" }),
});

describe("parseVersion", () => {
  it("reads three numeric parts, with or without a leading v", () => {
    expect(parseVersion("1.13.8")).toEqual([1, 13, 8]);
    expect(parseVersion("v1.13.8")).toEqual([1, 13, 8]);
  });

  it.each(["", "unknown", "1.13", "1.13.8.1", "1.13.8-beta", "v", "a.b.c", " 1.13.8", "1.13.8 "])(
    "rejects %j",
    (text) => {
      expect(parseVersion(text)).toBeNull();
    }
  );
});

describe("compareVersions", () => {
  it("orders by major, then minor, then patch", () => {
    expect(compareVersions("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareVersions("1.14.0", "1.13.99")).toBeGreaterThan(0);
    expect(compareVersions("1.13.8", "1.13.7")).toBeGreaterThan(0);
    expect(compareVersions("1.13.7", "1.13.8")).toBeLessThan(0);
    expect(compareVersions("1.13.8", "1.13.8")).toBe(0);
  });

  it("compares numbers, not strings (1.9.0 is older than 1.13.0)", () => {
    expect(compareVersions("1.13.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("1.2.10", "1.2.9")).toBeGreaterThan(0);
  });

  it("ignores a leading v on either side", () => {
    expect(compareVersions("v1.13.8", "1.13.8")).toBe(0);
  });

  it("throws, naming the bad value, rather than guess an order", () => {
    expect(() => compareVersions("nightly", "1.0.0")).toThrow(/nightly/);
    expect(() => compareVersions("1.0.0", "1.x")).toThrow(/1\.x/);
  });
});

describe("isDrifted (the policy: any newer Obsidian release counts)", () => {
  it("is true for a newer patch, minor or major release", () => {
    expect(isDrifted("1.13.8", "1.13.7")).toBe(true);
    expect(isDrifted("1.14.0", "1.13.7")).toBe(true);
    expect(isDrifted("2.0.0", "1.13.7")).toBe(true);
  });

  it("is false for the same release", () => {
    expect(isDrifted("1.13.7", "1.13.7")).toBe(false);
  });

  it("is false when the fixtures are NEWER than the latest release (e.g. captured on an early-access build)", () => {
    expect(isDrifted("1.13.7", "1.14.0")).toBe(false);
  });
});

describe("latestFromRelease", () => {
  it("returns the version from a release payload, without the v", () => {
    expect(latestFromRelease({ tag_name: "v1.13.8", draft: false, prerelease: false })).toBe("1.13.8");
    expect(latestFromRelease({ tag_name: "1.13.8" })).toBe("1.13.8");
  });

  it.each([null, undefined, "v1.0.0", 42, [], {}, { tag_name: 5 }, { tag_name: "" }])(
    "rejects a payload of the wrong shape: %j",
    (payload) => {
      expect(() => latestFromRelease(payload)).toThrow(/release/i);
    }
  );

  it("rejects a tag that is not a version, so a renamed tag scheme fails loudly", () => {
    expect(() => latestFromRelease({ tag_name: "nightly-2026" })).toThrow(/nightly-2026/);
  });

  it("refuses a draft or a prerelease: fixtures should track what users actually run", () => {
    expect(() => latestFromRelease({ tag_name: "v1.14.0", prerelease: true })).toThrow(/prerelease/i);
    expect(() => latestFromRelease({ tag_name: "v1.14.0", draft: true })).toThrow(/draft/i);
  });
});

describe("fixtureVersionsFrom", () => {
  it("reads obsidianVersion from each captured file", () => {
    expect(fixtureVersionsFrom([file("a.json", "1.13.7"), file("b.json", "1.13.8")])).toEqual([
      fx("a.json", "1.13.7"),
      fx("b.json", "1.13.8"),
    ]);
  });

  it("throws when there are no fixtures at all, so the canary can never go blind silently", () => {
    expect(() => fixtureVersionsFrom([])).toThrow(/no fixtures/i);
  });

  it("throws, naming the file, on invalid JSON", () => {
    expect(() => fixtureVersionsFrom([{ name: "broken.json", text: "{nope" }])).toThrow(/broken\.json/);
  });

  it.each([undefined, null, 7, "unknown", "1.13", ""])(
    "throws, naming the file, when obsidianVersion is %j (capture-real-render writes 'unknown' if it could not ask Obsidian)",
    (bad) => {
      expect(() => fixtureVersionsFrom([file("tags.json", bad)])).toThrow(/tags\.json/);
    }
  );

  it("throws when the JSON is not an object", () => {
    expect(() => fixtureVersionsFrom([{ name: "list.json", text: "[1,2]" }])).toThrow(/list\.json/);
  });
});

describe("checkDrift", () => {
  it("is not drifted when every fixture is on the latest release", () => {
    const r = checkDrift("1.13.7", [fx("a.json", "1.13.7"), fx("b.json", "1.13.7")]);
    expect(r).toMatchObject({ latest: "1.13.7", drifted: false, oldest: "1.13.7", stale: [] });
  });

  it("is drifted and lists ONLY the stale fixtures when the set is mixed", () => {
    const r = checkDrift("1.13.8", [
      fx("old.json", "1.13.4"),
      fx("new.json", "1.13.8"),
      fx("mid.json", "1.13.7"),
    ]);
    expect(r.drifted).toBe(true);
    expect(r.oldest).toBe("1.13.4");
    expect(r.stale.map((s) => s.name)).toEqual(["old.json", "mid.json"]);
  });

  it("finds the oldest by number, not by string order", () => {
    const r = checkDrift("1.13.0", [fx("a.json", "1.13.0"), fx("b.json", "1.9.0")]);
    expect(r.oldest).toBe("1.9.0");
    expect(r.drifted).toBe(true);
  });

  it("keeps every fixture in the result, stale or not", () => {
    const list = [fx("a.json", "1.13.7"), fx("b.json", "1.13.8")];
    expect(checkDrift("1.13.8", list).fixtures).toEqual(list);
  });

  it("is not drifted when the fixtures are newer than the latest release", () => {
    expect(checkDrift("1.13.7", [fx("a.json", "1.14.0")]).drifted).toBe(false);
  });

  it("throws on an empty fixture list and on an unusable latest version", () => {
    expect(() => checkDrift("1.13.8", [])).toThrow(/no fixtures/i);
    expect(() => checkDrift("banana", [fx("a.json", "1.13.7")])).toThrow(/banana/);
  });
});

describe("buildIssue", () => {
  const result = checkDrift("1.13.8", [
    fx("chrome.json", "1.13.7"),
    fx("tags.json", "1.13.8"),
    fx("app-image.json", "1.13.4"),
  ]);
  const issue = buildIssue(result);

  it("starts the title with the marker used to find it again, and names the release", () => {
    expect(issue.title.startsWith(ISSUE_TITLE_PREFIX)).toBe(true);
    expect(issue.title).toContain("1.13.8");
  });

  it("lists each stale fixture with the version it was captured on, and not the current ones", () => {
    expect(issue.body).toContain("chrome.json");
    expect(issue.body).toContain("1.13.7");
    expect(issue.body).toContain("app-image.json");
    expect(issue.body).toContain("1.13.4");
    expect(issue.body).not.toContain("tags.json");
  });

  it("tells the maintainer what to run and what to read", () => {
    expect(issue.body).toContain("npm run capture-real-render");
    expect(issue.body).toContain("tests/real-render.test.ts");
    expect(issue.body).toContain("https://github.com/obsidianmd/obsidian-releases/releases/tag/v1.13.8");
  });

  it("refuses to build an issue for a result that is not drifted", () => {
    expect(() => buildIssue(checkDrift("1.13.7", [fx("a.json", "1.13.7")]))).toThrow(/not drifted/i);
  });
});

describe("findOpenDriftIssue", () => {
  const drift = (n: number, title = `${ISSUE_TITLE_PREFIX} Obsidian 1.13.8 is out`) => ({
    number: n,
    title,
    html_url: `https://github.com/o/r/issues/${n}`,
  });

  it("returns null for an empty list", () => {
    expect(findOpenDriftIssue([])).toBeNull();
  });

  it("finds an open issue by its title marker", () => {
    expect(findOpenDriftIssue([drift(3, "Unrelated"), drift(9)])).toEqual({
      number: 9,
      url: "https://github.com/o/r/issues/9",
    });
  });

  it("matches the marker only at the START of the title", () => {
    expect(findOpenDriftIssue([drift(4, `Re: ${ISSUE_TITLE_PREFIX} something`)])).toBeNull();
  });

  it("ignores pull requests, which the issues endpoint also returns", () => {
    expect(findOpenDriftIssue([{ ...drift(5), pull_request: { url: "x" } }])).toBeNull();
  });

  it("skips malformed entries instead of throwing on them", () => {
    expect(findOpenDriftIssue([null, 3, {}, { title: 4 }, drift(6)])).toMatchObject({ number: 6 });
  });

  it("skips an entry with the right title but no usable number or url, rather than return half an issue", () => {
    const title = `${ISSUE_TITLE_PREFIX} Obsidian 1.13.8 is out`;
    expect(findOpenDriftIssue([{ title, html_url: "https://github.com/o/r/issues/1" }])).toBeNull();
    expect(findOpenDriftIssue([{ title, number: 1 }])).toBeNull();
    expect(findOpenDriftIssue([{ title, number: "1", html_url: "u" }, drift(7)])).toMatchObject({
      number: 7,
    });
  });

  it("throws when the payload is not a list (an error object from the API, say)", () => {
    expect(() => findOpenDriftIssue({ message: "Bad credentials" })).toThrow(/list/i);
  });
});

describe("makeGitHubClient", () => {
  function fakeFetch(status: number, body: string) {
    return vi.fn<FetchLike>(async () => ({
      ok: status >= 200 && status < 300,
      status,
      text: async () => body,
    }));
  }

  it("GETs with the headers GitHub requires, and returns the parsed body", async () => {
    const f = fakeFetch(200, '{"a":1}');
    const out = await makeGitHubClient(f, "tok").getJson("https://api.github.com/x");
    expect(out).toEqual({ a: 1 });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/x");
    expect(init.method).toBe("GET");
    expect(init.headers["Accept"]).toBe("application/vnd.github+json");
    expect(init.headers["User-Agent"]).toBeTruthy();
    expect(init.headers["X-GitHub-Api-Version"]).toBeTruthy();
    expect(init.headers["Authorization"]).toBe("Bearer tok");
    expect(init.body).toBeUndefined();
  });

  it("sends no Authorization header when there is no token (public reads still work)", async () => {
    const f = fakeFetch(200, "{}");
    await makeGitHubClient(f, null).getJson("https://api.github.com/x");
    expect(f.mock.calls[0]![1].headers).not.toHaveProperty("Authorization");
  });

  it("POSTs a JSON body with a content type", async () => {
    const f = fakeFetch(201, '{"html_url":"u"}');
    const out = await makeGitHubClient(f, "tok").postJson("https://api.github.com/y", { title: "t" });
    expect(out).toEqual({ html_url: "u" });
    const init = f.mock.calls[0]![1];
    expect(init.method).toBe("POST");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body!)).toEqual({ title: "t" });
  });

  it("throws with the status and the API's own message on a non-2xx response", async () => {
    const f = fakeFetch(403, '{"message":"API rate limit exceeded"}');
    await expect(makeGitHubClient(f, null).getJson("https://api.github.com/x")).rejects.toThrow(
      /403.*API rate limit exceeded/s
    );
  });

  it("still reports the status when the error body is not JSON", async () => {
    const f = fakeFetch(502, "<html>bad gateway</html>");
    await expect(makeGitHubClient(f, null).getJson("https://api.github.com/x")).rejects.toThrow(/502/);
  });

  it("throws on a 2xx response whose body is not JSON", async () => {
    const f = fakeFetch(200, "not json");
    await expect(makeGitHubClient(f, null).getJson("https://api.github.com/x")).rejects.toThrow(/JSON/);
  });
});

describe("resolveMode", () => {
  it("is a dry run by default when there is no token, outside CI", () => {
    expect(resolveMode([], {})).toEqual({
      dryRun: true,
      repo: null,
      token: null,
      latest: null,
      fixturesDir: null,
    });
  });

  it("goes live when a token and a repository are both present", () => {
    const m = resolveMode([], { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r" });
    expect(m).toMatchObject({ dryRun: false, repo: "o/r", token: "t" });
  });

  it("--dry-run wins over a token: nothing is ever posted", () => {
    const m = resolveMode(["--dry-run"], { GITHUB_TOKEN: "t", GITHUB_REPOSITORY: "o/r" });
    expect(m.dryRun).toBe(true);
    expect(m.repo).toBeNull();
    // The token is still kept: it authenticates the read of the releases API.
    expect(m.token).toBe("t");
  });

  it("in CI, a missing token is a hard error, not a quiet dry run", () => {
    expect(() => resolveMode([], { CI: "true", GITHUB_REPOSITORY: "o/r" })).toThrow(/GITHUB_TOKEN/);
  });

  it("in CI, a missing repository is a hard error too", () => {
    expect(() => resolveMode([], { CI: "true", GITHUB_TOKEN: "t" })).toThrow(/GITHUB_REPOSITORY/);
  });

  it("in CI, --dry-run is still allowed without either", () => {
    expect(resolveMode(["--dry-run"], { CI: "true" }).dryRun).toBe(true);
  });

  it("a token without a repository, outside CI, is a dry run rather than a guess", () => {
    expect(resolveMode([], { GITHUB_TOKEN: "t" })).toMatchObject({ dryRun: true, repo: null });
  });

  it("reads --latest and --fixtures values", () => {
    const m = resolveMode(["--latest", "v1.14.0", "--fixtures", "some/dir"], {});
    expect(m.latest).toBe("1.14.0");
    expect(m.fixturesDir).toBe("some/dir");
  });

  it.each([["--latest"], ["--fixtures"], ["--latest", "banana"], ["--nope"]])(
    "rejects bad arguments: %j",
    (...args) => {
      expect(() => resolveMode(args.flat() as string[], {})).toThrow();
    }
  );

  it("does not take the next flag as a value", () => {
    expect(() => resolveMode(["--latest", "--dry-run"], {})).toThrow(/--latest/);
  });
});

describe("runDriftCheck", () => {
  const RELEASE = { tag_name: "v1.13.8" };
  const ISSUES_URL = "https://api.github.com/repos/o/r/issues?state=open&per_page=100";

  function deps(
    over: Partial<DriftDeps> & { issues?: unknown; fixtures?: { name: string; text: string }[] } = {}
  ) {
    const getJson = vi.fn(async (url: string): Promise<unknown> => {
      if (url === RELEASES_URL) return RELEASE;
      if (url === ISSUES_URL) return over.issues ?? [];
      throw new Error(`unexpected GET ${url}`);
    });
    const postJson = vi.fn(async (_url: string, _body: unknown): Promise<unknown> => ({
      html_url: "https://github.com/o/r/issues/12",
    }));
    const log = vi.fn();
    const d: DriftDeps = {
      readFixtures: () => over.fixtures ?? [file("a.json", "1.13.7"), file("b.json", "1.13.7")],
      getJson: over.getJson ?? getJson,
      postJson: over.postJson ?? postJson,
      repo: "repo" in over ? over.repo! : "o/r",
      latest: over.latest ?? null,
      log: over.log ?? log,
    };
    return { d, getJson, postJson, log };
  }

  it("does nothing further when the fixtures are up to date", async () => {
    const { d, getJson, postJson } = deps({ fixtures: [file("a.json", "1.13.8")] });
    const out = await runDriftCheck(d);
    expect(out.outcome).toBe("up-to-date");
    expect(out.result.drifted).toBe(false);
    expect(postJson).not.toHaveBeenCalled();
    expect(getJson).toHaveBeenCalledTimes(1); // the release only: no issues lookup needed
  });

  it("opens one issue when drifted and none is open", async () => {
    const { d, postJson } = deps();
    const out = await runDriftCheck(d);
    expect(out.outcome).toBe("issue-created");
    expect(out.issueUrl).toBe("https://github.com/o/r/issues/12");
    expect(postJson).toHaveBeenCalledTimes(1);
    const [url, body] = postJson.mock.calls[0]! as [string, { title: string; body: string }];
    expect(url).toBe("https://api.github.com/repos/o/r/issues");
    expect(body.title).toContain("1.13.8");
    expect(body.body).toContain("a.json");
  });

  it("opens NO second issue while a drift issue is still open", async () => {
    const open = [
      {
        number: 3,
        title: `${ISSUE_TITLE_PREFIX} Obsidian 1.13.6 is out`,
        html_url: "https://github.com/o/r/issues/3",
      },
    ];
    const { d, postJson } = deps({ issues: open });
    const out = await runDriftCheck(d);
    expect(out.outcome).toBe("issue-already-open");
    expect(out.issueUrl).toBe("https://github.com/o/r/issues/3");
    expect(postJson).not.toHaveBeenCalled();
  });

  it("with no repository (dry run) reports the drift and touches nothing on GitHub", async () => {
    const { d, getJson, postJson, log } = deps({ repo: null });
    const out = await runDriftCheck(d);
    expect(out.outcome).toBe("drifted-dry-run");
    expect(postJson).not.toHaveBeenCalled();
    expect(getJson).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().join("\n")).toContain("1.13.8");
  });

  it("uses a given latest version instead of asking GitHub for it", async () => {
    const { d, getJson } = deps({ repo: null, latest: "9.9.9" });
    const out = await runDriftCheck(d);
    expect(out.result.latest).toBe("9.9.9");
    expect(getJson).not.toHaveBeenCalled();
  });

  it("logs the comparison in one readable line", async () => {
    const { d, log } = deps({ fixtures: [file("a.json", "1.13.8")] });
    await runDriftCheck(d);
    expect(log.mock.calls.flat().join("\n")).toMatch(/1\.13\.8/);
  });

  it("lets a failing release lookup fail the run: a silent canary is worse than a red one", async () => {
    const { d } = deps({
      getJson: async () => {
        throw new Error("rate limited");
      },
    });
    await expect(runDriftCheck(d)).rejects.toThrow(/rate limited/);
  });

  it("lets unreadable fixtures fail the run", async () => {
    const { d } = deps({ fixtures: [] });
    await expect(runDriftCheck(d)).rejects.toThrow(/no fixtures/i);
  });

  it("fails if GitHub answers the issue creation without a URL", async () => {
    const { d } = deps({ postJson: async () => ({}) });
    await expect(runDriftCheck(d)).rejects.toThrow(/html_url|issue/i);
  });

  it("fails if the open-issues lookup returns something that is not a list", async () => {
    const { d } = deps({ issues: { message: "Not Found" } });
    await expect(runDriftCheck(d)).rejects.toThrow(/list/i);
  });
});
