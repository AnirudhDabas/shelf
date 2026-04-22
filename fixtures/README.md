# Demo fixtures

These files back the `--no-shopify` dry-run mode of the loop. They let you exercise every code path — query selection, scoring, hypothesis generation, apply, revert, logging — with zero credentials and zero API cost.

## Files

- **`demo-store/products.json`** — A small rain-gear catalog (titles, descriptions, vendors, tags, sizes, prices, images). Intentionally bad for AI discoverability: marketing-fluff titles, no specs in descriptions, no metafields. The autoresearch loop's job is to make this catalog *better*. Used by `scripts/seed-store.ts` to seed a real Shopify dev store and by `--no-shopify` to fabricate in-memory products.
- **`demo-store/queries.json`** — 50 hand-written shopper queries (purchase / compare / research intent) used as the dry-run measurement set.

## A note on `targetProductIds`

Every query in `queries.json` ships with `targetProductIds: []` (empty). This is deliberate. In a normal run, `QueryGenerator` produces queries dynamically and binds each one to 1-3 real product GIDs that it knows exist in the live catalog. In dry-run, the loop round-robins these static queries onto whichever product GIDs it sees, so the binding is computed at run time rather than baked into the fixture.

If you build a fixture for your own catalog, leave `targetProductIds` empty — the loop will populate it.
