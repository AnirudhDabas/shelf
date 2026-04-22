# AI Shelf Score

The AI Shelf Score is a number from 0-100 that answers a narrow question: **when a real AI shopping agent is asked about products like yours, how often does your store come up?**

## The query set

Queries come from two sources:

1. **Claude-generated**, grounded in the actual catalog. The [QueryGenerator](../packages/core/src/queries/generator.ts) asks Claude to write realistic shopper queries per category and intent.
2. **Demo fixture** at [fixtures/demo-store/queries.json](../fixtures/demo-store/queries.json) — 50 queries across three intents, used as the baseline set for the rain-gear demo.

Every query has a typed intent: `purchase`, `compare`, or `research`. The three intents have different retrieval behaviour — a "what is hydrostatic head rating" research query rarely surfaces product citations, but a "best waterproof jacket under $200" purchase query almost always does. Mixing them keeps the score from being a single-intent overfit.

## Providers

| Provider   | Endpoint                                  | How appearance is detected                            |
| ---------- | ----------------------------------------- | ----------------------------------------------------- |
| Perplexity | Sonar API                                 | Store domain appears in `citations[]`                 |
| OpenAI     | Responses API with `web_search` tool      | Store domain appears in the returned citations        |
| Anthropic  | Messages API with `web_search` tool       | Store domain appears in `web_search_tool_result` urls |

A query "appears" when the provider's citation list contains the configured `SHOPIFY_STORE_DOMAIN` (or the public `.com` mapping of the myshopify subdomain).

## Denoising: two passes

Web-search responses are stochastic — the same query sent twice can return different citations. To keep the score from jumping around, scoring runs two denoising passes:

1. **Per-provider majority vote over repetitions.** Each `(query, provider)` pair is run three times (`SHELF_QUERIES_PER_MEASUREMENT`). The provider reports "matched" only if at least 2 of 3 calls said the store appeared.
2. **Cross-provider OR.** A query counts toward the overall score if *any* provider's majority vote matched. The rationale: appearance in even one major AI agent is a real win, and OR is conservative against false negatives (a provider throwing a transient error shouldn't drop the score).

The per-provider matched rates are kept alongside the overall — if Perplexity is at 80% and OpenAI at 12%, you see it.

## Confidence

Score-delta sign isn't enough to decide keep vs. revert — small positive deltas can be noise. Shelf uses [median absolute deviation (MAD)](../packages/core/src/confidence/mad.ts) over the last N measurements of the same product to set a noise floor, then classifies each experiment as `high`, `medium`, `low`, or `noise` confidence. Low-confidence positive deltas log as `kept_uncertain` so they're distinguishable from real wins in the trace.

## Why real API calls instead of heuristics

Heuristic scoring (keyword density, schema.org completeness, SEO lints) correlates weakly with what AI shoppers actually surface. The gap shows up most for metafields: a product with a perfect `waterproof_rating_mm` metafield but a vague description can still lose to a product whose description just says "10,000mm waterproof rating" in prose, because the web-search model reads the rendered page, not the structured data.

Scoring against the live agents closes that loop. The cost — ~$0.01-0.04 per query per provider — is the price of a ground-truth signal. Budgeted via `SHELF_BUDGET_LIMIT_USD`.

## Known limitations

- **Stochasticity.** Even with three repetitions, scores can jitter ±2-3 points between runs on identical catalogs. The MAD confidence layer absorbs most of this at the per-experiment level, but absolute scores aren't precise to the decimal.
- **Provider API churn.** Each of the three scoring providers has shipped breaking changes to their `web_search` surface in the last year. Adapter code is isolated in [`packages/core/src/scorer/{perplexity,openai,anthropic}.ts`](../packages/core/src/scorer/).
- **Cost.** Default budget is $5. At ~$0.03 per query per provider × 3 providers × 3 repetitions × 10 sampled queries per iteration, each measurement costs roughly $2.70 — so expect ~1-2 measurements against the default budget. Raise `SHELF_BUDGET_LIMIT_USD` for longer runs, or tune repetitions via `SHELF_QUERIES_PER_MEASUREMENT`.
- **Domain detection.** If your store is a custom-domain Shopify store, both the `.myshopify.com` and custom domain need to be matched. The matcher accepts comma-separated domains in `SHOPIFY_STORE_DOMAIN`.
