// 016-export-all-books: the export pipeline's feedback seam (research R4).
//
// A single export shows its own notices; a run over the whole library must
// not, so the pipeline takes its notices from an `ExportFeedback`. Without
// one it uses today's notices, which the notice tests in main.test.ts pin
// (FR-009). These cases drive the pipeline directly with a recording feedback.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExport, type ExportFeedback, type ProgressHandle } from "../src/adapters/export-pipeline";
import { DEFAULT_SETTINGS } from "../src/core/delivery/settings-core";
import type { EpubExportSettings } from "../src/core/delivery/settings-core";
import { Component, NOTICES, TFile, resetRequestUrlImpl, setRequestUrlImpl } from "./fixtures/obsidian-stub";
import { createVaultStub } from "./fixtures/vault-stub";

let dirs: string[];

beforeEach(() => {
  dirs = [];
  NOTICES.length = 0;
});

afterEach(async () => {
  resetRequestUrlImpl();
  await Promise.all(dirs.map((d) => fs.rm(d, { recursive: true, force: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

interface Recorded {
  started: string[];
  chapters: string[];
  pushes: number;
  finished: string[];
  failed: string[];
}

function recordingFeedback(): { feedback: ExportFeedback; recorded: Recorded } {
  const recorded: Recorded = { started: [], chapters: [], pushes: 0, finished: [], failed: [] };
  const feedback: ExportFeedback = {
    started: (title): ProgressHandle => {
      recorded.started.push(title);
      return {
        chapter: (index, total) => recorded.chapters.push(`${index}/${total}`),
        pushing: () => (recorded.pushes += 1),
        hide: () => {},
      };
    },
    finished: (savedText, input) => {
      recorded.finished.push(input.bookTitle);
      void savedText;
      return null;
    },
    failed: (message) => {
      recorded.failed.push(message);
    },
  };
  return { feedback, recorded };
}

async function oneChapterBook(settings: Partial<EpubExportSettings>, feedback?: ExportFeedback) {
  const vault = await tempDir("epub-feedback-vault-");
  await fs.writeFile(join(vault, "a.md"), "# A\n\nBody.\n");
  const outputFolder = settings.outputFolder ?? (await tempDir("epub-feedback-out-"));
  const { app } = createVaultStub(vault, "");
  return runExport(
    { meta: { title: "Tide", author: "Pan", language: "en" }, files: [new TFile(vault, "a.md") as never] },
    {
      app: app as never,
      component: new Component() as never,
      settings: {
        ...DEFAULT_SETTINGS,
        optimizeImages: false,
        embedThaiFont: false,
        ...settings,
        outputFolder,
      },
      titleFor: (file) => file.basename,
      feedback,
    }
  );
}

describe("runExport with a feedback of its own", () => {
  it("reports through the feedback and shows no notice of its own", async () => {
    const { feedback, recorded } = recordingFeedback();

    const outcome = await oneChapterBook({}, feedback);

    expect(recorded.started).toEqual(["Tide"]);
    expect(recorded.chapters).toEqual(["1/1"]);
    expect(recorded.finished).toEqual(["Tide"]);
    expect(recorded.failed).toEqual([]);
    expect(NOTICES).toEqual([]);
    expect(outcome.failure).toBeNull();
  });

  it("returns the failure message and tells the feedback, still showing no notice", async () => {
    const { feedback, recorded } = recordingFeedback();
    // An output "folder" that is really a file: writing the book must fail.
    const blocker = join(await tempDir("epub-feedback-block-"), "not-a-folder");
    await fs.writeFile(blocker, "x");

    const outcome = await oneChapterBook({ outputFolder: blocker }, feedback);

    expect(recorded.failed).toHaveLength(1);
    expect(outcome.failure).toBe(recorded.failed[0]);
    expect(outcome.report).toBeNull();
    expect(NOTICES).toEqual([]);
  });

  it("tells the feedback's handle when the book is being pushed", async () => {
    const { feedback, recorded } = recordingFeedback();
    setRequestUrlImpl(async () => {
      throw new Error("device unreachable");
    });

    await oneChapterBook({ pushAfterExport: true, booxUrl: "http://boox.local:8085" }, feedback);

    expect(recorded.pushes).toBe(1);
  });
});

describe("runExport without a feedback (pin: today's notices)", () => {
  it("shows the progress notice and the completion notice it always has", async () => {
    const outcome = await oneChapterBook({});

    expect(NOTICES[0]).toBe('Exporting "Tide"…');
    expect(NOTICES.some((n) => n.startsWith("EPUB saved to"))).toBe(true);
    expect(outcome.failure).toBeNull();
  });
});
