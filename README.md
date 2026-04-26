# shelf

> autoresearch for storefronts

Your Shopify store is enrolled in ChatGPT, Perplexity, and Google AI Mode.
It isn't showing up.

`shelf` is an autonomous agent that tunes your product catalog until it does.

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
npx shelf-ai init       # interactive .env setup
npx shelf-ai run        # start the loop
npx shelf-ai dashboard  # live view at http://localhost:3000
npx shelf-ai eval       # meta-evaluation of the loop's own behavior
```

Requires Node ≥ 20. Try the loop without any API keys via `npx shelf-ai run --dry-run --no-shopify`.

### From source

```bash
git clone https://github.com/AnirudhDabas/shelf
cd shelf
pnpm install
pnpm build
node packages/core/dist/cli.js init
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

After each apply, live mode sleeps 8s before re-measuring so Shopify's storefront and CDN caches reflect the change. At 25 iterations that's ~3.3 minutes of pure wait time; dry-run skips it entirely.

## Dashboard

```bash
npx shelf-ai dashboard
```

Next.js app on port 3000. Tails `shelf.jsonl` via SSE and renders the live score, a progression chart, and the last 20 experiments with expandable before/after diffs. No websockets, no database — just a file tail.

## Configuration

| Env var                            | Purpose                                                           |
| ---------------------------------- | ----------------------------------------------------------------- |
| `SHOPIFY_STORE_DOMAIN`             | `your-store.myshopify.com`                                        |
| `SHOPIFY_CLIENT_ID`                | OAuth client credentials (preferred over admin access token). When both OAuth and access token are set, OAuth wins. |
| `SHOPIFY_CLIENT_SECRET`            | OAuth client credentials (preferred over admin access token). When both OAuth and access token are set, OAuth wins. |
| `SHOPIFY_ADMIN_ACCESS_TOKEN`       | Admin API token with `write_products` + `write_product_listings`  |
| `PERPLEXITY_API_KEY`               | Sonar scoring provider (optional, at least one scorer required)   |
| `OPENAI_API_KEY`                   | OpenAI `web_search` scoring provider (optional)                   |
| `ANTHROPIC_API_KEY`                | Required — powers hypothesis + query generation                   |
| `SHELF_BUDGET_LIMIT_USD`           | Stop the loop when total estimated spend exceeds this (default 5 — roughly 5-10 real iterations depending on which scoring providers you enable; raise for longer runs) |
| `SHELF_MAX_ITERATIONS`             | Hard cap on iterations (default 100)                              |
| `SHELF_QUERIES_PER_MEASUREMENT`    | Repetitions per (query, provider) pair for majority voting (default: 3) |
| `SHELF_LOG_FILE`                   | Path for the jsonl experiment log (default `shelf.jsonl`)         |
| `SHELF_SESSION_FILE`               | Path for the human-readable session doc (default `shelf.md`)      |

## Dry run

```bash
npx shelf-ai run --dry-run                 # mock all AI calls, still read from Shopify
npx shelf-ai run --dry-run --no-shopify    # fully offline; read catalog from fixtures
```

`--dry-run` stubs every external AI call (Anthropic, OpenAI, Perplexity) so the full loop — query generation, scoring, hypothesis proposal, apply, revert — runs end-to-end at `$0.00`:

- **Queries** are loaded from [fixtures/demo-store/queries.json](fixtures/demo-store/queries.json) and round-robined onto the real product IDs fetched from your store.
- **Scorer** returns a deterministic pseudo-random `appeared` verdict per `(query, iteration)`, seeded so all configured providers agree. Baseline hovers near 30 and drifts up ~1 point per iteration (capped at +40), enough to exercise the keep/revert logic.
- **Hypothesis generator** returns a hardcoded `title_rewrite` (`Waterproof {type} — {title} | {vendor}`) so the applier and reverter run real code paths.
- **Shopify writes** still hit the Admin API unless you also pass `--no-shopify`.

Add `--no-shopify` to skip Shopify entirely: products are loaded from [fixtures/demo-store/products.json](fixtures/demo-store/products.json) with fabricated GIDs, and applier/reverter log `[dry-run] would apply ...` instead of calling the Admin API. This mode needs zero credentials — useful for smoke-testing a build or recording demo output.

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

## Backpressure checks

Every hypothesis passes a local check pass before it hits Shopify:

- Title length 10-255 characters (applies to `title_rewrite` only; warns above 100).
- No keyword appears more than 3 times in title + description (catches keyword stuffing).
- Description reading grade 5-12 (Flesch-Kincaid).
- Title must not start with `buy`, `shop`, or `best`.
- No ALL-CAPS word longer than 4 letters in the title (acronyms up to 4 characters are fine).
- Description length 50-5000 chars after HTML stripping.
- `metafield_add` / `metafield_update` values must be grounded in existing product data (at least one substantive token must appear somewhere in the product's title, description, tags, SEO fields, or existing metafields).

Failed checks are logged with `verdict: "checks_failed"` without touching the store.

## Optimization trace

See [docs/optimization-trace-example.md](docs/optimization-trace-example.md) for a worked example with 12 real experiments, before/after diffs, and score deltas.

## shelf eval — evaluating the loop itself

```bash
npx shelf-ai eval                # offline analyses against shelf.jsonl
npx shelf-ai eval --live         # also run a live score-stability sweep
npx shelf-ai eval --json         # raw JSON to stdout
npx shelf-ai eval -o report.md   # write the markdown report somewhere other than shelf-eval.md
npx shelf-ai eval --live --products 5 --runs 5   # tune the stability sweep
```

`shelf eval` is a meta-evaluation layer: it reads `shelf.jsonl` and produces a rigorous statistical analysis of how well the optimization loop is actually working. Five sections:

1. **Hypothesis Effectiveness** — keep rate, average score delta (kept and reverted), median iterations to first keep, and a recommended priority order if you only had budget for ~10 iterations.
2. **Score Stability** *(--live)* — re-measures 5 products 5 times each *without changing anything* and reports per-product mean/std/CV. Verdicts: stable (<5% CV), moderate (5-15%), unstable (>15%).
3. **Plateau Detection** — rolling-average score curve, plus the iteration where the loop stopped paying back its API spend.
4. **Provider Disagreement** — per-provider keep rates and score trajectories; flags providers that diverge from the rest.
5. **Reward Hacking Audit** — title-length inflation, readability drift, keyword-density creep, and product-clustering across kept changes. Outputs a Low/Medium/High risk score with evidence.

Output goes to your terminal, with the full markdown report written to `shelf-eval.md`. Add `--json` to pipe the raw structured data into another tool.

Evaluation methodology inspired by Andrew McNamara, Ben Lafferty, and Michael Garner's work on Sidekick evaluation at Shopify — specifically the principles of ground-truth-based evaluation, reward hacking detection, and statistical validation over "vibe testing" ([Building Production Ready Agentic Systems, Shopify Engineering, ICML 2025](https://shopify.engineering/building-production-ready-agentic-systems)).

## Built with

- Shopify Admin GraphQL API
- Perplexity Sonar API
- OpenAI Responses API with `web_search`
- Anthropic Claude API with the `web_search` tool
- Inspired by [autoresearch](https://github.com/karpathy/autoresearch) by [@karpathy](https://github.com/karpathy) and [pi-autoresearch](https://github.com/davebcn87/pi-autoresearch) by [@davebcn87](https://github.com/davebcn87)

## Why

Shopify activated Agentic Storefronts for all merchants on 2026-03-24. [5.6M stores](https://www.shopify.com/news/agentic-storefronts), and the [880M monthly AI users figure](https://openai.com/index/chatgpt-search) combines ChatGPT, Perplexity, and Gemini's public usage disclosures. Most stores are invisible because their product data isn't structured for machine consumption.

This closes the loop.

## Privacy

`shelf` writes only to your local disk (`shelf.jsonl`, `shelf.md`, `.shelf-cache/`) and to the third-party APIs you've configured (Shopify, Anthropic, optionally OpenAI/Perplexity). No telemetry, no analytics, no phone-home. Your API keys live in `.env` and never leave your machine.

## License

MIT
