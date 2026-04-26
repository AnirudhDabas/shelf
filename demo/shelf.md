# shelf session — demo

## Objective
Exercise every section of `shelf eval` against a hand-authored 35-experiment trace.
Catalog is a fictional outdoor-gear store with 10 products; baseline AI Shelf Score 25.

## What's been tried
- 8 `title_rewrite` experiments (5 kept) — leading category keywords + attribute stacking.
- 6 `description_restructure` (3 kept) — replaced marketing copy with specs + use cases.
- 5 `metafield_add` (2 kept) — high-impact spec metafields like `waterproof_rating_mm`.
- 5 `seo_title` (3 kept) — query-intent-led `<title>` rewrites.
- 4 `seo_description` (1 kept) — meta-description tightening.
- 4 `tags_update` (1 kept) — most reverted as low-signal.
- 3 `metafield_update` (1 kept) — corrections to existing values.
- 4 failures (3 `checks_failed`, 1 `generator_failed`).

## Dead ends
- `tags_update` and `seo_description` consistently produced near-zero or
  negative deltas — the providers don't seem to weight them strongly.
- After iter ~26 the loop stopped finding improvements; deltas hover at 0
  and reverts dominate.

## Key wins
- Iter 7: `metafield_add` of `waterproof_rating_mm = "10000"` lifted score by +7.
- Iter 13: `title_rewrite` of Alpine Down Vest gained +6.
- Iter 16: `description_restructure` of Cascade Trail Runners gained +5.

Final score: 76.0 / 100.
