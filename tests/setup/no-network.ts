// Structural anti-network guard, not per-file discipline. Registered via
// vitest.config.ts's `test.setupFiles`, so this runs once per test file,
// before any of that file's own hooks/tests.
//
// Without this, tests/fixtures/obsidian-stub.ts's default `requestUrl` is a
// REAL `fetch`. tests/main.test.ts happens to install its own throwing
// default in its own `beforeEach`, but tests/settings.test.ts and
// tests/http.test.ts rely on each individual test remembering to call
// `setRequestUrlImpl` — a future test (in those files or a new one) that
// forgets would perform real network I/O in CI.
//
// This `beforeEach` re-installs a throwing default before EVERY test in
// EVERY file. Hook ordering makes this safe to combine with a test file's
// own `beforeEach`: vitest runs `beforeEach` hooks outer-to-inner in
// registration order, and this setup file's hooks are registered before a
// test file's own top-level code runs, so this hook always fires first.
// A test file's own `beforeEach` (e.g. tests/main.test.ts's, which also
// installs a throwing default) registers and therefore runs after this one,
// so it still wins for that file. Nothing here needs to know about, or
// interact with, any test file's own `afterEach(resetRequestUrlImpl)` —
// this hook reruns before every subsequent test regardless of what the
// previous test's cleanup did.
//
// CRITICAL: this file is a vitest `setupFiles` entry only. It is never
// loaded by scripts/local-export.ts (that harness runs under tsx, not
// vitest), so the CLI harness's real-`fetch` default is untouched.
import { beforeEach } from "vitest";
import { setRequestUrlImpl } from "../fixtures/obsidian-stub";

beforeEach(() => {
  setRequestUrlImpl(async () => {
    throw new Error("unexpected network access in test — install a fake with setRequestUrlImpl");
  });
});
