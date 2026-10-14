---
export: false
---

# Scratch

SCRATCH-NOTE-SENTINEL

A fixture note for 017-note-exclusion, and the only marked note in the shipped
bundle's fixture vault. It exists to be LEFT OUT: `scripts/check-export-works.ts`
asserts the sentinel above appears in no entry of the exported `Book`, and that
no `chapter_004.xhtml` is produced. Because it is left out, the book must be
byte-identical to the book this folder produced before the file existed — which
is also what the review-pack baseline records.
