---
export: false
---
# Expected results

Read by `checkDataviewBook` in `scripts/check-export-works.ts`, which hard-codes the same numbers.

- `[Dataview query omitted]` markers: 14 (11 in 01 Queries, 3 from Inner through 02 Embeds)
- `[DataviewJS omitted]` markers: 1 (01 Queries)
- Dataview warnings: 12 referenced by `Dataview/01 Queries.md`, 3 referenced by `Dataview/Inner.md`
- Survive verbatim: `SAMPLE-QUERY-MUST-SURVIVE`, `CAPITAL-D-MUST-SURVIVE`, `INDENTED-MUST-SURVIVE`
