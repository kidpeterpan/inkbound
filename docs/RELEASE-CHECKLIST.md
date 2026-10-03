# Release checklist

Cutting a release is one commit, one tag, one workflow. This is the order, what
each step proves, and what to do when it fails. The parts that are easy to skip
are marked **do not skip** — they are the ones whose absence has shipped broken
builds before (1.7.0 and 1.7.1 went out with desktop export dead while every
gate was green).

## 1. Decide the version and prepare the notes

- [ ] Bump both manifests at once: `npm run version:bump -- <major.minor.patch>`
      (patch for internal work, minor for a feature, major for a break).
- [ ] Add a `## <version>` section to `CHANGELOG.md`. **This section becomes the
      GitHub release description**, and the release workflow fails without it.
      Write it for a reader, not for a diff: what changed and why it matters.
- [ ] `npm run release:check` — proves versions agree and the notes section
      exists, so the tag will publish. Takes a second; the alternative is a
      failed workflow on the shared branch after the tag is public.

## 2. Run the gate

Same list CI runs, in the same order (see DEVELOPING.md's gate sections for
what each one can and cannot see):

- [ ] `npm run lint && npm run format:check && npx tsc --noEmit`
- [ ] `npm run test:coverage`
- [ ] `npm run build && npm run check-mobile-safe && npm run check-review-safe`
- [ ] `npm run check-export-works` — the shipped bundle exports a real book
- [ ] `npm run epubcheck` — that book is valid EPUB 3

All of these also run in CI on the release commit, so a green local run is about
not wasting a public run, not about being the only check.

## 3. Look at what changed — **do not skip**

CI renders through the marked-based stub, so it cannot see real Obsidian's DOM,
real Mermaid output, or e-ink rendering. This step is the only thing that can.

- [ ] `npm run review-pack` — exports the fixture books with the shipped bundle
      and reports what changed since the last reviewed baseline:
      either "nothing changed … nothing NEW for the device pass to look at", or
      a list of the exact entries that changed.
- [ ] `npm run check-obsidian-drift` — are the captured real-render fixtures
      older than the newest Obsidian release? If they are, re-capture (see
      "The Obsidian drift canary" in DEVELOPING.md) before trusting the rest of
      this step.
- [ ] Open the book in real Obsidian and on the actual device. Check the entries
      the pack named, plus the hand-verified areas DEVELOPMENT.md keeps, in
      "Testing and its limits" → "Verified by hand". A chapter that changed is
      the thing to read; Mermaid and math rasterization are the things to look
      at rather than read.
- [ ] When the pass is done: `npm run review-pack -- --update`, and commit the
      updated `tests/fixtures/review-baseline.json` **in the release commit**.
      That records "these books were looked at", which is what makes the next
      release's diff meaningful.

## 4. Tag and watch it publish

- [ ] Commit: `chore: release <version>` (CHANGELOG.md, manifest.json,
      package.json, and the review baseline if it moved).
- [ ] Push `main`, then tag and push the tag:

      git tag <version>          # bare numeric — no "v" prefix; Obsidian's
          git push origin main       # installer matches manifest.json
          git push origin <version>

- [ ] `gh run watch` — the release workflow re-runs the whole gate on the tag,
      then publishes the GitHub release from the CHANGELOG section.
- [ ] `gh release view <version>` — confirm it is not a draft and carries
      `main.js` + `manifest.json`.

## If something fails after the tag is pushed

The workflow is idempotent for notes and assets: fix the problem, and re-run it
against the same tag (`gh release edit` / re-upload happen automatically when
the release already exists — see `.github/workflows/release.yml`). Do not delete
and re-push a tag Obsidian users may already have installed.
