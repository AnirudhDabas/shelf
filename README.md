# shelf

> autoresearch for storefronts

Your Shopify store is enrolled in ChatGPT, Perplexity, and Google AI Mode.
It isn't showing up.

`shelf` is an autonomous agent that tunes your product catalog until it does.

![dashboard](docs/dashboard.png)

## How it works

1. Generate ~50 realistic shopper queries for your catalog with Claude.
2. Measure an **AI Shelf Score** — fraction of queries where your store appears in ChatGPT, Perplexity, and Claude's web-search citations.
3. Propose one catalog change (title, description, metafield, SEO, tags) as a typed hypothesis.
4. Run backpressure checks (keyword density, reading grade, metafield grounding).
5. Apply via Shopify Admin GraphQL.
6. Re-measure the score.
7. Keep the change if score went up; revert if it didn't. Append the result to `shelf.jsonl` and update `shelf.md`. Loop.

The judges aren't heuristics. They're the actual AI agents shoppers use.

## Quick start

```bash
npx shelf init          # interactive .env setup
npx shelf run           # start the loop
npx shelf dashboard     # live view at http://localhost:3000
```

## The loop

```
propose → check → apply → measure → keep/revert → log
   ▲                                                │
   └────────────────────────────────────────────────┘
```

The loop structure and the two log artefacts — `shelf.jsonl` (append-only experiments) and `shelf.md` (four-section living session doc: *Objective / What's been tried / Dead ends / Key wins*) — are lifted from [autoresearch](https://github.com/karpathy/autoresearch) by @karpathy and [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) by @davebcn87. Shelf applies the same shape to a new optimization target.

## AI Shelf Score

A number from 0-100: the percentage of your generated query set where your store domain appears in AI-agent citations.

Each (query, provider) pair is run three times — web-search responses are stochastic, so the majority vote across repetitions denoises per-provider noise. A query counts as matched for the overall score if *any* configured provider's majority vote says it appeared.

Results are cached on disk by `{query, store}` for dry-run re-scoring without API cost.

## Dashboard

```bash
npx shelf dashboard
```

Next.js app on port 3000. Tails `shelf.jsonl` via SSE and renders the live score, a progression chart, and the last 20 experiments with expandable before/after diffs. No websockets, no database — just a file tail.

## Configuration

| Env var                            | Purpose                                                           |
| ---------------------------------- | ----------------------------------------------------------------- |
| `SHOPIFY_STORE_DOMAIN`             | `your-store.myshopify.com`                                        |
| `SHOPIFY_ADMIN_ACCESS_TOKEN`       | Admin API token with `write_products` + `write_product_listings`  |
| `SHOPIFY_STOREFRONT_ACCESS_TOKEN`  | Storefront token (used for grounding hypothesis generation)       |
| `PERPLEXITY_API_KEY`               | Sonar scoring provider (optional, at least one scorer required)   |
| `OPENAI_API_KEY`                   | OpenAI `web_search` scoring provider (optional)                   |
| `ANTHROPIC_API_KEY`                | Required — powers hypothesis + query generation                   |
| `SHELF_BUDGET_LIMIT_USD`           | Stop the loop when total estimated spend exceeds this (default 25)|
| `SHELF_MAX_ITERATIONS`             | Hard cap on iterations (default 100)                              |
| `SHELF_QUERIES_PER_MEASUREMENT`    | Query sample size per score measurement (default 3)               |
| `SHELF_LOG_FILE`                   | Path for the jsonl experiment log (default `shelf.jsonl`)         |
| `SHELF_SESSION_FILE`               | Path for the human-readable session doc (default `shelf.md`)      |

## Dry run

```bash
npx shelf run --dry-run
```

Re-scores the catalog from cached provider responses. No Shopify mutations, no scoring API cost, no log writes. Useful for reproducing a prior run or sanity-checking the scoring engine end-to-end.

## Hypothesis types

| Type                       | Example                                                      |
| -------------------------- | ------------------------------------------------------------ |
| `title_rewrite`            | `"The Explorer Pro"` → `"Waterproof Hiking Jacket — Explorer Pro"` |
| `description_restructure`  | Replace marketing fluff with specs, materials, use cases     |
| `metafield_add`            | Add `custom.waterproof_rating_mm = "10000"`                  |
| `metafield_update`         | Correct a mis-typed spec value                               |
| `seo_title`                | Rewrite `<title>` for query intent                           |
| `seo_description`          | Rewrite meta description with primary keywords               |
| `tags_update`              | Add `waterproof`, `3-layer`, `pit-zips`                      |
| `variant_title`            | `"Large"` → `"Large (42-44 in chest)"`                       |

## Backpressure checks

Every hypothesis passes a local check pass before it hits Shopify:

- Title length 10-70 characters.
- Keyword density ≤ 3% (catches keyword stuffing).
- Reading grade level 5-12 (Flesch-Kincaid).
- No spammy prefixes (`BEST`, `#1`, `GUARANTEED`).
- ALL CAPS ratio ≤ 10%.
- Metafield values must be grounded in the existing product description.

Failed checks are logged with `verdict: "checks_failed"` without touching the store.

## Optimization trace

See [docs/optimization-trace-example.md](docs/optimization-trace-example.md) for a worked example with 12 real experiments, before/after diffs, and score deltas.

## Built with

- Shopify Admin GraphQL API + Storefront API
- Perplexity Sonar API
- OpenAI Responses API with `web_search`
- Anthropic Claude API with the `web_search` tool
- Inspired by [autoresearch](https://github.com/karpathy/autoresearch) by [@karpathy](https://github.com/karpathy) and [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) by [@davebcn87](https://github.com/davebcn87)

## Why

Shopify activated Agentic Storefronts for all merchants on 2026-03-24. 5.6M stores, 880M monthly AI users. Most stores are invisible because their product data isn't structured for machine consumption.

This closes the loop.

## License

MIT
