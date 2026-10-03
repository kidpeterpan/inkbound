// Review pack: what the fixture books look like now, against what they looked
// like at the last review — the input to the manual pass a green CI cannot do.
//
// WHY: CI is stub-rendered (see the header of check-export-works.ts), so real
// Obsidian's DOM can change under this plugin without a single gate noticing —
// which is how 1.7.0 and 1.7.1 shipped with desktop export broken. The manual
// pass on a real device is the only check that catches it, and its cost is
// "look at everything". This makes it "look at these entries".
//
// It runs the SHIPPED bundle (the same export the CI gate runs), fingerprints
// both fixture books entry by entry — normalising the uuid/timestamp every
// export mints, and ignoring zip container details, via
// tests/fixtures/epub-fingerprint.ts — and diffs them against the recorded
// baseline in tests/fixtures/review-baseline.json.
//
// Usage:
//   npm run review-pack              # print what changed since the baseline
//   npm run review-pack -- --update  # re-record the baseline (after reviewing)
//
// The decision logic and its tests live in scripts/lib/review-pack.ts.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { epubEntryFingerprints } from "../tests/fixtures/epub-fingerprint";
import { diffBooks, fixtureHeader, reviewLines, type Fingerprints } from "./lib/review-pack";
import { REPO_ROOT } from "./lib/harness";

const BASELINE = path.join(REPO_ROOT, "tests", "fixtures", "review-baseline.json");
const REAL_RENDER_FIXTURE = path.join(REPO_ROOT, "tests", "fixtures", "real-render", "chrome.json");
// The keys name the fixture folder each book was exported from.
const BOOK_KEY = "smoke-vault/Book";
const FOOTNOTE_KEY = "smoke-vault/Footnotes";

interface Baseline {
  books: Record<string, Fingerprints>;
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv = {}): void {
  execFileSync(command, args, { cwd: REPO_ROOT, stdio: "inherit", env: { ...process.env, ...env } });
}

// The pack must review the code as it stands, not whatever was built last — a
// stale main.js would diff the wrong book and quietly clear a real change.
function buildShippedBundle(): void {
  console.log("review-pack: building the shipped bundle...");
  run("node", ["esbuild.config.mjs", "production"]);
}

/**
 * Exports both fixture books with the shipped bundle and fingerprints them.
 * check-export-works does the exporting (it already owns the vault stub, the
 * require shim and the assertions); the two KEEP_* variables are its
 * documented way to hand the books to another gate.
 */
function exportAndFingerprint(): Promise<Record<string, Fingerprints>> {
  const outDir = mkdtempSync(path.join(os.tmpdir(), "inkbound-review-pack-"));
  const bookPath = path.join(outDir, "book.epub");
  const footnotePath = path.join(outDir, "footnotes.epub");
  try {
    console.log("review-pack: exporting the fixture books with the shipped bundle...");
    run("node", ["node_modules/.bin/tsx", "scripts/check-export-works.ts"], {
      INKBOUND_KEEP_EPUB: bookPath,
      INKBOUND_KEEP_FOOTNOTE_EPUB: footnotePath,
    });
    for (const p of [bookPath, footnotePath]) {
      if (!existsSync(p)) {
        console.error(`review-pack: FAIL — the export gate did not produce ${p}.`);
        process.exit(1);
      }
    }
    return Promise.all([
      epubEntryFingerprints(readFileSync(bookPath)),
      epubEntryFingerprints(readFileSync(footnotePath)),
    ]).then(([book, footnotes]) => ({ [BOOK_KEY]: book, [FOOTNOTE_KEY]: footnotes }));
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

function readBaseline(): Baseline {
  if (!existsSync(BASELINE)) {
    console.log(`review-pack: no baseline at ${path.relative(REPO_ROOT, BASELINE)} yet.`);
    return { books: {} };
  }
  return JSON.parse(readFileSync(BASELINE, "utf8")) as Baseline;
}

function writeBaseline(books: Record<string, Fingerprints>): void {
  const payload: Baseline = { books };
  writeFileSync(BASELINE, `${JSON.stringify(payload, null, 2)}\n`);
  const entries = Object.values(books).reduce((n, book) => n + Object.keys(book).length, 0);
  console.log(
    `review-pack: recorded ${Object.keys(books).length} book(s), ${entries} entries, in ` +
      `${path.relative(REPO_ROOT, BASELINE)} — commit that file.`
  );
}

async function main(): Promise<void> {
  const update = process.argv.includes("--update");
  buildShippedBundle();
  const current = await exportAndFingerprint();

  if (update) {
    writeBaseline(current);
    return;
  }

  const baseline = readBaseline();
  const diffs = diffBooks(baseline.books, current);
  const fixture = fixtureHeader(JSON.parse(readFileSync(REAL_RENDER_FIXTURE, "utf8")));

  console.log("");
  for (const line of reviewLines(diffs, fixture)) console.log(line);
  console.log("");
  console.log(
    Object.keys(baseline.books).length === 0
      ? "review-pack: record this state first with `npm run review-pack -- --update`."
      : "review-pack: when the device pass is done, record the reviewed state with"
  );
  if (Object.keys(baseline.books).length > 0) {
    console.log("  npm run review-pack -- --update");
  }
}

main().catch((e) => {
  console.error("review-pack: FAIL — harness threw before the books could be compared.");
  console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
  process.exit(1);
});
