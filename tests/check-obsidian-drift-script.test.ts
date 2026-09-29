import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

// Runs scripts/check-obsidian-drift.ts as a real process. The pure rules are
// covered in obsidian-drift.test.ts; this proves the wiring around them —
// argv, the environment, the fixtures folder, the exit code — actually works.
//
// Every case passes --latest (or fails before any lookup), so none of them
// reaches GitHub. The child gets a minimal environment on purpose: the test
// runner's own CI / GITHUB_TOKEN must not change what is being tested.

const run = promisify(execFile);
const ROOT = resolve(__dirname, "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const SCRIPT = join(ROOT, "scripts", "check-obsidian-drift.ts");

async function drift(args: string[], env: Record<string, string> = {}) {
  try {
    const { stdout, stderr } = await run(TSX, [SCRIPT, ...args], {
      cwd: ROOT,
      env: { PATH: process.env.PATH ?? "", ...env },
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code?: number; stdout?: string; stderr?: string };
    return { code: err.code ?? -1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
}

let tmp: string;
let oneFixtureDir: string;
let emptyDir: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "drift-script-"));
  oneFixtureDir = join(tmp, "one");
  emptyDir = join(tmp, "empty");
  await mkdir(oneFixtureDir);
  await mkdir(emptyDir);
  await writeFile(join(oneFixtureDir, "only.json"), JSON.stringify({ obsidianVersion: "1.0.0", html: "" }));
  // Not a fixture: only *.json files are read.
  await writeFile(join(oneFixtureDir, "README.txt"), "ignored");
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("scripts/check-obsidian-drift.ts", () => {
  it.concurrent("reports drift in a dry run against the repo's real fixtures, and exits 0", async () => {
    const r = await drift(["--dry-run", "--latest", "99.0.0"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("latest release: 99.0.0");
    expect(r.stdout).toMatch(/would open an issue titled: \[obsidian-drift\] Obsidian 99\.0\.0/);
    expect(r.stdout).toContain("obsidian-drift: drifted-dry-run");
  });

  it.concurrent("says up to date when the fixtures are not behind", async () => {
    const r = await drift(["--dry-run", "--latest", "0.0.1"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("obsidian-drift: up-to-date");
    expect(r.stdout).not.toContain("would open");
  });

  it.concurrent("reads *.json from --fixtures and ignores other files", async () => {
    const r = await drift(["--dry-run", "--latest", "2.0.0", "--fixtures", oneFixtureDir]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("oldest fixture: 1.0.0 (1 fixtures, 1 behind)");
  });

  it.concurrent("fails, exit 1, when the fixtures folder has no fixtures", async () => {
    const r = await drift(["--dry-run", "--latest", "2.0.0", "--fixtures", emptyDir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("obsidian-drift: FAIL");
    expect(r.stderr).toMatch(/no fixtures/i);
  });

  it.concurrent("fails, exit 1, when the fixtures folder does not exist", async () => {
    const r = await drift(["--dry-run", "--latest", "2.0.0", "--fixtures", join(tmp, "missing")]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("obsidian-drift: FAIL");
  });

  it.concurrent("fails on a bad argument instead of ignoring it", async () => {
    const r = await drift(["--latest", "banana"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("banana");
  });

  it.concurrent("in CI without a token, fails before doing anything", async () => {
    const r = await drift(["--latest", "99.0.0"], { CI: "true" });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("GITHUB_TOKEN");
    expect(r.stdout).not.toContain("would open");
  });
});
